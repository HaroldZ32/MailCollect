import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Draft,
  OutgoingMessage,
  OutboxItem,
  RawEmail,
  SendEventData,
  SendMessageResponse,
  ServerEvent,
} from "@mailcollect/shared";
import type { MailSource, SendRequest, SendResult } from "@mailcollect/core/mail";
import { MailError, openStore, type Store } from "@mailcollect/core";
import { createApp } from "../app.js";
import { createEventBus, type EventBus, type OutboxWorkerPort, type ServerServices } from "../services.js";
import { createOutboxWorker, loadSendAccount } from "./send.js";

/**
 * 发信端点（C5 / AC-11/12/13）的 fixture 测试：真实 Store（临时 SQLite）+
 * 假 `MailSource`（Graph 发信端口）与假 outbox worker。SMTP 传输本身由 core 的
 * dispatch/smtp 测试覆盖，这里只验证「路由层如何接线、如何报告、如何清理」。
 */

const TOKEN = "test-token";

let dir: string;
let store: Store;
let app: ReturnType<typeof createApp>;
let events: EventBus;
let seen: ServerEvent[];

const baseServices = (): ServerServices => ({
  verifyAccount: vi.fn(async () => ({ ok: true, detail: "OK" })),
  loginAccount: vi.fn(async () => undefined),
  syncAccount: vi.fn(async () => undefined),
  extract: vi.fn(async () => ({ done: 0, total: 0 })),
  testLlm: vi.fn(async () => ({ ok: true, latencyMs: 1, detail: "pong" })),
  startBackground: vi.fn(),
  stopBackground: vi.fn(async () => undefined),
});

const buildApp = (options: { source?: MailSource; outbox?: OutboxWorkerPort } = {}): void => {
  events = createEventBus();
  seen = [];
  events.subscribe((event) => {
    seen.push(event);
  });
  const source = options.source;
  const outbox = options.outbox;
  app = createApp({
    store,
    services: {
      ...baseServices(),
      events,
      ...(source ? { mailSource: () => source } : {}),
      ...(outbox ? { outbox } : {}),
    },
    token: TOKEN,
    version: "test",
  });
};

const call = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("content-type", "application/json");
  return Promise.resolve(app.request(path, { ...init, headers }));
};

const bodyOf = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const postSend = (payload: unknown): Promise<Response> =>
  call("/api/send", { method: "POST", body: JSON.stringify(payload) });

interface FakeOutbox {
  readonly worker: OutboxWorkerPort;
  readonly kicks: { value: number };
}

const fakeOutbox = (): FakeOutbox => {
  const kicks = { value: 0 };
  return {
    kicks,
    worker: {
      kick: (): void => {
        kicks.value += 1;
      },
      stop: async (): Promise<void> => undefined,
    },
  };
};

const sendEvents = (): SendEventData[] =>
  seen
    .filter((event): event is { type: "send"; data: SendEventData } => event.type === "send")
    .map((event) => event.data);

const makeSource = (overrides: Partial<MailSource> = {}): MailSource => ({
  provider: "graph",
  verify: vi.fn(async () => ({ ok: true, detail: "OK" })),
  fetch: vi.fn(async () => ({ emails: [], cursor: null, hasMore: false })),
  close: vi.fn(async () => undefined),
  ...overrides,
});

const okResult = (overrides: Partial<Extract<SendResult, { ok: true }>> = {}): SendResult => ({
  ok: true,
  transport: "graph",
  messageId: null,
  savedToSent: "server",
  detail: "Graph 已发送（服务端保存到 Sent）",
  ...overrides,
});

const failResult = (error: MailError, detail = error.message): SendResult => ({
  ok: false,
  transport: "graph",
  savedToSent: "none",
  detail,
  error,
});

const graphSource = (sendViaGraph: (request: SendRequest) => Promise<SendResult>): MailSource =>
  makeSource({ sendViaGraph: vi.fn(sendViaGraph) });

const message = (patch: Partial<OutgoingMessage> = {}): OutgoingMessage => ({
  mode: "new",
  to: ["alice@example.com"],
  cc: [],
  bcc: [],
  subject: "周报",
  bodyText: "本周完成：A、B。",
  bodyHtml: null,
  attachments: [],
  includeSignature: true,
  replyToEmailId: null,
  ...patch,
});

const createGraphAccount = (config: Record<string, string> = {}): string =>
  store.createAccount({
    provider: "graph",
    label: "Outlook",
    email: "me@corp.com",
    config: { clientId: "client-abc", displayName: "张三", ...config },
    secret: "refresh-token",
  }).id;

