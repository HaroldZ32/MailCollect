import type { MailProvider, RawEmail, SyncCursor } from "@mailcollect/shared";
import Pop3Command from "node-pop3";
import type { Stream } from "node:stream";
import type { MailSourceAccount } from "./account.js";
import { makeCursor, readConfig, readConfigBool, readConfigInt } from "./account.js";
import { abortedError, isAbortError, toMailError } from "./errors.js";
import { parseMimeEmail } from "./message.js";
import type { FetchOptions, FetchResult, MailSource } from "./types.js";
import { MailError } from "./types.js";

/**
 * POP3 适配器（node-pop3），严格只读。
 *
 * 去重策略：游标保存「已见过的 UIDL 集合」。
 * POP3 的消息号在删除后会重排，不能用来去重；UIDL 是 RFC 1939 定义的持久唯一标识，
 * 所以游标形如 `v1:["<uidl1>","<uidl2>",...]`。每次同步列出全部 UIDL，只 RETR 集合里
 * 没有的那些。代价是游标随邮箱线性增长；换来的是删除/重排之后仍不重复、不漏取。
 *
 * 只读：本适配器只调用 STAT / UIDL / RETR / QUIT，从不发 DELE，也不会改动已读标记
 * （POP3 协议本身没有已读状态与文件夹，也没有推送能力，因此 watch() 返回 null）。
 */

const DEFAULT_TLS = true;
const DEFAULT_FETCH_LIMIT = 200;
const DEFAULT_TIMEOUT_MS = 30_000;
const CURSOR_PREFIX = "v1:";

/** 只声明适配器真正用到的 node-pop3 成员，测试可以注入结构兼容的假客户端。 */
export interface Pop3ClientLike {
  STAT(): Promise<string>;
  UIDL(msgNumber?: number | string): Promise<string[][] | string[]>;
  RETR(msgNumber: number): Promise<string | Stream>;
  QUIT(): Promise<string | void>;
}

/** 构造 node-pop3 客户端所需参数（生产默认走 node-pop3）。 */
export interface Pop3ConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly user: string;
  readonly password: string;
  readonly timeoutMs: number;
}

export interface Pop3SourceOptions {
  /** 测试注入点：替换 node-pop3 客户端。生产默认 `new Pop3Command(...)`。 */
  readonly createClient?: ((options: Pop3ConnectionOptions) => Pop3ClientLike) | undefined;
}

interface Pop3Config {
  readonly host: string;
  readonly port: number;
  readonly tls: boolean;
  readonly user: string;
  readonly fetchLimit: number;
  readonly timeoutMs: number;
}

interface UidlEntry {
  readonly messageNumber: number;
  readonly uidl: string;
}

function readPop3Config(account: MailSourceAccount): Pop3Config {
  const host = readConfig(account, "host");
  if (host === null) throw new MailError("protocol", "POP3 配置缺少 host", false);
  const tls = readConfigBool(account, "tls", DEFAULT_TLS);
  return {
    host,
    tls,
    port: readConfigInt(account, "port", 1, 65_535) ?? (tls ? 995 : 110),
    user: readConfig(account, "user") ?? account.email,
    fetchLimit: readConfigInt(account, "fetchLimit", 1, 5_000) ?? DEFAULT_FETCH_LIMIT,
    timeoutMs: readConfigInt(account, "timeoutMs", 1_000, 600_000) ?? DEFAULT_TIMEOUT_MS,
  };
}

/** UIDL() 无参时返回 `[[msgNumber, uidl], ...]`；这里兼容单条返回与脏行。 */
function parseUidlListing(listing: string[][] | string[]): UidlEntry[] {
  const rows: string[][] = isNestedList(listing) ? listing : [listing];
  const entries: UidlEntry[] = [];
  for (const row of rows) {
    const numberText = row[0];
    const uidl = row[1];
    if (numberText === undefined || uidl === undefined) continue;
    const messageNumber = Number.parseInt(numberText, 10);
    if (!Number.isSafeInteger(messageNumber) || messageNumber < 1) continue;
    if (uidl.length === 0) continue;
    entries.push({ messageNumber, uidl });
  }
  return entries;
}

function isNestedList(listing: string[][] | string[]): listing is string[][] {
  const first = listing[0];
  return Array.isArray(first);
}

function serializePop3Cursor(seen: ReadonlySet<string>): string {
  return `${CURSOR_PREFIX}${JSON.stringify([...seen].sort())}`;
}

/** 解析游标；格式不认识时按首次同步处理（宁可多拉，不可漏拉）。 */
function parsePop3Cursor(cursor: SyncCursor | undefined): Set<string> {
  if (cursor === undefined) return new Set();
  if (!cursor.value.startsWith(CURSOR_PREFIX)) return new Set();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor.value.slice(CURSOR_PREFIX.length));
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    return new Set();
  }
  if (!Array.isArray(parsed)) return new Set();
  return new Set(parsed.filter((value): value is string => typeof value === "string"));
}

