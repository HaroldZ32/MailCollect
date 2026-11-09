import { createHash, randomUUID } from "node:crypto";
import type {
  Account,
  AccountSendInput,
  ChangeLogRow,
  Category,
  CreateCategoryInput,
  CreateRuleInput,
  Draft,
  Folder,
  InitState,
  OutboxItem,
  OutboxStatus,
  OutgoingMessage,
  RawEmail,
  Rule,
  RuleTree,
  SeedIdentity,
  SeedRule,
  SyncCursor,
  Tag,
  UpdateAccountInput,
  UpdateCategoryInput,
  UpdateOnboardingInput,
  UpdateRuleInput,
} from "@mailcollect/shared";
import {
  SEED_RULE_PERSONAL_ID,
  UNCATEGORIZED_NAME,
  buildSeedRules,
  hasSeedIdentity,
  planSeedPersonalReconcile,
  serializeRuleTree,
  validateRuleTree,
} from "@mailcollect/shared";
import { decryptSecret, encryptSecret } from "./crypto.js";
import { decodeCursor, encodeCursor } from "./cursor.js";
import { bit, type Db, type SqlValue } from "./db.js";
import { StoreError } from "./errors.js";
import {
  UNRESOLVED_REF_JSON,
  UNKNOWN_REF,
  parseArray,
  parseEmailRefState,
  serializeEmailRef,
  toAccount,
  toCategory,
  toChangeLogRow,
  toDraft,
  toEmail,
  toFolder,
  toInitState,
  toOutboxItem,
  toRule,
  toTag,
  type AccountRow,
  type CategoryRow,
  type ChangeLogDbRow,
  type DraftRow,
  type EmailRow,
  type FolderRow,
  type InitStateRow,
  type OutboxRow,
  type ProviderRef,
  type EmailRefState,
  type RuleRow,
  type TagRow,
} from "./mappers.js";
import { LIKE_ESCAPE, containsLike } from "./like.js";

/**
 * v1.1 repositories.
 *
 * Split out of `store.ts` on purpose: `Store` already owns the v1 aggregates
 * (profile / account / email / task / LLM) and this file owns the v1.1 ones
 * (category / rule / tag / folder / draft / outbox / init state). They share the
 * same SQLite handle and the same append-only `change_log`, so the v1.1
 * repositories live on a base class that `Store` extends — one class per
 * service, no second connection, no second change stream.
 *
 * Every write in this file appends to `change_log` with an explicit
 * `entity` / `op`, including the rows reached through `ON DELETE CASCADE`
 * (they are selected before the delete so the sync seam never misses one).
 */

const nowIso = (): string => new Date().toISOString();

/** AC-12: a failed send is retried no sooner than 30 seconds later. */
export const OUTBOX_MIN_BACKOFF_MS = 30_000;
/** Exponential backoff ceiling; keeps a dead account from retrying forever. */
export const OUTBOX_MAX_BACKOFF_MS = 30 * 60_000;

const outboxBackoffMs = (attempts: number): number => {
  const exponent = Math.max(0, attempts - 1);
  return Math.min(OUTBOX_MIN_BACKOFF_MS * 2 ** exponent, OUTBOX_MAX_BACKOFF_MS);
};

export interface StoreDeps {
  readonly db: Db;
  readonly key: Buffer;
  readonly userId: string;
  readonly deviceId: string;
}

/** One `email -> category` hit produced by the rules engine. */
export interface TagHit {
  readonly categoryId: string;
  readonly ruleId: string | null;
}

/** A single tag to insert (`ClassificationTagStore.addTag`). */
export interface TagInput extends TagHit {
  readonly emailId: string;
  /** Caller-supplied timestamp; defaults to now. */
  readonly createdAt?: string;
}

export interface OutboxQuery {
  readonly accountId?: string;
  readonly status?: OutboxStatus;
}

/** Query for the folder-scoped message list (`GET /api/messages`). */
export interface EmailFolderQuery {
  readonly accountId?: string;
  readonly folder: string;
  readonly unreadOnly?: boolean;
  readonly search?: string;
  readonly categoryIds?: readonly string[];
  readonly limit?: number;
  readonly cursor?: string;
}

/** A stored email plus the v1.1 per-message state the list/detail views show. */
export interface EmailWithState {
  readonly email: RawEmail;
  readonly folder: string;
  readonly isRead: boolean;
}

export interface EmailFolderPage {
  readonly items: EmailWithState[];
  readonly nextCursor: string | null;
}

interface EmailStateRow {
  id: string;
  folder: string;
  is_read: number;
}

/**
 * `send` 的可空输入形状：`null` 显式清除该键，`undefined` 保持不变（PATCH 语义）。
 * 共享类型是 string-only；清除语义落在存储 seam 上，容忍旧客户端/JSON null。
 */
export type ClearableSendInput = {
  readonly [K in keyof AccountSendInput]?: AccountSendInput[K] | null;
};

/**
 * Folds `AccountSendInput` into the non-secret `account.config` string map.
 * Returning a new object keeps the caller's account snapshot immutable.
 */
export function applySendInput(
  config: Record<string, string>,
  send: ClearableSendInput,
): Record<string, string> {
  const next: Record<string, string> = { ...config };
  const put = (key: string, value: string | number | boolean | null | undefined): void => {
    if (value === undefined) return;
    if (value === null) {
      delete next[key];
      return;
    }
    next[key] = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  };
  put("smtpHost", send.smtpHost);
  put("smtpPort", send.smtpPort);
  put("smtpSecure", send.smtpSecure);
  put("smtpUser", send.smtpUser);
  put("ewsUrl", send.ewsUrl);
  put("authMode", send.authMode);
  put("signature", send.signature);
  put("displayName", send.displayName);
  return next;
}

/** Account payload for `change_log`: never `config` and never a secret. */
const publicAccount = (account: Account): unknown => ({
  id: account.id,
  provider: account.provider,
  label: account.label,
  email: account.email,
  enabled: account.enabled,
  send: account.send ?? null,
});

