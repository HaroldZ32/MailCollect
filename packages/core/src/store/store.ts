import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type {
  Account,
  BroadcastVerdict,
  ChangeLogRow,
  ChangeOp,
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
import { bit, type Db, type SqlValue } from "./db.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import {
  toAccount,
  toEmail,
  toProfile,
  toTask,
  toVerdict,
  type AccountRow,
  type EmailRow,
  type LlmConfigRow,
  type ProfileRow,
  type TaskRow,
  type VerdictRow,
} from "./mappers.js";

export interface StoreOptions {
  db: Db;
  /** AES key used for mailbox secrets; see crypto.ts. */
  key: Buffer;
  userId: string;
  deviceId: string;
}

const nowIso = (): string => new Date().toISOString();

const encodeCursor = (sentAt: string, id: string): string =>
  Buffer.from(`${sentAt}|${id}`, "utf8").toString("base64url");

const decodeCursor = (cursor: string): { sentAt: string; id: string } | null => {
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const idx = raw.indexOf("|");
    if (idx < 0) return null;
    return { sentAt: raw.slice(0, idx), id: raw.slice(idx + 1) };
  } catch {
    return null;
  }
};

/**
 * All local persistence goes through here. No SQL leaks into the server or the
 * pipeline, and every write appends to `change_log` so the reserved cloud-sync
 * seam has a complete ordered history to replay.
 */
export class Store {
  private readonly db: Db;
  private readonly key: Buffer;
  private readonly userId: string;
  private readonly deviceId: string;
  private revCounter = 0;

  constructor(opts: StoreOptions) {
    this.db = opts.db;
    this.key = opts.key;
    this.userId = opts.userId;
    this.deviceId = opts.deviceId;
  }

  migrate(): void {
    const schema = readFileSync(new URL("./schema.sql", import.meta.url), "utf8");
    this.db.exec(schema);
  }

  close(): void {
    this.db.close();
  }

  get driver(): string {
    return this.db.driver;
  }

  /* ------------------------------- change log ------------------------------ */

  private rev(): string {
    this.revCounter += 1;
    return `${Date.now().toString(36)}-${this.revCounter.toString(36)}`;
  }

  private log(entity: string, entityId: string, op: ChangeOp, payload: unknown): void {
    this.db
      .prepare(
        `INSERT INTO change_log (entity, entity_id, rev, device_id, op, payload, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entity, entityId, this.rev(), this.deviceId, op, JSON.stringify(payload), nowIso());
  }

  head(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log").get<{ seq: number }>();
    return Number(row?.seq ?? 0);
  }

  changes(since: number, limit = 500): ChangeLogRow[] {
    const rows = this.db
      .prepare("SELECT * FROM change_log WHERE seq > ? ORDER BY seq ASC LIMIT ?")
      .all<ChangeLogRow>(since, limit);
    return rows;
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
    this.db
      .prepare(
        `INSERT INTO account (id, user_id, provider, label, email, config_json, secret_cipher, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id,
        this.currentUserId(),
        input.provider,
        input.label,
        input.email,
        JSON.stringify(input.config),
        encryptSecret(this.key, input.secret),
        now,
      );
    const row = this.db.prepare("SELECT * FROM account WHERE id = ?").get<AccountRow>(id);
    if (!row) throw new Error("account write failed");
    const account = toAccount(row);
    this.log("account", id, "insert", account);
    return account;
  }

  deleteAccount(id: string): boolean {
    const result = this.db.prepare("DELETE FROM account WHERE id = ?").run(id);
    if (result.changes > 0) this.log("account", id, "delete", { id });
    return result.changes > 0;
  }

  markSynced(accountId: string, at: string): void {
    this.db.prepare("UPDATE account SET last_sync_at = ? WHERE id = ?").run(at, accountId);
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

  /** Inserts only messages we have not seen; returns the ids that were new. */
  upsertEmails(emails: RawEmail[]): { inserted: number; ids: string[] } {
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO raw_email (
         id, account_id, uid, message_id, thread_id, from_name, from_email,
         to_json, cc_json, subject, sent_at, body_text, has_attachments,
         headers_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ids: string[] = [];
    for (const email of emails) {
      const result = stmt.run(
        email.id,
        email.accountId,
        email.uid,
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
      );
      if (result.changes > 0) ids.push(email.id);
    }
    for (const id of ids) this.log("raw_email", id, "insert", { id });
    return { inserted: ids.length, ids };
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
      where.push("(subject LIKE ? OR from_email LIKE ? OR body_text LIKE ?)");
      const like = `%${query.search}%`;
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
