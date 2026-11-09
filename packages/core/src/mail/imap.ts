import type { FolderRole, MailProvider, RawEmail, SyncCursor } from "@mailcollect/shared";
import { ImapFlow } from "imapflow";
import type { ImapFlowOptions } from "imapflow";
import { simpleParser } from "mailparser";
import type { Attachment } from "mailparser";
import type { MailSourceAccount } from "./account.js";
import { makeCursor, readConfig, readConfigBool, readConfigInt } from "./account.js";
import { abortedError, isAbortError, notConfiguredError, toMailError, unsupportedError } from "./errors.js";
import { htmlToText, parseMimeEmail, toDate } from "./message.js";
import type {
  AttachmentData,
  AttachmentInfo,
  DeleteOptions,
  FetchOptions,
  FetchResult,
  FolderInfo,
  MailSearchHit,
  MailSearchQuery,
  MailSource,
  MessageBody,
  MessageFlagsPatch,
  MessageRef,
  SendRequest,
  SendResult,
} from "./types.js";
import { MailError } from "./types.js";

/**
 * IMAP 适配器（imapflow）。
 *
 * 游标格式：`"<uidValidity>:<lastUid>"`。
 * - 首次同步（无游标）只拉最近 `config.initialLimit ?? 50` 封，绝不整箱拉取；
 * - 增量从 `lastUid + 1:*` 按 UID 拉取；
 * - UIDVALIDITY 变化表示服务端重建了 UID 空间，旧 UID 全部失效 → 从 1 重新拉。
 *
 * v1.1 能力端口（全部 optional，见 types.ts）：文件夹列表、按文件夹读写（UID 只在选中的
 * 邮箱内有效，所以每次操作都先 `getMailboxLock(folder)`）、已读旗标、移动/删除、附件、
 * 服务器 SEARCH、APPEND 到 Sent。
 *
 * `fetch()` 默认仍是「收件箱增量」；传 `fetch({ folderId })` 就变成该文件夹的增量
 * （游标 `uidValidity:lastUid` 是文件夹作用域的，调用方要按文件夹各存一份）。
 *
 * 安全：imapflow 的协议日志整体关闭（`logger: false`），错误信息统一经 errors.ts 擦除 secret；
 * 本文件不打印任何日志，也不把正文写进错误信息。
 */

const DEFAULT_MAILBOX = "INBOX";
const DEFAULT_INITIAL_LIMIT = 50;
const DEFAULT_FETCH_LIMIT = 200;
const DEFAULT_SEARCH_LIMIT = 100;
const DEFAULT_SOCKET_TIMEOUT_MS = 60_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const WATCH_INITIAL_BACKOFF_MS = 500;
const WATCH_MAX_BACKOFF_MS = 30_000;
/** 错误信息里回显 id 的上限，避免把一长串外部输入抄进日志/响应。 */
const MAX_ECHO_ID_LENGTH = 32;

/** 只声明适配器真正用到的 imapflow 成员，测试可以注入结构兼容的假客户端。 */
export interface ImapMailboxLike {
  readonly uidValidity: bigint;
  readonly uidNext: number;
  readonly exists: number;
}

export interface ImapFetchMessageLike {
  readonly uid: number;
  readonly source?: Buffer | undefined;
  readonly internalDate?: Date | string | undefined;
  /** `\Seen` 等旗标；imapflow 给 Set，测试可给任意 Iterable。 */
  readonly flags?: Iterable<string> | undefined;
  /** 移动后按 Message-ID 重新定位时要用（只声明 messageId）。 */
  readonly envelope?: { readonly messageId?: string | null | undefined } | undefined;
}

export interface ImapFetchQuery {
  readonly uid?: boolean | undefined;
  readonly source?: boolean | undefined;
  readonly internalDate?: boolean | undefined;
  readonly flags?: boolean | undefined;
  readonly envelope?: boolean | undefined;
}

/** LIST 条目里适配器用到的字段（imapflow 的 ListResponse 是它的超集）。 */
export interface ImapMailboxListEntry {
  readonly path: string;
  readonly name?: string | null | undefined;
  readonly specialUse?: string | null | undefined;
  /** 只有传了 statusQuery 才会有。 */
  readonly status?: { readonly unseen?: number | null | undefined; readonly messages?: number | null | undefined } | undefined;
}

/** APPEND 结果；UIDPLUS 可用时服务器会回 uid。 */
export interface ImapAppendResult {
  readonly destination?: string | undefined;
  readonly uid?: number | undefined;
  readonly uidValidity?: bigint | number | undefined;
}

/** MOVE/COPY 结果；UIDPLUS 可用时 uidMap 能把源 uid 映射到目标邮箱的新 uid。 */
export interface ImapMoveResult {
  readonly destination?: string | undefined;
  readonly uidMap?: ReadonlyMap<number, number> | undefined;
}

/**
 * IMAP SEARCH 条件：字段之间是 AND。
 * 值原样交给 imapflow（它负责 CHARSET / literal 编码），适配器绝不手工拼搜索字符串。
 */
export interface ImapSearchCriteria {
  readonly subject?: string | undefined;
  readonly from?: string | undefined;
  readonly body?: string | undefined;
  readonly since?: Date | string | undefined;
  readonly before?: Date | string | undefined;
  readonly unseen?: boolean | undefined;
  /** 任意头的精确匹配，例如 `{ "Message-ID": "<x@y>" }`；编码由 imapflow 负责。 */
  readonly header?: Readonly<Record<string, string>> | undefined;
  /** 空条件用 `{ all: true }`，等价于「这个文件夹里的全部邮件」。 */
  readonly all?: boolean | undefined;
}

