import { InteractionRequiredAuthError, LogLevel, PublicClientApplication } from "@azure/msal-node";
import type { AccountInfo, ICachePlugin, TokenCacheContext } from "@azure/msal-node";
import type { MailProvider, RawEmail } from "@mailcollect/shared";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { MailSourceAccount } from "./account.js";
import { makeCursor, readConfig, readConfigInt } from "./account.js";
import { abortedError, isAbortError, toMailError } from "./errors.js";
import { buildRawEmail, htmlToText } from "./message.js";
import { pickHeaders } from "./headers.js";
import type { FetchOptions, FetchResult, MailSource } from "./types.js";
import { MailError } from "./types.js";

/**
 * Microsoft Graph 适配器。
 *
 * 认证：@azure/msal-node 的公共客户端 + 设备码流程。令牌缓存路径必须由调用方经
 * `config.cachePath` 指定（不写死全局路径），缓存文件按 0600 落盘。
 *
 * 增量：游标就是「下一次要请求的绝对 URL」——Graph delta 的 `@odata.nextLink`
 * （枚举未完成）或 `@odata.deltaLink`（增量基线）。首次同步用一次 `$top` 开窗，
 * 不整箱枚举。
 *
 * 安全：access token 只出现在 Authorization 头里；适配器不打印任何日志，
 * 错误信息经 errors.ts 擦除 secret。
 */

const DEFAULT_GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
const DEFAULT_TENANT = "common";
const DEFAULT_GRAPH_LIMIT = 50;
/** 带 offline_access 才能拿到 refresh token，跨进程复用缓存。 */
const DEFAULT_GRAPH_SCOPES = ["https://graph.microsoft.com/Mail.Read", "offline_access"] as const;

const GRAPH_SELECT_FIELDS = [
  "id",
  "internetMessageId",
  "conversationId",
  "subject",
  "receivedDateTime",
  "sentDateTime",
  "hasAttachments",
  "body",
  "bodyPreview",
  "from",
  "toRecipients",
  "ccRecipients",
  "internetMessageHeaders",
] as const;

const graphRecipientSchema = z.object({
  emailAddress: z
    .object({
      name: z.string().nullish(),
      address: z.string().nullish(),
    })
    .nullish(),
});

const graphMessageSchema = z.object({
  id: z.string().min(1),
  internetMessageId: z.string().nullish(),
  conversationId: z.string().nullish(),
  subject: z.string().nullish(),
  receivedDateTime: z.string().nullish(),
  sentDateTime: z.string().nullish(),
  hasAttachments: z.boolean().nullish(),
  body: z
    .object({
      contentType: z.string().nullish(),
      content: z.string().nullish(),
    })
    .nullish(),
  bodyPreview: z.string().nullish(),
  from: graphRecipientSchema.nullish(),
  toRecipients: z.array(graphRecipientSchema).nullish(),
  ccRecipients: z.array(graphRecipientSchema).nullish(),
  internetMessageHeaders: z
    .array(z.object({ name: z.string().nullish(), value: z.string().nullish() }))
    .nullish(),
});

const graphDeltaPageSchema = z.object({
  value: z.array(z.unknown()).optional(),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});

type GraphRecipient = z.infer<typeof graphRecipientSchema>;
type GraphMessage = z.infer<typeof graphMessageSchema>;
type GraphDeltaBody = z.infer<typeof graphDeltaPageSchema>;

/** Graph 响应的最小结构；测试可以直接给普通对象，无需构造真 Response。 */
export interface GraphResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

/** 传输层注入点。 */
export type GraphFetch = (
  input: string,
  init: { readonly headers: Readonly<Record<string, string>>; readonly signal?: AbortSignal },
) => Promise<GraphResponse>;

/** 设备码提示：由调用方展示给用户（适配器不会把它写进日志）。 */
export interface DeviceCodeNotice {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly message: string;
  readonly expiresInSeconds: number;
}

/** 令牌获取抽象：生产走 MSAL，测试可注入假实现。 */
export interface GraphAuth {
  /** 静默取令牌；缓存失效时抛 MailError("auth")，不阻塞等待用户。 */
  getAccessToken(): Promise<string>;
  /** 设备码登录：会阻塞等待用户在浏览器完成。 */
  login(): Promise<void>;
}

export interface GraphSourceOptions {
  readonly auth?: GraphAuth | undefined;
  readonly fetch?: GraphFetch | undefined;
  readonly onDeviceCode?: ((notice: DeviceCodeNotice) => void) | undefined;
}

