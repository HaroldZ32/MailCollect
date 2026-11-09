import { describe, expect, it } from "vitest";
import type { OutgoingMessage, RawEmail } from "@mailcollect/shared";
import { makeAccount } from "../test-support.js";
import { MailError, type SendRequest, type SendResult } from "../types.js";
import { dispatchSend, resolveSendChannel, smtpConfigForAccount, type SendSourcePort } from "./dispatch.js";
import { ScriptedSmtpWire, smtpReply } from "./test-support.js";
import type { SentMirrorPort } from "./sent-mirror.js";
import type { SmtpDelivery, SmtpTransportPort } from "./smtp.js";

/**
 * 发送落点验收（AC-10）：SMTP 成功 → 本地镜像 + IMAP APPEND；APPEND 失败只留本地；
 * Graph 不再 APPEND；EWS 走 CreateItem；POP3 仅本地。
 */

class FakeStore implements SentMirrorPort {
  readonly written: RawEmail[] = [];
  fail = false;

  upsertEmails(emails: readonly RawEmail[]): { inserted: number; ids: readonly string[] } {
    if (this.fail) throw new Error("SQLITE_FULL: disk full");
    this.written.push(...emails);
    return { inserted: emails.length, ids: emails.map((email) => email.id) };
  }
}

class FakeSource implements SendSourcePort {
  readonly appendCalls: SendRequest[] = [];
  readonly graphCalls: SendRequest[] = [];
  readonly ewsCalls: SendRequest[] = [];
  appendResult: SendResult = {
    ok: true,
    transport: "imap",
    messageId: "42",
    savedToSent: "server",
    detail: "已写入服务器「已发送」：Sent",
  };
  graphResult: SendResult = {
    ok: true,
    transport: "graph",
    messageId: null,
    savedToSent: "server",
    detail: "Graph 已发送（1 个收件人，服务端保存到 Sent）",
  };
  ewsResult: SendResult = {
    ok: true,
    transport: "ews",
    messageId: "ews-1",
    savedToSent: "server",
    detail: "EWS 已发送并保存到 Sent",
  };
  appendThrow: unknown = null;

  async appendSent(request: SendRequest): Promise<SendResult> {
    this.appendCalls.push(request);
    if (this.appendThrow !== null) throw this.appendThrow;
    return this.appendResult;
  }

  async sendViaGraph(request: SendRequest): Promise<SendResult> {
    this.graphCalls.push(request);
    return this.graphResult;
  }

  async sendViaEws(request: SendRequest): Promise<SendResult> {
    this.ewsCalls.push(request);
    return this.ewsResult;
  }
}

class FakeSmtp implements SmtpTransportPort {
  readonly calls: SendRequest[] = [];
  error: unknown = null;

  async send(request: SendRequest): Promise<SmtpDelivery> {
    this.calls.push(request);
    if (this.error !== null) throw this.error;
    return { accepted: ["alice@example.com"], detail: "SMTP 已投递（1 个收件人）" };
  }
}

function outgoing(overrides: Partial<OutgoingMessage> = {}): OutgoingMessage {
  return {
    mode: "new",
    to: ["alice@example.com"],
    cc: [],
    bcc: [],
    subject: "Hello",
    bodyText: "正文",
    bodyHtml: null,
    attachments: [],
    includeSignature: true,
    replyToEmailId: null,
    ...overrides,
  };
}

const imapAccount = () =>
  makeAccount(
    "imap",
    { smtpHost: "smtp.example.com", smtpPort: "587", smtpUser: "me@example.com" },
    "s3cret-app-password",
  );

