import { describe, expect, it } from "vitest";
import type { Pop3ClientLike } from "./pop3.js";
import { Pop3MailSource } from "./pop3.js";
import { makeAccount, rawEmail } from "./test-support.js";
import { MailError } from "./types.js";

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
});