interface GraphConfig {
  readonly clientId: string;
  readonly tenant: string;
  readonly cachePath: string;
  readonly scopes: readonly string[];
  readonly baseUrl: string;
  readonly initialLimit: number;
}

interface GraphDeltaPage {
  readonly value: readonly unknown[];
  readonly nextLink: string | null;
  readonly deltaLink: string | null;
}

function readGraphConfig(account: MailSourceAccount): GraphConfig {
  const clientId = readConfig(account, "clientId");
  if (clientId === null) throw new MailError("protocol", "Graph 配置缺少 clientId", false);
  const cachePath = readConfig(account, "cachePath");
  if (cachePath === null) {
    throw new MailError("protocol", "Graph 配置缺少 cachePath（令牌缓存文件路径必须由调用方指定）", false);
  }
  const scopesText = readConfig(account, "scopes");
  return {
    clientId,
    cachePath,
    tenant: readConfig(account, "tenant") ?? DEFAULT_TENANT,
    scopes:
      scopesText === null ? [...DEFAULT_GRAPH_SCOPES] : scopesText.split(",").map((item) => item.trim()).filter((item) => item.length > 0),
    baseUrl: (readConfig(account, "baseUrl") ?? DEFAULT_GRAPH_BASE_URL).replace(/\/+$/, ""),
    initialLimit: readConfigInt(account, "initialLimit", 1, 200) ?? DEFAULT_GRAPH_LIMIT,
  };
}

/** 读 Node 的 err.code（ENOENT 等），不依赖具体错误类。 */
function nodeErrorCode(err: unknown): string | null {
  if (typeof err !== "object" || err === null || !("code" in err)) return null;
  const code: unknown = Reflect.get(err, "code");
  return typeof code === "string" ? code : null;
}

/** 令牌缓存文件插件：读取失败只在 ENOENT（首次登录）时咽下。 */
function createFileCachePlugin(cachePath: string): ICachePlugin {
  return {
    async beforeCacheAccess(context: TokenCacheContext): Promise<void> {
      try {
        context.tokenCache.deserialize(await readFile(cachePath, "utf8"));
      } catch (err) {
        if (nodeErrorCode(err) !== "ENOENT") throw err;
        // 首次登录：缓存文件还不存在，保持空缓存。
      }
    },
    async afterCacheAccess(context: TokenCacheContext): Promise<void> {
      if (!context.cacheHasChanged) return;
      await mkdir(dirname(cachePath), { recursive: true });
      // 令牌缓存等价于凭据：只给当前用户读写。
      await writeFile(cachePath, context.tokenCache.serialize(), { encoding: "utf8", mode: 0o600 });
    },
  };
}

/** 生产用认证实现：MSAL 公共客户端 + 设备码 + 文件令牌缓存。 */
export class MsalDeviceCodeAuth implements GraphAuth {
  readonly #pca: PublicClientApplication;
  readonly #scopes: readonly string[];
  readonly #onDeviceCode: ((notice: DeviceCodeNotice) => void) | undefined;
  #account: AccountInfo | null = null;
  #lastNotice: DeviceCodeNotice | null = null;

  constructor(config: GraphConfig, onDeviceCode?: (notice: DeviceCodeNotice) => void) {
    this.#scopes = [...config.scopes];
    this.#onDeviceCode = onDeviceCode;
    this.#pca = new PublicClientApplication({
      auth: {
        clientId: config.clientId,
        authority: `https://login.microsoftonline.com/${config.tenant}`,
      },
      cache: { cachePlugin: createFileCachePlugin(config.cachePath) },
      // PII 日志关闭；级别压到 error，避免任何令牌片段进入日志。
      system: { loggerOptions: { logLevel: LogLevel.Error, piiLoggingEnabled: false } },
    });
  }

  /** 最近一次设备码提示。工厂创建时没有回调通道，服务层可读取它再展示给用户。 */
  get lastDeviceCodeNotice(): DeviceCodeNotice | null {
    return this.#lastNotice;
  }

  async getAccessToken(): Promise<string> {
    const account = await this.#resolveAccount();
    if (account === null) throw new MailError("auth", "需要设备码登录（尚未登录 Microsoft Graph）", false);
    try {
      const result = await this.#pca.acquireTokenSilent({ account, scopes: [...this.#scopes] });
      return result.accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        this.#account = null;
        throw new MailError("auth", "登录已过期，需要重新进行设备码登录", false);
      }
      throw toMailError(err, []);
    }
  }

  async login(): Promise<void> {
    const result = await this.#pca.acquireTokenByDeviceCode({
      scopes: [...this.#scopes],
      deviceCodeCallback: (response) => {
        const notice: DeviceCodeNotice = {
          userCode: response.userCode,
          verificationUri: response.verificationUri,
          message: response.message,
          expiresInSeconds: response.expiresIn,
        };
        this.#lastNotice = notice;
        this.#onDeviceCode?.(notice);
      },
    });
    if (result === null) throw new MailError("auth", "设备码登录未完成或已超时", false);
    this.#account = result.account;
  }

  async #resolveAccount(): Promise<AccountInfo | null> {
    if (this.#account !== null) return this.#account;
    const accounts = await this.#pca.getTokenCache().getAllAccounts();
    this.#account = accounts[0] ?? null;
    return this.#account;
  }
}

