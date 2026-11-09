import { describe, expect, it } from "vitest";
import type {
  ImapAppendResult,
  ImapClientLike,
  ImapFetchMessageLike,
  ImapFetchQuery,
  ImapMailboxLike,
  ImapMailboxListEntry,
  ImapMoveResult,
  ImapSearchCriteria,
} from "./imap.js";
import { ImapMailSource } from "./imap.js";
import { makeAccount, rawEmail } from "./test-support.js";
import { MailError } from "./types.js";

interface FakeMessage {
  readonly uid: number;
  readonly raw: string;
  /** 服务器端旗标；测试用它验证 `\Seen` → `isRead`。 */
  readonly flags?: readonly string[];
  /** envelope 里的 Message-ID；无 UIDPLUS 移动后重新定位时要用。 */
  readonly messageId?: string;
  /** IMAP 服务器记录的接收时间（INTERNALDATE）；与 Date 头无关。 */
  readonly internalDate?: Date;
}

interface FakeMessageCursor {
  readonly range: string;
  readonly uidMode: boolean;
}

interface FlagCall {
  readonly method: "add" | "remove";
  readonly range: string;
  readonly flags: readonly string[];
  readonly uid: boolean;
}

/** 结构兼容 imapflow 的假客户端：只在内存里按 UID/序列号区间取信。 */
class FakeImapClient implements ImapClientLike {
  readonly calls: FakeMessageCursor[] = [];
  readonly lockOptions: Array<{ readOnly?: boolean | undefined; acquireTimeout?: number | undefined } | undefined> = [];
  readonly lockPaths: string[] = [];
  readonly listCalls: Array<Parameters<ImapClientLike["list"]>[0]> = [];
  readonly searchCalls: Array<{ criteria: ImapSearchCriteria; uid: boolean }> = [];
  readonly flagCalls: FlagCall[] = [];
  readonly moveCalls: Array<{ range: string; destination: string; uid: boolean }> = [];
  readonly deleteCalls: Array<{ range: string; uid: boolean }> = [];
  readonly appendCalls: Array<{ path: string; size: number; flags: readonly string[] | undefined }> = [];
  /** INBOX 的内容；其它文件夹放 `folders`。 */
  messages: FakeMessage[] = [];
  folders = new Map<string, FakeMessage[]>();
  folderEntries: readonly ImapMailboxListEntry[] | undefined = undefined;
  uidValidity = 1;
  connectError: unknown = null;
  fetchError: unknown = null;
  listError: unknown = null;
  searchResult: readonly number[] | false | undefined = [];
  flagResult = true;
  moveUidMap: ReadonlyMap<number, number> | undefined = undefined;
  moveRejected = false;
  deleteRejected = false;
  appendRejected = false;
  logoutCalls = 0;
  closeCalls = 0;
  #selectedPath: string | null = null;

  get mailbox(): ImapMailboxLike | false {
    if (this.#selectedPath === null) return false;
    const messages = this.#messagesOf(this.#selectedPath);
    const lastUid = messages.reduce((max, message) => Math.max(max, message.uid), 0);
    return { uidValidity: BigInt(this.uidValidity), uidNext: lastUid + 1, exists: messages.length };
  }

  #messagesOf(path: string): readonly FakeMessage[] {
    if (path === "INBOX") return this.messages;
    return this.folders.get(path) ?? [];
  }

  async connect(): Promise<void> {
    if (this.connectError !== null) throw this.connectError;
  }

  async logout(): Promise<void> {
    this.logoutCalls += 1;
    this.#selectedPath = null;
  }

  close(): void {
    this.closeCalls += 1;
    this.#selectedPath = null;
  }

  async getMailboxLock(
    path: string,
    options?: { readonly readOnly?: boolean | undefined; readonly acquireTimeout?: number | undefined },
  ): Promise<{ release(): void }> {
    this.lockPaths.push(path);
    this.lockOptions.push(options);
    this.#selectedPath = path;
    return {
      release: () => {
        this.#selectedPath = null;
      },
    };
  }