export interface ImapClientLike {
  readonly mailbox: ImapMailboxLike | false;
  connect(): Promise<void>;
  logout(): Promise<void>;
  close(): void;
  getMailboxLock(
    path: string,
    options?: { readonly readOnly?: boolean | undefined; readonly acquireTimeout?: number | undefined },
  ): Promise<{ release(): void }>;
  mailboxOpen?(path: string, options?: { readonly readOnly?: boolean | undefined }): Promise<unknown>;
  fetch(
    range: string,
    query: ImapFetchQuery,
    options?: { readonly uid?: boolean | undefined },
  ): AsyncIterable<ImapFetchMessageLike>;
  idle(options?: { readonly whenFree?: boolean | undefined }): Promise<boolean | undefined>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  /** LIST：文件夹枚举；`specialUseHints` 用来给没有 SPECIAL-USE 的服务器兜底。 */
  list(options?: {
    readonly statusQuery?: { readonly messages?: boolean | undefined; readonly unseen?: boolean | undefined } | undefined;
    readonly specialUseHints?:
      | {
          readonly sent?: string | undefined;
          readonly trash?: string | undefined;
          readonly drafts?: string | undefined;
          readonly junk?: string | undefined;
          readonly archive?: string | undefined;
        }
      | undefined;
  }): Promise<readonly ImapMailboxListEntry[]>;
  /** SEARCH；`false` 表示服务器拒绝（不支持的条件/字符集），`undefined` 表示未选中邮箱。 */
  search(
    criteria: ImapSearchCriteria,
    options?: { readonly uid?: boolean | undefined },
  ): Promise<readonly number[] | false | undefined>;
  messageFlagsAdd(range: string, flags: readonly string[], options?: { readonly uid?: boolean | undefined }): Promise<boolean>;
  messageFlagsRemove(
    range: string,
    flags: readonly string[],
    options?: { readonly uid?: boolean | undefined },
  ): Promise<boolean>;
  /** MOVE；`false` 表示服务器拒绝。 */
  messageMove(
    range: string,
    destination: string,
    options?: { readonly uid?: boolean | undefined },
  ): Promise<ImapMoveResult | false>;
  /** 标记 `\Deleted` 并 EXPUNGE（imapflow 的内部实现：不带 UIDPLUS 时是整箱 EXPUNGE）。 */
  messageDelete(range: string, options?: { readonly uid?: boolean | undefined }): Promise<boolean | undefined>;
  /** APPEND；`false` 表示服务器拒绝。 */
  append(
    path: string,
    content: Buffer,
    flags?: readonly string[] | undefined,
    date?: Date | undefined,
  ): Promise<ImapAppendResult | false>;
}

export interface ImapSourceOptions {
  /** 测试注入点：替换 imapflow 客户端。生产默认 `new ImapFlow(...)`。 */
  readonly createClient?: ((options: ImapFlowOptions) => ImapClientLike) | undefined;
}

interface ImapConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  readonly user: string;
  readonly mailbox: string;
  readonly initialLimit: number;
  readonly fetchLimit: number;
  readonly searchLimit: number;
  readonly socketTimeoutMs: number;
  readonly acquireTimeoutMs: number;
  /** 显式指定 Sent / Trash 路径；为空时用 special-use 解析。 */
  readonly sentMailbox: string | null;
  readonly trashMailbox: string | null;
}

function readImapConfig(account: MailSourceAccount): ImapConfig {
  const host = readConfig(account, "host");
  if (host === null) throw new MailError("protocol", "IMAP 配置缺少 host", false);
  const secure = readConfigBool(account, "secure", true);
  return {
    host,
    secure,
    port: readConfigInt(account, "port", 1, 65_535) ?? (secure ? 993 : 143),
    user: readConfig(account, "user") ?? account.email,
    mailbox: readConfig(account, "mailbox") ?? DEFAULT_MAILBOX,
    initialLimit: readConfigInt(account, "initialLimit", 1, 1_000) ?? DEFAULT_INITIAL_LIMIT,
    fetchLimit: readConfigInt(account, "fetchLimit", 1, 5_000) ?? DEFAULT_FETCH_LIMIT,
    searchLimit: readConfigInt(account, "searchLimit", 1, 1_000) ?? DEFAULT_SEARCH_LIMIT,
    socketTimeoutMs: readConfigInt(account, "socketTimeoutMs", 1_000, 600_000) ?? DEFAULT_SOCKET_TIMEOUT_MS,
    acquireTimeoutMs: readConfigInt(account, "acquireTimeoutMs", 1_000, 600_000) ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
    sentMailbox: readConfig(account, "sentMailbox"),
    trashMailbox: readConfig(account, "trashMailbox"),
  };
}

/** 解析 `"uidValidity:lastUid"`；格式不认识时返回 null（当作首次同步）。 */
function parseImapCursor(cursor: SyncCursor | undefined): { uidValidity: number; lastUid: number } | null {
  if (cursor === undefined) return null;
  const match = /^(\d+):(\d+)$/.exec(cursor.value);
  if (match === null) return null;
  const [, validityText, uidText] = match;
  if (validityText === undefined || uidText === undefined) return null;
  const uidValidity = Number.parseInt(validityText, 10);
  const lastUid = Number.parseInt(uidText, 10);
  if (!Number.isSafeInteger(uidValidity) || !Number.isSafeInteger(lastUid)) return null;
  return { uidValidity, lastUid };
}

