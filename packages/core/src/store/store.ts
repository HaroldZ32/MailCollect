import { randomUUID } from "node:crypto";
import type {
  Account,
  BroadcastVerdict,
  CreateAccountInput,
  EmailListQuery,
  LlmConfig,
  LlmConfigInput,
  LlmConfigView,
  LlmProtocol,
  RawEmail,
  SyncCursor,
  Task,
  TaskCounts,
  TaskListQuery,
  TaskStatus,
  UpdateTaskInput,
  UpsertProfileInput,
  UserProfile,
} from "@mailcollect/shared";
import { bit, type SqlValue } from "./db.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { migrateSchema } from "./migrate.js";
import {
  EMPTY_EMAIL_EXTRAS,
  serializeAttachments,
  serializeEmailRef,
  toAccount,
  toEmail,
  toEmailExtras,
  toProfile,
  toTask,
  toVerdict,
  type AccountRow,
  type EmailExtras,
  type EmailExtrasInput,
  type EmailRow,
  type LlmConfigRow,
  type ProfileRow,
  type TaskRow,
  type VerdictRow,
} from "./mappers.js";
import { LIKE_ESCAPE, containsLike } from "./like.js";
import { applySendInput, StoreRepos, type StoreDeps } from "./repos.js";

export type StoreOptions = StoreDeps;

const nowIso = (): string => new Date().toISOString();

/**
 * Message-ID fallback matching window (days). Used only when the server moved a
 * message and the adapter could not resolve its new locator (`unresolved`): the
 * same account + same Message-ID + same folder within this window is the same
 * physical mail. A wide-but-bounded window keeps a reused Message-ID from two
 * unrelated messages apart.
 */
const MESSAGE_ID_MATCH_WINDOW_DAYS = 1;

/**
 * All local persistence goes through here. No SQL leaks into the server or the
 * pipeline, and every write appends to `change_log` so the reserved cloud-sync
 * seam has a complete ordered history to replay.
 *
 * The v1.1 aggregates (category / rule / tag / folder / draft / outbox / init
 * state / send config) live on {@link StoreRepos}; this class adds the v1 ones
 * and owns boot-time migration.
 */
export class Store extends StoreRepos {
  constructor(opts: StoreOptions) {
    super(opts);
  }

  /**
   * Applies the v1 schema, the additive v1.1 migration and the seed rules.
   *
   * Repeatable by construction: `schema.sql` / `schema-v11.sql` only create, the
   * column additions are PRAGMA-guarded, the "was this v1?" answer comes from the
   * persisted `schema_version` marker, and seeding is marker-guarded. A v1
   * database therefore upgrades in place, keeping profile / accounts / emails /
   * tasks / change_log intact, and a second boot changes nothing.
   */
  migrate(): void {
    const result = migrateSchema(this.db);
    if (result.legacy) this.markUpgradedFromV1();
    // A fresh database seeds the rules here so the wizard can display them;
    // `rules_seeded` makes every later call a no-op, and a rule the user deleted
    // is never replayed. `upsertProfile` reconciles 「点名给我」 with the profile.
    this.ensureSeedRules();
  }

  close(): void {
    this.db.close();
  }

  get driver(): string {
    return this.db.driver;
  }

  /* -------------------------------- profile -------------------------------- */

  getProfile(): UserProfile | null {
    const row = this.db.prepare("SELECT * FROM user_profile LIMIT 1").get<ProfileRow>();
    return row ? toProfile(row) : null;
  }

  currentUserId(): string {
    return this.getProfile()?.id ?? this.userId;
  }