describe("dispatchSend — SMTP / IMAP", () => {
  it("成功后写本地镜像并 APPEND 到服务器 Sent", async () => {
    const account = imapAccount();
    const source = new FakeSource();
    const store = new FakeStore();
    const smtp = new FakeSmtp();

    const outcome = await dispatchSend({
      account,
      source,
      store,
      message: outgoing({ bcc: ["carol@example.com"] }),
      smtpTransport: smtp,
      messageId: "<fixed@example.com>",
      sentAt: "2026-11-09T03:00:00.000Z",
    });

    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) throw new Error("期望发送成功");
    expect(outcome.result.transport).toBe("smtp");
    expect(outcome.result.savedToSent).toBe("server");
    expect(outcome.result.messageId).toBe("42");
    expect(outcome.result.detail).toContain("服务器「已发送」已写入");

    expect(smtp.calls).toHaveLength(1);
    // 信封 Bcc 交给 SMTP；MIME 头部里的 Bcc 也由 buildMime 写入（Graph 路径需要）。
    expect(smtp.calls[0]?.bcc).toEqual(["carol@example.com"]);
    expect(source.appendCalls).toHaveLength(1);
    expect(source.appendCalls[0]?.to).toEqual(["alice@example.com"]);
    expect(source.graphCalls).toHaveLength(0);

    expect(store.written).toHaveLength(1);
    const mirrored = store.written[0];
    if (mirrored === undefined) throw new Error("镜像丢失");
    expect(mirrored.accountId).toBe(account.id);
    expect(mirrored.fromEmail).toBe(account.email);
    expect(mirrored.to).toEqual(["alice@example.com"]);
    expect(mirrored.subject).toBe("Hello");
    expect(mirrored.messageId).toBe("<fixed@example.com>");
    expect(mirrored.sentAt).toBe("2026-11-09T03:00:00.000Z");
    expect(mirrored.uid).toBe("fixed@example.com");
    expect(outcome.emailId).toBe(mirrored.id);
    expect(outcome.messageId).toBe("<fixed@example.com>");
  });

  it("APPEND 失败：邮件仍算已发送，只留本地并给出可读提示", async () => {
    const source = new FakeSource();
    source.appendResult = {
      ok: false,
      transport: "imap",
      savedToSent: "local",
      detail: "IMAP APPEND 被服务器拒绝",
      error: new MailError("protocol", "IMAP APPEND 被服务器拒绝", true),
    };
    const store = new FakeStore();

    const outcome = await dispatchSend({
      account: imapAccount(),
      source,
      store,
      message: outgoing(),
      smtpTransport: new FakeSmtp(),
    });

    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) throw new Error("期望发送成功");
    expect(outcome.result.savedToSent).toBe("local");
    expect(outcome.result.detail).toContain("服务器「已发送」写入失败");
    expect(outcome.result.detail).toContain("本地「已发送」保留副本");
    expect(outcome.emailId).not.toBeNull();
    expect(store.written).toHaveLength(1);
  });

  it("APPEND 抛异常也不会击穿发信结果", async () => {
    const source = new FakeSource();
    source.appendThrow = new MailError("network", "IMAP 连接断开", true);

    const outcome = await dispatchSend({
      account: imapAccount(),
      source,
      store: new FakeStore(),
      message: outgoing(),
      smtpTransport: new FakeSmtp(),
    });

    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) throw new Error("期望发送成功");
    expect(outcome.result.savedToSent).toBe("local");
    expect(outcome.result.detail).toContain("IMAP 连接断开");
  });

  it("SMTP 失败：ok:false、不写镜像、密码不出现在文案", async () => {
    const smtp = new FakeSmtp();
    smtp.error = new MailError("auth", "SMTP 认证失败：服务器拒绝了用户名或密码", false);
    const store = new FakeStore();

    const outcome = await dispatchSend({
      account: imapAccount(),
      source: new FakeSource(),
      store,
      message: outgoing(),
      smtpTransport: smtp,
    });

    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("期望发送失败");
    expect(outcome.result.savedToSent).toBe("none");
    expect(outcome.result.error.code).toBe("auth");
    expect(outcome.result.detail).not.toContain("s3cret-app-password");
    expect(outcome.emailId).toBeNull();
    expect(store.written).toHaveLength(0);
  });

  it("缺 smtpHost 时给 not_configured，而不是连接失败的混乱报错", async () => {
    const outcome = await dispatchSend({
      account: makeAccount("imap", {}, "s3cret-app-password"),
      source: new FakeSource(),
      store: new FakeStore(),
      message: outgoing(),
      smtpTransport: new FakeSmtp(),
    });

    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("期望发送失败");
    expect(outcome.result.error.code).toBe("not_configured");
    expect(outcome.result.detail).toContain("smtpHost");
  });

  it("专用 SMTP 密码：AUTH 用 smtpPassword，DATA 无 Bcc，RCPT 仍投递 bcc，本地镜像无 bcc", async () => {
    const account = makeAccount(
      "imap",
      { smtpHost: "smtp.example.com", smtpPort: "587", smtpUser: "me@example.com" },
      "recv-secret",
    );
    const wire = new ScriptedSmtpWire([
      smtpReply(220, "smtp.example.com"),
      smtpReply(250, "smtp.example.com", "STARTTLS", "AUTH PLAIN"),
      smtpReply(220, "ready"),
      smtpReply(250, "smtp.example.com", "AUTH PLAIN"),
      smtpReply(235, "ok"),
      smtpReply(250, "sender ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(250, "recipient ok"),
      smtpReply(354, "go"),
      smtpReply(250, "queued"),
      smtpReply(221, "bye"),
    ]);
    const store = new FakeStore();

    const outcome = await dispatchSend({
      account,
      source: new FakeSource(),
      store,
      message: outgoing({ bcc: ["carol@example.com"] }),
      smtpPassword: "send-secret",
      smtpWireFactory: async () => wire,
      messageId: "<dedicated@example.com>",
    });

    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) throw new Error("期望发送成功");
    expect(outcome.result.savedToSent).toBe("server");

    // 专用密码真的用于 AUTH（而不是收信 secret）。
    const auth = wire.transcript.find((line) => line.startsWith("AUTH PLAIN "));
    expect(auth).toBeDefined();
    const decoded = Buffer.from(auth!.slice("AUTH PLAIN ".length), "base64").toString("utf8");
    expect(decoded).toBe("\u0000me@example.com\u0000send-secret");
    expect(wire.text()).not.toContain("recv-secret");

    // 线上 DATA 没有盲抄名单，但信封 RCPT 仍到 bcc。
    expect(wire.payloadText()).not.toMatch(/^Bcc:/mi);
    expect(wire.transcript).toContain("RCPT TO:<carol@example.com>");

    // 本地镜像只有 to/cc，bcc 地址不落库。
    const mirrored = store.written[0];
    if (mirrored === undefined) throw new Error("镜像丢失");
    expect(mirrored.to).toEqual(["alice@example.com"]);
    expect(mirrored.cc).toEqual([]);
    expect(mirrored.headers.bcc).toBeUndefined();
    expect(JSON.stringify(mirrored)).not.toContain("carol@example.com");
  });

  it("smtpPassword 进 redact 列表：传输层原始错误不泄漏专用密码", async () => {
    const smtp = new FakeSmtp();
    smtp.error = new Error("AUTH failed while using send-secret");
    const outcome = await dispatchSend({
      account: makeAccount(
        "imap",
        { smtpHost: "smtp.example.com", smtpPort: "587", smtpUser: "me@example.com" },
        "recv-secret",
      ),
      source: new FakeSource(),
      store: new FakeStore(),
      message: outgoing(),
      smtpTransport: smtp,
      smtpPassword: "send-secret",
    });

    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("期望发送失败");
    expect(outcome.result.detail).not.toContain("send-secret");
    expect(outcome.result.detail).toContain("***");
  });

  it("本地镜像写入失败不影响已发送事实，但明确告知", async () => {
    const store = new FakeStore();
    store.fail = true;

    const outcome = await dispatchSend({
      account: imapAccount(),
      source: new FakeSource(),
      store,
      message: outgoing(),
      smtpTransport: new FakeSmtp(),
    });

    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) throw new Error("期望发送成功");
    expect(outcome.emailId).toBeNull();
    // APPEND 成功时服务器端副本存在，落点仍是 server；只是本地镜像缺失。
    expect(outcome.result.savedToSent).toBe("server");
    expect(outcome.result.detail).toContain("镜像写入失败");
    expect(outcome.result.detail).not.toContain("s3cret-app-password");
  });
});