function fetchQuery(): ImapFetchQuery {
  return { uid: true, source: true, internalDate: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------ MIME → MessageBody / 附件 ------------------------ */

/**
 * 协议无关的 MIME 解析助手，IMAP 与 POP3 共用（pop3.ts 从这里导入）。
 *
 * 为什么不放 message.ts：那边只负责 `RawEmail`，而本任务（mail-imap-pop3）的
 * write scope 只含 imap.ts / pop3.ts；等后续任务扩 scope 时把这两块搬进 message.ts 即可。
 * 也因此这里的 `flattenAddresses` 与 message.ts 的 `collectAddresses` 目前各有一份。
 */

/** 附件 id：优先用 MIME partId（如 `"1.2"`），非 multipart 邮件退化为 1-based 序号。 */
function attachmentIdOf(attachment: Attachment, index: number): string {
  return attachment.partId ?? String(index + 1);
}

/** mailparser 的附件 → 适配器对外的附件元数据。 */
function attachmentInfoOf(attachment: Attachment, index: number): AttachmentInfo {
  return {
    id: attachmentIdOf(attachment, index),
    filename: attachment.filename ?? `attachment-${index + 1}`,
    mimeType: attachment.contentType.length > 0 ? attachment.contentType : "application/octet-stream",
    size: attachment.size,
    inline:
      attachment.contentDisposition === "inline" || attachment.related === true || attachment.cid !== undefined,
  };
}

/** 把 AddressObject 摊平成地址字符串数组（不保留显示名）。 */
function flattenAddresses(input: unknown): string[] {
  if (input === null || input === undefined) return [];
  const groups = Array.isArray(input) ? input : [input];
  const addresses: string[] = [];
  for (const group of groups) {
    if (typeof group !== "object" || group === null || !("value" in group)) continue;
    const values: unknown = Reflect.get(group, "value");
    if (!Array.isArray(values)) continue;
    for (const item of values) {
      if (typeof item !== "object" || item === null) continue;
      const address: unknown = Reflect.get(item, "address");
      if (typeof address === "string" && address.trim().length > 0) addresses.push(address.trim());
    }
  }
  return addresses;
}

/**
 * 解析一封邮件为 `MessageBody`（纯文本 + 原始 html + 附件元数据）。
 *
 * `html` 原样保留，sanitize 由服务端出站前统一做；`text` 为纯文本（HTML-only 邮件用
 * `htmlToText` 兜底）。`isRead` 来自服务器的 `\Seen` 旗标，POP3 传 false。
 */
export async function parseMessageBody(
  source: Buffer | string,
  ref: MessageRef,
  isRead: boolean,
  receivedAt: Date | null,
): Promise<MessageBody> {
  const parsed = await simpleParser(source);
  const sender = parsed.from?.value[0];
  const senderName = sender?.name?.trim() ?? "";
  const senderEmail = sender?.address?.trim() ?? "";
  const html = typeof parsed.html === "string" && parsed.html.trim().length > 0 ? parsed.html : null;
  const text = typeof parsed.text === "string" ? parsed.text : html === null ? "" : htmlToText(html);

  return {
    id: ref.id,
    folderId: ref.folderId ?? null,
    subject: parsed.subject ?? "",
    fromName: senderName.length > 0 ? senderName : null,
    fromEmail: senderEmail,
    to: flattenAddresses(parsed.to),
    cc: flattenAddresses(parsed.cc),
    sentAt: (parsed.date ?? receivedAt ?? new Date()).toISOString(),
    // 服务器接收时间与 Date 头分开给：拿不到就不放这个字段，绝不拿 sentAt 冒充。
    ...(receivedAt === null ? {} : { receivedAt }),
    text,
    html,
    isRead,
    attachments: parsed.attachments.map((attachment, index) => attachmentInfoOf(attachment, index)),
  };
}

/** 按附件 id 取原始字节；id 认不出时抛类型化 MailError（上层映射为 4xx）。 */
export async function parseAttachmentData(source: Buffer | string, attachmentId: string): Promise<AttachmentData> {
  const parsed = await simpleParser(source);
  const index = parsed.attachments.findIndex((attachment, position) => attachmentIdOf(attachment, position) === attachmentId);
  const attachment = index === -1 ? undefined : parsed.attachments[index];
  if (attachment === undefined) {
    throw new MailError("protocol", "这封邮件里没有这个附件（id 可能已失效，或附件已被删除）", false);
  }
  return { info: attachmentInfoOf(attachment, index), content: new Uint8Array(attachment.content) };
}

/* ----------------------------- 文件夹与搜索 ------------------------------ */

/** RFC 6154 special-use → 规范化角色。认不出的（\All、\Flagged 等）落到 `other`。 */
const SPECIAL_USE_ROLES: Readonly<Record<string, FolderRole>> = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\trash": "trash",
  "\\junk": "junk",
  "\\spam": "junk",
  "\\archive": "archive",
};

/**
 * 文件夹角色。
 *
 * 先看服务器的 special-use 标记；没有标记时只把 INBOX 认作收件箱，其余一律 `other`。
 * 名字猜测（「已发送」「Sent Mail」等本地化命名）交给 imapflow 的 `specialUseSource: "name"`
 * 与 `specialUseHints`，适配器不再自己维护一张语言表。
 */
function folderRole(entry: ImapMailboxListEntry): FolderRole {
  const special = entry.specialUse?.trim().toLowerCase() ?? "";
  if (special.length > 0) {
    const role = SPECIAL_USE_ROLES[special];
    if (role !== undefined) return role;
  }
  if (entry.path.trim().toLowerCase() === "inbox") return "inbox";
  return "other";
}

/** 服务器返回的旗标里是否有 `\Seen`（大小写不敏感）。 */
function hasSeenFlag(flags: Iterable<string> | undefined): boolean {
  if (flags === undefined) return false;
  for (const flag of flags) {
    if (flag.toLowerCase() === "\\seen") return true;
  }
  return false;
}

/** 去空白；空串按「没有这个条件」处理。 */
function normalizeText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * `MailSearchQuery` → IMAP SEARCH 条件。
 *
 * 值原样交给 imapflow（非 ASCII 由它用 literal + `CHARSET UTF-8` 编码），这里只做
 * 「空值剔除」和「空条件 → ALL」，绝不把用户输入拼进搜索字符串（注入 + 编码错乱）。
 */
function toImapCriteria(query: MailSearchQuery): ImapSearchCriteria {
  const subject = normalizeText(query.subject);
  const from = normalizeText(query.from);
  const body = normalizeText(query.body);
  const since = normalizeText(query.since);
  const before = normalizeText(query.before);
  const criteria: {
    subject?: string;
    from?: string;
    body?: string;
    since?: string;
    before?: string;
    unseen?: boolean;
    all?: boolean;
  } = {};

  if (subject !== null) criteria.subject = subject;
  if (from !== null) criteria.from = from;
  if (body !== null) criteria.body = body;
  if (since !== null) criteria.since = since;
  if (before !== null) criteria.before = before;
  if (query.unreadOnly === true) criteria.unseen = true;
  if (Object.keys(criteria).length === 0) criteria.all = true;
  return criteria;
}

/**
 * `FetchOptions.folderId` 的分辨：空白/缺省回落到账号默认邮箱（`config.mailbox`）。
 *
 * IMAP 会真的选中这个文件夹再增量拉取——不能静默当成「收件箱」或「全量」，
 * 否则调用方会把别的文件夹的邮件记到错的文件夹名下。
 */
function folderOfOptions(options: FetchOptions, fallback: string): string {
  const folder = options.folderId?.trim() ?? "";
  return folder.length > 0 ? folder : fallback;
}

/** IMAP 的邮件 id 就是 uid（十进制整数）；别的形状说明调用方拿错了 id。 */
function requireUid(id: string, operation: string): string {
  const trimmed = id.trim();
  if (!/^\d+$/.test(trimmed)) {
    const echo = trimmed.length === 0 ? "空" : trimmed.slice(0, MAX_ECHO_ID_LENGTH);
    throw new MailError("protocol", `${operation} 需要 IMAP uid（十进制整数），收到：${echo}`, false);
  }
  return trimmed;
}

export class ImapMailSource implements MailSource {
  readonly provider: MailProvider = "imap";
  readonly #account: MailSourceAccount;
  readonly #config: ImapConfig;
  readonly #secrets: readonly string[];
  readonly #createClient: (options: ImapFlowOptions) => ImapClientLike;
  #client: ImapClientLike | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(account: MailSourceAccount, options: ImapSourceOptions = {}) {
    this.#account = account;
    this.#config = readImapConfig(account);
    this.#secrets = [account.secret];
    this.#createClient = options.createClient ?? ((clientOptions) => new ImapFlow(clientOptions));
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.#connect();
      return {
        ok: true,
        detail: `IMAP 已连接：${this.#account.email} @ ${this.#config.host}:${this.#config.port}`,
      };
    } catch (err) {
      const mapped = this.#mapError(err);
      await this.#disconnect();
      return { ok: false, detail: `${mapped.code}: ${mapped.message}` };
    }
  }

  async fetch(options: FetchOptions = {}): Promise<FetchResult> {
    return this.#runExclusive(() => this.#fetchOnce(options));
  }

  /**
   * IDLE 监听。返回取消函数；取消会关闭连接（下次操作自动重连）。
   * 断线后按指数退避重连，退避上限 30s；错误不外抛，避免后台任务变成未处理拒绝。
   */
  async watch(onNew: () => void): Promise<(() => void) | null> {
    let cancelled = false;
    let backoffMs = WATCH_INITIAL_BACKOFF_MS;

    const loop = async (): Promise<void> => {
      while (!cancelled) {
        try {
          const client = await this.#connect();
          if (cancelled) {
            await this.#disconnect();
            return;
          }
          // IDLE 只对「已选中的邮箱」报告新邮件，因此先选中（不加锁，不影响 fetch）。
          if (client.mailboxOpen !== undefined) await client.mailboxOpen(this.#config.mailbox, { readOnly: true });
          if (cancelled) return;
          const idleResult = await client.idle();
          if (cancelled) break;
          if (idleResult === false) throw new MailError("protocol", "IMAP 服务器拒绝 IDLE", true);
          backoffMs = WATCH_INITIAL_BACKOFF_MS;
          onNew();
        } catch (err) {
          if (cancelled || isAbortError(err)) break;
          await this.#disconnect();
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, WATCH_MAX_BACKOFF_MS);
        }
      }
    };

    void loop();
    return () => {
      cancelled = true;
      void this.#disconnect();
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#runExclusive(async () => {
      await this.#disconnect();
    });
  }

  /* ---------------------------- v1.1 能力端口 ---------------------------- */

  /** 列出文件夹并把 special-use 规范化成 `FolderRole`；未读数走 STATUS。 */
  async listFolders(): Promise<readonly FolderInfo[]> {
    return this.#runExclusive(async () => {
      const client = await this.#connect();
      try {
        const entries = await client.list({
          statusQuery: { messages: true, unseen: true },
          specialUseHints: this.#specialUseHints(),
        });
        return entries.map((entry) => ({
          id: entry.path,
          name: entry.name ?? entry.path,
          role: folderRole(entry),
          unreadCount: entry.status?.unseen ?? 0,
        }));
      } catch (err) {
        throw this.#mapError(err);
      }
    });
  }

  /**
   * 按文件夹拉取（IMAP 专属方法，**不在**冻结的 `MailSource` 上）。
   *
   * `fetch()` 保持「收件箱增量」语义不变——`FetchOptions` 是冻结点，没有 folderId；
   * 需要在收件箱之外的文件夹（Sent/Drafts/Archive）做增量时走这里：游标格式、limit、
   * 首次开窗、UIDVALIDITY 重置的判定与 `fetch()` 完全一致，只是换了选中的文件夹。
   */
  async fetchFolder(folderId: string, options: FetchOptions = {}): Promise<FetchResult> {
    const folder = folderId.trim();
    if (folder.length === 0) throw new MailError("protocol", "IMAP 按文件夹拉取时 folderId 为空", false);
    // 与 `fetch({ folderId })` 是同一条路径，避免两套锁/游标逻辑漂移。
    return this.fetch({ ...options, folderId: folder });
  }

  /**
   * 读单封邮件（正文 + 附件元数据）。
   *
   * IMAP 的 uid 只在选中的邮箱内有效：先按 `ref.folderId` 选中（缺省收件箱）再 FETCH。
   */
  async getMessage(ref: MessageRef): Promise<MessageBody> {
    const folder = this.#folderOf(ref);
    const uid = requireUid(ref.id, "IMAP 读邮件");
    return this.#runExclusive(async () => {
      const client = await this.#connect();
      try {
        return await this.#withMailbox(client, folder, true, async () => {
          const fetched = await this.#fetchSource(client, uid);
          if (fetched === null || fetched.source === undefined) {
            throw new MailError("protocol", `IMAP 找不到这封邮件：${folder} 里的 uid ${uid} 可能已失效，需要重新同步`, false);
          }
          return parseMessageBody(
            fetched.source,
            { id: uid, folderId: folder },
            hasSeenFlag(fetched.flags),
            toDate(fetched.internalDate),
          );
        });
      } catch (err) {
        throw this.#mapError(err);
      }
    });
  }

  /** 取附件原始字节。适配器不缓存正文，因此每次都会重新 FETCH 这封邮件的 MIME。 */
  async getAttachment(ref: MessageRef, attachmentId: string): Promise<AttachmentData> {
    const folder = this.#folderOf(ref);
    const uid = requireUid(ref.id, "IMAP 取附件");
    return this.#runExclusive(async () => {
      const client = await this.#connect();
      try {
        return await this.#withMailbox(client, folder, true, async () => {
          const fetched = await this.#fetchSource(client, uid);
          if (fetched === null || fetched.source === undefined) {
            throw new MailError("protocol", `IMAP 找不到这封邮件：${folder} 里的 uid ${uid} 可能已失效，需要重新同步`, false);
          }
          return parseAttachmentData(fetched.source, attachmentId);
        });
      } catch (err) {
        throw this.#mapError(err);
      }
    });
  }

  /** 服务器端已读/旗标：只发给出的字段，写操作拿读写锁。 */
  async setFlags(ref: MessageRef, patch: MessageFlagsPatch): Promise<void> {
    const folder = this.#folderOf(ref);
    const uid = requireUid(ref.id, "IMAP 设置旗标");
    const add: string[] = [];
    const remove: string[] = [];
    if (patch.read === true) add.push("\\Seen");
    else if (patch.read === false) remove.push("\\Seen");
    if (patch.flagged === true) add.push("\\Flagged");
    else if (patch.flagged === false) remove.push("\\Flagged");
    if (add.length === 0 && remove.length === 0) return;

    await this.#runExclusive(async () => {
      const client = await this.#connect();
      try {
        await this.#withMailbox(client, folder, false, async () => {
          if (add.length > 0 && !(await client.messageFlagsAdd(uid, add, { uid: true }))) {
            throw new MailError("protocol", "IMAP 设置旗标失败：服务器拒绝了 STORE", true);
          }
          if (remove.length > 0 && !(await client.messageFlagsRemove(uid, remove, { uid: true }))) {
            throw new MailError("protocol", "IMAP 清除旗标失败：服务器拒绝了 STORE", true);
          }
        });
      } catch (err) {
        throw this.#mapError(err);
      }
    });
  }

  /**
   * 移动到目标文件夹，返回**目标文件夹内**的新 uid。
   *
   * IMAP 的 uid 是文件夹作用域的：移动后消息在目标文件夹里拿的是**另一个** uid，旧 uid
   * 在那里可能指向一封完全不同的邮件，所以绝不能把旧 uid 当新引用返回。解析顺序：
   * 1. UIDPLUS 的 COPYUID/APPENDUID（`messageMove` 回的 `uidMap`）——一次就能拿到，最可靠；
   * 2. 没有 UIDPLUS：移动前记下 Message-ID，移动后在目标文件夹 `SEARCH HEADER Message-ID`
   *    重新定位，且必须**唯一**命中；
   * 3. 两者都拿不到 → 返回 `null`（移动本身已经成功）。调用方据此重新同步该文件夹，
   *    不得沿用旧 ref 去读/标/删。
   */
  async move(ref: MessageRef, targetFolderId: string): Promise<MessageRef | null> {
    const folder = this.#folderOf(ref);
    const uid = requireUid(ref.id, "IMAP 移动邮件");
    const target = targetFolderId.trim();
    if (target.length === 0) throw new MailError("protocol", "IMAP 移动邮件的目标文件夹为空", false);

    return this.#runExclusive(async () => {
      const client = await this.#connect();
      try {
        // 同一把读写锁内：先记 Message-ID，再 MOVE（两步都要源文件夹处于选中状态）。
        const outcome = await this.#withMailbox(client, folder, false, async () => {
          let messageId: string | null = null;
          try {
            messageId = await this.#fetchMessageId(client, uid);
          } catch {
            // no-excuse-ok: catch —— Message-ID 只是无 UIDPLUS 时的兜底；取不到就按「没有兜底」
            // 处理，真正的故障会由下面的 MOVE 命令暴露出来。
            messageId = null;
          }
          const moved = await client.messageMove(uid, target, { uid: true });
          if (moved === false) throw new MailError("protocol", "IMAP 移动邮件失败：服务器拒绝了 MOVE/COPY", true);
          return { messageId, moved };
        });

        const destination = outcome.moved.destination ?? target;
        const mapped = outcome.moved.uidMap?.get(Number.parseInt(uid, 10));
        if (mapped !== undefined) return { id: String(mapped), folderId: destination };

        // 源文件夹的锁已经释放，这里再选目标文件夹——同一连接上不能嵌套两把锁。
        const relocated =
          outcome.messageId === null ? null : await this.#locateMovedUid(client, destination, outcome.messageId);
        return relocated === null ? null : { id: String(relocated), folderId: destination };
      } catch (err) {
        throw this.#mapError(err);
      }
    });
  }

  /**
   * 删除。
   *
   * 默认（`permanent !== true`）移进回收站；找不到回收站就报 unsupported，绝不悄悄改成
   * 永久删除。`permanent: true` 走 STORE `\Deleted` + EXPUNGE——没有 UIDPLUS 的服务器上
   * 这是整箱 EXPUNGE（同邮箱里其它已标记删除的邮件也会一起消失）。
   */
  async delete(ref: MessageRef, options: DeleteOptions = {}): Promise<void> {
    const folder = this.#folderOf(ref);
    const uid = requireUid(ref.id, "IMAP 删除邮件");
    const permanent = options.permanent === true;

    await this.#runExclusive(async () => {
      const client = await this.#connect();
      try {
        const trash = permanent ? null : await this.#resolveFolder(client, "trash", this.#config.trashMailbox);
        await this.#withMailbox(client, folder, false, async () => {
          if (trash === null) {
            const deleted = await client.messageDelete(uid, { uid: true });
            // imapflow 在「没有选中邮箱/没有 range」时返回 undefined：那不是成功，必须报出来。
            if (deleted !== true) throw new MailError("protocol", "IMAP 彻底删除失败：服务器拒绝了 EXPUNGE", true);
            return;
          }
          const moved = await client.messageMove(uid, trash, { uid: true });
          if (moved === false) throw new MailError("protocol", "IMAP 移入回收站失败：服务器拒绝了 MOVE", true);
        });
      } catch (err) {
        throw this.#mapError(err);
      }
    });
  }

  /**
   * 服务器端 SEARCH（主题/发件人/正文/日期/未读）。
   *
   * 空条件等价于「列出这个文件夹」；结果按 uid 从新到旧截到 `limit`。
   * 条件值原样交给 imapflow 编码，适配器不拼搜索字符串。
   */
  async search(query: MailSearchQuery): Promise<readonly MailSearchHit[]> {
    const folder = query.folderId ?? this.#config.mailbox;
    const criteria = toImapCriteria(query);
    const limit = Math.max(1, query.limit ?? this.#config.searchLimit);

    return this.#runExclusive(async () => {
      const client = await this.#connect();
      try {
        return await this.#withMailbox(client, folder, true, async () => {
          const found = await client.search(criteria, { uid: true });
          if (found === false) {
            throw unsupportedError("IMAP SEARCH", "服务器拒绝了搜索条件（可能是字符集或搜索键不支持）");
          }
          if (found === undefined) throw new MailError("protocol", "IMAP 没有选中邮箱，无法搜索", false);
          return [...found]
            .sort((left, right) => right - left)
            .slice(0, limit)
            .map((uid) => ({ id: String(uid), folderId: folder }));
        });
      } catch (err) {
        throw this.#mapError(err);
      }
    });
  }

  /**
   * 把已发送副本 APPEND 进服务器 Sent。
   *
   * 失败**不抛**：返回 `ok:false` + 类型化 error，上层保留本地镜像并把 detail 给用户看。
   * Sent 路径优先级：`SendRequest.sentFolderId` → 账号配置 `sentMailbox` → special-use `\Sent`。
   */
  async appendSent(request: SendRequest): Promise<SendResult> {
    try {
      return await this.#runExclusive(async () => {
        const client = await this.#connect();
        const sent = request.sentFolderId ?? (await this.#resolveFolder(client, "sent", this.#config.sentMailbox));
        const appended = await client.append(sent, Buffer.from(request.mime), ["\\Seen"], new Date());
        if (appended === false) throw new MailError("protocol", "IMAP APPEND 被服务器拒绝", true);
        return {
          ok: true,
          transport: "imap",
          messageId: appended.uid === undefined ? null : String(appended.uid),
          savedToSent: "server",
          detail: `已写入服务器「已发送」：${sent}`,
        };
      });
    } catch (err) {
      const error = this.#mapError(err);
      return { ok: false, transport: "imap", savedToSent: "local", detail: error.message, error };
    }
  }

  /* ------------------------------- 内部实现 ------------------------------- */

  /** ref 指向的文件夹；缺省用账号配置的收件箱。 */
  #folderOf(ref: MessageRef): string {
    const folder = ref.folderId?.trim() ?? "";
    return folder.length > 0 ? folder : this.#config.mailbox;
  }

  /** 只把配置里真的写了的路径作为 special-use 提示传下去。 */
  #specialUseHints(): { readonly sent?: string; readonly trash?: string } | undefined {
    const hints: { sent?: string; trash?: string } = {};
    if (this.#config.sentMailbox !== null) hints.sent = this.#config.sentMailbox;
    if (this.#config.trashMailbox !== null) hints.trash = this.#config.trashMailbox;
    return Object.keys(hints).length > 0 ? hints : undefined;
  }

  /** 选中一个文件夹并拿锁：IMAP 的 uid 只在选中的邮箱内有效。 */
  async #withMailbox<T>(client: ImapClientLike, path: string, readOnly: boolean, task: () => Promise<T>): Promise<T> {
    let lock: { release(): void };
    try {
      lock = await client.getMailboxLock(path, { readOnly, acquireTimeout: this.#config.acquireTimeoutMs });
    } catch (err) {
      throw this.#mapError(err);
    }
    try {
      return await task();
    } finally {
      lock.release();
    }
  }

  /** 取一封邮件的 MIME 与旗标；找不到返回 null（uid 失效怎么报由调用方决定）。 */
  async #fetchSource(
    client: ImapClientLike,
    uid: string,
  ): Promise<
    { source: Buffer | undefined; flags: Iterable<string> | undefined; internalDate: Date | string | undefined } | null
  > {
    for await (const message of client.fetch(
      uid,
      { uid: true, source: true, flags: true, internalDate: true },
      { uid: true },
    )) {
      return { source: message.source, flags: message.flags, internalDate: message.internalDate };
    }
    return null;
  }

  /** 只取 Message-ID（envelope）；消息没有 Message-ID 时返回 null。 */
  async #fetchMessageId(client: ImapClientLike, uid: string): Promise<string | null> {
    for await (const message of client.fetch(uid, { uid: true, envelope: true }, { uid: true })) {
      const messageId = message.envelope?.messageId?.trim() ?? "";
      return messageId.length > 0 ? messageId : null;
    }
    return null;
  }

  /**
   * 没有 UIDPLUS 时，在目标文件夹里按 Message-ID 找回刚移过去的那封。
   *
   * 必须**唯一**命中才算解析成功（0 封或多封都返回 null，宁可让上层重新同步）。
   * 「服务器不支持 HEADER 搜索 / 目标文件夹打不开」同样降级为 null——移动已经成功，
   * 不能把「找新引用失败」报成「移动失败」；但网络/认证错误是真问题，照常上抛。
   */
  async #locateMovedUid(client: ImapClientLike, folder: string, messageId: string): Promise<number | null> {
    try {
      return await this.#withMailbox(client, folder, true, async () => {
        const found = await client.search({ header: { "Message-ID": messageId } }, { uid: true });
        if (found === false || found === undefined) return null;
        const uids = [...found];
        return uids.length === 1 ? (uids[0] ?? null) : null;
      });
    } catch (err) {
      const mapped = this.#mapError(err);
      if (mapped.code === "network" || mapped.code === "auth") throw mapped;
      return null;
    }
  }

  /** 按 special-use 解析 Sent / Trash；配置里的显式路径优先。 */
  async #resolveFolder(client: ImapClientLike, role: "sent" | "trash", configured: string | null): Promise<string> {
    if (configured !== null) return configured;
    const folders = await client.list();
    const match = folders.find((folder) => folderRole(folder) === role);
    if (match === undefined) {
      throw role === "sent"
        ? notConfiguredError("imap", "找不到「已发送」文件夹：请在账号配置里指定 sentMailbox")
        : unsupportedError("IMAP 删除", "找不到「已删除」文件夹：请在账号配置里指定 trashMailbox");
    }
    return match.path;
  }

  async #fetchOnce(options: FetchOptions): Promise<FetchResult> {
    const client = await this.#connect();
    // `folderId` 是文件夹作用域的增量：给了就选中那个文件夹，没给/空白仍是账号默认邮箱。
    const lock = await this.#lock(client, folderOfOptions(options, this.#config.mailbox));
    let failure: MailError | null = null;
    try {
      return await this.#collect(client, options);
    } catch (err) {
      failure = this.#mapError(err);
      throw failure;
    } finally {
      lock.release();
      // 网络类错误说明连接已不可信：丢弃，下一次调用重建（fetch 本身不自动重试）。
      if (failure !== null && failure.code === "network") await this.#disconnect();
    }
  }

  async #collect(client: ImapClientLike, options: FetchOptions): Promise<FetchResult> {
    const mailbox = client.mailbox;
    if (mailbox === false) throw new MailError("protocol", "IMAP 邮箱未选中", false);
    const uidValidity = Number(mailbox.uidValidity);
    const previous = parseImapCursor(options.since);
    const limit = Math.max(1, options.limit ?? this.#config.fetchLimit);

    if (previous === null) return this.#fetchInitial(client, mailbox, uidValidity, limit, options);
    if (previous.uidValidity !== uidValidity) {
      // UIDVALIDITY 变了：旧游标全部作废，从头重拉（仍受 limit 约束，分多次调完）。
      return this.#fetchUidRange(client, uidValidity, "1:*", 0, limit, options);
    }
    if (previous.lastUid >= mailbox.uidNext - 1) {
      return { emails: [], cursor: options.since ?? null, hasMore: false };
    }
    return this.#fetchUidRange(client, uidValidity, `${previous.lastUid + 1}:*`, previous.lastUid, limit, options);
  }

  /** 首次同步：按「最近 N 个序列号」开窗，只取最新的一段，绝不整箱拉取。 */
  async #fetchInitial(
    client: ImapClientLike,
    mailbox: ImapMailboxLike,
    uidValidity: number,
    limit: number,
    options: FetchOptions,
  ): Promise<FetchResult> {
    const window = Math.min(this.#config.initialLimit, limit);
    if (mailbox.exists === 0) {
      return { emails: [], cursor: makeCursor(this.#account.id, `${uidValidity}:0`), hasMore: false };
    }
    const start = Math.max(1, mailbox.exists - window + 1);
    const emails: RawEmail[] = [];
    const receivedAtByUid = new Map<string, Date>();
    let lastUid = 0;

    for await (const message of client.fetch(`${start}:*`, fetchQuery(), { uid: false })) {
      if (options.signal?.aborted === true) throw abortedError();
      lastUid = Math.max(lastUid, message.uid);
      const fetched = await this.#toEmail(message);
      if (fetched !== null) {
        emails.push(fetched.email);
        if (fetched.receivedAt !== null) receivedAtByUid.set(fetched.email.uid, fetched.receivedAt);
        options.onProgress?.(emails.length);
        if (emails.length >= window) break;
      }
    }
    return {
      emails,
      cursor: makeCursor(this.#account.id, `${uidValidity}:${lastUid}`),
      hasMore: mailbox.exists > window,
      ...(receivedAtByUid.size > 0 ? { receivedAtByUid } : {}),
    };
  }

  /** 按 UID 区间拉取（增量与 UIDVALIDITY 重置共用）。 */
  async #fetchUidRange(
    client: ImapClientLike,
    uidValidity: number,
    range: string,
    previousLastUid: number,
    limit: number,
    options: FetchOptions,
  ): Promise<FetchResult> {
    const emails: RawEmail[] = [];
    const receivedAtByUid = new Map<string, Date>();
    let lastUid = previousLastUid;
    let hitLimit = false;

    for await (const message of client.fetch(range, fetchQuery(), { uid: true })) {
      if (options.signal?.aborted === true) throw abortedError();
      // 游标按「已消费到的最大 UID」推进：单封解析失败也必须跳过，否则会永远卡住。
      lastUid = Math.max(lastUid, message.uid);
      const fetched = await this.#toEmail(message);
      if (fetched === null) continue;
      emails.push(fetched.email);
      if (fetched.receivedAt !== null) receivedAtByUid.set(fetched.email.uid, fetched.receivedAt);
      options.onProgress?.(emails.length);
      if (emails.length >= limit) {
        hitLimit = true;
        break;
      }
    }
    return {
      emails,
      cursor: makeCursor(this.#account.id, `${uidValidity}:${lastUid}`),
      hasMore: hitLimit,
      ...(receivedAtByUid.size > 0 ? { receivedAtByUid } : {}),
    };
  }

  /**
   * 一封 FETCH 结果 → `RawEmail` + 服务器接收时间。
   *
   * `internalDate` 是 IMAP 服务器记录的**接收**时间（不是发件人的 Date 头）：
   * 它同时用于 `RawEmail.sentAt` 的兜底（邮件没有 Date 头时）和 `receivedAtByUid`。
   */
  async #toEmail(message: ImapFetchMessageLike): Promise<{ email: RawEmail; receivedAt: Date | null } | null> {
    const source = message.source;
    if (source === undefined) return null;
    const receivedAt = toDate(message.internalDate);
    try {
      const email = await parseMimeEmail(this.#account.id, String(message.uid), source, receivedAt);
      return { email, receivedAt };
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      // 单封 MIME 解析失败不阻断整批同步：跳过这封，游标照常前进。
      return null;
    }
  }

  async #connect(): Promise<ImapClientLike> {
    if (this.#closed) throw new MailError("protocol", "IMAP 适配器已关闭", false);
    const existing = this.#client;
    if (existing !== null) return existing;

    let client: ImapClientLike;
    try {
      client = this.#createClient(this.#clientOptions());
    } catch (err) {
      throw toMailError(err, this.#secrets);
    }
    // imapflow 在连接层 emit 'error'；没有监听器时 EventEmitter 会抛错并终止进程。
    // 连接状态由下一次操作失败来体现，这里只负责不让进程崩溃。
    client.on("error", () => undefined);
    try {
      await client.connect();
    } catch (err) {
      client.close();
      throw toMailError(err, this.#secrets);
    }
    this.#client = client;
    return client;
  }

  async #disconnect(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    if (client === null) return;
    try {
      await client.logout();
    } catch {
      // no-excuse-ok: catch —— 连接已断时 LOGOUT 必然失败；close() 是幂等收尾，
      // 这里不能再抛，否则会盖掉真正的错误。
      client.close();
    }
  }

  async #lock(client: ImapClientLike, path: string = this.#config.mailbox): Promise<{ release(): void }> {
    try {
      return await client.getMailboxLock(path, {
        readOnly: true,
        acquireTimeout: this.#config.acquireTimeoutMs,
      });
    } catch (err) {
      throw this.#mapError(err);
    }
  }

  #clientOptions(): ImapFlowOptions {
    return {
      host: this.#config.host,
      port: this.#config.port,
      secure: this.#config.secure,
      auth: { user: this.#config.user, pass: this.#account.secret },
      // 协议日志可能带凭据与邮件内容：整体关闭。
      logger: false,
      // IDLE 只由 watch() 显式启动，避免后台 IDLE 和 fetch 抢连接。
      disableAutoIdle: true,
      socketTimeout: this.#config.socketTimeoutMs,
    };
  }

  /** 串行化同一账号的 IMAP 命令：一个连接上不能并发跑两个锁。 */
  #runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(task, task);
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  #mapError(err: unknown): MailError {
    if (isAbortError(err)) return abortedError();
    return toMailError(err, this.#secrets);
  }
}