  upsertProfile(input: UpsertProfileInput): UserProfile {
    const existing = this.getProfile();
    const id = existing?.id ?? randomUUID();
    const now = nowIso();
    const aliases = JSON.stringify(input.aliases.filter(Boolean));
    const emails = JSON.stringify(input.emails.filter(Boolean));
    if (existing) {
      this.db
        .prepare(
          `UPDATE user_profile
              SET display_name = ?, aliases_json = ?, emails_json = ?, timezone = ?, updated_at = ?
            WHERE id = ?`,
        )
        .run(input.displayName, aliases, emails, input.timezone, now, id);
    } else {
      this.db
        .prepare(
          `INSERT INTO user_profile (id, display_name, aliases_json, emails_json, timezone, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, input.displayName, aliases, emails, input.timezone, now, now);
    }
    const profile = this.getProfile();
    if (!profile) throw new Error("profile write failed");
    this.log("user_profile", id, existing ? "update" : "insert", profile);
    // The 「点名给我」 seed depends on the profile's names/aliases/addresses, so
    // every profile save re-evaluates it through shared.planSeedPersonalReconcile
    // (no-op once unchanged, never resurrects a tombstoned or user-edited rule).
    this.reconcileSeedPersonalRule();
    return profile;
  }

  /* -------------------------------- accounts ------------------------------- */

  listAccounts(): Account[] {
    return this.db
      .prepare("SELECT * FROM account ORDER BY created_at ASC")
      .all<AccountRow>()
      .map(toAccount);
  }

  /** Returns the account plus its DECRYPTED secret. Only the sync engine may call this. */
  getAccountWithSecret(id: string): { account: Account; secret: string } | null {
    const row = this.db.prepare("SELECT * FROM account WHERE id = ?").get<AccountRow>(id);
    if (!row) return null;
    const secret = row.secret_cipher ? decryptSecret(this.key, row.secret_cipher) : "";
    return { account: toAccount(row), secret };
  }

  createAccount(input: CreateAccountInput): Account {
    const id = randomUUID();
    const now = nowIso();
    // v1.1 outbound settings are non-secret config entries; the SMTP/EWS password
    // is AES-256-GCM encrypted exactly like the inbound mailbox secret (C2).
    const config = input.send ? applySendInput(input.config, input.send) : { ...input.config };
    const smtpPassword = input.send?.smtpPassword;
    this.db
      .prepare(
        `INSERT INTO account (id, user_id, provider, label, email, config_json, secret_cipher,
                              smtp_secret_cipher, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id,
        this.currentUserId(),
        input.provider,
        input.label,
        input.email,
        JSON.stringify(config),
        // Graph device-code accounts legitimately have no secret to paste; store
        // NULL instead of an undecryptable empty ciphertext.
        input.secret.length > 0 ? encryptSecret(this.key, input.secret) : null,
        smtpPassword && smtpPassword.length > 0 ? encryptSecret(this.key, smtpPassword) : null,
        now,
      );
    const row = this.db.prepare("SELECT * FROM account WHERE id = ?").get<AccountRow>(id);
    if (!row) throw new Error("account write failed");
    const account = toAccount(row);
    // Never put `config` into the change log: it now carries a local cache path,
    // and the change stream is exposed over /api/sync/changes.
    this.log("account", id, "insert", {
      id: account.id,
      provider: account.provider,
      label: account.label,
      email: account.email,
    });
    return account;
  }

  /**
   * Deletes an account and every row its foreign keys cascade into.
   *
   * A cascade is still a write: the affected rows are SELECTed first (inside the
   * same transaction) and each one is appended to `change_log` with
   * `op=delete`, so the reserved sync seam can replay the whole account removal
   * instead of resurrecting orphaned mail / tags / folders / drafts / outbox
   * items on the next device. Same rule as `deleteCategory`.
   */
  deleteAccount(id: string): boolean {
    const removed = this.tx(() => {
      const emails = this.db
        .prepare("SELECT id FROM raw_email WHERE account_id = ?")
        .all<{ id: string }>(id);
      const verdicts = this.db
        .prepare(
          "SELECT email_id FROM broadcast_verdict WHERE email_id IN (SELECT id FROM raw_email WHERE account_id = ?)",
        )
        .all<{ email_id: string }>(id);
      const tasks = this.db
        .prepare(
          "SELECT id FROM task WHERE source_email_id IN (SELECT id FROM raw_email WHERE account_id = ?)",
        )
        .all<{ id: string }>(id);
      const tags = this.db
        .prepare(
          "SELECT * FROM tag WHERE email_id IN (SELECT id FROM raw_email WHERE account_id = ?)",
        )
        .all<{ id: string; email_id: string }>(id);
      const folders = this.db
        .prepare("SELECT path FROM folder WHERE account_id = ?")
        .all<{ path: string }>(id);
      const drafts = this.db
        .prepare("SELECT id FROM draft WHERE account_id = ?")
        .all<{ id: string }>(id);
      const outbox = this.db
        .prepare("SELECT id FROM outbox WHERE account_id = ?")
        .all<{ id: string }>(id);
      const cursors = this.db
        .prepare("SELECT account_id FROM sync_cursor WHERE account_id = ?")
        .all<{ account_id: string }>(id);

      const result = this.db.prepare("DELETE FROM account WHERE id = ?").run(id);
      if (result.changes === 0) return 0;

      this.clearFolderCursors(id);
      this.log("account", id, "delete", { id });
      for (const row of emails) this.log("raw_email", row.id, "delete", { id: row.id, accountId: id });
      for (const row of verdicts) {
        this.log("broadcast_verdict", row.email_id, "delete", { emailId: row.email_id, accountId: id });
      }
      for (const row of tasks) this.log("task", row.id, "delete", { id: row.id, accountId: id });
      for (const row of tags) {
        this.log("tag", row.id, "delete", { id: row.id, emailId: row.email_id, accountId: id });
      }
      for (const row of folders) {
        this.log("folder", `${id}:${row.path}`, "delete", { accountId: id, path: row.path });
      }
      for (const row of drafts) this.log("draft", row.id, "delete", { id: row.id, accountId: id });
      for (const row of outbox) this.log("outbox", row.id, "delete", { id: row.id, accountId: id });
      for (const row of cursors) {
        this.log("sync_cursor", row.account_id, "delete", { accountId: id });
      }
      return result.changes;
    });
    return removed > 0;
  }

  markSynced(accountId: string, at: string): void {
    this.db.prepare("UPDATE account SET last_sync_at = ? WHERE id = ?").run(at, accountId);
  }

  getLastSync(accountId: string): string | null {
    const row = this.db
      .prepare("SELECT last_sync_at FROM account WHERE id = ?")
      .get<{ last_sync_at: string | null }>(accountId);
    return row?.last_sync_at ?? null;
  }

  /* --------------------------------- cursor -------------------------------- */

  getCursor(accountId: string): SyncCursor | null {
    const row = this.db
      .prepare("SELECT account_id, value, updated_at FROM sync_cursor WHERE account_id = ?")
      .get<{ account_id: string; value: string; updated_at: string }>(accountId);
    return row ? { accountId: row.account_id, value: row.value, updatedAt: row.updated_at } : null;
  }

  setCursor(accountId: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO sync_cursor (account_id, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(accountId, value, nowIso());
  }

  /* --------------------------------- emails -------------------------------- */

  /**
   * Inserts only messages we have not seen; returns the ids that were new.
   *
   * With `folderId` (v1.1 per-folder sync) the row records its folder and its
   * authoritative server locator, and — because IMAP UIDs are folder-scoped —
   * the local dedupe key becomes `"<folderId>\u001f<provider uid>"`. The true
   * provider id stays in `provider_ref_json.ref.id`; without the compound key a
   * message in Archive with uid 5 would collide with inbox uid 5 and be dropped
   * by `UNIQUE (account_id, uid)`.
   *
   * A message that MOVED keeps its local row: the next sync returns it under a
   * NEW provider id, so an existing row is matched by its persisted ref and
   * re-pointed instead of inserted again. A v1 row (plain uid, no ref) is adopted
   * on its first folder-scoped sync instead of being duplicated.
   *
   * When the adapter moved a message but could not resolve the new locator
   * (`unresolved`), neither the uid nor the ref can identify it. The last-resort
   * match is `Message-ID` + same folder + a sent date within
   * {@link MESSAGE_ID_MATCH_WINDOW_DAYS}: without it the next sync would insert a
   * second local row for the same physical mail.
   */
  upsertEmails(
    emails: RawEmail[],
    folderId?: string | null,
    extras?: ReadonlyMap<string, EmailExtrasInput>,
  ): { inserted: number; ids: string[] } {
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO raw_email (
         id, account_id, uid, message_id, thread_id, from_name, from_email,
         to_json, cc_json, subject, sent_at, body_text, has_attachments,
         headers_json, created_at, folder, provider_ref_json, received_at, attachments_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const findByUid = this.db.prepare(
      "SELECT id, uid, folder, provider_ref_json FROM raw_email WHERE account_id = ? AND uid = ?",
    );
    // A persisted ref identifies a message only WITH its folder: IMAP UIDs are
    // folder-scoped, so ref {id:"5", folder:"INBOX"} is not the Archive message
    // with uid 5. A ref without a folder (protocols with mailbox-wide ids) still
    // matches anywhere.
    const findByRef = this.db.prepare(
      `SELECT id, uid, folder, provider_ref_json FROM raw_email
        WHERE account_id = ?
          AND CASE WHEN json_valid(provider_ref_json)
                   THEN json_extract(provider_ref_json, '$.ref.id') END = ?
          AND (
            CASE WHEN json_valid(provider_ref_json)
                 THEN json_extract(provider_ref_json, '$.ref.folderId') END = ?
            OR CASE WHEN json_valid(provider_ref_json)
                    THEN json_extract(provider_ref_json, '$.ref.folderId') END IS NULL
          )
        LIMIT 1`,
    );
    const findLegacy = this.db.prepare(
      "SELECT id, uid, folder, provider_ref_json FROM raw_email WHERE account_id = ? AND uid = ? AND provider_ref_json IS NULL",
    );
    // Last resort: a message whose server locator is unknown (`unresolved`) comes
    // back under a new id. Message-ID + folder + a nearby sent date identifies the
    // same physical mail, so the existing row is re-pointed instead of duplicated.
    const findByMessageId = this.db.prepare(
      `SELECT id, uid, folder, provider_ref_json,
              ABS(julianday(sent_at) - julianday(?)) AS distance
         FROM raw_email
        WHERE account_id = ?
          AND message_id = ?
          AND message_id <> ''
          AND folder = ?
          AND ABS(julianday(sent_at) - julianday(?)) <= ?
        ORDER BY distance ASC
        LIMIT 1`,
    );
    const reidentify = this.db.prepare(
      "UPDATE raw_email SET uid = ?, folder = ?, provider_ref_json = ? WHERE id = ?",
    );
    const writeExtras = this.db.prepare(
      "UPDATE raw_email SET received_at = ?, attachments_json = ? WHERE id = ?",
    );
    type ExistingRow = {
      id: string;
      uid: string;
      folder: string;
      provider_ref_json: string | null;
    };
    const localUid = (folder: string | null, uid: string): string =>
      folder === null ? uid : `${folder}\u001f${uid}`;

    const ids: string[] = [];
    for (const email of emails) {
      const folder = folderId ?? null;
      const uid = localUid(folder, email.uid);
      const refJson = folder === null ? null : serializeEmailRef({ id: email.uid, folderId: folder });
      if (folder !== null) {
        const existing =
          findByUid.get<ExistingRow>(email.accountId, uid) ??
          findByRef.get<ExistingRow>(email.accountId, email.uid, folder) ??
          findLegacy.get<ExistingRow>(email.accountId, email.uid) ??
          (email.messageId.trim() === ""
            ? undefined
            : findByMessageId.get<ExistingRow>(
                email.sentAt,
                email.accountId,
                email.messageId,
                folder,
                email.sentAt,
                MESSAGE_ID_MATCH_WINDOW_DAYS,
              ));
        if (existing) {
          if (
            existing.uid !== uid ||
            existing.folder !== folder ||
            existing.provider_ref_json !== refJson
          ) {
            reidentify.run(uid, folder, refJson, existing.id);
            const extra = extras?.get(email.id);
            if (extra) {
              writeExtras.run(
                extra.receivedAt ?? null,
                serializeAttachments(extra.attachments ?? []),
                existing.id,
              );
            }
            this.log("raw_email", existing.id, "update", {
              id: existing.id,
              folder,
              ref: { id: email.uid, folderId: folder },
            });
          }
          continue;
        }
      } else if (findByUid.get(email.accountId, email.uid)) {
        continue;
      }
      const result = insert.run(
        email.id,
        email.accountId,
        uid,
        email.messageId,
        email.threadId,
        email.fromName,
        email.fromEmail,
        JSON.stringify(email.to),
        JSON.stringify(email.cc),
        email.subject,
        email.sentAt,
        email.bodyText,
        bit(email.hasAttachments),
        JSON.stringify(email.headers),
        email.createdAt,
        folder ?? "INBOX",
        refJson,
        extras?.get(email.id)?.receivedAt ?? null,
        serializeAttachments(extras?.get(email.id)?.attachments ?? []),
      );
      if (result.changes > 0) ids.push(email.id);
    }
    for (const id of ids) this.log("raw_email", id, "insert", { id });
    return { inserted: ids.length, ids };
  }

  /**
   * Writes the rule-projection metadata of one message (received time + attachment
   * metadata, never the attachment bytes). Omitted fields keep their value so a
   * later enrichment cannot erase a previously stored received time.
   */
  setEmailExtras(emailId: string, extras: EmailExtrasInput): boolean {
    const current = this.getEmailExtras(emailId);
    const receivedChanged =
      extras.receivedAt !== undefined && extras.receivedAt !== current.receivedAt;
    const attachmentsChanged =
      extras.attachments !== undefined &&
      serializeAttachments(extras.attachments) !== serializeAttachments(current.attachments);
    // Idempotent: a per-folder resync reports the same values every time, and a
    // no-op must not append a change_log row (the sync seam would grow forever).
    if (!receivedChanged && !attachmentsChanged) return this.getEmail(emailId) !== null;

    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (extras.receivedAt !== undefined) {
      sets.push("received_at = ?");
      params.push(extras.receivedAt);
    }
    if (extras.attachments !== undefined) {
      sets.push("attachments_json = ?");
      params.push(serializeAttachments(extras.attachments));
    }
    params.push(emailId);
    const result = this.db
      .prepare(`UPDATE raw_email SET ${sets.join(", ")} WHERE id = ?`)
      .run(...params);
    if (result.changes === 0) return false;
    // The sync seam only needs the identity; metadata (including attachment
    // filenames) stays in the row and is read back by id — same minimal-payload
    // rule the outbox logging follows after T63.
    this.log("raw_email", emailId, "update", { id: emailId });
    return true;
  }

  /**
   * Writes the server-reported receive time for one fetched batch (T64 contract:
   * `FetchResult.receivedAtByUid`, key = provider uid).
   *
   * Rules that make this trustworthy:
   * - an email WITHOUT a map entry is skipped, never written as NULL — a later
   *   sync can still fill it and an existing value is never wiped;
   * - the stored value is the server receive time converted to ISO, never
   *   `RawEmail.sentAt` (the sender's Date header);
   * - idempotent: re-syncing the same batch writes nothing and logs nothing.
   */
  applyReceivedAt(emails: readonly RawEmail[], receivedAtByUid: ReadonlyMap<string, Date>): void {
    for (const email of emails) {
      const receivedAt = receivedAtByUid.get(email.uid);
      if (receivedAt === undefined) continue;
      this.setEmailExtras(email.id, { receivedAt: receivedAt.toISOString() });
    }
  }

  /** Attachment metadata + received time for the rules projection (never bytes). */
  getEmailExtras(emailId: string): EmailExtras {
    const row = this.db
      .prepare("SELECT received_at, attachments_json FROM raw_email WHERE id = ?")
      .get<{ received_at: string | null; attachments_json: string | null }>(emailId);
    return row ? toEmailExtras(row) : EMPTY_EMAIL_EXTRAS;
  }

  listEmails(query: EmailListQuery): { items: RawEmail[]; nextCursor: string | null } {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (query.accountId) {
      where.push("account_id = ?");
      params.push(query.accountId);
    }
    if (query.search) {
      // Wildcards in the user's input are literals, not LIKE operators.
      where.push(
        `(subject LIKE ? ${LIKE_ESCAPE} OR from_email LIKE ? ${LIKE_ESCAPE} OR body_text LIKE ? ${LIKE_ESCAPE})`,
      );
      const like = containsLike(query.search);
      params.push(like, like, like);
    }
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (cursor) {
        where.push("(sent_at < ? OR (sent_at = ? AND id < ?))");
        params.push(cursor.sentAt, cursor.sentAt, cursor.id);
      }
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM raw_email ${clause} ORDER BY sent_at DESC, id DESC LIMIT ?`)
      .all<EmailRow>(...params, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(toEmail),
      nextCursor: rows.length > limit && last ? encodeCursor(last.sent_at, last.id) : null,
    };
  }

  getEmail(id: string): RawEmail | null {
    const row = this.db.prepare("SELECT * FROM raw_email WHERE id = ?").get<EmailRow>(id);
    return row ? toEmail(row) : null;
  }

  /** Oldest-first queue of messages that still need LLM extraction. */
  emailsPendingExtraction(limit = 20): RawEmail[] {
    return this.db
      .prepare(
        `SELECT * FROM raw_email WHERE extracted_at IS NULL ORDER BY sent_at ASC LIMIT ?`,
      )
      .all<EmailRow>(limit)
      .map(toEmail);
  }

  markExtracted(emailId: string, note: string | null): void {
    this.db
      .prepare("UPDATE raw_email SET extracted_at = ?, extraction_note = ? WHERE id = ?")
      .run(nowIso(), note, emailId);
  }

  /* ------------------------------- broadcast -------------------------------- */

  setBroadcastVerdict(emailId: string, verdict: BroadcastVerdict): void {
    this.db
      .prepare(
        `INSERT INTO broadcast_verdict (email_id, kind, signals_json) VALUES (?, ?, ?)
         ON CONFLICT(email_id) DO UPDATE SET kind = excluded.kind, signals_json = excluded.signals_json`,
      )
      .run(emailId, verdict.kind, JSON.stringify(verdict.signals));
  }

  getBroadcastVerdict(emailId: string): BroadcastVerdict | null {
    const row = this.db
      .prepare("SELECT * FROM broadcast_verdict WHERE email_id = ?")
      .get<VerdictRow>(emailId);
    return row ? toVerdict(row) : null;
  }

  getBroadcastDecision(listId: string): "always_task" | "always_ignore" | null {
    const row = this.db
      .prepare("SELECT decision FROM broadcast_decision WHERE list_id = ?")
      .get<{ decision: string }>(listId);
    return (row?.decision as "always_task" | "always_ignore" | undefined) ?? null;
  }

  setBroadcastDecision(listId: string, decision: "always_task" | "always_ignore"): void {
    this.db
      .prepare(
        `INSERT INTO broadcast_decision (list_id, decision, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(list_id) DO UPDATE SET decision = excluded.decision, updated_at = excluded.updated_at`,
      )
      .run(listId, decision, nowIso());
  }

  /* --------------------------------- tasks --------------------------------- */

  /** Idempotent: the UNIQUE(source_email_id, title) index swallows re-extraction. */
  insertTasks(tasks: Task[]): Task[] {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO task (
         id, user_id, title, detail, owner, owner_name, kind, status, origin,
         confidence, evidence_quote, source_email_id, thread_id,
         time_phrase, due_at, window_start, window_end, timezone, time_confidence,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const inserted: Task[] = [];
    for (const task of tasks) {
      const result = stmt.run(
        task.id,
        task.userId,
        task.title,
        task.detail,
        task.owner,
        task.ownerName,
        task.kind,
        task.status,
        task.origin,
        task.confidence,
        task.evidenceQuote,
        task.sourceEmailId,
        task.threadId,
        task.time?.phrase ?? null,
        task.time?.dueAt ?? null,
        task.time?.windowStart ?? null,
        task.time?.windowEnd ?? null,
        task.time?.timezone ?? null,
        task.time?.confidence ?? null,
        task.createdAt,
        task.updatedAt,
      );
      if (result.changes > 0) inserted.push(task);
    }
    for (const task of inserted) this.log("task", task.id, "insert", task);
    return inserted;
  }

  listTasks(query: TaskListQuery): Task[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (query.status) {
      where.push("status = ?");
      params.push(query.status);
    }
    if (query.includeBroadcast === false) {
      where.push("origin != 'broadcast'");
    }
    if (query.from) {
      where.push("COALESCE(due_at, window_start, created_at) >= ?");
      params.push(query.from);
    }
    if (query.to) {
      where.push("COALESCE(due_at, window_start, created_at) <= ?");
      params.push(query.to);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT * FROM task ${clause}
         ORDER BY COALESCE(due_at, window_start, created_at) ASC, created_at ASC`,
      )
      .all<TaskRow>(...params)
      .map(toTask);
  }

  taskCounts(): TaskCounts {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM task GROUP BY status")
      .all<{ status: TaskStatus; n: number }>();
    const counts: TaskCounts = { candidate: 0, confirmed: 0, dismissed: 0, done: 0 };
    for (const row of rows) counts[row.status] = Number(row.n);
    return counts;
  }

  updateTask(id: string, patch: UpdateTaskInput): Task | null {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    const map: Array<[keyof UpdateTaskInput, string]> = [
      ["title", "title"],
      ["detail", "detail"],
      ["status", "status"],
      ["dueAt", "due_at"],
      ["windowStart", "window_start"],
      ["windowEnd", "window_end"],
    ];
    for (const [field, column] of map) {
      const value = patch[field];
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      params.push(value);
    }
    if (sets.length === 0) return this.getTask(id);
    sets.push("updated_at = ?");
    params.push(nowIso(), id);
    this.db.prepare(`UPDATE task SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    const task = this.getTask(id);
    if (task) this.log("task", id, "update", task);
    return task;
  }

  getTask(id: string): Task | null {
    const row = this.db.prepare("SELECT * FROM task WHERE id = ?").get<TaskRow>(id);
    return row ? toTask(row) : null;
  }

  /** Bulk confirm/dismiss, used by the broadcast reminder card. */
  setTasksStatus(ids: string[], status: TaskStatus): Task[] {
    const updated: Task[] = [];
    for (const id of ids) {
      const task = this.updateTask(id, { status });
      if (task) updated.push(task);
    }
    return updated;
  }

  /* ----------------------------------- llm --------------------------------- */

  private static toLlmConfig(row: LlmConfigRow): LlmConfig {
    return {
      id: row.id,
      label: row.label,
      protocol: row.protocol as LlmProtocol,
      baseUrl: row.base_url,
      model: row.model,
      apiKeyRef: row.api_key_cipher ? "stored" : null,
      temperature: row.temperature,
      maxTokens: row.max_tokens,
      timeoutMs: row.timeout_ms,
      isDefault: row.is_default === 1,
    };
  }

  listLlmConfigs(): LlmConfigView[] {
    return this.db
      .prepare("SELECT * FROM llm_config ORDER BY is_default DESC, created_at ASC")
      .all<LlmConfigRow>()
      .map((row) => {
        const config = Store.toLlmConfig(row);
        return {
          id: config.id,
          label: config.label,
          protocol: config.protocol,
          baseUrl: config.baseUrl,
          model: config.model,
          hasKey: row.api_key_cipher !== null,
          isDefault: config.isDefault,
        };
      });
  }

  /** Returns a config plus its DECRYPTED key. Only the extraction engine may call this. */
  getLlmWithKey(id?: string): { config: LlmConfig; apiKey: string | null } | null {
    const row = id
      ? this.db.prepare("SELECT * FROM llm_config WHERE id = ?").get<LlmConfigRow>(id)
      : this.db
          .prepare("SELECT * FROM llm_config ORDER BY is_default DESC, created_at ASC LIMIT 1")
          .get<LlmConfigRow>();
    if (!row) return null;
    return {
      config: Store.toLlmConfig(row),
      apiKey: row.api_key_cipher ? decryptSecret(this.key, row.api_key_cipher) : null,
    };
  }

  upsertLlmConfig(input: LlmConfigInput): LlmConfigView {
    const id = randomUUID();
    const now = nowIso();
    const isDefault = input.isDefault ?? this.listLlmConfigs().length === 0;
    if (isDefault) this.db.prepare("UPDATE llm_config SET is_default = 0").run();
    this.db
      .prepare(
        `INSERT INTO llm_config (id, label, protocol, base_url, model, api_key_cipher,
                                 temperature, max_tokens, timeout_ms, is_default, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.label,
        input.protocol,
        input.baseUrl,
        input.model,
        input.apiKey ? encryptSecret(this.key, input.apiKey) : null,
        input.temperature ?? 0.2,
        input.maxTokens ?? 2048,
        60_000,
        bit(isDefault),
        now,
      );
    const view = this.listLlmConfigs().find((item) => item.id === id);
    if (!view) throw new Error("llm config write failed");
    this.log("llm_config", id, "insert", view);
    return view;
  }

  setDefaultLlmConfig(id: string): boolean {
    const exists = this.db.prepare("SELECT id FROM llm_config WHERE id = ?").get<{ id: string }>(id);
    if (!exists) return false;
    this.db.prepare("UPDATE llm_config SET is_default = 0").run();
    this.db.prepare("UPDATE llm_config SET is_default = 1 WHERE id = ?").run(id);
    this.log("llm_config", id, "update", { id, isDefault: true });
    return true;
  }

  deleteLlmConfig(id: string): boolean {
    const result = this.db.prepare("DELETE FROM llm_config WHERE id = ?").run(id);
    if (result.changes > 0) this.log("llm_config", id, "delete", { id });
    return result.changes > 0;
  }
}
