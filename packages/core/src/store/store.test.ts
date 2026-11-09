import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CreateRuleInput, OutgoingMessage, RawEmail, RuleTree, Task } from "@mailcollect/shared";
import {
  SEED_CATEGORY_PERSONAL_ID,
  SEED_RULE_BROADCAST_ID,
  SEED_RULE_PERSONAL_ID,
  UNCATEGORIZED_NAME,
} from "@mailcollect/shared";
import { evaluateRuleTree, projectRuleEmail } from "../rules/index.js";
import { applySendInput } from "./repos.js";
import { OUTBOX_MIN_BACKOFF_MS, StoreError } from "./index.js";
import { openDatabase, openStore, type Store } from "./index.js";

let dir: string;
let store: Store;
let accountId: string;

const email = (over: Partial<RawEmail> = {}): RawEmail => ({
  id: over.id ?? "e1",
  accountId: over.accountId ?? accountId,
  uid: over.uid ?? "1",
  messageId: "<a@b>",
  threadId: "t1",
  fromName: "李雷",
  fromEmail: "lilei@corp.com",
  to: ["me@corp.com"],
  cc: [],
  subject: over.subject ?? "请张三周五前提交报告",
  sentAt: "2026-11-02T09:00:00.000Z",
  bodyText: "张三，请你在周五下班前把季度报告发我。",
  hasAttachments: false,
  headers: { "list-id": "none" },
  createdAt: "2026-11-02T09:00:01.000Z",
});