/** Graph 的 delta 页 → 领域消息。单封坏数据跳过，不阻塞整页。 */
function toGraphMessage(item: unknown): GraphMessage | null {
  if (typeof item === "object" && item !== null && "@removed" in item) return null;
  const parsed = graphMessageSchema.safeParse(item);
  return parsed.success ? parsed.data : null;
}

function collectRecipients(list: readonly GraphRecipient[] | null | undefined): string[] {
  if (list === null || list === undefined) return [];
  const addresses: string[] = [];
  for (const recipient of list) {
    const address = recipient.emailAddress?.address?.trim();
    if (address !== undefined && address.length > 0) addresses.push(address);
  }
  return addresses;
}

function toRawEmail(accountId: string, message: GraphMessage): RawEmail {
  const sender = message.from?.emailAddress ?? null;
  const senderName = sender?.name?.trim() ?? "";
  const body = message.body ?? null;
  const isPlainText = body?.contentType?.toLowerCase() === "text";
  const bodyText = body === null ? (message.bodyPreview ?? "") : isPlainText ? (body.content ?? "") : htmlToText(body.content ?? "");
  const headerPairs: Array<readonly [string, string]> = [];
  for (const header of message.internetMessageHeaders ?? []) {
    if (typeof header.name === "string" && typeof header.value === "string") headerPairs.push([header.name, header.value]);
  }

  return buildRawEmail(accountId, {
    uid: message.id,
    messageId: message.internetMessageId ?? message.id,
    threadId: message.conversationId ?? null,
    fromName: senderName.length > 0 ? senderName : null,
    fromEmail: sender?.address?.trim() ?? "",
    to: collectRecipients(message.toRecipients),
    cc: collectRecipients(message.ccRecipients),
    subject: message.subject ?? "",
    sentAt: message.receivedDateTime ?? message.sentDateTime ?? new Date().toISOString(),
    bodyText,
    hasAttachments: message.hasAttachments === true,
    headers: pickHeaders(headerPairs),
  });
}

export class GraphMailSource implements MailSource {
  readonly provider: MailProvider = "graph";
  readonly #account: MailSourceAccount;
  readonly #config: GraphConfig;
  readonly #secrets: readonly string[];
  readonly #auth: GraphAuth;
  readonly #fetch: GraphFetch;
  #closed = false;