const createImapAccount = (config: Record<string, string> = {}): string =>
  store.createAccount({
    provider: "imap",
    label: "公司邮箱",
    email: "me@corp.com",
    config: { host: "imap.corp.com", ...config },
    secret: "app-password",
  }).id;

const seedInbound = (targetAccountId: string, patch: Partial<RawEmail> = {}): string => {
  const id = "inbound-1";
  store.upsertEmails([
    {
      id,
      accountId: targetAccountId,
      uid: "uid-1",
      messageId: "<origin@corp.com>",
      threadId: null,
      fromName: "李雷",
      fromEmail: "lilei@corp.com",
      to: ["me@corp.com"],
      cc: [],
      subject: "预算确认",
      sentAt: "2026-11-02T09:00:00.000Z",
      bodyText: "请确认预算。",
      hasAttachments: false,
      headers: { references: "<root@corp.com>" },
      createdAt: "2026-11-02T09:00:01.000Z",
      ...patch,
    },
  ]);
  return id;
};

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mailcollect-send-"));
  store = await openStore(join(dir, "db.sqlite"), "device-test");
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/send", () => {
  it("sends, mirrors the message locally, emits SSE and reports sent", async () => {
    const accountId = createGraphAccount({ signature: "— 张三" });
    const sendViaGraph = vi.fn(async (_request: SendRequest) => okResult());
    buildApp({ source: makeSource({ sendViaGraph }) });

    const res = await postSend({ accountId, message: message(), draftId: "draft-1" });
    expect(res.status).toBe(200);
    const body = await bodyOf<SendMessageResponse>(res);
    expect(body).toMatchObject({ status: "sent", error: null });
    expect(body.outboxId).not.toBeNull();
    expect(body.emailId).not.toBeNull();
    expect(sendViaGraph).toHaveBeenCalledTimes(1);

    // 本地「已发送」镜像（dispatch 注入 store 写入）+ 签名 + From 固定账号地址。
    const mirrored = store.getEmail(body.emailId ?? "");
    expect(mirrored?.subject).toBe("周报");
    expect(mirrored?.fromEmail).toBe("me@corp.com");
    expect(mirrored?.bodyText).toContain("— 张三");
    expect(mirrored?.hasAttachments).toBe(false);

    // T70：镜像归位到 Sent 桶（无 Sent 角色行时字面 `Sent`），不再落 INBOX。
    expect(store.getEmailState(body.emailId ?? "")?.folder).toBe("Sent");
    const sentView = await bodyOf<{ items: Array<{ id: string }> }>(
      await call(`/api/messages?accountId=${accountId}&folder=Sent`),
    );
    expect(sentView.items.map((item) => item.id)).toEqual([body.emailId]);
    const inboxView = await bodyOf<{ items: Array<{ id: string }> }>(
      await call(`/api/messages?accountId=${accountId}&folder=INBOX`),
    );
    expect(inboxView.items).toHaveLength(0);

    // outbox 审计行已终态；SSE 有 sent 事件。
    expect(store.getOutboxItem(body.outboxId ?? "")?.status).toBe("sent");
    expect(sendEvents().some((event) => event.status === "sent" && event.emailId === body.emailId)).toBe(
      true,
    );
  });

  it("keeps Bcc out of the mirrored copy but passes it to dispatch", async () => {
    const accountId = createGraphAccount();
    let seenBcc: readonly string[] = [];
    const sendViaGraph = vi.fn(async (request: SendRequest) => {
      seenBcc = request.bcc;
      return okResult();
    });
    buildApp({ source: makeSource({ sendViaGraph }) });

    const res = await postSend({
      accountId,
      message: message({ bcc: ["secret@example.com"] }),
    });
    const body = await bodyOf<SendMessageResponse>(res);
    expect(body.status).toBe("sent");
    // 路由不裁剪 Bcc：通道投影（SMTP DATA 删头 / Graph 读 MIME）是 dispatch 的事。
    expect(seenBcc).toEqual(["secret@example.com"]);
    // 本地镜像只有 To/Cc（Bcc 不落可展示的副本）。
    const mirrored = store.getEmail(body.emailId ?? "");
    expect(mirrored?.to).toEqual(["alice@example.com"]);
    expect(JSON.stringify(mirrored)).not.toContain("secret@example.com");
  });

  it("maps the mirror into the real Sent role folder when a snapshot exists (T70)", async () => {
    const accountId = createGraphAccount();
    store.replaceFolders(accountId, [
      { accountId, path: "INBOX", role: "inbox", unread: 0 },
      { accountId, path: "[Gmail]/Sent Mail", role: "sent", unread: 0 },
    ]);
    buildApp({ source: makeSource({ sendViaGraph: vi.fn(async () => okResult()) }) });

    const body = await bodyOf<SendMessageResponse>(
      await postSend({ accountId, message: message() }),
    );
    expect(body.status).toBe("sent");
    // 归位到 store 里 Sent 角色的真实路径，而不是 INBOX、也不是固定字面值。
    expect(store.getEmailState(body.emailId ?? "")?.folder).toBe("[Gmail]/Sent Mail");

    const byRole = await bodyOf<{ items: Array<{ id: string }> }>(
      await call(`/api/messages?accountId=${accountId}&folder=sent`),
    );
    expect(byRole.items.map((item) => item.id)).toEqual([body.emailId]);
    const byName = await bodyOf<{ items: Array<{ id: string }> }>(
      await call(`/api/messages?accountId=${accountId}&folder=${encodeURIComponent("[Gmail]/Sent Mail")}`),
    );
    expect(byName.items.map((item) => item.id)).toEqual([body.emailId]);
    const inbox = await bodyOf<{ items: unknown[] }>(
      await call(`/api/messages?accountId=${accountId}&folder=INBOX`),
    );
    expect(inbox.items).toHaveLength(0);
  });

  it("puts the mirror in Sent for the EWS channel too (T70)", async () => {
    const accountId = store.createAccount({
      provider: "ews",
      label: "Exchange",
      email: "me@corp.com",
      config: { ewsUrl: "https://exchange.corp/EWS/Exchange.asmx" },
      secret: "exchange-password",
    }).id;
    const sendViaEws = vi.fn(async (_request: SendRequest) => ({
      ok: true as const,
      transport: "ews" as const,
      messageId: "ews-1",
      savedToSent: "server" as const,
      detail: "EWS 已发送并保存到 Sent",
    }));
    buildApp({ source: makeSource({ provider: "ews", sendViaEws }) });

    const body = await bodyOf<SendMessageResponse>(
      await postSend({ accountId, message: message() }),
    );
    expect(body.status).toBe("sent");
    expect(sendViaEws).toHaveBeenCalledTimes(1);
    expect(store.getEmailState(body.emailId ?? "")?.folder).toBe("Sent");
  });

  it("applies the per-account signature only when includeSignature is true (AC-13)", async () => {
    const accountId = createGraphAccount({ signature: "— 张三" });
    buildApp({ source: makeSource({ sendViaGraph: vi.fn(async () => okResult()) }) });

    const withSignature = await postSend({ accountId, message: message({ subject: "有签名" }) });
    const signed = await bodyOf<SendMessageResponse>(withSignature);
    expect(store.getEmail(signed.emailId ?? "")?.bodyText).toContain("— 张三");

    const withoutSignature = await postSend({
      accountId,
      message: message({ subject: "无签名", includeSignature: false }),
    });
    const unsigned = await bodyOf<SendMessageResponse>(withoutSignature);
    expect(store.getEmail(unsigned.emailId ?? "")?.bodyText).not.toContain("— 张三");
  });

  it("takes the dedicated SMTP password from the encrypted secret store", () => {
    const accountId = store.createAccount({
      provider: "imap",
      label: "公司邮箱",
      email: "me@corp.com",
      config: { host: "imap.corp.com" },
      secret: "inbound-secret-xyz",
      send: { smtpHost: "smtp.corp.com", smtpUser: "me", smtpPassword: "smtp-secret-abc" },
    }).id;

    const loaded = loadSendAccount(store, accountId);
    expect(loaded?.smtpPassword).toBe("smtp-secret-abc");
    expect(loaded?.account.secret).toBe("inbound-secret-xyz");

    // 没有单独设置发信密码的账号：route 传空串，dispatch 按契约回退收信 secret。
    const fallback = loadSendAccount(store, createImapAccount());
    expect(fallback?.smtpPassword).toBe("");
  });

  it("passes attachment payloads to the MIME builder and marks the mirror", async () => {
    const accountId = createGraphAccount();
    let capturedMime: Uint8Array | null = null;
    const sendViaGraph = vi.fn(async (request: SendRequest) => {
      capturedMime = request.mime;
      return okResult();
    });
    buildApp({ source: makeSource({ sendViaGraph }) });

    const res = await postSend({
      accountId,
      message: message({
        attachments: [
          {
            filename: "report.txt",
            mimeType: "text/plain",
            size: 5,
            dataBase64: Buffer.from("hello").toString("base64"),
          },
        ],
      }),
    });
    const body = await bodyOf<SendMessageResponse>(res);
    expect(body.status).toBe("sent");
    expect(store.getEmail(body.emailId ?? "")?.hasAttachments).toBe(true);
    expect(new TextDecoder().decode(capturedMime ?? new Uint8Array())).toContain("report.txt");
  });

  it("treats delivered-but-Sent-copy-failed as a success (no retry invitation)", async () => {
    const accountId = createGraphAccount();
    const sendViaGraph = vi.fn(async (_request: SendRequest) =>
      okResult({ savedToSent: "local", detail: "已投递；服务器 Sent 副本写入失败" }),
    );
    buildApp({ source: makeSource({ sendViaGraph }) });

    const res = await postSend({ accountId, message: message() });
    expect(res.status).toBe(200);
    const body = await bodyOf<SendMessageResponse>(res);
    expect(body.status).toBe("sent");
    expect(body.error).toBeNull();
    // 没有产生 queued/failed 的发件箱行，不会诱发重试。
    expect(store.listOutbox().filter((item) => item.status !== "sent")).toHaveLength(0);
  });

  it("returns a typed 401 for an auth failure and parks the message in the outbox", async () => {
    const accountId = createGraphAccount();
    const sendViaGraph = vi.fn(async (_request: SendRequest) =>
      failResult(new MailError("auth", "登录已失效，请重新授权", false)),
    );
    buildApp({ source: makeSource({ sendViaGraph }) });

    const res = await postSend({ accountId, message: message() });
    expect(res.status).toBe(401);
    const body = await bodyOf<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe("unauthorized");

    const rows = store.listOutbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("failed");
    expect(rows[0]?.lastError).toContain("登录已失效");
    // 不可重试的失败被停住（不自动重试）。
    expect(rows[0]?.nextAttemptAt).not.toBeNull();
    expect(Date.parse(rows[0]?.nextAttemptAt ?? "")).toBeGreaterThan(Date.now() + 30 * 24 * 3600_000);
  });

  it("returns a typed 502 for a non-auth non-retryable failure", async () => {
    const accountId = createImapAccount(); // 没有 smtpHost → dispatch 报 not_configured，不联网
    buildApp({ source: makeSource() });

    const res = await postSend({ accountId, message: message() });
    expect(res.status).toBe(502);
    const body = await bodyOf<{ error: { code: string } }>(res);
    expect(body.error.code).toBe("upstream_error");
    expect(store.listOutbox()[0]?.status).toBe("failed");
  });

  it("queues a retryable (offline) failure and kicks the worker (AC-12)", async () => {
    const accountId = createGraphAccount();
    const sendViaGraph = vi.fn(async (_request: SendRequest) => {
      throw new MailError("network", "连接被重置", true);
    });
    const outbox = fakeOutbox();
    buildApp({ source: makeSource({ sendViaGraph }), outbox: outbox.worker });
    outbox.kicks.value = 0; // app 装配时已 kick 过一次（重启恢复）

    const res = await postSend({ accountId, message: message() });
    expect(res.status).toBe(200);
    const body = await bodyOf<SendMessageResponse>(res);
    expect(body.status).toBe("queued");
    expect(body.outboxId).not.toBeNull();
    expect(body.emailId).toBeNull();

    const item = store.getOutboxItem(body.outboxId ?? "");
    expect(item?.status).toBe("queued");
    expect(outbox.kicks.value).toBe(1);
    expect(sendEvents().some((event) => event.status === "queued")).toBe(true);
  });

  it("supports queueOnly without attempting delivery", async () => {
    const accountId = createGraphAccount();
    const sendViaGraph = vi.fn(async (_request: SendRequest) => okResult());
    buildApp({ source: makeSource({ sendViaGraph }) });

    const res = await postSend({ accountId, message: message(), queueOnly: true });
    const body = await bodyOf<SendMessageResponse>(res);
    expect(body.status).toBe("queued");
    expect(sendViaGraph).not.toHaveBeenCalled();
    expect(store.getOutboxItem(body.outboxId ?? "")?.status).toBe("queued");
  });

  it("validates the request with typed 400/404 instead of a raw 500", async () => {
    const accountId = createGraphAccount();
    buildApp({ source: makeSource({ sendViaGraph: vi.fn(async () => okResult()) }) });

    const noRecipients = await postSend({
      accountId,
      message: message({ to: [], cc: [], bcc: [] }),
    });
    expect(noRecipients.status).toBe(400);
    expect((await bodyOf<{ error: { code: string } }>(noRecipients)).error.code).toBe(
      "invalid_input",
    );

    const badMode = await postSend({
      accountId,
      message: { ...message(), mode: "shout" },
    });
    expect(badMode.status).toBe(400);

    const unknownAccount = await postSend({ accountId: "nope", message: message() });
    expect(unknownAccount.status).toBe(404);

    const replyMissing = await postSend({
      accountId,
      message: message({ mode: "reply", replyToEmailId: "missing-email" }),
    });
    expect(replyMissing.status).toBe(404);
  });

  it("builds reply threading and quoting from the stored original", async () => {
    const accountId = createGraphAccount();
    seedInbound(accountId);
    buildApp({ source: makeSource({ sendViaGraph: vi.fn(async () => okResult()) }) });

    const res = await postSend({
      accountId,
      message: message({
        mode: "reply",
        replyToEmailId: "inbound-1",
        subject: "预算确认",
        to: ["lilei@corp.com"],
      }),
    });
    const body = await bodyOf<SendMessageResponse>(res);
    expect(body.status).toBe("sent");
    const mirrored = store.getEmail(body.emailId ?? "");
    expect(mirrored?.subject).toBe("Re: 预算确认");
    expect(mirrored?.threadId).toBe("<origin@corp.com>");
    expect(mirrored?.bodyText).toContain("> 请确认预算。");
  });

  it("never echoes the inbound or SMTP password in responses or outbox errors", async () => {
    const accountId = store.createAccount({
      provider: "graph",
      label: "Outlook",
      email: "me@corp.com",
      config: { clientId: "client-abc" },
      secret: "inbound-secret-xyz",
      send: { smtpPassword: "smtp-secret-abc" },
    }).id;
    const sendViaGraph = vi.fn(async (_request: SendRequest) =>
      failResult(new MailError("auth", "密码 smtp-secret-abc 被拒绝"), "密码 smtp-secret-abc 被拒绝"),
    );
    buildApp({ source: makeSource({ sendViaGraph }) });

    const res = await postSend({ accountId, message: message() });
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toContain("smtp-secret-abc");
    expect(text).not.toContain("inbound-secret-xyz");
    const outboxText = JSON.stringify(store.listOutbox());
    expect(outboxText).not.toContain("smtp-secret-abc");
    expect(outboxText).not.toContain("inbound-secret-xyz");
  });

  it("does not double-send when the same draftId is retried (idempotency)", async () => {
    const accountId = createGraphAccount();
    const sendViaGraph = vi.fn(async (_request: SendRequest) => okResult());
    buildApp({ source: makeSource({ sendViaGraph }) });

    const first = await postSend({ accountId, message: message(), draftId: "draft-1" });
    const firstBody = await bodyOf<SendMessageResponse>(first);
    const second = await postSend({ accountId, message: message(), draftId: "draft-1" });
    const secondBody = await bodyOf<SendMessageResponse>(second);

    expect(sendViaGraph).toHaveBeenCalledTimes(1);
    expect(secondBody.status).toBe("sent");
    expect(secondBody.emailId).toBe(firstBody.emailId);
  });

  it("sends the edited content fresh when the same key is retried with changes", async () => {
    const accountId = createGraphAccount();
    let online = false;
    const sendViaGraph = vi.fn(async (_request: SendRequest) => {
      if (!online) throw new MailError("network", "离线", true);
      return okResult();
    });
    buildApp({ source: makeSource({ sendViaGraph }) });

    const queued = await bodyOf<SendMessageResponse>(
      await postSend({ accountId, message: message({ subject: "初稿" }), draftId: "draft-1" }),
    );
    expect(queued.status).toBe("queued");
    expect(store.getOutboxItem(queued.outboxId ?? "")?.status).toBe("queued");

    // 用户改完稿再发：旧行从未投递，删掉它并按新内容重新投递。
    online = true;
    const sent = await bodyOf<SendMessageResponse>(
      await postSend({ accountId, message: message({ subject: "定稿" }), draftId: "draft-1" }),
    );
    expect(sent.status).toBe("sent");
    expect(store.getOutboxItem(queued.outboxId ?? "")).toBeNull();
    expect(store.getEmail(sent.emailId ?? "")?.subject).toBe("定稿");
  });

  it("refuses to silently drop an edit when the queued copy was already delivered", async () => {
    const accountId = createGraphAccount();
    const sendViaGraph = vi.fn(async (_request: SendRequest) => {
      throw new MailError("network", "离线", true);
    });
    buildApp({ source: makeSource({ sendViaGraph }) });

    const queued = await bodyOf<SendMessageResponse>(
      await postSend({ accountId, message: message({ subject: "初稿" }), draftId: "draft-1" }),
    );
    // 后台 worker 抢先投递了旧内容。
    store.markOutboxSent(queued.outboxId ?? "");

    const res = await postSend({
      accountId,
      message: message({ subject: "定稿" }),
      draftId: "draft-1",
    });
    expect(res.status).toBe(400);
    const body = await bodyOf<{ error: { code: string; message: string } }>(res);
    expect(body.error.code).toBe("invalid_input");
    expect(body.error.message).toContain("已由后台发送完成");
    expect(sendViaGraph).toHaveBeenCalledTimes(1);
  });

  it("reuses the queued outbox row on a same-key retry instead of enqueueing again", async () => {
    const accountId = createGraphAccount();
    const sendViaGraph = vi.fn(async (_request: SendRequest) => {
      throw new MailError("network", "离线", true);
    });
    const outbox = fakeOutbox();
    buildApp({ source: makeSource({ sendViaGraph }), outbox: outbox.worker });

    const first = await bodyOf<SendMessageResponse>(
      await postSend({ accountId, message: message(), draftId: "draft-1" }),
    );
    outbox.kicks.value = 0;
    const second = await bodyOf<SendMessageResponse>(
      await postSend({ accountId, message: message(), draftId: "draft-1" }),
    );

    expect(second.status).toBe("queued");
    expect(second.outboxId).toBe(first.outboxId);
    expect(store.listOutbox()).toHaveLength(1);
    expect(sendViaGraph).toHaveBeenCalledTimes(1);
    expect(outbox.kicks.value).toBe(1);
  });
});