export class StoreRepos {
  protected readonly db: Db;
  protected readonly key: Buffer;
  protected readonly userId: string;
  protected readonly deviceId: string;
  private revCounter = 0;

  constructor(deps: StoreDeps) {
    this.db = deps.db;
    this.key = deps.key;
    this.userId = deps.userId;
    this.deviceId = deps.deviceId;
  }

  /* ------------------------------ transparent plumbing ----------------------------- */

  /** Runs `fn` in one SQLite transaction; rolls back and re-throws on failure. */
  protected tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (cause) {
      this.db.exec("ROLLBACK");
      throw cause;
    }
  }

  private rev(): string {
    this.revCounter += 1;
    return `${Date.now().toString(36)}-${this.revCounter.toString(36)}`;
  }

  protected log(
    entity: string,
    entityId: string,
    op: "insert" | "update" | "delete",
    payload: unknown,
  ): void {
    this.db
      .prepare(
        `INSERT INTO change_log (entity, entity_id, rev, device_id, op, payload, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(entity, entityId, this.rev(), this.deviceId, op, JSON.stringify(payload), nowIso());
  }

  head(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM change_log")
      .get<{ seq: number }>();
    return Number(row?.seq ?? 0);
  }

  changes(since: number, limit = 500): ChangeLogRow[] {
    return this.db
      .prepare("SELECT * FROM change_log WHERE seq > ? ORDER BY seq ASC LIMIT ?")
      .all<ChangeLogDbRow>(since, limit)
      .map(toChangeLogRow);
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get<{ value: string }>(key);
    return row?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value);
  }

  /* ---------------------------------- categories --------------------------------- */

  listCategories(): Category[] {
    return this.db
      .prepare("SELECT * FROM category ORDER BY created_at ASC, id ASC")
      .all<CategoryRow>()
      .map(toCategory);
  }

  getCategory(id: string): Category | null {
    const row = this.db.prepare("SELECT * FROM category WHERE id = ?").get<CategoryRow>(id);
    return row ? toCategory(row) : null;
  }

  createCategory(input: CreateCategoryInput): Category {
    const name = input.name.trim();
    if (name === "") throw new StoreError("invalid", "分类名称不能为空");
    if (name === UNCATEGORIZED_NAME) {
      throw new StoreError("invalid", `「${UNCATEGORIZED_NAME}」是计算态，不能创建为分类`);
    }
    const clash = this.db
      .prepare("SELECT id FROM category WHERE name = ?")
      .get<{ id: string }>(name);
    if (clash) throw new StoreError("conflict", `分类「${name}」已存在`);

    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO category (id, name, enter_todo, broadcast, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, name, bit(input.enterTodo), bit(input.broadcast), now, now);
    const created = this.getCategory(id);
    if (!created) throw new StoreError("state", "category write failed");
    this.log("category", id, "insert", created);
    return created;
  }

  updateCategory(id: string, patch: UpdateCategoryInput): Category | null {
    const existing = this.getCategory(id);
    if (!existing) return null;

    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name === "") throw new StoreError("invalid", "分类名称不能为空");
      if (name === UNCATEGORIZED_NAME) {
        throw new StoreError("invalid", `「${UNCATEGORIZED_NAME}」是计算态，不能作为分类名称`);
      }
      const clash = this.db
        .prepare("SELECT id FROM category WHERE name = ?")
        .get<{ id: string }>(name);
      if (clash && clash.id !== id) throw new StoreError("conflict", `分类「${name}」已存在`);
      sets.push("name = ?");
      params.push(name);
    }
    if (patch.enterTodo !== undefined) {
      sets.push("enter_todo = ?");
      params.push(bit(patch.enterTodo));
    }
    if (patch.broadcast !== undefined) {
      sets.push("broadcast = ?");
      params.push(bit(patch.broadcast));
    }
    if (sets.length === 0) return existing;

    sets.push("updated_at = ?");
    params.push(nowIso(), id);
    this.db.prepare(`UPDATE category SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    const updated = this.getCategory(id);
    if (!updated) return null;
    this.log("category", id, "update", updated);
    return updated;
  }

  /**
   * Deletes a category and, through the schema's `ON DELETE CASCADE`, its rules
   * and tags. The cascaded rows are read first so each one still lands in
   * `change_log` (op=`delete`) — a cascade is not an excuse for a silent write.
   */
  deleteCategory(id: string): boolean {
    const existing = this.getCategory(id);
    if (!existing) return false;
    const rules = this.db.prepare("SELECT id FROM rule WHERE category_id = ?").all<{ id: string }>(id);
    const tags = this.db
      .prepare("SELECT * FROM tag WHERE category_id = ?")
      .all<TagRow>(id);

    this.tx(() => {
      this.db.prepare("DELETE FROM category WHERE id = ?").run(id);
      this.log("category", id, "delete", { id, name: existing.name });
      for (const rule of rules) {
        this.log("rule", rule.id, "delete", { id: rule.id, categoryId: id });
        if (rule.id === SEED_RULE_PERSONAL_ID) this.setMeta("seed_personal_deleted", nowIso());
      }
      for (const tag of tags) {
        this.log("tag", tag.id, "delete", {
          id: tag.id,
          emailId: tag.email_id,
          categoryId: id,
        });
      }
    });
    return true;
  }

  /* ------------------------------------ rules ----------------------------------- */

  listRules(): Rule[] {
    return this.db
      .prepare("SELECT * FROM rule ORDER BY order_index ASC, created_at ASC, id ASC")
      .all<RuleRow>()
      .map(toRule);
  }

  getRule(id: string): Rule | null {
    const row = this.db.prepare("SELECT * FROM rule WHERE id = ?").get<RuleRow>(id);
    return row ? toRule(row) : null;
  }

  private validateTree(tree: RuleTree): RuleTree {
    const parsed = validateRuleTree(tree);
    if (!parsed.ok) {
      const detail = parsed.issues
        .map((issue) => `${issue.path === "" ? "root" : issue.path}:${issue.code}`)
        .join(", ");
      throw new StoreError("invalid", `条件树不合法（${detail}）`);
    }
    return parsed.tree;
  }

  private nextRuleOrder(): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM rule")
      .get<{ next: number }>();
    return Number(row?.next ?? 0);
  }

  createRule(input: CreateRuleInput): Rule {
    const name = input.name.trim();
    if (name === "") throw new StoreError("invalid", "规则名称不能为空");
    if (!this.getCategory(input.categoryId)) {
      throw new StoreError("not_found", `分类 ${input.categoryId} 不存在`);
    }
    const tree = this.validateTree(input.tree);
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO rule (id, name, category_id, tree_json, enabled, order_index, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        input.categoryId,
        JSON.stringify(tree),
        bit(input.enabled ?? true),
        input.order ?? this.nextRuleOrder(),
        now,
        now,
      );
    const created = this.getRule(id);
    if (!created) throw new StoreError("state", "rule write failed");
    this.log("rule", id, "insert", created);
    return created;
  }

  updateRule(id: string, patch: UpdateRuleInput): Rule | null {
    const existing = this.getRule(id);
    if (!existing) return null;

    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (name === "") throw new StoreError("invalid", "规则名称不能为空");
      sets.push("name = ?");
      params.push(name);
    }
    if (patch.categoryId !== undefined) {
      if (!this.getCategory(patch.categoryId)) {
        throw new StoreError("not_found", `分类 ${patch.categoryId} 不存在`);
      }
      sets.push("category_id = ?");
      params.push(patch.categoryId);
    }
    if (patch.tree !== undefined) {
      sets.push("tree_json = ?");
      params.push(JSON.stringify(this.validateTree(patch.tree)));
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      params.push(bit(patch.enabled));
    }
    if (patch.order !== undefined) {
      sets.push("order_index = ?");
      params.push(patch.order);
    }
    if (sets.length === 0) return existing;

    sets.push("updated_at = ?");
    params.push(nowIso(), id);
    this.db.prepare(`UPDATE rule SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    const updated = this.getRule(id);
    if (!updated) return null;
    this.log("rule", id, "update", updated);
    return updated;
  }

  deleteRule(id: string): boolean {
    if (!this.getRule(id)) return false;
    this.tx(() => {
      this.db.prepare("DELETE FROM rule WHERE id = ?").run(id);
      this.log("rule", id, "delete", { id });
      // 「点名给我」 is re-expanded on every profile save; the tombstone is what
      // makes "deleted once" mean "never comes back" (C3 / AC-03).
      if (id === SEED_RULE_PERSONAL_ID) this.setMeta("seed_personal_deleted", nowIso());
    });
    return true;
  }

  /** Drag-and-drop ordering: `ids` is the display order; unknown ids are refused. */
  reorderRules(ids: readonly string[]): Rule[] {
    const unique = [...new Set(ids)];
    const now = nowIso();
    this.tx(() => {
      unique.forEach((id, index) => {
        const result = this.db
          .prepare("UPDATE rule SET order_index = ?, updated_at = ? WHERE id = ?")
          .run(index, now, id);
        if (result.changes === 0) throw new StoreError("not_found", `规则 ${id} 不存在`);
        this.log("rule", id, "update", { id, order: index });
      });
    });
    return this.listRules();
  }

  /* ------------------------------------- tags ----------------------------------- */

  listTagsForEmail(emailId: string): Tag[] {
    return this.db
      .prepare("SELECT * FROM tag WHERE email_id = ? ORDER BY created_at ASC, id ASC")
      .all<TagRow>(emailId)
      .map(toTag);
  }

  listTagsForEmails(emailIds: readonly string[]): Tag[] {
    if (emailIds.length === 0) return [];
    const unique = [...new Set(emailIds)];
    const placeholders = unique.map(() => "?").join(",");
    return this.db
      .prepare(
        `SELECT * FROM tag WHERE email_id IN (${placeholders})
         ORDER BY email_id ASC, created_at ASC, id ASC`,
      )
      .all<TagRow>(...unique)
      .map(toTag);
  }

  /** ANY-semantics filter for the inbox: emails tagged with at least one category. */
  listEmailIdsByCategories(categoryIds: readonly string[]): string[] {
    if (categoryIds.length === 0) return [];
    const unique = [...new Set(categoryIds)];
    const placeholders = unique.map(() => "?").join(",");
    return this.db
      .prepare(`SELECT DISTINCT email_id FROM tag WHERE category_id IN (${placeholders})`)
      .all<{ email_id: string }>(...unique)
      .map((row) => row.email_id);
  }

  /**
   * Idempotent re-tagging (C6): the target set is compared with the stored set,
   * then only the difference is written. Re-running with the same hits produces
   * no writes and no `change_log` rows; a changed rule id updates in place and
   * keeps the tag's original id and `created_at`.
   */
  replaceTagsForEmail(emailId: string, hits: readonly TagHit[]): Tag[] {
    const desired = new Map<string, string | null>();
    for (const hit of hits) {
      if (!desired.has(hit.categoryId)) desired.set(hit.categoryId, hit.ruleId);
    }
    if (desired.size > 0) {
      const ids = [...desired.keys()];
      const placeholders = ids.map(() => "?").join(",");
      const found = new Set(
        this.db
          .prepare(`SELECT id FROM category WHERE id IN (${placeholders})`)
          .all<{ id: string }>(...ids)
          .map((row) => row.id),
      );
      const missing = ids.filter((id) => !found.has(id));
      if (missing.length > 0) {
        throw new StoreError("not_found", `分类不存在：${missing.join(", ")}`);
      }
    }

    const current = this.listTagsForEmail(emailId);
    const currentByCategory = new Map(current.map((tag) => [tag.categoryId, tag]));
    const toDelete = current.filter((tag) => !desired.has(tag.categoryId));
    const toInsert = [...desired.entries()].filter(([categoryId]) => !currentByCategory.has(categoryId));
    const toReassign = [...desired.entries()].flatMap(([categoryId, ruleId]) => {
      const tag = currentByCategory.get(categoryId);
      return tag && tag.ruleId !== ruleId ? [{ tag, ruleId }] : [];
    });

    if (toDelete.length === 0 && toInsert.length === 0 && toReassign.length === 0) return current;

    const now = nowIso();
    this.tx(() => {
      for (const tag of toDelete) {
        this.db.prepare("DELETE FROM tag WHERE id = ?").run(tag.id);
        this.log("tag", tag.id, "delete", { id: tag.id, emailId, categoryId: tag.categoryId });
      }
      for (const [categoryId, ruleId] of toInsert) {
        const id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO tag (id, email_id, category_id, rule_id, created_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run(id, emailId, categoryId, ruleId, now);
        this.log("tag", id, "insert", { id, emailId, categoryId, ruleId });
      }
      for (const { tag, ruleId } of toReassign) {
        this.db.prepare("UPDATE tag SET rule_id = ? WHERE id = ?").run(ruleId, tag.id);
        this.log("tag", tag.id, "update", { id: tag.id, emailId, categoryId: tag.categoryId, ruleId });
      }
    });
    return this.listTagsForEmail(emailId);
  }

  /** Removes every tag of one email, logging each row (`ClassificationTagStore`). */
  removeTagsForEmail(emailId: string): void {
    const current = this.listTagsForEmail(emailId);
    if (current.length === 0) return;
    this.tx(() => {
      this.db.prepare("DELETE FROM tag WHERE email_id = ?").run(emailId);
      for (const tag of current) {
        this.log("tag", tag.id, "delete", {
          id: tag.id,
          emailId,
          categoryId: tag.categoryId,
        });
      }
    });
  }

  /**
   * Adds one tag (the second half of `ClassificationTagStore`). Idempotent per
   * `(email, category)`; `createdAt` from the caller is honoured so a background
   * recompute keeps the classification timestamp it reported.
   */
  addTag(input: TagInput): Tag {
    if (!this.getCategory(input.categoryId)) {
      throw new StoreError("not_found", `分类 ${input.categoryId} 不存在`);
    }
    const existing = this.db
      .prepare("SELECT * FROM tag WHERE email_id = ? AND category_id = ?")
      .get<TagRow>(input.emailId, input.categoryId);
    if (existing) return toTag(existing);

    const id = randomUUID();
    const createdAt = input.createdAt ?? nowIso();
    this.db
      .prepare("INSERT INTO tag (id, email_id, category_id, rule_id, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, input.emailId, input.categoryId, input.ruleId, createdAt);
    this.log("tag", id, "insert", {
      id,
      emailId: input.emailId,
      categoryId: input.categoryId,
      ruleId: input.ruleId,
    });
    const created = this.db.prepare("SELECT * FROM tag WHERE id = ?").get<TagRow>(id);
    if (!created) throw new StoreError("state", "tag write failed");
    return toTag(created);
  }

  /* ------------------------------ server message refs --------------------------- */

  /**
   * Persists the message's authoritative server locator (after a move, or when a
   * sync re-identifies a moved message). Logged as a `raw_email` update so the
   * sync seam replays the new locator too.
   */
  setEmailRef(emailId: string, ref: ProviderRef): boolean {
    const result = this.db
      .prepare("UPDATE raw_email SET provider_ref_json = ? WHERE id = ?")
      .run(serializeEmailRef(ref), emailId);
    if (result.changes === 0) return false;
    this.log("raw_email", emailId, "update", { id: emailId, ref });
    return true;
  }

  /** Records "moved on the server, new locator unknown": the old uid must not be reused. */
  markEmailRefUnresolved(emailId: string): boolean {
    const result = this.db
      .prepare("UPDATE raw_email SET provider_ref_json = ? WHERE id = ?")
      .run(UNRESOLVED_REF_JSON, emailId);
    if (result.changes === 0) return false;
    this.log("raw_email", emailId, "update", { id: emailId, ref: null, unresolved: true });
    return true;
  }

  getEmailRefState(emailId: string): EmailRefState {
    const row = this.db
      .prepare("SELECT provider_ref_json FROM raw_email WHERE id = ?")
      .get<{ provider_ref_json: string | null }>(emailId);
    if (!row) return UNKNOWN_REF;
    return parseEmailRefState(row.provider_ref_json);
  }

  /* -------------------------------- folder cursors ------------------------------ */

  /**
   * Per-folder resume position, stored as one JSON map per account in `meta`.
   *
   * A sync cursor is folder-scoped (IMAP UIDs, Graph delta per folder), so the
   * account-scoped `sync_cursor` row cannot represent a multi-folder sync. It is
   * kept for single-range adapters (POP3 / EWS); folder-capable sync uses this.
   */
  private folderCursorKey(accountId: string): string {
    return `folder_sync_cursor:${accountId}`;
  }

  private readFolderCursors(accountId: string): Record<string, { value: string; updatedAt: string }> {
    const raw = this.getMeta(this.folderCursorKey(accountId));
    if (raw === null) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, { value: string; updatedAt: string }> = {};
    for (const [folderId, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
      const record = entry as Record<string, unknown>;
      if (typeof record["value"] !== "string") continue;
      out[folderId] = {
        value: record["value"],
        updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : "",
      };
    }
    return out;
  }

  getFolderCursor(accountId: string, folderId: string): SyncCursor | null {
    const entry = this.readFolderCursors(accountId)[folderId];
    if (!entry) return null;
    return { accountId, value: entry.value, updatedAt: entry.updatedAt };
  }

  setFolderCursor(accountId: string, folderId: string, value: string): void {
    const cursors = this.readFolderCursors(accountId);
    cursors[folderId] = { value, updatedAt: nowIso() };
    this.setMeta(this.folderCursorKey(accountId), JSON.stringify(cursors));
  }

  /** Drops the folder-cursor map; called when the account itself is deleted. */
  clearFolderCursors(accountId: string): void {
    this.db.prepare("DELETE FROM meta WHERE key = ?").run(this.folderCursorKey(accountId));
  }

  /* ----------------------------------- folders ---------------------------------- */

  listFolders(accountId: string): Folder[] {
    return this.db
      .prepare("SELECT * FROM folder WHERE account_id = ? ORDER BY path ASC")
      .all<FolderRow>(accountId)
      .map(toFolder);
  }

  getFolder(accountId: string, path: string): Folder | null {
    const row = this.db
      .prepare("SELECT * FROM folder WHERE account_id = ? AND path = ?")
      .get<FolderRow>(accountId, path);
    return row ? toFolder(row) : null;
  }

  private applyFolder(folder: Folder): void {
    const now = nowIso();
    const existing = this.getFolder(folder.accountId, folder.path);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO folder (account_id, path, role, unread, updated_at) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(folder.accountId, folder.path, folder.role, folder.unread, now);
      this.log("folder", `${folder.accountId}:${folder.path}`, "insert", folder);
      return;
    }
    if (existing.role === folder.role && existing.unread === folder.unread) return;
    this.db
      .prepare(`UPDATE folder SET role = ?, unread = ?, updated_at = ? WHERE account_id = ? AND path = ?`)
      .run(folder.role, folder.unread, now, folder.accountId, folder.path);
    this.log("folder", `${folder.accountId}:${folder.path}`, "update", folder);
  }

  upsertFolder(folder: Folder): Folder {
    this.tx(() => this.applyFolder(folder));
    return this.getFolder(folder.accountId, folder.path) ?? folder;
  }

  /**
   * Replaces one account's folder set with the server's answer: unknown paths are
   * deleted (logged), known paths are upserted, an unchanged folder writes nothing.
   */
  replaceFolders(accountId: string, folders: readonly Folder[]): Folder[] {
    const desired = new Map(folders.map((folder) => [folder.path, folder]));
    this.tx(() => {
      for (const existing of this.listFolders(accountId)) {
        if (desired.has(existing.path)) continue;
        this.db
          .prepare("DELETE FROM folder WHERE account_id = ? AND path = ?")
          .run(accountId, existing.path);
        this.log("folder", `${accountId}:${existing.path}`, "delete", existing);
      }
      for (const folder of desired.values()) this.applyFolder(folder);
    });
    return this.listFolders(accountId);
  }

  setFolderUnread(accountId: string, path: string, unread: number): boolean {
    const result = this.db
      .prepare("UPDATE folder SET unread = ?, updated_at = ? WHERE account_id = ? AND path = ?")
      .run(Math.max(0, Math.trunc(unread)), nowIso(), accountId, path);
    if (result.changes === 0) return false;
    this.log("folder", `${accountId}:${path}`, "update", { accountId, path, unread });
    return true;
  }

  /* ------------------------------------ drafts ---------------------------------- */

  saveDraft(accountId: string, message: OutgoingMessage, draftId: string | null = null): Draft {
    const now = nowIso();
    const existing = draftId === null ? null : this.getDraftRow(draftId);
    if (existing && existing.account_id !== accountId) {
      throw new StoreError("conflict", `草稿 ${existing.id} 属于另一个账号`);
    }
    const id = existing?.id ?? draftId ?? randomUUID();
    const json = JSON.stringify(message);
    if (existing) {
      this.db
        .prepare("UPDATE draft SET message_json = ?, saved_at = ? WHERE id = ?")
        .run(json, now, id);
      this.log("draft", id, "update", { id, accountId: existing.account_id, savedAt: now });
    } else {
      this.db
        .prepare("INSERT INTO draft (id, account_id, message_json, saved_at) VALUES (?, ?, ?, ?)")
        .run(id, accountId, json, now);
      this.log("draft", id, "insert", { id, accountId, savedAt: now });
    }
    const draft = this.getDraft(id);
    if (!draft) throw new StoreError("state", "draft write failed");
    return draft;
  }

  private getDraftRow(id: string): DraftRow | null {
    const row = this.db.prepare("SELECT * FROM draft WHERE id = ?").get<DraftRow>(id);
    return row ?? null;
  }

  getDraft(id: string): Draft | null {
    const row = this.getDraftRow(id);
    return row ? toDraft(row) : null;
  }

  listDrafts(accountId?: string): Draft[] {
    const rows = accountId
      ? this.db
          .prepare("SELECT * FROM draft WHERE account_id = ? ORDER BY saved_at DESC, id ASC")
          .all<DraftRow>(accountId)
      : this.db.prepare("SELECT * FROM draft ORDER BY saved_at DESC, id ASC").all<DraftRow>();
    return rows.map(toDraft);
  }

  deleteDraft(id: string): boolean {
    const result = this.db.prepare("DELETE FROM draft WHERE id = ?").run(id);
    if (result.changes > 0) this.log("draft", id, "delete", { id });
    return result.changes > 0;
  }

  /* ------------------------------------ outbox ---------------------------------- */

  enqueueOutbox(accountId: string, message: OutgoingMessage): OutboxItem {
    const id = randomUUID();
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO outbox (id, account_id, message_json, status, attempts,
                             next_attempt_at, last_error, created_at, updated_at, sent_at)
         VALUES (?, ?, ?, 'queued', 0, NULL, NULL, ?, ?, NULL)`,
      )
      .run(id, accountId, JSON.stringify(message), now, now);
    const item = this.getOutboxItem(id);
    if (!item) throw new StoreError("state", "outbox write failed");
    // `change_log` is exposed over /api/sync/changes, so its payload carries only
    // the identifier and the state — never the message body, recipients or
    // attachment bytes. A replay that needs the full message reads the `outbox`
    // row by this id (the table keeps the snapshot because sending needs it).
    this.log("outbox", id, "insert", {
      outboxId: item.id,
      status: item.status,
      attempts: item.attempts,
    });
    return item;
  }

  getOutboxItem(id: string): OutboxItem | null {
    const row = this.db.prepare("SELECT * FROM outbox WHERE id = ?").get<OutboxRow>(id);
    return row ? toOutboxItem(row) : null;
  }

  listOutbox(query: OutboxQuery = {}): OutboxItem[] {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (query.accountId) {
      where.push("account_id = ?");
      params.push(query.accountId);
    }
    if (query.status) {
      where.push("status = ?");
      params.push(query.status);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    return this.db
      .prepare(`SELECT * FROM outbox ${clause} ORDER BY created_at ASC, id ASC`)
      .all<OutboxRow>(...params)
      .map(toOutboxItem);
  }

  /**
   * State machine (C5): takes the oldest due `queued`/`failed` row and moves it
   * to `sending`, bumping `attempts`. A due time in the future means the row is
   * still backing off and is skipped.
   */
  claimNextOutbox(now: string = nowIso()): OutboxItem | null {
    return this.tx(() => {
      const row = this.db
        .prepare(
          `SELECT * FROM outbox
            WHERE status IN ('queued', 'failed')
              AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
            ORDER BY created_at ASC, id ASC
            LIMIT 1`,
        )
        .get<OutboxRow>(now);
      if (!row) return null;
      const attempts = Number(row.attempts) + 1;
      this.db
        .prepare("UPDATE outbox SET status = 'sending', attempts = ?, updated_at = ? WHERE id = ?")
        .run(attempts, now, row.id);
      const item = this.getOutboxItem(row.id);
      if (!item) throw new StoreError("state", `outbox ${row.id} vanished while claiming`);
      this.log("outbox", item.id, "update", { id: item.id, status: item.status, attempts });
      return item;
    });
  }

  markOutboxSent(id: string, now: string = nowIso()): OutboxItem | null {
    const existing = this.getOutboxItem(id);
    if (!existing) return null;
    this.db
      .prepare(
        `UPDATE outbox
            SET status = 'sent', sent_at = ?, next_attempt_at = NULL, last_error = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(now, now, id);
    const item = this.getOutboxItem(id);
    if (!item) return null;
    this.log("outbox", id, "update", { id, status: item.status });
    return item;
  }

  /**
   * Records a delivery failure. `nextAttemptAt` is at least
   * {@link OUTBOX_MIN_BACKOFF_MS} away (AC-12) and doubles per attempt up to
   * {@link OUTBOX_MAX_BACKOFF_MS}; a caller may pass an explicit delay.
   */
  markOutboxFailed(id: string, error: string, retryAfterMs?: number): OutboxItem | null {
    const existing = this.getOutboxItem(id);
    if (!existing) return null;
    const now = nowIso();
    const delay = Math.max(
      OUTBOX_MIN_BACKOFF_MS,
      retryAfterMs ?? outboxBackoffMs(Math.max(1, existing.attempts)),
    );
    const nextAttemptAt = new Date(Date.parse(now) + delay).toISOString();
    const lastError = error.slice(0, 500);
    this.db
      .prepare(
        `UPDATE outbox SET status = 'failed', last_error = ?, next_attempt_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(lastError, nextAttemptAt, now, id);
    const item = this.getOutboxItem(id);
    if (!item) return null;
    this.log("outbox", id, "update", {
      id,
      status: item.status,
      attempts: item.attempts,
      nextAttemptAt: item.nextAttemptAt,
    });
    return item;
  }

  /** Manual retry: any non-`sending` row goes back to `queued` and is due now. */
  retryOutbox(id: string, now: string = nowIso()): OutboxItem | null {
    const existing = this.getOutboxItem(id);
    if (!existing || existing.status === "sending") return null;
    this.db
      .prepare(
        `UPDATE outbox SET status = 'queued', next_attempt_at = NULL, last_error = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(now, id);
    const item = this.getOutboxItem(id);
    if (!item) return null;
    this.log("outbox", id, "update", { id, status: item.status, attempts: item.attempts });
    return item;
  }

  deleteOutbox(id: string): boolean {
    const result = this.db.prepare("DELETE FROM outbox WHERE id = ?").run(id);
    if (result.changes > 0) this.log("outbox", id, "delete", { id });
    return result.changes > 0;
  }

  /** Boot recovery: a `sending` row left behind by a crash goes back to `queued`. */
  recoverOutbox(now: string = nowIso()): number {
    const rows = this.db
      .prepare("SELECT * FROM outbox WHERE status = 'sending'")
      .all<OutboxRow>();
    if (rows.length === 0) return 0;
    this.tx(() => {
      for (const row of rows) {
        this.db
          .prepare("UPDATE outbox SET status = 'queued', updated_at = ? WHERE id = ?")
          .run(now, row.id);
        this.log("outbox", row.id, "update", { id: row.id, status: "queued", recovered: true });
      }
    });
    return rows.length;
  }

  /* ---------------------------------- init state -------------------------------- */

  getInitState(): InitState {
    const row = this.db.prepare("SELECT * FROM init_state WHERE id = 1").get<InitStateRow>();
    return toInitState(row);
  }

  /**
   * Partial update, as `PUT /api/onboarding` describes. The first time the wizard
   * is finished or skipped the seed rules are created; see {@link ensureSeedRules}.
   */
  setInitState(patch: UpdateOnboardingInput): InitState {
    const existing = this.db.prepare("SELECT * FROM init_state WHERE id = 1").get<InitStateRow>();
    const current = toInitState(existing);
    const completed = patch.completed ?? current.completed;
    const skipped = patch.skipped ?? current.skipped;
    this.tx(() => {
      this.db
        .prepare(
          `INSERT INTO init_state (id, completed, skipped, updated_at) VALUES (1, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             completed = excluded.completed,
             skipped = excluded.skipped,
             updated_at = excluded.updated_at`,
        )
        .run(bit(completed), bit(skipped), nowIso());
      this.log("init_state", "1", existing ? "update" : "insert", { completed, skipped });
    });
    if (completed || skipped) this.ensureSeedRules();
    return this.getInitState();
  }

  /** v1 installs have been in use already: no wizard, seeds still created once. */
  markUpgradedFromV1(): void {
    const existing = this.db.prepare("SELECT * FROM init_state WHERE id = 1").get<InitStateRow>();
    if (!existing) {
      this.tx(() => {
        this.db
          .prepare("INSERT INTO init_state (id, completed, skipped, updated_at) VALUES (1, 1, 0, ?)")
          .run(nowIso());
        this.log("init_state", "1", "insert", {
          completed: true,
          skipped: false,
          migratedFromV1: true,
        });
      });
    }
    this.ensureSeedRules();
  }

  /* ----------------------------------- seeding ---------------------------------- */

  private seedIdentityFromProfile(): SeedIdentity | null {
    const row = this.db
      .prepare("SELECT display_name, aliases_json, emails_json FROM user_profile LIMIT 1")
      .get<{ display_name: string; aliases_json: string; emails_json: string }>();
    if (!row) return null;
    const aliases = parseArray(row.aliases_json);
    const emails = parseArray(row.emails_json);
    const names = [row.display_name, ...aliases].filter((name) => name.trim() !== "");
    return { names, emails };
  }

  /** sha256 of the canonical tree serialisation (seed-edit detection). */
  private treeHash(tree: RuleTree): string {
    const serialized = serializeRuleTree(tree);
    const json = serialized.ok ? serialized.json : JSON.stringify(tree);
    return createHash("sha256").update(json).digest("hex");
  }

  private insertSeedRule(seed: SeedRule, now: string): Rule | null {
    const categoryResult = this.db
      .prepare(
        `INSERT OR IGNORE INTO category (id, name, enter_todo, broadcast, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        seed.category.id,
        seed.category.name,
        bit(seed.category.enterTodo),
        bit(seed.category.broadcast),
        now,
        now,
      );
    if (categoryResult.changes > 0) {
      const category = this.getCategory(seed.category.id);
      if (category) this.log("category", category.id, "insert", category);
    }
    const ruleResult = this.db
      .prepare(
        `INSERT OR IGNORE INTO rule (id, name, category_id, tree_json, enabled, order_index,
                                      created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        seed.id,
        seed.name,
        seed.category.id,
        JSON.stringify(seed.tree),
        bit(seed.enabled),
        seed.order,
        now,
        now,
      );
    if (ruleResult.changes === 0) return null;
    const rule = this.getRule(seed.id);
    if (rule) this.log("rule", rule.id, "insert", rule);
    return rule;
  }

  /**
   * Creates the seed rules — at most once, ever.
   *
   * Two guarantees:
   * - `rules_seeded` marker: later calls are no-ops, so a rule the user DELETED is
   *   never replayed (and `INSERT OR IGNORE` on the stable ids only protects an
   *   interrupted seed pass, it is not the "once" guarantee);
   * - 「点名给我」 is only persisted when the profile has matchable identity terms
   *   (`shared` refuses an inert personal rule); otherwise it is created later by
   *   {@link reconcileSeedPersonalRule} once the wizard saves the profile.
   *
   * Returns the rules created by THIS call.
   */
  ensureSeedRules(identity?: SeedIdentity | null): Rule[] {
    if (this.getMeta("rules_seeded") !== null) return [];
    const resolved = identity ?? this.seedIdentityFromProfile();
    const seeds = buildSeedRules(resolved ?? { names: [], emails: [] });
    const created: Rule[] = [];
    this.tx(() => {
      const now = nowIso();
      for (const seed of seeds) {
        const rule = this.insertSeedRule(seed, now);
        if (!rule) continue;
        created.push(rule);
        if (rule.id === SEED_RULE_PERSONAL_ID) {
          this.setMeta("seed_personal_hash", this.treeHash(rule.tree));
        }
      }
      this.setMeta("rules_seeded", "1");
      this.setMeta("rules_seeded_at", now);
    });
    return created;
  }

  /**
   * Idempotent re-expansion of 「点名给我」, evaluated whenever the profile is
   * saved (`shared.planSeedPersonalReconcile` owns the decision):
   * - no usable identity words -> nothing;
   * - the user deleted it (tombstone) -> never recreated;
   * - the user edited it (tree hash differs from what we wrote) -> untouched;
   * - missing -> created; unchanged -> nothing; identity changed -> overwritten.
   */
  reconcileSeedPersonalRule(identity?: SeedIdentity | null): void {
    if (this.getMeta("rules_seeded") === null) return;
    const resolved = identity ?? this.seedIdentityFromProfile();
    const rule = this.getRule(SEED_RULE_PERSONAL_ID);
    const storedHash = this.getMeta("seed_personal_hash");
    const deleted = this.getMeta("seed_personal_deleted") !== null;
    // A row we cannot prove we wrote (missing hash) is treated as user-authored:
    // never overwrite what the user may have edited by hand.
    const edited = rule !== null && (storedHash === null || this.treeHash(rule.tree) !== storedHash);
    const plan = planSeedPersonalReconcile(resolved, {
      tree: rule?.tree ?? null,
      edited,
      deleted,
    });
    if (plan.kind === "skip") return;

    const now = nowIso();
    this.tx(() => {
      if (plan.kind === "create") {
        this.insertSeedRule(plan.rule, now);
      } else {
        this.db
          .prepare("UPDATE rule SET tree_json = ?, updated_at = ? WHERE id = ?")
          .run(JSON.stringify(plan.rule.tree), now, plan.rule.id);
        const updated = this.getRule(plan.rule.id);
        if (updated) this.log("rule", updated.id, "update", updated);
      }
      this.setMeta("seed_personal_hash", this.treeHash(plan.rule.tree));
    });
  }

  /* ------------------------------ account send config --------------------------- */

  setAccountSendConfig(accountId: string, send: AccountSendInput): Account | null {
    const row = this.db.prepare("SELECT * FROM account WHERE id = ?").get<AccountRow>(accountId);
    if (!row) return null;
    const config = applySendInput(toAccount(row).config, send);
    const password = send.smtpPassword;
    const cipher =
      password === undefined
        ? row.smtp_secret_cipher
        : password === ""
          ? null
          : encryptSecret(this.key, password);
    return this.writeAccountConfig(accountId, config, cipher);
  }

  /** Rotates label / enabled / config / passwords (`PATCH /api/accounts/:id`). */
  updateAccount(id: string, input: UpdateAccountInput): Account | null {
    const row = this.db.prepare("SELECT * FROM account WHERE id = ?").get<AccountRow>(id);
    if (!row) return null;
    const account = toAccount(row);
    const config = input.send
      ? applySendInput(input.config ?? account.config, input.send)
      : (input.config ?? account.config);
    const secretCipher =
      input.secret === undefined
        ? row.secret_cipher
        : input.secret.length === 0
          ? null
          : encryptSecret(this.key, input.secret);
    const smtpPassword = input.send?.smtpPassword;
    const smtpCipher =
      smtpPassword === undefined
        ? row.smtp_secret_cipher
        : smtpPassword.length === 0
          ? null
          : encryptSecret(this.key, smtpPassword);

    this.db
      .prepare(
        `UPDATE account
            SET label = ?, enabled = ?, config_json = ?, secret_cipher = ?, smtp_secret_cipher = ?
          WHERE id = ?`,
      )
      .run(
        input.label ?? row.label,
        bit(input.enabled ?? (row.enabled === 1)),
        JSON.stringify(config),
        secretCipher,
        smtpCipher,
        id,
      );
    const updated = this.db.prepare("SELECT * FROM account WHERE id = ?").get<AccountRow>(id);
    if (!updated) return null;
    const mapped = toAccount(updated);
    this.log("account", id, "update", publicAccount(mapped));
    return mapped;
  }

  private writeAccountConfig(
    accountId: string,
    config: Record<string, string>,
    smtpCipher: string | null,
  ): Account | null {
    this.db
      .prepare("UPDATE account SET config_json = ?, smtp_secret_cipher = ? WHERE id = ?")
      .run(JSON.stringify(config), smtpCipher, accountId);
    const row = this.db.prepare("SELECT * FROM account WHERE id = ?").get<AccountRow>(accountId);
    if (!row) return null;
    const mapped = toAccount(row);
    this.log("account", accountId, "update", publicAccount(mapped));
    return mapped;
  }

  /** Account plus its DECRYPTED SMTP/EWS password. Only the send worker may call this. */
  getAccountWithSmtpSecret(id: string): { account: Account; smtpPassword: string } | null {
    const row = this.db.prepare("SELECT * FROM account WHERE id = ?").get<AccountRow>(id);
    if (!row) return null;
    return {
      account: toAccount(row),
      smtpPassword: row.smtp_secret_cipher ? decryptSecret(this.key, row.smtp_secret_cipher) : "",
    };
  }

  /* --------------------------- per-message state (v1.1) ------------------------ */

  getEmailState(id: string): { folder: string; isRead: boolean } | null {
    const row = this.db
      .prepare("SELECT id, folder, is_read FROM raw_email WHERE id = ?")
      .get<EmailStateRow>(id);
    return row ? { folder: row.folder, isRead: row.is_read === 1 } : null;
  }

  markEmailRead(id: string, isRead: boolean): boolean {
    const result = this.db
      .prepare("UPDATE raw_email SET is_read = ? WHERE id = ?")
      .run(bit(isRead), id);
    if (result.changes === 0) return false;
    this.log("raw_email", id, "update", { id, isRead });
    return true;
  }

  moveEmail(id: string, folder: string): boolean {
    const target = folder.trim();
    if (target === "") throw new StoreError("invalid", "目标文件夹不能为空");
    const result = this.db
      .prepare("UPDATE raw_email SET folder = ? WHERE id = ?")
      .run(target, id);
    if (result.changes === 0) return false;
    this.log("raw_email", id, "update", { id, folder: target });
    return true;
  }

  deleteEmail(id: string): boolean {
    const result = this.db.prepare("DELETE FROM raw_email WHERE id = ?").run(id);
    if (result.changes > 0) this.log("raw_email", id, "delete", { id });
    return result.changes > 0;
  }

  /**
   * Folder-scoped, searchable page of stored mail for `GET /api/messages`.
   * Cursor order matches `listEmails` (`sent_at DESC, id DESC`), so a message
   * never appears twice or disappears between pages.
   */
  listEmailsInFolder(query: EmailFolderQuery): EmailFolderPage {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
    const where: string[] = ["folder = ?"];
    const params: SqlValue[] = [query.folder];
    if (query.accountId) {
      where.push("account_id = ?");
      params.push(query.accountId);
    }
    if (query.unreadOnly) where.push("is_read = 0");
    if (query.search) {
      // Wildcards in the user's input are literals, not LIKE operators.
      where.push(
        `(subject LIKE ? ${LIKE_ESCAPE} OR from_email LIKE ? ${LIKE_ESCAPE} OR body_text LIKE ? ${LIKE_ESCAPE})`,
      );
      const like = containsLike(query.search);
      params.push(like, like, like);
    }
    if (query.categoryIds && query.categoryIds.length > 0) {
      const unique = [...new Set(query.categoryIds)];
      const placeholders = unique.map(() => "?").join(",");
      where.push(`id IN (SELECT email_id FROM tag WHERE category_id IN (${placeholders}))`);
      params.push(...unique);
    }
    if (query.cursor) {
      const cursor = decodeCursor(query.cursor);
      if (cursor) {
        where.push("(sent_at < ? OR (sent_at = ? AND id < ?))");
        params.push(cursor.sentAt, cursor.sentAt, cursor.id);
      }
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM raw_email WHERE ${where.join(" AND ")}
         ORDER BY sent_at DESC, id DESC LIMIT ?`,
      )
      .all<EmailRow & { folder: string; is_read: number }>(...params, limit + 1);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map((row) => ({
        email: toEmail(row),
        folder: row.folder,
        isRead: row.is_read === 1,
      })),
      nextCursor: rows.length > limit && last ? encodeCursor(last.sent_at, last.id) : null,
    };
  }
}