describe("dispatchSend — POP3", () => {
  it("只保留本地副本，不尝试服务器 Sent", async () => {
    const source = new FakeSource();
    const outcome = await dispatchSend({
      account: makeAccount("pop3", { smtpHost: "smtp.example.com" }, "s3cret-app-password"),
      source,
      store: new FakeStore(),
      message: outgoing(),
      smtpTransport: new FakeSmtp(),
    });

    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) throw new Error("期望发送成功");
    expect(outcome.result.savedToSent).toBe("local");
    expect(outcome.result.detail).toContain("POP3");
    expect(source.appendCalls).toHaveLength(0);
  });
});

describe("dispatchSend — Graph", () => {
  it("走 sendViaGraph，服务端已保存 Sent，绝不再 APPEND", async () => {
    const source = new FakeSource();
    const store = new FakeStore();
    const outcome = await dispatchSend({
      account: makeAccount("graph", {}, "unused"),
      source,
      store,
      message: outgoing(),
    });

    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) throw new Error("期望发送成功");
    expect(outcome.result.transport).toBe("graph");
    expect(outcome.result.savedToSent).toBe("server");
    expect(source.graphCalls).toHaveLength(1);
    expect(source.appendCalls).toHaveLength(0);
    expect(store.written).toHaveLength(1);
    expect(outcome.emailId).not.toBeNull();
  });

  it("Graph 路径保留 Bcc 头（服务端靠 MIME 头投递盲抄）", async () => {
    const source = new FakeSource();
    await dispatchSend({
      account: makeAccount("graph", {}, "unused"),
      source,
      store: new FakeStore(),
      message: outgoing({ bcc: ["carol@example.com"] }),
    });
    const sent = source.graphCalls[0];
    if (sent === undefined) throw new Error("没有调用 sendViaGraph");
    expect(Buffer.from(sent.mime).toString("utf8")).toContain("Bcc: carol@example.com");
  });

  it("适配器失败时原样返回类型化错误且不写镜像", async () => {
    const source = new FakeSource();
    source.graphResult = {
      ok: false,
      transport: "graph",
      savedToSent: "none",
      detail: "缺少 Mail.Send 权限",
      error: new MailError("auth", "缺少 Mail.Send 权限或授权已失效", false),
    };
    const store = new FakeStore();
    const outcome = await dispatchSend({
      account: makeAccount("graph", {}, "unused"),
      source,
      store,
      message: outgoing(),
    });

    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("期望发送失败");
    expect(outcome.result.error.code).toBe("auth");
    expect(store.written).toHaveLength(0);
  });

  it("适配器没有 sendViaGraph 时给 not_configured，不崩溃", async () => {
    const outcome = await dispatchSend({
      account: makeAccount("graph", {}, "unused"),
      source: {},
      store: new FakeStore(),
      message: outgoing(),
    });

    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("期望发送失败");
    expect(outcome.result.error.code).toBe("not_configured");
    expect(outcome.result.transport).toBe("graph");
  });
});

