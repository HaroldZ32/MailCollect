import { describe, expect, it } from "vitest";
import type { Pop3ClientLike } from "./pop3.js";
import { Pop3MailSource } from "./pop3.js";
import { makeAccount, rawEmail } from "./test-support.js";
import type { MailSource } from "./types.js";
import { MailError } from "./types.js";

/** 一封 multipart/mixed：html 正文 + 一个 base64 附件。 */
function mimeWithAttachment(options: {
  readonly subject?: string;
  readonly html?: string;
  readonly filename?: string;
  readonly content?: string;
}): string {
  const boundary = "b1";
  const filename = options.filename ?? "note.txt";
  const content = options.content ?? "attachment-bytes";
  return [
    "Message-ID: <m1@example.com>",
    "From: Alice <alice@example.com>",
    "To: user@example.com",
    `Subject: ${options.subject ?? "Hello"}`,
    "Date: 04 Nov 2026 09:00:00 +0800",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "",
    options.html ?? "<p>hi</p>",
    `--${boundary}`,
    `Content-Type: text/plain; name="${filename}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${filename}"`,
    "",
    Buffer.from(content, "utf8").toString("base64"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** 结构兼容 node-pop3 的假客户端：只实现适配器会调用的四个命令（没有 DELE）。 */
class FakePop3Client implements Pop3ClientLike {
  readonly retrCalls: number[] = [];
  uidlCalls = 0;
  quitCalls = 0;
  uidl: string[][] = [];
  messages = new Map<number, string>();
  statError: unknown = null;
  uidlError: unknown = null;
  retrError: unknown = null;

  async STAT(): Promise<string> {
    if (this.statError !== null) throw this.statError;
    return `+OK ${this.messages.size} 2048`;
  }

  async UIDL(): Promise<string[][]> {
    this.uidlCalls += 1;
    if (this.uidlError !== null) throw this.uidlError;
    return this.uidl;
  }

  async RETR(msgNumber: number): Promise<string> {
    this.retrCalls.push(msgNumber);
    if (this.retrError !== null) throw this.retrError;
    return this.messages.get(msgNumber) ?? rawEmail();
  }

  async QUIT(): Promise<string> {
    this.quitCalls += 1;
    return "+OK";
  }
}

function buildSource(client: FakePop3Client): Pop3MailSource {
  return new Pop3MailSource(makeAccount("pop3", { host: "pop3.example.com" }), { createClient: () => client });
}

describe("Pop3MailSource", () => {
  it("用 UIDL 去重：第二次同步只 RETR 新出现的邮件", async () => {
    const client = new FakePop3Client();
    client.uidl = [
      ["1", "u1"],
      ["2", "u2"],
      ["3", "u3"],
    ];
    client.messages = new Map([
      [1, rawEmail({ messageId: "a@example.com", subject: "a", body: "body a" })],
      [2, rawEmail({ messageId: "b@example.com", subject: "b", body: "body b" })],
      [3, rawEmail({ messageId: "c@example.com", subject: "c", body: "body c" })],
    ]);
    const source = buildSource(client);

    const first = await source.fetch();
    // 最新优先：先拿最近的邮件
    expect(first.emails.map((email) => email.uid)).toEqual(["u3", "u2", "u1"]);
    expect(first.cursor?.value.startsWith("v1:[")).toBe(true);
    expect(first.hasMore).toBe(false);

    client.uidl = [
      ["1", "u1"],
      ["2", "u2"],
      ["3", "u3"],
      ["4", "u4"],
    ];
    client.messages.set(4, rawEmail({ messageId: "d@example.com", subject: "d", body: "body d" }));

    const second = await source.fetch({ since: first.cursor ?? undefined });

    expect(client.retrCalls).toEqual([3, 2, 1, 4]);
    expect(second.emails.map((email) => email.uid)).toEqual(["u4"]);
    await source.close();
  });

  it("watch() 返回 null：POP3 没有推送能力", async () => {
    const client = new FakePop3Client();
    const source = buildSource(client);
    await expect(source.watch(() => undefined)).resolves.toBeNull();
    await source.close();
  });

  it("limit 截断本批并报告 hasMore", async () => {
    const client = new FakePop3Client();
    client.uidl = ["u1", "u2", "u3", "u4", "u5"].map((uidl, index) => [String(index + 1), uidl]);
    const source = buildSource(client);

    const result = await source.fetch({ limit: 2 });

    expect(client.retrCalls).toEqual([5, 4]);
    expect(result.emails).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    await source.close();
  });

  it("认证失败映射为 auth 且错误信息不含 secret", async () => {
    const client = new FakePop3Client();
    client.uidlError = new Error("-ERR [AUTH] Authentication failed for s3cret-app-password");
    const source = buildSource(client);

    const failure = await source.fetch().then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(MailError);
    if (failure instanceof MailError) {
      expect(failure.code).toBe("auth");
      expect(failure.message).not.toContain("s3cret-app-password");
    }
  });

  it("超时类错误映射为可重试的 network", async () => {
    const client = new FakePop3Client();
    client.retrError = Object.assign(new Error("socket timeout"), { code: "ETIMEDOUT" });
    client.uidl = [["1", "u1"]];
    client.messages.set(1, rawEmail());
    const source = buildSource(client);

    const failure = await source.fetch().then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(MailError);
    if (failure instanceof MailError) {
      expect(failure.code).toBe("network");
      expect(failure.retryable).toBe(true);
    }
  });

  it("verify() 用 STAT 验证连接并报告账号与主机", async () => {
    const client = new FakePop3Client();
    const source = buildSource(client);
    await expect(source.verify()).resolves.toEqual({
      ok: true,
      detail: "POP3 已连接：user@example.com @ pop3.example.com:995（0 封）",
    });
    await source.close();

    const badClient = new FakePop3Client();
    badClient.statError = new Error("-ERR [AUTH] Authentication failed.");
    const badSource = buildSource(badClient);
    const result = await badSource.verify();
    expect(result.ok).toBe(false);
    expect(result.detail.startsWith("auth:")).toBe(true);
  });

  it("fetch({ folderId }) 被忽略：仍是同一个 Inbox，不报错也不丢邮件", async () => {
    const client = new FakePop3Client();
    client.uidl = [["1", "u1"]];
    client.messages = new Map([[1, rawEmail({ messageId: "only@example.com", subject: "only", body: "body" })]]);
    const source = buildSource(client);

    const result = await source.fetch({ folderId: "Sent" });

    expect(result.emails.map((email) => email.uid)).toEqual(["u1"]);
    expect(result.hasMore).toBe(false);
    await source.close();
  });

  it("listFolders：POP3 只有一个 Inbox，且不需要连服务器", async () => {
    const client = new FakePop3Client();
    const source = buildSource(client);

    await expect(source.listFolders()).resolves.toEqual([
      { id: "INBOX", name: "Inbox", role: "inbox", unreadCount: 0 },
    ]);
    expect(client.uidlCalls).toBe(0);
    expect(client.retrCalls).toEqual([]);
    await source.close();
  });

  it("getMessage：用 UIDL 翻出消息序号再 RETR，html/附件齐全，isRead 恒为 false", async () => {
    const client = new FakePop3Client();
    // 故意让 UIDL 顺序与序号不同，验证适配器真的做了映射
    client.uidl = [
      ["1", "u1"],
      ["2", "u2"],
    ];
    client.messages = new Map([
      [1, rawEmail({ messageId: "a@example.com", subject: "one", body: "body one" })],
      [2, mimeWithAttachment({ subject: "带附件", html: "<p>正文 <b>粗</b></p>", filename: "报表.txt", content: "附件内容" })],
    ]);
    const source = buildSource(client);

    const body = await source.getMessage({ id: "u2" });

    expect(client.retrCalls).toEqual([2]);
    expect(body.id).toBe("u2");
    expect(body.folderId).toBeNull();
    expect(body.subject).toBe("带附件");
    expect(body.html).toContain("<b>粗</b>");
    expect(body.text).toContain("正文");
    expect(body.isRead).toBe(false);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]?.filename).toBe("报表.txt");

    const missing = await source.getMessage({ id: "u404" }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(missing).toBeInstanceOf(MailError);
    if (missing instanceof MailError) expect(missing.code).toBe("protocol");
    await source.close();
  });

  it("getAttachment：按 UIDL + 附件 id 取回字节，越界 id 报 protocol", async () => {
    const client = new FakePop3Client();
    client.uidl = [["1", "u1"]];
    client.messages = new Map([[1, mimeWithAttachment({ filename: "报表.txt", content: "附件内容" })]]);
    const source = buildSource(client);

    const body = await source.getMessage({ id: "u1" });
    const attachmentId = body.attachments[0]?.id ?? "";
    const data = await source.getAttachment({ id: "u1" }, attachmentId);
    expect(Buffer.from(data.content).toString("utf8")).toBe("附件内容");
    expect(data.info.mimeType).toBe("text/plain");

    const missing = await source.getAttachment({ id: "u1" }, "9.9").then(
      () => null,
      (err: unknown) => err,
    );
    expect(missing).toBeInstanceOf(MailError);
    if (missing instanceof MailError) expect(missing.code).toBe("protocol");
    await source.close();
  });

  it("能力边界：POP3 不实现服务器端旗标/移动删除/搜索/发信端口", async () => {
    const client = new FakePop3Client();
    const source: MailSource = buildSource(client);

    // 已读/移动/删除是本地语义，搜索走本地已同步数据，发信走 SMTP，Sent 只留本地。
    expect(source.setFlags).toBeUndefined();
    expect(source.move).toBeUndefined();
    expect(source.delete).toBeUndefined();
    expect(source.search).toBeUndefined();
    expect(source.appendSent).toBeUndefined();
    expect(source.sendViaGraph).toBeUndefined();
    expect(source.sendViaEws).toBeUndefined();
    expect(typeof source.listFolders).toBe("function");
    expect(typeof source.getMessage).toBe("function");
    expect(typeof source.getAttachment).toBe("function");
    await source.close();
  });
});

describe("Pop3MailSource receivedAt 语义", () => {
  it("POP3 没有服务器接收时间：fetch 不给 receivedAtByUid，getMessage 不给 receivedAt", async () => {
    const client = new FakePop3Client();
    client.uidl = [["1", "u1"]];
    client.messages = new Map([[1, rawEmail({ subject: "no-receipt-time" })]]);
    const source = buildSource(client);

    const result = await source.fetch();
    expect(result.receivedAtByUid).toBeUndefined();
    // sentAt 仍然是 Date 头，没有被任何「接收时间」污染
    expect(result.emails[0]?.sentAt).toBe("2026-11-04T01:00:00.000Z");

    const body = await source.getMessage({ id: "u1" });
    expect(body.receivedAt).toBeUndefined();
    await source.close();
  });
});