describe("drafts", () => {
  it("upserts by (accountId, draftId): a second autosave updates, never duplicates (AC-11)", async () => {
    const accountId = createGraphAccount();
    buildApp();

    const first = await call("/api/drafts", {
      method: "PUT",
      body: JSON.stringify({ accountId, draftId: "draft-1", ...message({ subject: "初稿" }) }),
    });
    expect(first.status).toBe(200);
    const firstBody = await bodyOf<{ draft: Draft }>(first);
    expect(firstBody.draft.id).toBe("draft-1");
    expect(firstBody.draft.subject).toBe("初稿");

    const second = await call("/api/drafts", {
      method: "PUT",
      body: JSON.stringify({ accountId, draftId: "draft-1", ...message({ subject: "改过的稿" }) }),
    });
    const secondBody = await bodyOf<{ draft: Draft }>(second);
    expect(secondBody.draft.id).toBe("draft-1");
    expect(secondBody.draft.subject).toBe("改过的稿");

    const list = await call(`/api/drafts?accountId=${accountId}`);
    const listBody = await bodyOf<{ items: Draft[] }>(list);
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0]?.subject).toBe("改过的稿");
  });

  it("creates a server-side id when draftId is omitted, and restores after restart", async () => {
    const accountId = createGraphAccount();
    buildApp();

    const created = await call("/api/drafts", {
      method: "PUT",
      body: JSON.stringify({ accountId, ...message({ subject: "新草稿" }) }),
    });
    const createdBody = await bodyOf<{ draft: Draft }>(created);
    expect(createdBody.draft.id).not.toBe("");

    // 重启 = 新的 app，但同一份 SQLite；草稿必须还在。
    buildApp();
    const restored = await call(`/api/drafts/${createdBody.draft.id}`);
    expect(restored.status).toBe(200);
    expect((await bodyOf<{ draft: Draft }>(restored)).draft.subject).toBe("新草稿");
  });

  it("accepts an incomplete draft (no recipients) and deletes it", async () => {
    const accountId = createGraphAccount();
    buildApp();

    const saved = await call("/api/drafts", {
      method: "PUT",
      body: JSON.stringify({
        accountId,
        draftId: "draft-x",
        ...message({ to: [], cc: [], bcc: [], subject: "", bodyText: "" }),
      }),
    });
    expect(saved.status).toBe(200);

    const removed = await call("/api/drafts/draft-x", { method: "DELETE" });
    expect(removed.status).toBe(200);
    expect(store.getDraft("draft-x")).toBeNull();

    const again = await call("/api/drafts/draft-x", { method: "DELETE" });
    expect(again.status).toBe(404);
  });

  it("cleans the draft after a successful send", async () => {
    const accountId = createGraphAccount();
    buildApp({ source: makeSource({ sendViaGraph: vi.fn(async () => okResult()) }) });

    await call("/api/drafts", {
      method: "PUT",
      body: JSON.stringify({ accountId, draftId: "draft-1", ...message() }),
    });
    expect(store.getDraft("draft-1")).not.toBeNull();

    const sent = await postSend({ accountId, message: message(), draftId: "draft-1" });
    expect((await bodyOf<SendMessageResponse>(sent)).status).toBe("sent");
    expect(store.getDraft("draft-1")).toBeNull();
  });
});