describe("dispatchSend — EWS", () => {
  it("走 sendViaEws（CreateItem），不 APPEND", async () => {
    const source = new FakeSource();
    const outcome = await dispatchSend({
      account: makeAccount("ews", { ewsUrl: "https://exchange.example.com/EWS/Exchange.asmx" }, "s3cret-app-password"),
      source,
      store: new FakeStore(),
      message: outgoing(),
    });

    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) throw new Error("期望发送成功");
    expect(outcome.result.transport).toBe("ews");
    expect(outcome.result.savedToSent).toBe("server");
    expect(source.ewsCalls).toHaveLength(1);
    expect(source.appendCalls).toHaveLength(0);
  });

  it("EWS 路径保留 Bcc 头（CreateItem 依赖 MIME 头）", async () => {
    const source = new FakeSource();
    await dispatchSend({
      account: makeAccount("ews", { ewsUrl: "https://exchange.example.com/EWS/Exchange.asmx" }, "pw"),
      source,
      store: new FakeStore(),
      message: outgoing({ bcc: ["carol@example.com"] }),
    });
    const sent = source.ewsCalls[0];
    if (sent === undefined) throw new Error("没有调用 sendViaEws");
    expect(Buffer.from(sent.mime).toString("utf8")).toContain("Bcc: carol@example.com");
  });

  it("适配器没有 CreateItem 端口但配了 SMTP 时，退回 SMTP 并明说只留本地", async () => {
    const outcome = await dispatchSend({
      account: makeAccount("ews", { smtpHost: "smtp.example.com" }, "s3cret-app-password"),
      source: {},
      store: new FakeStore(),
      message: outgoing(),
      smtpTransport: new FakeSmtp(),
    });

    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) throw new Error("期望发送成功");
    expect(outcome.result.transport).toBe("smtp");
    expect(outcome.result.savedToSent).toBe("local");
    expect(outcome.result.detail).toContain("CreateItem");
  });
});

