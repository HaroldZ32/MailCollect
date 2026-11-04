import type { MailProvider, RawEmail, SyncCursor } from "@mailcollect/shared";
import { ImapFlow } from "imapflow";
import type { ImapFlowOptions } from "imapflow";
import type { MailSourceAccount } from "./account.js";
import { makeCursor, readConfig, readConfigBool, readConfigInt } from "./account.js";
import { abortedError, isAbortError, toMailError } from "./errors.js";
import { parseMimeEmail, toDate } from "./message.js";
import type { FetchOptions, FetchResult, MailSource } from "./types.js";
import { MailError } from "./types.js";

/**
 * IMAP 适配器（imapflow）。
 *
 * 游标格式：`"<uidValidity>:<lastUid>"`。
 * - 首次同步（无游标）只拉最近 `config.initialLimit ?? 50` 封，绝不整箱拉取；
 * - 增量从 `lastUid + 1:*` 按 UID 拉取；
 * - UIDVALIDITY 变化表示服务端重建了 UID 空间，旧 UID 全部失效 → 从 1 重新拉。
 *
 * 安全：imapflow 的协议日志整体关闭（`logger: false`），错误信息统一经 errors.ts 擦除 secret。
 */

const DEFAULT_MAILBOX = "INBOX";
const DEFAULT_INITIAL_LIMIT = 50;
const DEFAULT_FETCH_LIMIT = 200;
const DEFAULT_SOCKET_TIMEOUT_MS = 60_000;
const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const WATCH_INITIAL_BACKOFF_MS = 500;
const WATCH_MAX_BACKOFF_MS = 30_000;

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
}

export interface ImapFetchQuery {
  readonly uid?: boolean | undefined;
  readonly source?: boolean | undefined;
  readonly internalDate?: boolean | undefined;
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
  readonly socketTimeoutMs: number;
  readonly acquireTimeoutMs: number;
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
    socketTimeoutMs: readConfigInt(account, "socketTimeoutMs", 1_000, 600_000) ?? DEFAULT_SOCKET_TIMEOUT_MS,
    acquireTimeoutMs: readConfigInt(account, "acquireTimeoutMs", 1_000, 600_000) ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
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

  async #fetchOnce(options: FetchOptions): Promise<FetchResult> {
    const client = await this.#connect();
    const lock = await this.#lock(client);
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
    let lastUid = 0;

    for await (const message of client.fetch(`${start}:*`, fetchQuery(), { uid: false })) {
      if (options.signal?.aborted === true) throw abortedError();
      lastUid = Math.max(lastUid, message.uid);
      const email = await this.#toEmail(message);
      if (email !== null) {
        emails.push(email);
        options.onProgress?.(emails.length);
        if (emails.length >= window) break;
      }
    }
    return { emails, cursor: makeCursor(this.#account.id, `${uidValidity}:${lastUid}`), hasMore: mailbox.exists > window };
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
    let lastUid = previousLastUid;
    let hitLimit = false;

    for await (const message of client.fetch(range, fetchQuery(), { uid: true })) {
      if (options.signal?.aborted === true) throw abortedError();
      // 游标按「已消费到的最大 UID」推进：单封解析失败也必须跳过，否则会永远卡住。
      lastUid = Math.max(lastUid, message.uid);
      const email = await this.#toEmail(message);
      if (email === null) continue;
      emails.push(email);
      options.onProgress?.(emails.length);
      if (emails.length >= limit) {
        hitLimit = true;
        break;
      }
    }
    return { emails, cursor: makeCursor(this.#account.id, `${uidValidity}:${lastUid}`), hasMore: hitLimit };
  }

  async #toEmail(message: ImapFetchMessageLike): Promise<RawEmail | null> {
    const source = message.source;
    if (source === undefined) return null;
    try {
      return await parseMimeEmail(this.#account.id, String(message.uid), source, toDate(message.internalDate));
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

    const client = this.#createClient(this.#clientOptions());
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
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      // 连接已断时 LOGOUT 必然失败：close() 只做套接字收尾，不向上抛。
      client.close();
    }
  }

  async #lock(client: ImapClientLike): Promise<{ release(): void }> {
    try {
      return await client.getMailboxLock(this.#config.mailbox, {
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
