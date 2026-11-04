import { describe, expect, it } from "vitest";
import type { ImapClientLike, ImapFetchMessageLike, ImapFetchQuery, ImapMailboxLike } from "./imap.js";
import { ImapMailSource } from "./imap.js";
import { makeAccount, rawEmail } from "./test-support.js";
import { MailError } from "./types.js";

interface FakeMessage {
  readonly uid: number;
  readonly raw: string;
}

/** 结构兼容 imapflow 的假客户端：只在内存里按 UID/序列号区间取信。 */
class FakeImapClient implements ImapClientLike {
  readonly calls: Array<{ range: string; uidMode: boolean }> = [];
  readonly lockOptions: Array<{ readOnly?: boolean | undefined; acquireTimeout?: number | undefined } | undefined> = [];
  messages: FakeMessage[] = [];
  uidValidity = 1;
  connectError: unknown = null;
  fetchError: unknown = null;
  logoutCalls = 0;
  closeCalls = 0;
  #selected = false;

  get mailbox(): ImapMailboxLike | false {
    if (!this.#selected) return false;
    const lastUid = this.messages.reduce((max, message) => Math.max(max, message.uid), 0);
    return { uidValidity: BigInt(this.uidValidity), uidNext: lastUid + 1, exists: this.messages.length };
  }

  async connect(): Promise<void> {
    if (this.connectError !== null) throw this.connectError;
  }

  async logout(): Promise<void> {
    this.logoutCalls += 1;
    this.#selected = false;
  }

  close(): void {
    this.closeCalls += 1;
    this.#selected = false;
  }

  async getMailboxLock(
    path: string,
    options?: { readonly readOnly?: boolean | undefined; readonly acquireTimeout?: number | undefined },
  ): Promise<{ release(): void }> {
    void path;
    this.lockOptions.push(options);
    this.#selected = true;
    return {
      release: () => {
        this.#selected = false;
      },
    };
  }

  async mailboxOpen(path: string, options?: { readonly readOnly?: boolean | undefined }): Promise<unknown> {
    void path;
    void options;
    this.#selected = true;
    return this.mailbox;
  }

  async idle(_options?: { readonly whenFree?: boolean | undefined }): Promise<boolean | undefined> {
    // 一直等新邮件：模拟 IDLE 挂起，直到取消函数关闭连接。
    return new Promise<boolean>(() => undefined);
  }

  async *fetch(
    range: string,
    query: ImapFetchQuery,
    options?: { readonly uid?: boolean | undefined },
  ): AsyncGenerator<ImapFetchMessageLike> {
    void query;
    const uidMode = options?.uid === true;
    this.calls.push({ range, uidMode });
    if (this.fetchError !== null) throw this.fetchError;
    for (const message of selectRange(this.messages, range, uidMode)) {
      yield { uid: message.uid, source: Buffer.from(message.raw, "utf8") };
    }
  }

  on(_event: string, _listener: (...args: unknown[]) => void): unknown {
    return this;
  }
}

function selectRange(messages: readonly FakeMessage[], range: string, uidMode: boolean): FakeMessage[] {
  const parts = range.split(":");
  const startText = parts[0];
  const endText = parts[1];
  if (startText === undefined || endText === undefined) return [];
  const start = Number.parseInt(startText, 10);
  if (!Number.isSafeInteger(start)) return [];
  const last = uidMode ? messages.reduce((max, message) => Math.max(max, message.uid), 0) : messages.length;
  const end = endText === "*" ? last : Number.parseInt(endText, 10);
  return messages.filter((message, index) => {
    const position = uidMode ? message.uid : index + 1;
    return position >= start && position <= end;
  });
}

function buildMessages(count: number): FakeMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const uid = index + 1;
    return {
      uid,
      raw: rawEmail({ messageId: `m${uid}@example.com`, subject: `msg ${uid}`, body: `body ${uid}` }),
    };
  });
}

function buildSource(client: FakeImapClient, config: Record<string, string> = {}): ImapMailSource {
  return new ImapMailSource(makeAccount("imap", { host: "imap.example.com", ...config }), {
    createClient: () => client,
  });
}

function cursor(value: string): { accountId: string; value: string; updatedAt: string } {
  return { accountId: "acc-1", value, updatedAt: "2026-11-03T00:00:00.000Z" };
}