describe("outbox endpoints", () => {
  it("enqueues a message for delivery and kicks the worker", async () => {
    const accountId = createGraphAccount();
    const outbox = fakeOutbox();
    buildApp({ outbox: outbox.worker });
    outbox.kicks.value = 0;

    const res = await call("/api/outbox", {
      method: "POST",
      body: JSON.stringify({ accountId, message: message() }),
    });
    expect(res.status).toBe(200);
    const body = await bodyOf<{ item: OutboxItem }>(res);
    expect(body.item.status).toBe("queued");
    expect(body.item.accountId).toBe(accountId);
    expect(outbox.kicks.value).toBe(1);
  });

  it("lists with filters and validates status", async () => {
    const accountId = createGraphAccount();
    buildApp();
    const queued = store.enqueueOutbox(accountId, message());
    const failed = store.enqueueOutbox(accountId, message());
    store.markOutboxFailed(failed.id, "SMTP 550");

    const all = await call(`/api/outbox?accountId=${accountId}`);
    expect((await bodyOf<{ items: OutboxItem[] }>(all)).items).toHaveLength(2);

    const onlyFailed = await call(`/api/outbox?status=failed`);
    const failedItems = (await bodyOf<{ items: OutboxItem[] }>(onlyFailed)).items;
    expect(failedItems.map((item) => item.id)).toEqual([failed.id]);

    const badStatus = await call("/api/outbox?status=bogus");
    expect(badStatus.status).toBe(400);

    const unknownAccount = await call("/api/outbox?accountId=nope");
    expect(unknownAccount.status).toBe(404);
    expect(store.getOutboxItem(queued.id)?.status).toBe("queued");
  });

  it("retries a failed row manually and refuses to retry a sent one", async () => {
    const accountId = createGraphAccount();
    const outbox = fakeOutbox();
    buildApp({ outbox: outbox.worker });
    const failed = store.enqueueOutbox(accountId, message());
    store.markOutboxFailed(failed.id, "连接失败");
    expect(store.getOutboxItem(failed.id)?.status).toBe("failed");

    outbox.kicks.value = 0;
    const retry = await call(`/api/outbox/${failed.id}/retry`, { method: "POST" });
    expect(retry.status).toBe(200);
    const retryBody = await bodyOf<{ item: OutboxItem }>(retry);
    expect(retryBody.item.status).toBe("queued");
    expect(retryBody.item.nextAttemptAt).toBeNull();
    expect(retryBody.item.lastError).toBeNull();
    expect(outbox.kicks.value).toBe(1);

    const sent = store.enqueueOutbox(accountId, message());
    store.markOutboxSent(sent.id);
    const refused = await call(`/api/outbox/${sent.id}/retry`, { method: "POST" });
    expect(refused.status).toBe(400);

    const unknown = await call("/api/outbox/nope/retry", { method: "POST" });
    expect(unknown.status).toBe(404);
  });

  it("deletes a row and returns the removed snapshot", async () => {
    const accountId = createGraphAccount();
    buildApp();
    const item = store.enqueueOutbox(accountId, message());

    const res = await call(`/api/outbox/${item.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((await bodyOf<{ item: OutboxItem }>(res)).item.id).toBe(item.id);
    expect(store.getOutboxItem(item.id)).toBeNull();

    const again = await call(`/api/outbox/${item.id}`, { method: "DELETE" });
    expect(again.status).toBe(404);
  });
});

describe("outbox worker (AC-12)", () => {
  it("drives queued → sending → sent and mirrors the sent message", async () => {
    const accountId = createGraphAccount();
    const source = makeSource({ sendViaGraph: vi.fn(async () => okResult()) });
    const workerEvents: ServerEvent[] = [];
    const worker = createOutboxWorker({
      store,
      mailSource: () => source,
      emit: (event) => workerEvents.push(event),
    });
    const item = store.enqueueOutbox(accountId, message());

    const result = await worker.drain();
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(store.getOutboxItem(item.id)?.status).toBe("sent");
    expect(store.getOutboxItem(item.id)?.sentAt).not.toBeNull();
    const statuses = workerEvents
      .filter((event) => event.type === "send")
      .map((event) => (event.type === "send" ? event.data.status : ""));
    expect(statuses).toEqual(["sending", "sent"]);
    // 本地 Sent 镜像也写了（subject 唯一即可），并且由 worker 路径同样归位到 Sent（T70）。
    const mirrored = store.listEmails({ search: "周报" }).items[0];
    expect(mirrored).toBeDefined();
    expect(store.getEmailState(mirrored?.id ?? "")?.folder).toBe("Sent");
    await worker.stop();
  });

  it("marks a retryable failure failed with a ≥30s backoff, then succeeds on retry", async () => {
    const accountId = createGraphAccount();
    let attempt = 0;
    const source = makeSource({
      sendViaGraph: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new MailError("network", "离线", true);
        return okResult();
      }),
    });
    const worker = createOutboxWorker({ store, mailSource: () => source });
    const item = store.enqueueOutbox(accountId, message());

    await worker.drain();
    const failed = store.getOutboxItem(item.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.attempts).toBe(1);
    expect(failed?.lastError).toBe("离线");
    const backoff = Date.parse(failed?.nextAttemptAt ?? "") - Date.now();
    expect(backoff).toBeGreaterThanOrEqual(29_000); // ≥30s（允许几毫秒执行误差）

    // 退避未到：第二轮不认领这一行。
    await worker.drain();
    expect(store.getOutboxItem(item.id)?.status).toBe("failed");

    // 手动重试 + 恢复网络。
    store.retryOutbox(item.id);
    const retried = await worker.drain();
    expect(retried).toEqual({ sent: 1, failed: 0 });
    expect(store.getOutboxItem(item.id)?.status).toBe("sent");
    await worker.stop();
  });

  it("parks a non-retryable failure instead of auto-retrying it", async () => {
    const accountId = createGraphAccount();
    const source = makeSource({
      sendViaGraph: vi.fn(async () => failResult(new MailError("auth", "凭据被拒绝", false))),
    });
    const worker = createOutboxWorker({ store, mailSource: () => source });
    const item = store.enqueueOutbox(accountId, message());

    await worker.drain();
    const parked = store.getOutboxItem(item.id);
    expect(parked?.status).toBe("failed");
    expect(Date.parse(parked?.nextAttemptAt ?? "")).toBeGreaterThan(Date.now() + 30 * 24 * 3600_000);

    const second = await worker.drain();
    expect(second).toEqual({ sent: 0, failed: 0 });
    await worker.stop();
  });

  it("recovers a `sending` row left by a crash and delivers it after restart", async () => {
    const accountId = createGraphAccount();
    const item = store.enqueueOutbox(accountId, message());
    // 模拟上一进程在投递中被杀：行停在 sending。
    store.claimNextOutbox();
    expect(store.getOutboxItem(item.id)?.status).toBe("sending");

    // 「重启」：新 worker 构造时 recoverOutbox 把 sending 拉回 queued。
    const source = makeSource({ sendViaGraph: vi.fn(async () => okResult()) });
    const worker = createOutboxWorker({ store, mailSource: () => source });
    expect(store.getOutboxItem(item.id)?.status).toBe("queued");

    const result = await worker.drain();
    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(store.getOutboxItem(item.id)?.status).toBe("sent");
    await worker.stop();
  });

  it("delivers a row that was queued before the restart", async () => {
    const accountId = createGraphAccount();
    const item = store.enqueueOutbox(accountId, message());
    // 新进程（新 worker）启动：queued 行仍在，drain 后投递成功。
    const source = makeSource({ sendViaGraph: vi.fn(async () => okResult()) });
    const worker = createOutboxWorker({ store, mailSource: () => source });
    expect(store.getOutboxItem(item.id)?.status).toBe("queued");
    await worker.drain();
    expect(store.getOutboxItem(item.id)?.status).toBe("sent");
    await worker.stop();
  });

  it("leaves the queue untouched when no adapter factory is wired", async () => {
    const accountId = createGraphAccount();
    const item = store.enqueueOutbox(accountId, message());
    const worker = createOutboxWorker({ store });
    const result = await worker.drain();
    expect(result).toEqual({ sent: 0, failed: 0 });
    expect(store.getOutboxItem(item.id)?.status).toBe("queued");
    await worker.stop();
  });
});
