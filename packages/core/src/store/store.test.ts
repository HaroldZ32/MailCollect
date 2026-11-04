import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RawEmail, Task } from "@mailcollect/shared";
import { openStore, type Store } from "./index.js";

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