describe("ImapMailSource", () => {
  it("首次同步只拉最近 initialLimit 封，绝不整箱拉取", async () => {
    const client = new FakeImapClient();
    client.uidValidity = 777;
    client.messages = buildMessages(60);
    const source = buildSource(client, { initialLimit: "50" });

    const result = await source.fetch();

    expect(result.emails).toHaveLength(50);
    expect(client.calls).toEqual([{ range: "11:*", uidMode: false }]);
    expect(result.cursor?.value).toBe("777:60");
    expect(result.hasMore).toBe(true);
    expect(result.emails[0]?.uid).toBe("11");
    expect(result.emails[0]?.bodyText).toContain("body 11");
    expect(result.emails[0]?.sentAt).toBe("2026-11-04T01:00:00.000Z");
    // 只读：必须用只读邮箱锁
    expect(client.lockOptions[0]?.readOnly).toBe(true);
    await source.close();
  });

  it("增量同步从 lastUid+1 起按 UID 拉取，并把游标推进到最后一封", async () => {
    const client = new FakeImapClient();
    client.uidValidity = 100;
    client.messages = buildMessages(7);
    const source = buildSource(client);

    const result = await source.fetch({ since: cursor("100:5") });

    expect(client.calls).toEqual([{ range: "6:*", uidMode: true }]);
    expect(result.emails.map((email) => email.uid)).toEqual(["6", "7"]);
    expect(result.cursor?.value).toBe("100:7");
    expect(result.hasMore).toBe(false);
    await source.close();
  });

  it("UIDVALIDITY 变化时重置游标并从 UID 1 重拉", async () => {
    const client = new FakeImapClient();
    client.uidValidity = 200;
    client.messages = buildMessages(3);
    const source = buildSource(client);

    const result = await source.fetch({ since: cursor("100:500") });

    expect(client.calls).toEqual([{ range: "1:*", uidMode: true }]);
    expect(result.emails).toHaveLength(3);
    expect(result.cursor?.value).toBe("200:3");
    await source.close();
  });

  it("没有新邮件时不重复拉取，游标保持原值", async () => {
    const client = new FakeImapClient();
    client.uidValidity = 100;
    client.messages = buildMessages(7);
    const source = buildSource(client);

    const result = await source.fetch({ since: cursor("100:7") });

    expect(client.calls).toHaveLength(0);
    expect(result.emails).toEqual([]);
    expect(result.cursor?.value).toBe("100:7");
    expect(result.hasMore).toBe(false);
    await source.close();
  });

  it("limit 截断本批并报告 hasMore", async () => {
    const client = new FakeImapClient();
    client.uidValidity = 1;
    client.messages = buildMessages(10);
    const source = buildSource(client);

    const result = await source.fetch({ since: cursor("1:0"), limit: 3 });

    expect(result.emails).toHaveLength(3);
    expect(result.cursor?.value).toBe("1:3");
    expect(result.hasMore).toBe(true);
    await source.close();
  });

  it("认证失败映射为 auth 且错误信息不含 secret", async () => {
    const client = new FakeImapClient();
    client.connectError = Object.assign(new Error("LOGIN failed: password s3cret-app-password rejected"), {
      authenticationFailed: true,
    });
    const source = buildSource(client);

    const failure = await source.fetch().then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(MailError);
    if (failure instanceof MailError) {
      expect(failure.code).toBe("auth");
      expect(failure.retryable).toBe(false);
      expect(failure.message).not.toContain("s3cret-app-password");
      expect(failure.message).toContain("***");
    }
  });

  it("连接层错误映射为可重试的 network", async () => {
    const client = new FakeImapClient();
    client.connectError = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:993"), {
      code: "ECONNREFUSED",
    });
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

  it("verify() 成功时报告账号与主机，失败时返回 ok=false", async () => {
    const okClient = new FakeImapClient();
    const okSource = buildSource(okClient);
    await expect(okSource.verify()).resolves.toEqual({
      ok: true,
      detail: "IMAP 已连接：user@example.com @ imap.example.com:993",
    });
    await okSource.close();

    const badClient = new FakeImapClient();
    badClient.connectError = Object.assign(new Error("AUTHENTICATIONFAILED"), { authenticationFailed: true });
    const badSource = buildSource(badClient);
    const result = await badSource.verify();
    expect(result.ok).toBe(false);
    expect(result.detail.startsWith("auth:")).toBe(true);
  });

  it("watch() 返回取消函数，取消后断开连接", async () => {
    const client = new FakeImapClient();
    client.messages = buildMessages(1);
    const source = buildSource(client);

    const cancel = await source.watch(() => undefined);
    expect(typeof cancel).toBe("function");
    if (typeof cancel === "function") cancel();

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.logoutCalls).toBeGreaterThanOrEqual(1);
    await source.close();
  });
});
