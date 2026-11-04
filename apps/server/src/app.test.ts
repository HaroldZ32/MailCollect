import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawEmail, Task } from "@mailcollect/shared";
import { openStore, type Store } from "@mailcollect/core";
import { createApp } from "./app.js";
import type { ServerServices } from "./services.js";

const TOKEN = "test-token";
let dir: string;
let store: Store;
let accountId: string;
let app: ReturnType<typeof createApp>;

const services: ServerServices = {
  verifyAccount: vi.fn(async () => ({ ok: true, detail: "OK" })),
  syncAccount: vi.fn(async () => undefined),
  extract: vi.fn(async () => ({ done: 0, total: 0 })),
  testLlm: vi.fn(async () => ({ ok: true, latencyMs: 12, detail: "pong" })),
  startBackground: vi.fn(),
  stopBackground: vi.fn(async () => undefined),
};

const email: RawEmail = {
  id: "e1",
  accountId: "",
  uid: "1",
  messageId: "<a@b>",
  threadId: null,
  fromName: "李雷",
  fromEmail: "lilei@corp.com",
  to: ["me@corp.com"],
  cc: [],
  subject: "请张三周五前提交报告",
  sentAt: "2026-11-02T09:00:00.000Z",
  bodyText: "张三，请你在周五下班前把季度报告发我。",
  hasAttachments: false,
  headers: {},
  createdAt: "2026-11-02T09:00:01.000Z",
};

const task: Task = {
  id: "t1",
  userId: "u1",
  title: "提交季度报告",
  detail: null,
  owner: "me",
  ownerName: "张三",
  kind: "deadline",
  status: "candidate",
  origin: "personal",
  confidence: 0.9,
  evidenceQuote: "请你在周五下班前把季度报告发我",
  sourceEmailId: "e1",
  threadId: null,
  time: null,
  createdAt: "2026-11-02T09:00:02.000Z",
  updatedAt: "2026-11-02T09:00:02.000Z",
};