/** RETR 结果：生产构造固定 `parseStreamToString: true`，因此这里只接受字符串。 */
function readRetrResult(raw: string | Stream): string {
  if (typeof raw === "string") return raw;
  throw new MailError("protocol", "POP3 客户端返回了未解析的邮件流（需开启 parseStreamToString）", false);
}

export class Pop3MailSource implements MailSource {
  readonly provider: MailProvider = "pop3";
  readonly #account: MailSourceAccount;
  readonly #config: Pop3Config;
  readonly #secrets: readonly string[];
  readonly #createClient: (options: Pop3ConnectionOptions) => Pop3ClientLike;
  #client: Pop3ClientLike | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(account: MailSourceAccount, options: Pop3SourceOptions = {}) {
    this.#account = account;
    this.#config = readPop3Config(account);
    this.#secrets = [account.secret];
    this.#createClient =
      options.createClient ??
      ((connection) =>
        new Pop3Command({
          host: connection.host,
          port: connection.port,
          tls: connection.tls,
          user: connection.user,
          password: connection.password,
          timeout: connection.timeoutMs,
        }));
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      const client = await this.#ensureClient();
      const stat = await client.STAT();
      const count = /^\+OK\s+(\d+)/.exec(stat)?.[1];
      const suffix = count === undefined ? "" : `（${count} 封）`;
      return {
        ok: true,
        detail: `POP3 已连接：${this.#account.email} @ ${this.#config.host}:${this.#config.port}${suffix}`,
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

  /** POP3 没有推送通道，也没有 IDLE 等价机制：只能由调用方轮询 fetch()。 */
  async watch(_onNew: () => void): Promise<(() => void) | null> {
    return null;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#runExclusive(async () => {
      await this.#disconnect();
    });
  }

  async #fetchOnce(options: FetchOptions): Promise<FetchResult> {
    const client = await this.#ensureClient();
    let failure: MailError | null = null;
    try {
      const entries = parseUidlListing(await client.UIDL());
      const seen = parsePop3Cursor(options.since);
      const unseen = entries
        .filter((entry) => !seen.has(entry.uidl))
        // 最新优先：首次同步先把最近的邮件拿出来（老邮件在后续轮次补齐，绝不漏）。
        .sort((a, b) => b.messageNumber - a.messageNumber);
      const limit = Math.max(1, options.limit ?? this.#config.fetchLimit);
      const batch = unseen.slice(0, limit);
      const emails: RawEmail[] = [];

      for (const entry of batch) {
        if (options.signal?.aborted === true) throw abortedError();
        const text = readRetrResult(await client.RETR(entry.messageNumber));
        const email = await this.#toEmail(text, entry.uidl);
        // 无论解析成功与否都记入已见集合：坏邮件不能每轮重试、卡住整个账号。
        seen.add(entry.uidl);
        if (email === null) continue;
        emails.push(email);
        options.onProgress?.(emails.length);
      }

      return {
        emails,
        cursor: makeCursor(this.#account.id, serializePop3Cursor(seen)),
        hasMore: unseen.length > batch.length,
      };
    } catch (err) {
      failure = this.#mapError(err);
      throw failure;
    } finally {
      if (failure !== null && failure.code === "network") await this.#disconnect();
    }
  }

  async #toEmail(text: string, uidl: string): Promise<RawEmail | null> {
    try {
      return await parseMimeEmail(this.#account.id, uidl, text, null);
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      return null;
    }
  }

  /**
   * 返回已连接（且已通过 USER/PASS 认证）的客户端。
   *
   * 注意：不要先调用底层 `connect()`——node-pop3 的 `_connect()` 在 `_socket` 已存在时
   * 会跳过 USER/PASS，导致后续命令处于未认证状态。这里让第一条命令自己完成建连+认证。
   */
  async #ensureClient(): Promise<Pop3ClientLike> {
    if (this.#closed) throw new MailError("protocol", "POP3 适配器已关闭", false);
    const existing = this.#client;
    if (existing !== null) return existing;
    let client: Pop3ClientLike;
    try {
      client = this.#createClient({
        host: this.#config.host,
        port: this.#config.port,
        tls: this.#config.tls,
        user: this.#config.user,
        password: this.#account.secret,
        timeoutMs: this.#config.timeoutMs,
      });
    } catch (err) {
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
      await client.QUIT();
    } catch {
      // no-excuse-ok: catch —— 连接已断时 QUIT 必然失败；套接字已不可用，无需再收尾，
      // 也不能用清理异常盖掉真正的错误。
    }
  }

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