  async mailboxOpen(path: string, options?: { readonly readOnly?: boolean | undefined }): Promise<unknown> {
    void options;
    this.#selectedPath = path;
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
    for (const message of selectRange(this.#messagesOf(this.#selectedPath ?? "INBOX"), range, uidMode)) {
      yield {
        uid: message.uid,
        source: Buffer.from(message.raw, "utf8"),
        flags: message.flags === undefined ? undefined : new Set(message.flags),
        envelope: message.messageId === undefined ? undefined : { messageId: message.messageId },
        internalDate: message.internalDate,
      };
    }
  }

  async list(options?: Parameters<ImapClientLike["list"]>[0]): Promise<readonly ImapMailboxListEntry[]> {
    this.listCalls.push(options);
    if (this.listError !== null) throw this.listError;
    if (this.folderEntries !== undefined) return this.folderEntries;
    return [{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox", status: { unseen: 0, messages: this.messages.length } }];
  }

  async search(
    criteria: ImapSearchCriteria,
    options?: { readonly uid?: boolean | undefined },
  ): Promise<readonly number[] | false | undefined> {
    this.searchCalls.push({ criteria, uid: options?.uid === true });
    return this.searchResult;
  }

  async messageFlagsAdd(
    range: string,
    flags: readonly string[],
    options?: { readonly uid?: boolean | undefined },
  ): Promise<boolean> {
    this.flagCalls.push({ method: "add", range, flags, uid: options?.uid === true });
    return this.flagResult;
  }

  async messageFlagsRemove(
    range: string,
    flags: readonly string[],
    options?: { readonly uid?: boolean | undefined },
  ): Promise<boolean> {
    this.flagCalls.push({ method: "remove", range, flags, uid: options?.uid === true });
    return this.flagResult;
  }

  async messageMove(
    range: string,
    destination: string,
    options?: { readonly uid?: boolean | undefined },
  ): Promise<ImapMoveResult | false> {
    this.moveCalls.push({ range, destination, uid: options?.uid === true });
    if (this.moveRejected) return false;
    return { destination, uidMap: this.moveUidMap };
  }

  async messageDelete(range: string, options?: { readonly uid?: boolean | undefined }): Promise<boolean | undefined> {
    this.deleteCalls.push({ range, uid: options?.uid === true });
    return this.deleteRejected ? false : true;
  }

  async append(
    path: string,
    content: Buffer,
    flags?: readonly string[] | undefined,
    date?: Date | undefined,
  ): Promise<ImapAppendResult | false> {
    void date;
    this.appendCalls.push({ path, size: content.byteLength, flags });
    if (this.appendRejected) return false;
    return { destination: path, uid: 42, uidValidity: 1n };
  }

  on(_event: string, _listener: (...args: unknown[]) => void): unknown {
    return this;
  }
}

function selectRange(messages: readonly FakeMessage[], range: string, uidMode: boolean): FakeMessage[] {
  const parts = range.split(":");
  const startText = parts[0];
  if (startText === undefined) return [];
  const start = Number.parseInt(startText, 10);
  if (!Number.isSafeInteger(start)) return [];
  const last = uidMode ? messages.reduce((max, message) => Math.max(max, message.uid), 0) : messages.length;
  const endText = parts[1];
  const end = endText === undefined ? start : endText === "*" ? last : Number.parseInt(endText, 10);
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

/** 一封 multipart/mixed：html 正文 + 一个附件（附件按 base64 编码，带文件名）。 */
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

  it("fetchFolder：收件箱之外的文件夹用同一套游标语义增量拉取", async () => {
    const client = new FakeImapClient();
    client.folders.set("Archive", [
      { uid: 1, raw: rawEmail({ messageId: "a1@example.com", subject: "arch 1" }) },
      { uid: 2, raw: rawEmail({ messageId: "a2@example.com", subject: "arch 2" }) },
    ]);
    const source = buildSource(client);

    const result = await source.fetchFolder("Archive", { since: cursor("1:0") });

    expect(client.lockPaths).toEqual(["Archive"]);
    expect(client.lockOptions[0]?.readOnly).toBe(true);
    expect(client.calls).toEqual([{ range: "1:*", uidMode: true }]);
    expect(result.emails.map((email) => email.uid)).toEqual(["1", "2"]);
    expect(result.cursor?.value).toBe("1:2");
    expect(result.hasMore).toBe(false);

    const empty = await source.fetchFolder("  ").then(
      () => null,
      (err: unknown) => err,
    );
    expect(empty).toBeInstanceOf(MailError);
    await source.close();
  });

  it("fetch({ folderId }) 选中该文件夹再增量拉取；空白 folderId 回落到默认收件箱", async () => {
    const client = new FakeImapClient();
    client.messages = buildMessages(2);
    client.folders.set("Archive", [
      { uid: 1, raw: rawEmail({ messageId: "ar1@example.com", subject: "arch 1" }) },
      { uid: 2, raw: rawEmail({ messageId: "ar2@example.com", subject: "arch 2" }) },
    ]);
    const source = buildSource(client);

    const archived = await source.fetch({ folderId: "Archive", since: cursor("1:0") });

    expect(client.lockPaths).toEqual(["Archive"]);
    expect(client.lockOptions[0]?.readOnly).toBe(true);
    expect(archived.emails.map((email) => email.uid)).toEqual(["1", "2"]);
    expect(archived.cursor?.value).toBe("1:2");

    // 空白 folderId 等同未给：回到账号默认邮箱（INBOX），不会报错
    const inbox = await source.fetch({ folderId: "   " });
    expect(client.lockPaths.at(-1)).toBe("INBOX");
    expect(inbox.emails.map((email) => email.uid)).toEqual(["1", "2"]);
    await source.close();
  });

  it("listFolders：special-use 映射成角色、未读数取 STATUS、special-use 提示传给服务器", async () => {
    const client = new FakeImapClient();
    client.folderEntries = [
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox", status: { unseen: 3, messages: 10 } },
      { path: "Sent Items", name: "Sent Items", specialUse: "\\Sent", status: { unseen: 0 } },
      { path: "Drafts", name: "Drafts", specialUse: "\\Drafts" },
      { path: "Trash", name: "Trash", specialUse: "\\Trash" },
      { path: "Archive", name: "Archive", specialUse: "\\Archive" },
      { path: "Junk", name: "Junk", specialUse: "\\Junk" },
      { path: "Flagged", name: "Flagged", specialUse: "\\Flagged" },
      { path: "inbox", name: "lowercase", specialUse: null },
    ];
    const source = buildSource(client, { sentMailbox: "Sent Items" });

    const folders = await source.listFolders();

    expect(folders.map((folder) => folder.role)).toEqual([
      "inbox",
      "sent",
      "drafts",
      "trash",
      "archive",
      "junk",
      "other",
      "inbox",
    ]);
    expect(folders[0]).toEqual({ id: "INBOX", name: "INBOX", role: "inbox", unreadCount: 3 });
    expect(folders[1]).toEqual({ id: "Sent Items", name: "Sent Items", role: "sent", unreadCount: 0 });
    expect(client.listCalls[0]).toEqual({
      statusQuery: { messages: true, unseen: true },
      specialUseHints: { sent: "Sent Items" },
    });
    expect(client.lockPaths).toHaveLength(0); // LIST 不需要选中邮箱
    await source.close();
  });

  it("getMessage：按 folderId 选中文件夹，带回 html、附件元数据与 \\Seen 状态", async () => {
    const client = new FakeImapClient();
    client.folders.set("Sent Items", [
      {
        uid: 7,
        raw: mimeWithAttachment({ subject: "季度报告", html: "<p>hi <b>there</b></p>", filename: "报表.txt", content: "附件内容" }),
        flags: ["\\Seen", "\\Flagged"],
      },
    ]);
    const source = buildSource(client);

    const body = await source.getMessage({ id: "7", folderId: "Sent Items" });

    expect(body.id).toBe("7");
    expect(body.folderId).toBe("Sent Items");
    expect(body.subject).toBe("季度报告");
    expect(body.html).toContain("<b>there</b>");
    expect(body.text).toContain("hi");
    expect(body.isRead).toBe(true);
    expect(body.attachments).toHaveLength(1);
    const attachment = body.attachments[0];
    expect(attachment?.filename).toBe("报表.txt");
    expect(attachment?.mimeType).toBe("text/plain");
    expect(attachment?.size).toBe(Buffer.byteLength("附件内容", "utf8"));
    expect(attachment?.inline).toBe(false);
    expect(attachment?.id.length).toBeGreaterThan(0);
    expect(client.lockPaths).toEqual(["Sent Items"]);
    expect(client.lockOptions[0]?.readOnly).toBe(true);
    expect(client.calls.at(-1)).toEqual({ range: "7", uidMode: true });
    await source.close();
  });

  it("getMessage：没有 \\Seen 时 isRead=false；uid 失效/形状不对都抛类型化错误", async () => {
    const client = new FakeImapClient();
    client.messages = [{ uid: 1, raw: rawEmail({ subject: "unread" }) }];
    const source = buildSource(client);

    const body = await source.getMessage({ id: "1" });
    expect(body.isRead).toBe(false);
    expect(body.folderId).toBe("INBOX"); // 缺省用收件箱

    const missing = await source.getMessage({ id: "999" }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(missing).toBeInstanceOf(MailError);
    if (missing instanceof MailError) expect(missing.code).toBe("protocol");

    const malformed = await source.getMessage({ id: "not-a-uid" }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(malformed).toBeInstanceOf(MailError);
    if (malformed instanceof MailError) expect(malformed.message).toContain("uid");
    await source.close();
  });

  it("getAttachment：用 MessageBody 给出的附件 id 取回原始字节，非法 id 报 protocol", async () => {
    const client = new FakeImapClient();
    client.folders.set("Sent Items", [
      { uid: 7, raw: mimeWithAttachment({ filename: "报表.txt", content: "附件内容" }) },
    ]);
    const source = buildSource(client);
    const ref = { id: "7", folderId: "Sent Items" };

    const body = await source.getMessage(ref);
    const attachmentId = body.attachments[0]?.id ?? "";
    const data = await source.getAttachment(ref, attachmentId);

    expect(Buffer.from(data.content).toString("utf8")).toBe("附件内容");
    expect(data.info.filename).toBe("报表.txt");

    const missing = await source.getAttachment(ref, "9.9").then(
      () => null,
      (err: unknown) => err,
    );
    expect(missing).toBeInstanceOf(MailError);
    if (missing instanceof MailError) expect(missing.code).toBe("protocol");
    await source.close();
  });

  it("setFlags：read=true 加 \\Seen 并拿读写锁，read=false 移除，空 patch 不发命令", async () => {
    const client = new FakeImapClient();
    client.messages = buildMessages(2);
    const source = buildSource(client);

    await source.setFlags({ id: "2" }, { read: true });
    expect(client.flagCalls).toEqual([{ method: "add", range: "2", flags: ["\\Seen"], uid: true }]);
    expect(client.lockOptions.at(-1)?.readOnly).toBe(false);

    await source.setFlags({ id: "2" }, { read: false, flagged: true });
    expect(client.flagCalls.slice(-2)).toEqual([
      { method: "add", range: "2", flags: ["\\Flagged"], uid: true },
      { method: "remove", range: "2", flags: ["\\Seen"], uid: true },
    ]);

    const before = client.flagCalls.length;
    await source.setFlags({ id: "2" }, {});
    expect(client.flagCalls).toHaveLength(before);
    await source.close();
  });

  it("move：UIDPLUS 的 uidMap 优先——返回目标文件夹里的新 uid", async () => {
    const client = new FakeImapClient();
    client.messages = buildMessages(3);
    client.moveUidMap = new Map([[2, 900]]);
    const source = buildSource(client);

    await expect(source.move({ id: "2" }, "Archive")).resolves.toEqual({ id: "900", folderId: "Archive" });
    expect(client.moveCalls).toEqual([{ range: "2", destination: "Archive", uid: true }]);
    // 有 COPYUID 就不需要回目标文件夹重新定位
    expect(client.lockPaths).toEqual(["INBOX"]);
    expect(client.searchCalls).toEqual([]);
    await source.close();
  });

  it("move：没有 UIDPLUS 时用 Message-ID 在目标文件夹重新定位，返回那里的新 uid", async () => {
    const client = new FakeImapClient();
    client.messages = [
      { uid: 4, messageId: "<m4@example.com>", raw: rawEmail({ messageId: "m4@example.com" }) },
    ];
    client.searchResult = [77];
    const source = buildSource(client);

    await expect(source.move({ id: "4" }, "Archive")).resolves.toEqual({ id: "77", folderId: "Archive" });

    // 先读源邮件的 Message-ID（源文件夹），移动后到目标文件夹按 HEADER 搜索
    expect(client.searchCalls).toEqual([
      { criteria: { header: { "Message-ID": "<m4@example.com>" } }, uid: true },
    ]);
    expect(client.lockPaths).toEqual(["INBOX", "Archive"]);
    expect(client.lockOptions[0]?.readOnly).toBe(false);
    expect(client.lockOptions.at(-1)?.readOnly).toBe(true);
    await source.close();
  });

  it("move：没有 UIDPLUS 又定位不到唯一一封 → 返回 null，绝不把旧 uid 当新引用", async () => {
    // ① 连 Message-ID 都拿不到（envelope 缺失）：移动成功但解析不出新引用
    const client = new FakeImapClient();
    client.messages = buildMessages(2);
    const source = buildSource(client);

    await expect(source.move({ id: "1" }, "Archive")).resolves.toBeNull();
    expect(client.moveCalls).toHaveLength(1); // MOVE 确实发出去了
    expect(client.lockPaths).toEqual(["INBOX"]); // 没有定位条件，不去搜目标文件夹

    // ② 搜到多封同 Message-ID：不猜，同样返回 null
    const ambiguous = new FakeImapClient();
    ambiguous.messages = [{ uid: 5, messageId: "<dup@example.com>", raw: rawEmail() }];
    ambiguous.searchResult = [77, 78];
    const second = buildSource(ambiguous);

    await expect(second.move({ id: "5" }, "Archive")).resolves.toBeNull();
    await source.close();
    await second.close();
  });

  it("move：服务器拒绝 MOVE 时报类型化 protocol 错误", async () => {
    const client = new FakeImapClient();
    client.messages = buildMessages(1);
    client.moveRejected = true;
    const source = buildSource(client);

    const failure = await source.move({ id: "1" }, "Archive").then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(MailError);
    if (failure instanceof MailError) expect(failure.code).toBe("protocol");
    await source.close();
  });

  it("delete：默认移进回收站，permanent 才 EXPUNGE，找不到回收站报 unsupported", async () => {
    const client = new FakeImapClient();
    client.messages = buildMessages(2);
    client.folderEntries = [
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
      { path: "Trash", name: "Trash", specialUse: "\\Trash" },
    ];
    const source = buildSource(client);

    await source.delete({ id: "1" });
    expect(client.moveCalls).toEqual([{ range: "1", destination: "Trash", uid: true }]);
    expect(client.deleteCalls).toHaveLength(0);

    await source.delete({ id: "2" }, { permanent: true });
    expect(client.deleteCalls).toEqual([{ range: "2", uid: true }]);

    client.folderEntries = [{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox" }];
    const failure = await source.delete({ id: "1" }).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(MailError);
    if (failure instanceof MailError) {
      expect(failure.code).toBe("unsupported");
      expect(failure.message).toContain("trashMailbox");
    }
    await source.close();
  });

  it("search：条件原样交给服务器、uid:true、中文不拼接，结果按新到旧截断", async () => {
    const client = new FakeImapClient();
    client.searchResult = [3, 1, 5, 2];
    const source = buildSource(client, { searchLimit: "2" });

    const hits = await source.search({
      subject: "季度 报告",
      from: "王小明 <wang@example.com>",
      body: "发票",
      folderId: "Archive",
    });

    expect(hits).toEqual([
      { id: "5", folderId: "Archive" },
      { id: "3", folderId: "Archive" },
    ]);
    expect(client.searchCalls[0]).toEqual({
      criteria: { subject: "季度 报告", from: "王小明 <wang@example.com>", body: "发票" },
      uid: true,
    });
    expect(client.lockPaths).toEqual(["Archive"]);

    await source.search({});
    expect(client.searchCalls[1]?.criteria).toEqual({ all: true });

    await source.search({ unreadOnly: true, subject: "   " });
    expect(client.searchCalls[2]?.criteria).toEqual({ unseen: true });

    client.searchResult = false;
    const failure = await source.search({}).then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(MailError);
    if (failure instanceof MailError) expect(failure.code).toBe("unsupported");
    await source.close();
  });

  it("appendSent：APPEND 成功写 Sent，被拒/找不到 Sent 都返回 ok:false 而不抛", async () => {
    const client = new FakeImapClient();
    client.folderEntries = [
      { path: "INBOX", name: "INBOX", specialUse: "\\Inbox" },
      { path: "Sent", name: "Sent", specialUse: "\\Sent" },
    ];
    const source = buildSource(client);
    const request = {
      mime: Buffer.from(mimeWithAttachment({}), "utf8"),
      to: ["to@example.com"],
      cc: [],
      bcc: [],
      from: "user@example.com",
    };

    const ok = await source.appendSent(request);
    expect(ok).toMatchObject({ ok: true, transport: "imap", savedToSent: "server", messageId: "42" });
    expect(client.appendCalls[0]?.path).toBe("Sent");
    expect(client.appendCalls[0]?.flags).toEqual(["\\Seen"]);
    expect(client.appendCalls[0]?.size).toBe(request.mime.byteLength);

    client.appendRejected = true;
    const rejected = await source.appendSent(request);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe("protocol");

    client.folderEntries = [{ path: "INBOX", name: "INBOX", specialUse: "\\Inbox" }];
    const missing = await source.appendSent(request);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("not_configured");
      expect(missing.detail).toContain("sentMailbox");
      expect(missing.savedToSent).toBe("local");
    }
    await source.close();
  });
});

describe("ImapMailSource receivedAt 语义", () => {
  it("fetch 用 INTERNALDATE 作服务器接收时间，与 Date 头的 sentAt 分开", async () => {
    const client = new FakeImapClient();
    client.messages = [
      {
        uid: 1,
        // Date 头 = 2026-11-04T01:00:00Z；服务器接收时间故意不同。
        raw: rawEmail({ date: "04 Nov 2026 09:00:00 +0800" }),
        internalDate: new Date("2026-11-05T02:00:00Z"),
      },
    ];
    const source = buildSource(client);

    const result = await source.fetch();

    expect(result.receivedAtByUid?.get("1")?.toISOString()).toBe("2026-11-05T02:00:00.000Z");
    expect(result.emails[0]?.sentAt).toBe("2026-11-04T01:00:00.000Z");
    expect(result.receivedAtByUid?.get("1")?.toISOString()).not.toBe(result.emails[0]?.sentAt);
    await source.close();
  });

  it("拿不到 INTERNALDATE 时整个 receivedAtByUid 缺省（绝不造数）", async () => {
    const client = new FakeImapClient();
    client.messages = buildMessages(2);
    const source = buildSource(client);

    const result = await source.fetch();

    expect(result.receivedAtByUid).toBeUndefined();
    await source.close();
  });

  it("getMessage 的 MessageBody 带 receivedAt，sentAt 仍取 Date 头", async () => {
    const client = new FakeImapClient();
    client.messages = [
      { uid: 3, raw: rawEmail({ subject: "带接收时间" }), internalDate: new Date("2026-11-05T02:00:00Z") },
    ];
    const source = buildSource(client);

    const body = await source.getMessage({ id: "3" });

    expect(body.receivedAt?.toISOString()).toBe("2026-11-05T02:00:00.000Z");
    expect(body.sentAt).toBe("2026-11-04T01:00:00.000Z");
    await source.close();
  });
});