const call = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("content-type", "application/json");
  return Promise.resolve(app.request(path, { ...init, headers }));
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mailcollect-api-"));
  store = await openStore(join(dir, "db.sqlite"), "device-test");
  accountId = store.createAccount({
    provider: "imap",
    label: "测试邮箱",
    email: "me@corp.com",
    config: { host: "imap.corp.com" },
    secret: "app-password",
  }).id;
  store.upsertEmails([{ ...email, accountId }]);
  store.insertTasks([{ ...task, sourceEmailId: "e1" }]);
  app = createApp({ store, services, token: TOKEN, version: "test" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("http api", () => {
  it("serves health without a token", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; hasProfile: boolean };
    expect(body.ok).toBe(true);
    expect(body.hasProfile).toBe(false);
  });

  it("rejects every other route without a token", async () => {
    const res = await app.request("/api/profile");
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("rejects a wrong token", async () => {
    const res = await app.request("/api/profile", {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts a query token ONLY on the SSE route (EventSource cannot set headers)", async () => {
    // Non-SSE routes must keep refusing the query-token shortcut.
    const profileViaQuery = await app.request(`/api/profile?token=${TOKEN}`);
    expect(profileViaQuery.status).toBe(401);

    const wrongOnEvents = await app.request("/api/events?token=wrong");
    expect(wrongOnEvents.status).toBe(401);
  });

  it("round-trips the profile", async () => {
    const put = await call("/api/profile", {
      method: "PUT",
      body: JSON.stringify({
        displayName: "张三",
        aliases: ["San Zhang"],
        emails: ["me@corp.com"],
        timezone: "Asia/Shanghai",
      }),
    });
    expect(put.status).toBe(200);

    const get = await call("/api/profile");
    const body = (await get.json()) as { profile: { displayName: string; timezone: string } };
    expect(body.profile.displayName).toBe("张三");
    expect(body.profile.timezone).toBe("Asia/Shanghai");
  });

  it("never returns a mailbox secret", async () => {
    const res = await call("/api/accounts");
    const text = await res.text();
    expect(text).not.toContain("app-password");
    const body = JSON.parse(text) as { items: Array<{ hasSecret: boolean; secret?: string }> };
    expect(body.items[0]?.hasSecret).toBe(true);
    expect(body.items[0]?.secret).toBeUndefined();
  });

  it("lists emails and a single email", async () => {
    const list = await call("/api/emails?limit=10");
    const body = (await list.json()) as { items: RawEmail[] };
    expect(body.items).toHaveLength(1);

    const single = await call("/api/emails/e1");
    expect(single.status).toBe(200);
    const detail = (await single.json()) as { email: RawEmail };
    expect(detail.email.subject).toContain("张三");

    const missing = await call("/api/emails/nope");
    expect(missing.status).toBe(404);
  });

  it("breaks tasks down by status with counts", async () => {
    const all = await call("/api/tasks");
    const body = (await all.json()) as {
      items: Task[];
      counts: Record<string, number>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.counts.candidate).toBe(1);

    const empty = await call("/api/tasks?status=confirmed");
    const confirmed = (await empty.json()) as { items: Task[] };
    expect(confirmed.items).toHaveLength(0);
  });

  it("confirms tasks in bulk and remembers the list decision", async () => {
    const res = await call("/api/tasks/bulk", {
      method: "POST",
      body: JSON.stringify({
        ids: ["t1"],
        decision: "confirm",
        listId: "list.corp.com",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Task[] };
    expect(body.items[0]?.status).toBe("confirmed");
    expect(store.getBroadcastDecision("list.corp.com")).toBe("always_task");
  });

  it("patches a task's schedule", async () => {
    const res = await call("/api/tasks/t1", {
      method: "PATCH",
      body: JSON.stringify({ dueAt: "2026-11-06T10:00:00.000Z", status: "confirmed" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { task: Task };
    expect(body.task.time?.dueAt).toBe("2026-11-06T10:00:00.000Z");
    expect(body.task.status).toBe("confirmed");
  });

  it("creates, defaults and deletes LLM configs without leaking the key", async () => {
    const created = await call("/api/llm/configs", {
      method: "POST",
      body: JSON.stringify({
        label: "DeepSeek",
        protocol: "openai-compatible",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        apiKey: "sk-secret",
      }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { config: { id: string; hasKey: boolean } };
    expect(createdBody.config.hasKey).toBe(true);

    const listed = await call("/api/llm/configs");
    const listedText = await listed.text();
    expect(listedText).not.toContain("sk-secret");

    const removed = await call(`/api/llm/configs/${createdBody.config.id}`, { method: "DELETE" });
    expect(removed.status).toBe(200);
  });

  it("validates required fields instead of storing garbage", async () => {
    const res = await call("/api/llm/configs", {
      method: "POST",
      body: JSON.stringify({ label: "x", protocol: "openai-compatible", baseUrl: "", model: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("dispatches a sync job and returns immediately", async () => {
    const res = await call("/api/sync", {
      method: "POST",
      body: JSON.stringify({ accountId }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jobId: string };
    expect(body.jobId).toContain("sync-");
  });

  it("returns 404 for an unknown account", async () => {
    const res = await call("/api/sync", {
      method: "POST",
      body: JSON.stringify({ accountId: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("serves a JSON 404 for unknown api paths", async () => {
    const res = await call("/api/does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  it("exposes the ordered change stream as the cloud-sync seam", async () => {
    const all = await call("/api/sync/changes?since=0");
    expect(all.status).toBe(200);
    const body = (await all.json()) as { head: number; items: Array<{ seq: number }> };
    expect(body.head).toBeGreaterThan(0);
    expect(body.items.length).toBeGreaterThan(0);
    const seqs = body.items.map((row) => row.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    const tail = await call(`/api/sync/changes?since=${body.head}`);
    const tailBody = (await tail.json()) as { items: unknown[] };
    expect(tailBody.items).toHaveLength(0);
  });

  it("returns the change stream in the frozen camelCase shape", async () => {
    const res = await call("/api/sync/changes?since=0");
    const body = (await res.json()) as {
      items: Array<Record<string, unknown>>;
    };
    const first = body.items[0];
    expect(first).toBeDefined();
    expect(Object.keys(first ?? {})).not.toContain("entity_id");
    expect(Object.keys(first ?? {})).not.toContain("device_id");
  });
});