describe("dispatchSend — 回复", () => {
  it("MIME 线程头与本镜像的 in-reply-to/threadId 保持一致", async () => {
    const store = new FakeStore();
    const outcome = await dispatchSend({
      account: imapAccount(),
      source: new FakeSource(),
      store,
      message: outgoing({ mode: "reply", subject: "Hello", bodyText: "收到" }),
      original: {
        messageId: "<orig@example.com>",
        references: ["<root@example.com>"],
        fromName: "Alice",
        fromEmail: "alice@example.com",
        bodyText: "原始内容",
      },
      smtpTransport: new FakeSmtp(),
      messageId: "<reply@example.com>",
    });

    expect(outcome.result.ok).toBe(true);
    if (!outcome.result.ok) throw new Error("期望发送成功");
    const mirrored = store.written[0];
    if (mirrored === undefined) throw new Error("镜像丢失");
    expect(mirrored.subject).toBe("Re: Hello");
    expect(mirrored.headers["in-reply-to"]).toBe("<orig@example.com>");
    expect(mirrored.headers.references).toBe("<root@example.com> <orig@example.com>");
    expect(mirrored.threadId).toBe("<orig@example.com>");
    expect(mirrored.bodyText).toContain("> 原始内容");
  });

  it("MIME 构造失败（没有收件人）返回类型化失败且不落镜像", async () => {
    const store = new FakeStore();
    const outcome = await dispatchSend({
      account: imapAccount(),
      source: new FakeSource(),
      store,
      message: outgoing({ to: [], cc: [], bcc: [] }),
      smtpTransport: new FakeSmtp(),
    });

    expect(outcome.result.ok).toBe(false);
    if (outcome.result.ok) throw new Error("期望发送失败");
    expect(outcome.result.error.code).toBe("protocol");
    expect(store.written).toHaveLength(0);
  });
});

describe("发信配置解析", () => {
  it("端口未写时保守取隐式 TLS（465），显式 587 走 STARTTLS，用户名缺省用账号邮箱", () => {
    const conservative = smtpConfigForAccount(makeAccount("imap", { smtpHost: "smtp.example.com" }, "pw"));
    expect(conservative).not.toBeNull();
    expect(conservative?.port).toBe(465);
    expect(conservative?.secure).toBe(true);
    expect(conservative?.user).toBe("user@example.com");

    const starttls = smtpConfigForAccount(
      makeAccount("imap", { smtpHost: "smtp.example.com", smtpPort: "587" }, "pw"),
    );
    expect(starttls?.port).toBe(587);
    expect(starttls?.secure).toBe(false);

    const implicit = smtpConfigForAccount(
      makeAccount("imap", { smtpHost: "smtp.example.com", smtpPort: "465", smtpSecure: "true" }, "pw"),
    );
    expect(implicit?.port).toBe(465);
    expect(implicit?.secure).toBe(true);
  });

  it("专用 smtpPassword 优先；缺省/空白回退收信 secret", () => {
    const account = makeAccount("imap", { smtpHost: "smtp.example.com" }, "recv-secret");
    expect(smtpConfigForAccount(account, "send-secret")?.password).toBe("send-secret");
    expect(smtpConfigForAccount(account)?.password).toBe("recv-secret");
    expect(smtpConfigForAccount(account, "")?.password).toBe("recv-secret");
    expect(smtpConfigForAccount(account, "   ")?.password).toBe("recv-secret");
    expect(smtpConfigForAccount(account, null)?.password).toBe("recv-secret");
  });

  it("没有 smtpHost 时返回 null", () => {
    expect(smtpConfigForAccount(makeAccount("imap", {}, "pw"))).toBeNull();
  });

  it("选路：graph→graph，ews 有端口才走 ews，其余 smtp", () => {
    expect(resolveSendChannel(makeAccount("graph", {}, "x"), {})).toBe("graph");
    expect(resolveSendChannel(makeAccount("ews", {}, "x"), {})).toBe("smtp");
    expect(resolveSendChannel(makeAccount("ews", {}, "x"), new FakeSource())).toBe("ews");
    expect(resolveSendChannel(makeAccount("imap", {}, "x"), {})).toBe("smtp");
    expect(resolveSendChannel(makeAccount("pop3", {}, "x"), {})).toBe("smtp");
  });
});