const task = (over: Partial<Task> = {}): Task => ({
  id: over.id ?? "t1",
  userId: "u1",
  title: over.title ?? "提交季度报告",
  detail: null,
  owner: "me",
  ownerName: "张三",
  kind: "deadline",
  status: "candidate",
  origin: "personal",
  confidence: 0.9,
  evidenceQuote: "请你在周五下班前把季度报告发我",
  sourceEmailId: "e1",
  threadId: "t1",
  time: {
    phrase: "周五下班前",
    dueAt: "2026-11-06T09:00:00.000Z",
    windowStart: null,
    windowEnd: null,
    timezone: "Asia/Shanghai",
    confidence: 0.8,
  },
  createdAt: "2026-11-02T09:00:02.000Z",
  updatedAt: "2026-11-02T09:00:02.000Z",
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mailcollect-test-"));
  store = await openStore(join(dir, "db.sqlite"), "device-a");
  accountId = store.createAccount({
    provider: "imap",
    label: "测试邮箱",
    email: "me@corp.com",
    config: { host: "imap.corp.com" },
    secret: "pw",
  }).id;
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("store", () => {
  it("uses the built-in sqlite driver (no native module)", () => {
    expect(store.driver).toBe("node:sqlite");
  });

  it("accepts an account with no secret (Graph device-code accounts paste nothing)", () => {
    const account = store.createAccount({
      provider: "graph",
      label: "Outlook",
      email: "me@outlook.com",
      config: { clientId: "abc", tenant: "common" },
      secret: "",
    });
    // Reading it back must not throw — an empty ciphertext used to break every
    // account listing with "unsupported secret payload".
    const loaded = store.getAccountWithSecret(account.id);
    expect(loaded?.secret).toBe("");
    expect(store.listAccounts()).toHaveLength(2);
  });

  it("round-trips the user profile", () => {
    const created = store.upsertProfile({
      displayName: "张三",
      aliases: ["张 三", "San Zhang"],
      emails: ["me@corp.com"],
      timezone: "Asia/Shanghai",
    });
    expect(created.displayName).toBe("张三");
    expect(store.getProfile()?.aliases).toEqual(["张 三", "San Zhang"]);

    const updated = store.upsertProfile({
      displayName: "张三",
      aliases: ["San Zhang"],
      emails: ["me@corp.com", "z3@corp.com"],
      timezone: "Asia/Shanghai",
    });
    expect(updated.id).toBe(created.id);
    expect(store.getProfile()?.emails).toHaveLength(2);
  });

  it("encrypts the mailbox secret and never stores it in clear", () => {
    const account = store.createAccount({
      provider: "imap",
      label: "公司邮箱",
      email: "me@corp.com",
      config: { host: "imap.corp.com", port: "993" },
      secret: "super-secret-app-password",
    });
    const loaded = store.getAccountWithSecret(account.id);
    expect(loaded?.secret).toBe("super-secret-app-password");
    expect(JSON.stringify(loaded?.account)).not.toContain("super-secret-app-password");
  });

  it("deduplicates emails by (account, uid) across repeated syncs", () => {
    const first = store.upsertEmails([email()]);
    const second = store.upsertEmails([email()]);
    expect(first.inserted).toBe(1);
    expect(second.inserted).toBe(0);
    expect(store.listEmails({}).items).toHaveLength(1);
  });

  it("keeps mailboxes isolated: same uid in two accounts is two emails", () => {
    const other = store.createAccount({
      provider: "imap",
      label: "B",
      email: "b@corp.com",
      config: {},
      secret: "x",
    });
    store.upsertEmails([email({ id: "e1", uid: "42" })]);
    store.upsertEmails([email({ id: "e2", uid: "42", accountId: other.id })]);
    expect(store.listEmails({}).items).toHaveLength(2);
  });

  it("paginates emails newest-first with a stable cursor", () => {
    store.upsertEmails(
      Array.from({ length: 5 }, (_, i) =>
        email({ id: `e${i}`, uid: String(i), subject: `s${i}` }),
      ),
    );
    const page1 = store.listEmails({ limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = store.listEmails({ limit: 2, cursor: page1.nextCursor! });
    expect(page2.items).toHaveLength(2);
    const ids = new Set([...page1.items, ...page2.items].map((item) => item.id));
    expect(ids.size).toBe(4);
  });

  it("is idempotent on re-extraction because of UNIQUE(source_email_id, title)", () => {
    store.upsertEmails([email()]);
    const first = store.insertTasks([task()]);
    const second = store.insertTasks([task()]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(store.taskCounts()).toEqual({ candidate: 1, confirmed: 0, dismissed: 0, done: 0 });
  });

  it("moves tasks through the confirm/dismiss states", () => {
    store.upsertEmails([email()]);
    store.insertTasks([task({ id: "t1" }), task({ id: "t2", title: "整理会议纪要" })]);
    store.setTasksStatus(["t1"], "confirmed");
    expect(store.taskCounts().confirmed).toBe(1);

    const updated = store.updateTask("t2", { status: "dismissed" });
    expect(updated?.status).toBe("dismissed");
    expect(store.listTasks({ status: "candidate" })).toHaveLength(0);
  });

  it("records an ordered change log for every write (the sync seam)", () => {
    store.upsertProfile({
      displayName: "张三",
      aliases: [],
      emails: ["me@corp.com"],
      timezone: "Asia/Shanghai",
    });
    store.createAccount({
      provider: "imap",
      label: "A",
      email: "a@corp.com",
      config: {},
      secret: "x",
    });
    store.upsertEmails([email()]);

    const head = store.head();
    expect(head).toBeGreaterThan(0);

    const all = store.changes(0);
    expect(all.length).toBeGreaterThanOrEqual(3);
    expect(all.map((row) => row.seq)).toEqual([...all.map((row) => row.seq)].sort((a, b) => a - b));

    const tail = store.changes(head - 1);
    expect(tail).toHaveLength(1);
    expect(tail[0]?.entity).toBe("raw_email");

    // The sync seam must speak the frozen camelCase contract, not DB column names.
    const first = all[0];
    expect(first?.deviceId).toBe("device-a");
    expect(first?.entityId).toBeTruthy();
    expect(Object.keys(first ?? {})).not.toContain("entity_id");
    expect(Object.keys(first ?? {})).not.toContain("device_id");
  });

  it("stores LLM configs with an encrypted key and one default", () => {
    const first = store.upsertLlmConfig({
      label: "DeepSeek",
      protocol: "openai-compatible",
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-chat",
      apiKey: "sk-test-123",
    });
    expect(first.isDefault).toBe(true);
    expect(first.hasKey).toBe(true);

    const second = store.upsertLlmConfig({
      label: "Ollama",
      protocol: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
      model: "qwen3:8b",
    });
    expect(second.isDefault).toBe(false);

    expect(store.getLlmWithKey()?.config.label).toBe("DeepSeek");
    expect(store.getLlmWithKey()?.apiKey).toBe("sk-test-123");
    expect(JSON.stringify(store.listLlmConfigs())).not.toContain("sk-test-123");

    store.setDefaultLlmConfig(second.id);
    expect(store.getLlmWithKey()?.config.label).toBe("Ollama");
  });

  it("queues only unextracted emails and stops re-queuing after a mark", () => {
    store.upsertEmails([email({ id: "e1", uid: "1" }), email({ id: "e2", uid: "2" })]);
    expect(store.emailsPendingExtraction()).toHaveLength(2);
    store.markExtracted("e1", null);
    expect(store.emailsPendingExtraction().map((item) => item.id)).toEqual(["e2"]);
  });

  it("remembers an always-ignore decision for a mailing list", () => {
    store.setBroadcastDecision("list.corp.com", "always_ignore");
    expect(store.getBroadcastDecision("list.corp.com")).toBe("always_ignore");
    expect(store.getBroadcastDecision("other.list")).toBeNull();
  });
});

/* ------------------------------------------------------------------------- */
/* v1.1 — migration, seeds, tags, outbox, drafts, folders, per-message state  */
/* ------------------------------------------------------------------------- */

const message = (over: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  mode: over.mode ?? "new",
  to: over.to ?? ["lilei@corp.com"],
  cc: over.cc ?? [],
  bcc: over.bcc ?? [],
  subject: over.subject ?? "报告",
  bodyText: over.bodyText ?? "附件是报告。",
  bodyHtml: over.bodyHtml ?? null,
  attachments: over.attachments ?? [],
  includeSignature: over.includeSignature ?? true,
  replyToEmailId: over.replyToEmailId ?? null,
});

const entitiesSince = (store: Store, from: number): string[] =>
  store.changes(from, 1000).map((row) => row.entity);

describe("rules and categories", () => {
  it("creates the broadcast seed on a fresh database and the personal one once a profile exists", () => {
    // A fresh store has no profile yet: only 「群发/通知」 is persisted, because an
    // inert 「点名给我」 would match nothing (shared refuses to build it).
    expect(store.listRules().map((rule) => rule.id)).toEqual([SEED_RULE_BROADCAST_ID]);

    store.upsertProfile({
      displayName: "张三",
      aliases: ["San Zhang"],
      emails: ["me@corp.com"],
      timezone: "Asia/Shanghai",
    });

    const rules = store.listRules();
    expect(rules.map((rule) => rule.id).sort()).toEqual(
      [SEED_RULE_PERSONAL_ID, SEED_RULE_BROADCAST_ID].sort(),
    );
    const personal = rules.find((rule) => rule.id === SEED_RULE_PERSONAL_ID);
    expect(personal?.name).toBe("点名给我");
    expect(JSON.stringify(personal?.tree)).toContain("张三");
    expect(personal?.categoryId).toBe(SEED_CATEGORY_PERSONAL_ID);
  });

  it("seeds once: a deleted seed rule is never replayed", () => {
    store.upsertProfile({
      displayName: "张三",
      aliases: [],
      emails: ["me@corp.com"],
      timezone: "Asia/Shanghai",
    });
    expect(store.listRules()).toHaveLength(2);

    expect(store.deleteRule(SEED_RULE_PERSONAL_ID)).toBe(true);
    expect(store.listRules()).toHaveLength(1);

    // Reopening (migrate) and re-saving the profile must not resurrect it.
    store.migrate();
    store.upsertProfile({
      displayName: "张三",
      aliases: ["San Zhang"],
      emails: ["me@corp.com"],
      timezone: "Asia/Shanghai",
    });
    expect(store.listRules().map((rule) => rule.id)).toEqual([SEED_RULE_BROADCAST_ID]);
  });

  it("keeps a user-edited personal rule untouched when the profile changes", () => {
    store.upsertProfile({
      displayName: "张三",
      aliases: [],
      emails: ["me@corp.com"],
      timezone: "Asia/Shanghai",
    });
    const edited: CreateRuleInput["tree"] = {
      kind: "field",
      field: "subject",
      op: "contains",
      value: "urgent",
    };
    store.updateRule(SEED_RULE_PERSONAL_ID, { tree: edited });
    store.upsertProfile({
      displayName: "李四",
      aliases: [],
      emails: ["me@corp.com"],
      timezone: "Asia/Shanghai",
    });
    expect(JSON.stringify(store.getRule(SEED_RULE_PERSONAL_ID)?.tree)).toContain("urgent");
  });

  it("CRUDs categories with a unique name and refuses 「未分类」", () => {
    const work = store.createCategory({ name: "工作", enterTodo: true, broadcast: false });
    expect(work.enterTodo).toBe(true);
    expect(() => store.createCategory({ name: "工作", enterTodo: false, broadcast: false })).toThrow(
      /已存在/,
    );
    expect(() =>
      store.createCategory({ name: UNCATEGORIZED_NAME, enterTodo: true, broadcast: false }),
    ).toThrow(StoreError);

    const renamed = store.updateCategory(work.id, { name: "工作邮件", broadcast: true });
    expect(renamed?.name).toBe("工作邮件");
    expect(renamed?.broadcast).toBe(true);

    const other = store.createCategory({ name: "通知", enterTodo: false, broadcast: false });
    expect(() => store.updateCategory(other.id, { name: "工作邮件" })).toThrow(StoreError);
    expect(store.getCategory("missing")).toBeNull();
    expect(store.updateCategory("missing", { name: "x" })).toBeNull();
    expect(store.deleteCategory("missing")).toBe(false);
  });

  it("deletes a category together with its rules and tags, logging every cascaded row", () => {
    const work = store.createCategory({ name: "工作", enterTodo: true, broadcast: false });
    const rule = store.createRule({
      name: "主题含报告",
      categoryId: work.id,
      tree: { kind: "field", field: "subject", op: "contains", value: "报告" },
    });
    store.upsertEmails([email()]);
    store.replaceTagsForEmail("e1", [{ categoryId: work.id, ruleId: rule.id }]);
    const head = store.head();

    expect(store.deleteCategory(work.id)).toBe(true);
    expect(store.getRule(rule.id)).toBeNull();
    expect(store.listTagsForEmail("e1")).toEqual([]);
    const entities = entitiesSince(store, head);
    expect(entities.filter((entity) => entity === "category")).toHaveLength(1);
    expect(entities.filter((entity) => entity === "rule")).toHaveLength(1);
    expect(entities.filter((entity) => entity === "tag")).toHaveLength(1);
  });

  it("validates the rule tree on write and refuses a missing category", () => {
    const work = store.createCategory({ name: "工作", enterTodo: true, broadcast: false });
    expect(() =>
      store.createRule({
        name: "坏树",
        categoryId: work.id,
        tree: { kind: "and", children: [] },
      }),
    ).toThrow(StoreError);
    expect(() =>
      store.createRule({
        name: "孤儿规则",
        categoryId: "nope",
        tree: { kind: "field", field: "subject", op: "exists" },
      }),
    ).toThrow(/不存在/);
    const created = store.createRule({
      name: "ok",
      categoryId: work.id,
      tree: { kind: "field", field: "subject", op: "exists" },
    });
    expect(() => store.updateRule(created.id, { tree: { kind: "or", children: [] } })).toThrow(
      StoreError,
    );
  });

  it("reorders rules by id and refuses unknown ids", () => {
    const work = store.createCategory({ name: "工作", enterTodo: true, broadcast: false });
    const tree: CreateRuleInput["tree"] = { kind: "field", field: "subject", op: "exists" };
    const a = store.createRule({ name: "a", categoryId: work.id, tree });
    const b = store.createRule({ name: "b", categoryId: work.id, tree });
    const c = store.createRule({ name: "c", categoryId: work.id, tree });

    store.reorderRules([c.id, a.id, b.id]);
    expect(store.getRule(c.id)?.order).toBe(0);
    expect(store.getRule(a.id)?.order).toBe(1);
    expect(store.getRule(b.id)?.order).toBe(2);
    expect(() => store.reorderRules([c.id, "missing"])).toThrow(StoreError);

    expect(store.deleteRule(a.id)).toBe(true);
    expect(store.getRule(a.id)).toBeNull();
  });
});

describe("tags", () => {
  it("replaces tags idempotently and writes nothing when the target set is unchanged", () => {
    const work = store.createCategory({ name: "工作", enterTodo: true, broadcast: false });
    const notice = store.createCategory({ name: "通知", enterTodo: false, broadcast: true });
    store.upsertEmails([email()]);

    const first = store.replaceTagsForEmail("e1", [{ categoryId: work.id, ruleId: "r1" }]);
    expect(first).toHaveLength(1);
    const head = store.head();
    const again = store.replaceTagsForEmail("e1", [{ categoryId: work.id, ruleId: "r1" }]);
    expect(again.map((tag) => tag.id)).toEqual(first.map((tag) => tag.id));
    expect(store.head()).toBe(head);

    const both = store.replaceTagsForEmail("e1", [
      { categoryId: work.id, ruleId: "r1" },
      { categoryId: notice.id, ruleId: null },
    ]);
    expect(both).toHaveLength(2);

    const onlyNotice = store.replaceTagsForEmail("e1", [{ categoryId: notice.id, ruleId: "r2" }]);
    expect(onlyNotice).toHaveLength(1);
    expect(onlyNotice[0]?.categoryId).toBe(notice.id);
    expect(onlyNotice[0]?.ruleId).toBe("r2");
    expect(onlyNotice[0]?.id).toBe(both.find((tag) => tag.categoryId === notice.id)?.id);

    const cleared = store.replaceTagsForEmail("e1", []);
    expect(cleared).toEqual([]);
    expect(() => store.replaceTagsForEmail("e1", [{ categoryId: "nope", ruleId: null }])).toThrow(
      StoreError,
    );
  });

  it("supports the rules engine's add-then-remove tag seam idempotently", () => {
    const work = store.createCategory({ name: "工作", enterTodo: true, broadcast: false });
    store.upsertEmails([email()]);
    const tag = store.addTag({
      emailId: "e1",
      categoryId: work.id,
      ruleId: "r1",
      createdAt: "2026-11-09T00:00:00.000Z",
    });
    expect(tag.createdAt).toBe("2026-11-09T00:00:00.000Z");
    expect(store.addTag({ emailId: "e1", categoryId: work.id, ruleId: "r1" }).id).toBe(tag.id);
    expect(store.listTagsForEmail("e1")).toHaveLength(1);
    expect(() => store.addTag({ emailId: "e1", categoryId: "nope", ruleId: null })).toThrow(
      StoreError,
    );

    const head = store.head();
    store.removeTagsForEmail("e1");
    expect(store.listTagsForEmail("e1")).toEqual([]);
    expect(entitiesSince(store, head)).toEqual(["tag"]);
    store.removeTagsForEmail("e1"); // nothing left -> no write, no change_log row
    expect(store.head()).toBe(head + 1);
  });

  it("lists tags for many emails and filters email ids by category (ANY semantics)", () => {
    const work = store.createCategory({ name: "工作", enterTodo: true, broadcast: false });
    const other = store.createCategory({ name: "其他", enterTodo: false, broadcast: false });
    store.upsertEmails([email({ id: "e1", uid: "1" }), email({ id: "e2", uid: "2" }), email({ id: "e3", uid: "3" })]);
    store.replaceTagsForEmail("e1", [{ categoryId: work.id, ruleId: null }]);
    store.replaceTagsForEmail("e2", [{ categoryId: other.id, ruleId: null }]);

    expect(store.listTagsForEmails(["e1", "e2"]).map((tag) => tag.emailId).sort()).toEqual(["e1", "e2"]);
    expect(store.listTagsForEmails([])).toEqual([]);
    expect(store.listEmailIdsByCategories([work.id]).sort()).toEqual(["e1"]);
    expect(store.listEmailIdsByCategories([work.id, other.id]).sort()).toEqual(["e1", "e2"]);
    expect(store.listEmailIdsByCategories([])).toEqual([]);
  });
});

describe("outbox state machine", () => {
  it("moves queued -> sending -> failed (backoff) -> sending -> sent", () => {
    const item = store.enqueueOutbox(accountId, message());
    expect(item.status).toBe("queued");
    expect(item.attempts).toBe(0);

    const sending = store.claimNextOutbox();
    expect(sending?.id).toBe(item.id);
    expect(sending?.status).toBe("sending");
    expect(sending?.attempts).toBe(1);
    // Nothing else is due: one row, already in flight.
    expect(store.claimNextOutbox()).toBeNull();

    const failedAt = Date.now();
    const failed = store.markOutboxFailed(item.id, "SMTP 550 rejected");
    expect(failed?.status).toBe("failed");
    expect(failed?.lastError).toContain("550");
    const nextAttempt = Date.parse(failed?.nextAttemptAt ?? "");
    expect(nextAttempt - failedAt).toBeGreaterThanOrEqual(OUTBOX_MIN_BACKOFF_MS - 1000);

    // Still backing off: not claimable one millisecond early, claimable when due.
    expect(store.claimNextOutbox(new Date(nextAttempt - 1).toISOString())).toBeNull();
    const retried = store.claimNextOutbox(failed?.nextAttemptAt ?? undefined);
    expect(retried?.status).toBe("sending");
    expect(retried?.attempts).toBe(2);

    const sent = store.markOutboxSent(item.id);
    expect(sent?.status).toBe("sent");
    expect(sent?.sentAt).not.toBeNull();
    expect(sent?.lastError).toBeNull();
    expect(store.claimNextOutbox()).toBeNull();
  });

  it("doubles the backoff per attempt and caps it", () => {
    const item = store.enqueueOutbox(accountId, message());
    store.claimNextOutbox();
    const first = store.markOutboxFailed(item.id, "boom");
    const firstDelay = Date.parse(first?.nextAttemptAt ?? "") - Date.now();
    store.claimNextOutbox(new Date(Date.now() + OUTBOX_MIN_BACKOFF_MS).toISOString());
    const second = store.markOutboxFailed(item.id, "boom", 120_000);
    const secondDelay = Date.parse(second?.nextAttemptAt ?? "") - Date.now();
    expect(secondDelay).toBeGreaterThanOrEqual(119_000);
    expect(secondDelay).toBeGreaterThanOrEqual(firstDelay);
  });

  it("retries manually, recovers interrupted sends on boot and deletes on request", () => {
    const item = store.enqueueOutbox(accountId, message());
    store.claimNextOutbox();
    expect(store.recoverOutbox()).toBe(1);
    const recovered = store.getOutboxItem(item.id);
    expect(recovered?.status).toBe("queued");
    expect(recovered?.attempts).toBe(1);

    store.claimNextOutbox();
    store.markOutboxFailed(item.id, "offline");
    const requeued = store.retryOutbox(item.id);
    expect(requeued?.status).toBe("queued");
    expect(requeued?.nextAttemptAt).toBeNull();

    expect(store.listOutbox({ accountId }).map((row) => row.id)).toEqual([item.id]);
    expect(store.listOutbox({ status: "sent" })).toEqual([]);
    expect(store.deleteOutbox(item.id)).toBe(true);
    expect(store.getOutboxItem(item.id)).toBeNull();
    expect(store.markOutboxSent("missing")).toBeNull();
    expect(store.markOutboxFailed("missing", "x")).toBeNull();
    expect(store.retryOutbox("missing")).toBeNull();
  });
});

describe("email metadata (T60)", () => {
  const attachment = {
    filename: "季度报告.pdf",
    mimeType: "application/pdf",
    size: 2048,
  };

  it("stores receivedAt and attachment metadata from a sync batch", () => {
    const result = store.upsertEmails(
      [email({ id: "e1", uid: "1" })],
      "INBOX",
      new Map([
        ["e1", { receivedAt: "2026-11-03T08:00:00.000Z", attachments: [attachment] }],
      ]),
    );
    expect(result.inserted).toBe(1);
    expect(store.getEmailExtras("e1")).toEqual({
      receivedAt: "2026-11-03T08:00:00.000Z",
      attachments: [attachment],
    });
    // 未知邮件 / 未富化邮件返回空值，而不是抛错（C6：缺失即叶子 false）。
    expect(store.getEmailExtras("missing")).toEqual({ receivedAt: null, attachments: [] });
  });

  it("updates metadata in place without touching the row count", () => {
    store.upsertEmails([email({ id: "e1", uid: "1" })], "INBOX");
    expect(store.setEmailExtras("e1", { receivedAt: "2026-11-03T08:00:00.000Z" })).toBe(true);
    expect(store.setEmailExtras("e1", { attachments: [attachment] })).toBe(true);
    expect(store.getEmailExtras("e1")).toEqual({
      receivedAt: "2026-11-03T08:00:00.000Z",
      attachments: [attachment],
    });
    // 部分更新不清空另一列。
    expect(store.setEmailExtras("e1", { attachments: [] })).toBe(true);
    expect(store.getEmailExtras("e1")).toEqual({
      receivedAt: "2026-11-03T08:00:00.000Z",
      attachments: [],
    });
    expect(store.setEmailExtras("missing", { receivedAt: null })).toBe(false);
    expect(store.listEmails({}).items).toHaveLength(1);
  });

  it("wires the adapter receive-time map through applyReceivedAt (T64 contract)", () => {
    const batch = [
      email({ id: "e1", uid: "1" }),
      email({ id: "e2", uid: "2", messageId: "<m2@corp.example>", sentAt: "2026-11-04T09:00:00.000Z" }),
    ];
    store.upsertEmails(batch, "INBOX");

    // 适配器只给「它真的知道」的那几封：e1 在 map 里，e2 不在。
    const receivedAtByUid = new Map([["1", new Date("2026-11-05T02:00:00.000Z")]]);
    store.applyReceivedAt(batch, receivedAtByUid);

    expect(store.getEmailExtras("e1").receivedAt).toBe("2026-11-05T02:00:00.000Z");
    expect(store.getEmailExtras("e2").receivedAt).toBeNull();
    // Date → ISO 由本方法完成；绝不拿 sentAt（2026-11-02）冒充接收时间。
    expect(store.getEmail("e1")?.sentAt).toBe("2026-11-02T09:00:00.000Z");

    // 幂等：同一批再跑一次不新增任何 change_log 行。
    const head = store.head();
    store.applyReceivedAt(batch, receivedAtByUid);
    expect(store.head()).toBe(head);

    // 空 map 不擦掉已有值（缺条目 = 省略，不是写 null）。
    store.applyReceivedAt(batch, new Map());
    expect(store.getEmailExtras("e1").receivedAt).toBe("2026-11-05T02:00:00.000Z");
  });

  it("does not append a change_log row when the same metadata is written again", () => {
    store.upsertEmails([email({ id: "e1", uid: "1" })], "INBOX");
    expect(
      store.setEmailExtras("e1", {
        receivedAt: "2026-11-03T08:00:00.000Z",
        attachments: [attachment],
      }),
    ).toBe(true);

    const head = store.head();
    expect(store.setEmailExtras("e1", { receivedAt: "2026-11-03T08:00:00.000Z" })).toBe(true);
    expect(store.setEmailExtras("e1", { attachments: [attachment] })).toBe(true);
    expect(store.head()).toBe(head);

    expect(store.setEmailExtras("e1", { receivedAt: "2026-11-04T08:00:00.000Z" })).toBe(true);
    expect(store.head()).toBe(head + 1);
  });

  it("feeds a date.which=received + attachment rule from stored metadata end to end", async () => {
    store.upsertEmails([email({ id: "e1", uid: "1" })], "INBOX");
    store.setEmailExtras("e1", {
      receivedAt: "2026-11-03T08:00:00.000Z",
      attachments: [attachment],
    });

    const receivedRule: RuleTree = {
      kind: "and",
      children: [
        { kind: "field", field: "attachmentName", op: "contains", value: "季度报告" },
        {
          kind: "field",
          field: "date",
          op: "between",
          which: "received",
          value: { from: "2026-11-03T00:00:00.000Z", to: "2026-11-04T00:00:00.000Z" },
        },
      ],
    };
    const context = { userEmails: ["me@corp.com"], timezone: "Asia/Shanghai" };

    const raw = store.getEmail("e1");
    if (!raw) throw new Error("missing fixture");
    const hit = projectRuleEmail(raw, store.getEmailState("e1"), store.getEmailExtras("e1"));
    await expect(evaluateRuleTree(receivedRule, hit, context)).resolves.toBe(true);

    // POP3 场景：协议不提供接收时间 → 字段未知 → 叶子按 C6 判 false，
    // 其否定为 true（引擎没有三态，见 docs/upgrade-v1.1.md §8 的边界说明）。
    store.upsertEmails(
      [
        {
          ...email({ id: "pop3", uid: "2" }),
          messageId: "<pop3@corp.example>",
          sentAt: "2026-11-04T09:00:00.000Z",
        },
      ],
      "INBOX",
    );
    const pop3Raw = store.getEmail("pop3");
    if (!pop3Raw) throw new Error("missing fixture");
    const unknown = projectRuleEmail(
      pop3Raw,
      store.getEmailState("pop3"),
      store.getEmailExtras("pop3"),
    );
    const receivedOnly: RuleTree = {
      kind: "field",
      field: "date",
      op: "between",
      which: "received",
      value: { from: "2026-11-03T00:00:00.000Z", to: "2026-11-04T00:00:00.000Z" },
    };
    await expect(evaluateRuleTree(receivedOnly, unknown, context)).resolves.toBe(false);
    await expect(
      evaluateRuleTree({ kind: "not", child: receivedOnly }, unknown, context),
    ).resolves.toBe(true);
  });

  it("keeps the metadata columns after a restart and on a second migration", async () => {
    store.upsertEmails(
      [email({ id: "e1", uid: "1" })],
      "INBOX",
      new Map([["e1", { receivedAt: "2026-11-03T08:00:00.000Z", attachments: [attachment] }]]),
    );
    store.close();
    store = await openStore(join(dir, "db.sqlite"), "device-a");
    expect(store.getEmailExtras("e1")).toEqual({
      receivedAt: "2026-11-03T08:00:00.000Z",
      attachments: [attachment],
    });

    const head = store.head();
    store.migrate();
    store.migrate();
    expect(store.head()).toBe(head);
    expect(store.getEmailExtras("e1").attachments).toHaveLength(1);
  });
});

describe("change_log privacy (T63)", () => {
  it("never puts outbox message bodies into the sync stream", () => {
    const secretBody = "这是只应存在于 outbox 表里的正文标记";
    const attachment = {
      filename: "secret-report.pdf",
      mimeType: "application/pdf",
      size: 3,
      dataBase64: "QUJD",
    };
    const item = store.enqueueOutbox(
      accountId,
      message({
        to: ["confidential@corp.example"],
        subject: "机密主题",
        bodyText: secretBody,
        bodyHtml: `<p>${secretBody}</p>`,
        attachments: [attachment],
      }),
    );

    // The sync row carries only the identifier + state.
    const head = store.head();
    const enqueued = store
      .changes(head - 1)
      .find((row) => row.entity === "outbox" && row.op === "insert");
    expect(enqueued).toBeDefined();
    expect(JSON.parse(enqueued?.payload ?? "{}")).toEqual({
      outboxId: item.id,
      status: "queued",
      attempts: 0,
    });

    // The whole public stream (GET /api/sync/changes returns exactly this) has no
    // body, no attachment bytes and no recipient list.
    const stream = JSON.stringify(store.changes(0));
    expect(stream).not.toContain(secretBody);
    expect(stream).not.toContain("QUJD");
    expect(stream).not.toContain("confidential@corp.example");
    expect(stream).not.toContain("机密主题");

    // …while the table itself still holds the full snapshot for sending / replay.
    expect(store.getOutboxItem(item.id)?.message.bodyText).toBe(secretBody);
    expect(store.getOutboxItem(item.id)?.message.attachments[0]?.dataBase64).toBe("QUJD");
  });
});

describe("drafts", () => {
  it("upserts by (accountId, draftId) and deletes", () => {
    const saved = store.saveDraft(accountId, message());
    const head = store.head();
    const updated = store.saveDraft(accountId, message({ subject: "改过的主题" }), saved.id);
    expect(updated.id).toBe(saved.id);
    expect(updated.subject).toBe("改过的主题");
    expect(store.listDrafts(accountId)).toHaveLength(1);
    expect(entitiesSince(store, head)).toEqual(["draft"]);
    const listed = store.listDrafts(accountId)[0];
    expect(Date.parse(listed?.savedAt ?? "")).toBeGreaterThanOrEqual(Date.parse(saved.savedAt));

    expect(store.deleteDraft(saved.id)).toBe(true);
    expect(store.getDraft(saved.id)).toBeNull();
    expect(store.listDrafts()).toEqual([]);
  });

  it("refuses to overwrite a draft that belongs to another account", () => {
    const other = store.createAccount({
      provider: "imap",
      label: "B",
      email: "b@corp.com",
      config: {},
      secret: "x",
    });
    const saved = store.saveDraft(accountId, message());
    expect(() => store.saveDraft(other.id, message(), saved.id)).toThrow(StoreError);
  });
});

describe("folders and per-message state", () => {
  it("upserts folders, replaces the set and tracks unread counts", () => {
    const inbox = { accountId, path: "INBOX", role: "inbox" as const, unread: 3 };
    const archive = { accountId, path: "Archive", role: "archive" as const, unread: 0 };
    store.upsertFolder(inbox);
    store.upsertFolder(archive);
    expect(store.listFolders(accountId)).toHaveLength(2);

    const head = store.head();
    store.upsertFolder(inbox); // unchanged -> no write, no change_log row
    expect(store.head()).toBe(head);

    expect(store.setFolderUnread(accountId, "INBOX", 5)).toBe(true);
    expect(store.getFolder(accountId, "INBOX")?.unread).toBe(5);
    expect(store.setFolderUnread(accountId, "nope", 1)).toBe(false);

    const replaced = store.replaceFolders(accountId, [{ ...inbox, unread: 0 }]);
    expect(replaced.map((folder) => folder.path)).toEqual(["INBOX"]);
  });

  it("marks read, moves and deletes stored emails", () => {
    store.upsertEmails([email({ id: "e1", uid: "1" }), email({ id: "e2", uid: "2" })]);
    expect(store.getEmailState("e1")).toEqual({ folder: "INBOX", isRead: false });

    expect(store.markEmailRead("e1", true)).toBe(true);
    expect(store.getEmailState("e1")?.isRead).toBe(true);
    expect(store.moveEmail("e1", "Archive")).toBe(true);
    expect(store.getEmailState("e1")?.folder).toBe("Archive");
    expect(store.markEmailRead("missing", true)).toBe(false);

    const page = store.listEmailsInFolder({ folder: "Archive" });
    expect(page.items.map((item) => item.email.id)).toEqual(["e1"]);
    expect(page.items[0]?.isRead).toBe(true);
    expect(store.listEmailsInFolder({ folder: "INBOX" }).items.map((item) => item.email.id)).toEqual([
      "e2",
    ]);
    expect(store.listEmailsInFolder({ folder: "INBOX", unreadOnly: true }).items).toHaveLength(1);
    expect(store.listEmailsInFolder({ folder: "INBOX", search: "季度报告" }).items).toHaveLength(1);
    expect(store.listEmailsInFolder({ folder: "INBOX", search: "没有这段" }).items).toHaveLength(0);

    expect(store.deleteEmail("e2")).toBe(true);
    expect(store.getEmail("e2")).toBeNull();
  });

  it("filters the folder page by category (ANY) and paginates with a stable cursor", () => {
    const work = store.createCategory({ name: "工作", enterTodo: true, broadcast: false });
    store.upsertEmails(
      Array.from({ length: 3 }, (_, index) =>
        email({ id: `e${index}`, uid: String(index), subject: `s${index}` }),
      ),
    );
    store.replaceTagsForEmail("e1", [{ categoryId: work.id, ruleId: null }]);

    const filtered = store.listEmailsInFolder({ folder: "INBOX", categoryIds: [work.id] });
    expect(filtered.items.map((item) => item.email.id)).toEqual(["e1"]);

    const page1 = store.listEmailsInFolder({ folder: "INBOX", limit: 2 });
    expect(page1.items).toHaveLength(2);
    expect(page1.nextCursor).not.toBeNull();
    const page2 = store.listEmailsInFolder({
      folder: "INBOX",
      limit: 2,
      cursor: page1.nextCursor ?? "",
    });
    expect(page2.items).toHaveLength(1);
    const ids = new Set([...page1.items, ...page2.items].map((item) => item.email.id));
    expect(ids.size).toBe(3);
  });
});

describe("onboarding state", () => {
  it("reads defaults and persists completed/skipped partially", () => {
    expect(store.getInitState()).toEqual({ completed: false, skipped: false });
    expect(store.setInitState({ skipped: true })).toEqual({ completed: false, skipped: true });
    expect(store.getInitState().skipped).toBe(true);
    expect(store.setInitState({ completed: true })).toEqual({ completed: true, skipped: true });
    expect(entitiesSince(store, 0)).toContain("init_state");
  });
});

describe("account send config", () => {
  it("stores SMTP settings as non-secret config and the password encrypted", () => {
    const account = store.createAccount({
      provider: "imap",
      label: "公司邮箱",
      email: "me@corp.com",
      config: { host: "imap.corp.com" },
      secret: "inbound-pw",
      send: {
        smtpHost: "smtp.corp.com",
        smtpPort: 587,
        smtpSecure: true,
        smtpUser: "me@corp.com",
        smtpPassword: "smtp-secret-pw",
        authMode: "password",
      },
    });
    expect(account.send).toEqual({
      smtpHost: "smtp.corp.com",
      smtpPort: 587,
      smtpSecure: true,
      smtpUser: "me@corp.com",
      ewsUrl: null,
      authMode: "password",
    });
    expect(store.getAccountWithSmtpSecret(account.id)?.smtpPassword).toBe("smtp-secret-pw");

    // Neither the account JSON nor the change stream may leak the password.
    const asJson = JSON.stringify(store.listAccounts());
    expect(asJson).not.toContain("smtp-secret-pw");
    expect(asJson).not.toContain("inbound-pw");
    expect(JSON.stringify(store.changes(0))).not.toContain("smtp-secret-pw");

    const updated = store.updateAccount(account.id, { send: { smtpHost: "smtp2.corp.com" } });
    expect(updated?.send?.smtpHost).toBe("smtp2.corp.com");
    expect(store.getAccountWithSmtpSecret(account.id)?.smtpPassword).toBe("smtp-secret-pw");

    store.setAccountSendConfig(account.id, { smtpPassword: "" });
    expect(store.getAccountWithSmtpSecret(account.id)?.smtpPassword).toBe("");

    expect(store.updateAccount("missing", { label: "x" })).toBeNull();
    expect(store.setAccountSendConfig("missing", { smtpHost: "x" })).toBeNull();
  });
});

describe("account identity text (T68)", () => {
  it("applySendInput 写入 signature/displayName；undefined 保持、null 删除", () => {
    const base = { smtpHost: "smtp.corp.com", signature: "旧签名", displayName: "旧名字" };

    const kept = applySendInput(base, { smtpPort: 587 });
    expect(kept["signature"]).toBe("旧签名");
    expect(kept["displayName"]).toBe("旧名字");

    const written = applySendInput(base, {
      signature: "——\n新签名",
      displayName: "张三",
    });
    expect(written["signature"]).toBe("——\n新签名");
    expect(written["displayName"]).toBe("张三");

    const cleared = applySendInput(base, { signature: null, displayName: null });
    expect("signature" in cleared).toBe(false);
    expect("displayName" in cleared).toBe(false);
    expect(cleared["smtpHost"]).toBe("smtp.corp.com");
  });

  it("store 落库后签名可读回，且不影响发信通道判定", () => {
    const account = store.createAccount({
      provider: "graph",
      label: "Outlook",
      email: "me@outlook.com",
      config: { clientId: "abc" },
      secret: "",
      send: { signature: "——\n个人签名", displayName: "张三" },
    });
    expect(account.config["signature"]).toBe("——\n个人签名");
    expect(account.config["displayName"]).toBe("张三");
    // 只有身份文本、没有 SMTP/EWS 连接：mapper 仍把 send 视为 null。
    expect(account.send).toBeNull();
  });
});

describe("folder-scoped sync (T53)", () => {
  it("records the folder and server ref per message and lists non-INBOX mail", () => {
    const result = store.upsertEmails([email({ id: "a1", uid: "10" })], "Archive");
    expect(result.inserted).toBe(1);
    expect(store.getEmailState("a1")?.folder).toBe("Archive");
    expect(store.getEmailRefState("a1")).toEqual({
      kind: "ref",
      ref: { id: "10", folderId: "Archive" },
    });
    expect(store.listEmailsInFolder({ folder: "Archive" }).items.map((item) => item.email.id)).toEqual([
      "a1",
    ]);
    expect(store.listEmailsInFolder({ folder: "INBOX" }).items).toEqual([]);
  });

  it("keeps same-numbered UIDs from different folders as two emails", () => {
    // IMAP uid 是文件夹作用域的：inbox 的 5 与 archive 的 5 是两封不同的邮件，
    // 不能因为 UNIQUE(account_id, uid) 被丢掉。
    const inbox = store.upsertEmails([email({ id: "i5", uid: "5" })], "INBOX");
    const archive = store.upsertEmails([email({ id: "a5", uid: "5" })], "Archive");
    expect(inbox.inserted).toBe(1);
    expect(archive.inserted).toBe(1);
    expect(store.listEmails({}).items).toHaveLength(2);
    expect(store.listEmailsInFolder({ folder: "INBOX" }).items).toHaveLength(1);
    expect(store.listEmailsInFolder({ folder: "Archive" }).items).toHaveLength(1);
  });

  it("matches an unresolved move by Message-ID on resync instead of duplicating the row", () => {
    // 服务端已移动，但适配器无法解析目标文件夹的新 uid：ref 变成 unresolved。
    store.upsertEmails([email({ id: "e1", uid: "5" })], "INBOX");
    store.moveEmail("e1", "Archive");
    expect(store.markEmailRefUnresolved("e1")).toBe(true);

    // 重新同步 Archive：服务端给出新 uid，只能靠 Message-ID + 同文件夹 + 相近时间识别。
    const again = store.upsertEmails([email({ id: "e1-dup", uid: "88" })], "Archive");
    expect(again.inserted).toBe(0);
    expect(store.listEmails({}).items.map((item) => item.id)).toEqual(["e1"]);
    expect(store.getEmail("e1-dup")).toBeNull();
    expect(store.getEmailState("e1")?.folder).toBe("Archive");
    expect(store.getEmailRefState("e1")).toEqual({
      kind: "ref",
      ref: { id: "88", folderId: "Archive" },
    });
  });

  it("only uses the Message-ID fallback within the same folder and a nearby date", () => {
    store.upsertEmails([email({ id: "e1", uid: "5" })], "INBOX");
    store.markEmailRefUnresolved("e1");

    // 同 Message-ID、不同文件夹：本模型一行只属于一个文件夹 → 新行。
    expect(store.upsertEmails([email({ id: "other-folder", uid: "6" })], "Archive").inserted).toBe(
      1,
    );

    // 同文件夹、同 Message-ID，但发送时间相差 3 天 → 不合并（防 Message-ID 复用）。
    const far = { ...email({ id: "far", uid: "7" }), sentAt: "2026-11-05T09:00:00.000Z" };
    expect(store.upsertEmails([far], "INBOX").inserted).toBe(1);
  });

  it("adopts a v1 plain-uid row on the first folder-scoped sync instead of duplicating it", () => {
    // 模拟升级后的 v1 行：裸 uid、没有 ref。
    store.upsertEmails([email({ id: "e1", uid: "5" })]);
    expect(store.getEmail("e1")?.uid).toBe("5");

    const result = store.upsertEmails([email({ id: "e1", uid: "5" })], "INBOX");
    expect(result.inserted).toBe(0);
    expect(store.listEmails({}).items).toHaveLength(1);
    // 本地去重键变成「文件夹 + 裸 uid」；服务端 id 仍在 ref 里。
    expect(store.getEmail("e1")?.uid).toBe("INBOX\u001f5");
    expect(store.getEmailRefState("e1")).toEqual({
      kind: "ref",
      ref: { id: "5", folderId: "INBOX" },
    });
  });

  it("re-identifies a moved message on the next sync instead of duplicating it", () => {
    store.upsertEmails([email({ id: "e1", uid: "7" })], "INBOX");
    store.moveEmail("e1", "Archive");
    store.setEmailRef("e1", { id: "77", folderId: "Archive" });

    // The server hands the moved message back under its NEW folder-scoped uid.
    const again = store.upsertEmails([email({ id: "e1-dup", uid: "77" })], "Archive");
    expect(again.inserted).toBe(0);
    expect(store.listEmails({}).items.map((item) => item.id)).toEqual(["e1"]);
    expect(store.getEmailState("e1")).toMatchObject({ folder: "Archive" });
    expect(store.getEmailRefState("e1")).toMatchObject({
      kind: "ref",
      ref: { id: "77", folderId: "Archive" },
    });
  });

  it("persists the ref across a restart and marks it unresolved on request", async () => {
    store.upsertEmails([email({ id: "e1", uid: "1" })], "INBOX");
    store.setEmailRef("e1", { id: "42", folderId: "Archive" });

    store.close();
    store = await openStore(join(dir, "db.sqlite"), "device-a");
    expect(store.getEmailRefState("e1")).toEqual({
      kind: "ref",
      ref: { id: "42", folderId: "Archive" },
    });

    expect(store.markEmailRefUnresolved("e1")).toBe(true);
    expect(store.getEmailRefState("e1")).toEqual({ kind: "unresolved" });
    expect(store.getEmailRefState("missing")).toEqual({ kind: "unknown" });
    expect(store.setEmailRef("missing", { id: "x", folderId: null })).toBe(false);
    expect(store.markEmailRefUnresolved("missing")).toBe(false);
  });

  it("keeps one cursor per folder and drops them with the account", () => {
    store.setFolderCursor(accountId, "INBOX", "uidvalidity:1");
    store.setFolderCursor(accountId, "Archive", "uidvalidity:9");
    expect(store.getFolderCursor(accountId, "INBOX")?.value).toBe("uidvalidity:1");
    expect(store.getFolderCursor(accountId, "Archive")?.value).toBe("uidvalidity:9");
    expect(store.getFolderCursor(accountId, "Sent")).toBeNull();

    store.setFolderCursor(accountId, "INBOX", "uidvalidity:2");
    expect(store.getFolderCursor(accountId, "Archive")?.value).toBe("uidvalidity:9");

    store.deleteAccount(accountId);
    expect(store.getFolderCursor(accountId, "INBOX")).toBeNull();
  });

  it("escapes LIKE wildcards so a literal % is not 'match everything'", () => {
    store.upsertEmails([
      email({ id: "e1", uid: "1", subject: "进度 100% 完成" }),
      email({ id: "e2", uid: "2", subject: "普通邮件" }),
      email({ id: "e3", uid: "3", subject: "under_score" }),
    ]);
    expect(store.listEmails({ search: "%" }).items.map((item) => item.id)).toEqual(["e1"]);
    expect(store.listEmails({ search: "_" }).items.map((item) => item.id)).toEqual(["e3"]);
    expect(store.listEmails({ search: "0%" }).items.map((item) => item.id)).toEqual(["e1"]);
    expect(
      store.listEmailsInFolder({ folder: "INBOX", search: "%" }).items.map((item) => item.email.id),
    ).toEqual(["e1"]);
    // A backslash is a literal too, not an escape for the next character.
    store.upsertEmails([email({ id: "e4", uid: "4", subject: "path C:\\tmp" })]);
    expect(store.listEmails({ search: "C:\\tmp" }).items.map((item) => item.id)).toEqual(["e4"]);
  });
});

describe("account deletion", () => {
  it("logs every row the foreign-key cascade removes", () => {
    const other = store.createAccount({
      provider: "imap",
      label: "B",
      email: "b@corp.com",
      config: {},
      secret: "x",
    });
    store.upsertEmails([email({ id: "b-mail", uid: "9", accountId: other.id })]);
    store.setBroadcastVerdict("b-mail", { kind: "broadcast", signals: ["header:list-id"] });
    store.insertTasks([{ ...task({ id: "b-task" }), sourceEmailId: "b-mail" }]);
    const work = store.createCategory({ name: "工作", enterTodo: true, broadcast: false });
    store.replaceTagsForEmail("b-mail", [{ categoryId: work.id, ruleId: null }]);
    store.upsertFolder({ accountId: other.id, path: "INBOX", role: "inbox", unread: 2 });
    store.saveDraft(other.id, message());
    store.enqueueOutbox(other.id, message());
    store.setCursor(other.id, "uidvalidity:42");
    const head = store.head();

    expect(store.deleteAccount(other.id)).toBe(true);

    // A cascade is a write: every affected table must appear in the sync seam.
    const entities = new Set(entitiesSince(store, head));
    for (const entity of [
      "account",
      "raw_email",
      "broadcast_verdict",
      "task",
      "tag",
      "folder",
      "draft",
      "outbox",
      "sync_cursor",
    ]) {
      expect(entities.has(entity)).toBe(true);
    }

    // …and the rows are really gone while the surviving account is untouched.
    expect(store.listAccounts().map((account) => account.id)).toEqual([accountId]);
    expect(store.listEmails({ accountId: other.id }).items).toEqual([]);
    expect(store.listTagsForEmail("b-mail")).toEqual([]);
    expect(store.listFolders(other.id)).toEqual([]);
    expect(store.listDrafts(other.id)).toEqual([]);
    expect(store.listOutbox({ accountId: other.id })).toEqual([]);
    expect(store.getCursor(other.id)).toBeNull();
    expect(store.getTask("b-task")).toBeNull();
    expect(store.getBroadcastVerdict("b-mail")).toBeNull();

    const secondHead = store.head();
    expect(store.deleteAccount("missing")).toBe(false);
    expect(store.head()).toBe(secondHead);
  });
});

describe("migration bookkeeping", () => {
  it("creates the folder index and keeps a second migration a no-op", async () => {
    const probe = await openDatabase(join(dir, "db.sqlite"));
    const indexNames = probe
      .prepare("PRAGMA index_list(raw_email)")
      .all<{ name: string }>()
      .map((row) => row.name);
    probe.close();
    // `listEmailsInFolder` filters on (folder, sent_at); without this it is a scan.
    expect(indexNames).toContain("idx_raw_email_folder");

    const head = store.head();
    store.migrate();
    store.migrate();
    expect(store.head()).toBe(head);
  });
});

describe("v1 -> v1.1 migration", () => {
  const legacyFile = (dir: string): string => join(dir, "legacy.sqlite");

  const writeLegacyV1 = async (file: string): Promise<void> => {
    const db = await openDatabase(file);
    db.exec(readFileSync(new URL("./schema.sql", import.meta.url), "utf8"));
    db.exec(`
      INSERT INTO user_profile (id, display_name, aliases_json, emails_json, timezone, created_at, updated_at)
      VALUES ('u-old', '张三', '["San Zhang"]', '["old@corp.com"]', 'Asia/Shanghai',
              '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z');
      INSERT INTO account (id, user_id, provider, label, email, config_json, secret_cipher, enabled, created_at)
      VALUES ('acc-old', 'u-old', 'imap', '旧邮箱', 'old@corp.com', '{"host":"imap.corp.com"}', NULL, 1,
              '2026-11-01T00:00:00.000Z');
      INSERT INTO raw_email (id, account_id, uid, message_id, thread_id, from_name, from_email,
                             to_json, cc_json, subject, sent_at, body_text, has_attachments,
                             headers_json, created_at)
      VALUES ('mail-old', 'acc-old', '1', '<m@x>', NULL, '李雷', 'lilei@corp.com',
              '["old@corp.com"]', '[]', '旧邮件', '2026-11-01T09:00:00.000Z', '正文', 0, '{}',
              '2026-11-01T09:00:01.000Z');
      INSERT INTO task (id, user_id, title, detail, owner, owner_name, kind, status, origin,
                        confidence, evidence_quote, source_email_id, thread_id, time_phrase,
                        due_at, window_start, window_end, timezone, time_confidence,
                        created_at, updated_at)
      VALUES ('task-old', 'u-old', '旧任务', NULL, 'me', NULL, 'action', 'candidate', 'personal',
              0.8, '证据', 'mail-old', NULL, NULL, NULL, NULL, NULL, NULL, NULL,
              '2026-11-01T09:00:02.000Z', '2026-11-01T09:00:02.000Z');
      INSERT INTO change_log (entity, entity_id, rev, device_id, op, payload, ts)
      VALUES ('raw_email', 'mail-old', 'rev-old', 'device-old', 'insert', '{}',
              '2026-11-01T09:00:02.000Z');
    `);
    db.close();
  };

  it("upgrades in place, keeps every v1 row and seeds the two rules once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mailcollect-migrate-"));
    const file = legacyFile(dir);
    try {
      await writeLegacyV1(file);
      const migrated = await openStore(file, "device-a");

      // v1 data survives untouched.
      expect(migrated.getProfile()?.id).toBe("u-old");
      expect(migrated.listAccounts().map((account) => account.id)).toEqual(["acc-old"]);
      expect(migrated.getEmail("mail-old")?.subject).toBe("旧邮件");
      expect(migrated.getTask("task-old")?.title).toBe("旧任务");
      const allChanges = migrated.changes(0);
      expect(allChanges.some((row) => row.deviceId === "device-old")).toBe(true);

      // Seeds use the existing profile's identity, and an upgraded install is
      // treated as onboarded (no wizard on next boot).
      const rules = migrated.listRules();
      expect(rules.map((rule) => rule.id).sort()).toEqual(
        [SEED_RULE_PERSONAL_ID, SEED_RULE_BROADCAST_ID].sort(),
      );
      expect(JSON.stringify(rules)).toContain("张三");
      expect(migrated.getInitState().completed).toBe(true);

      const probe = await openDatabase(file);
      const indexNames = probe
        .prepare("PRAGMA index_list(raw_email)")
        .all<{ name: string }>()
        .map((row) => row.name);
      const columns = probe
        .prepare("PRAGMA table_info(raw_email)")
        .all<{ name: string }>()
        .map((row) => row.name);
      probe.close();
      expect(indexNames).toContain("idx_raw_email_folder");
      expect(columns).toEqual(
        expect.arrayContaining([
          "folder",
          "is_read",
          "provider_ref_json",
          "received_at",
          "attachments_json",
        ]),
      );

      // Re-running the migration is a no-op: same rows, same change log head.
      const head = migrated.head();
      migrated.migrate();
      migrated.migrate();
      expect(migrated.listRules()).toHaveLength(2);
      expect(migrated.head()).toBe(head);
      expect(migrated.getProfile()?.displayName).toBe("张三");
      expect(migrated.getEmail("mail-old")).not.toBeNull();
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not replay a seed rule the user deleted after the upgrade", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mailcollect-migrate-"));
    const file = legacyFile(dir);
    try {
      await writeLegacyV1(file);
      const migrated = await openStore(file, "device-a");
      expect(migrated.deleteRule(SEED_RULE_PERSONAL_ID)).toBe(true);
      migrated.migrate();
      expect(migrated.listRules().map((rule) => rule.id)).toEqual([SEED_RULE_BROADCAST_ID]);
      migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