  constructor(account: MailSourceAccount, options: GraphSourceOptions = {}) {
    this.#account = account;
    this.#config = readGraphConfig(account);
    this.#secrets = [account.secret];
    this.#auth = options.auth ?? this.#createAuth(options.onDeviceCode);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * 设备码登录入口（`MailSource` 接口之外的用户动作）。
   * 设备码提示经 `onDeviceCode` 回调交给调用方；工厂创建的实例可从 MSAL 实现的
   * `lastDeviceCodeNotice` 读取（服务层应在 verify() 之前取走并展示）。
   */
  async login(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.#auth.login();
    } catch (err) {
      return this.#failure(err);
    }
    return this.verify();
  }

  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      const token = await this.#auth.getAccessToken();
      // 用最小代价验证「令牌有效 + 具备 Mail.Read」：取一封消息的 id。
      await this.#request(`${this.#config.baseUrl}/me/messages?$top=1&$select=id`, token, undefined);
      return { ok: true, detail: `Graph 已连接：${this.#account.email}` };
    } catch (err) {
      return this.#failure(err);
    }
  }

  async fetch(options: FetchOptions = {}): Promise<FetchResult> {
    if (this.#closed) throw new MailError("protocol", "Graph 适配器已关闭", false);
    try {
      const token = await this.#auth.getAccessToken();
      const cursorValue = options.since?.value ?? null;
      const url = cursorValue === null ? this.#startUrl(options) : this.#verifyCursorUrl(cursorValue);
      const page = await this.#deltaPage(url, token, options.signal);

      const emails: RawEmail[] = [];
      for (const item of page.value) {
        if (options.signal?.aborted === true) throw abortedError();
        const message = toGraphMessage(item);
        if (message === null) continue;
        emails.push(toRawEmail(this.#account.id, message));
        options.onProgress?.(emails.length);
      }

      const next = page.deltaLink ?? page.nextLink;
      if (next === null) throw new MailError("protocol", "Graph 增量响应缺少 deltaLink/nextLink", false);
      return {
        emails,
        cursor: makeCursor(this.#account.id, next),
        // nextLink 还在枚举历史，deltaLink 才是真正的增量基线。
        hasMore: page.deltaLink === null,
      };
    } catch (err) {
      throw this.#mapError(err);
    }
  }

  /** Graph 有订阅推送，但 v1 不做公网回调：按「无推送能力」返回 null，调用方走轮询。 */
  async watch(_onNew: () => void): Promise<(() => void) | null> {
    return null;
  }

  async close(): Promise<void> {
    this.#closed = true;
  }

  #createAuth(onDeviceCode?: (notice: DeviceCodeNotice) => void): GraphAuth {
    try {
      return new MsalDeviceCodeAuth(this.#config, onDeviceCode);
    } catch (err) {
      throw toMailError(err, this.#secrets);
    }
  }

  /**
   * 游标里的 URL 会带着 Bearer 令牌去请求：只接受属于配置端点的地址，
   * 避免被篡改的游标把令牌发到任意主机。
   */
  #verifyCursorUrl(cursorValue: string): string {
    if (!cursorValue.startsWith(`${this.#config.baseUrl}/`)) {
      throw new MailError("protocol", "Graph 游标 URL 不属于配置的端点，拒绝带令牌请求", false);
    }
    return cursorValue;
  }

  #startUrl(options: FetchOptions): string {
    const top = Math.min(this.#config.initialLimit, Math.max(1, options.limit ?? this.#config.initialLimit));
    return `${this.#config.baseUrl}/me/messages/delta?$select=${GRAPH_SELECT_FIELDS.join(",")}&$top=${top}`;
  }

  async #deltaPage(url: string, token: string, signal: AbortSignal | undefined): Promise<GraphDeltaPage> {
    const response = await this.#request(url, token, signal);
    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      throw new MailError("protocol", "Graph 响应不是合法 JSON", true, err);
    }
    const parsed = graphDeltaPageSchema.safeParse(body);
    if (!parsed.success) throw new MailError("protocol", "Graph 响应结构无法识别", true, parsed.error);
    return {
      value: parsed.data.value ?? [],
      nextLink: parsed.data["@odata.nextLink"] ?? null,
      deltaLink: parsed.data["@odata.deltaLink"] ?? null,
    };
  }

  async #request(url: string, token: string, signal: AbortSignal | undefined): Promise<GraphResponse> {
    let response: GraphResponse;
    try {
      response = await this.#fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (err) {
      if (isAbortError(err)) throw abortedError();
      throw toMailError(err, this.#secrets);
    }
    if (!response.ok) throw this.#httpError(response);
    return response;
  }

  #httpError(response: GraphResponse): MailError {
    const detail = `Graph 请求失败：HTTP ${response.status}${response.statusText.length > 0 ? ` ${response.statusText}` : ""}`;
    if (response.status === 429) return new MailError("rate_limited", detail, true);
    if (response.status === 401 || response.status === 403) return new MailError("auth", detail, false);
    if (response.status >= 500) return new MailError("network", detail, true);
    return new MailError("protocol", detail, false);
  }

  #failure(err: unknown): { ok: false; detail: string } {
    const mapped = this.#mapError(err);
    return { ok: false, detail: `${mapped.code}: ${mapped.message}` };
  }

  #mapError(err: unknown): MailError {
    if (isAbortError(err)) return abortedError();
    return toMailError(err, this.#secrets);
  }
}
