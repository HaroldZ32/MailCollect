import { InteractionRequiredAuthError, LogLevel, PublicClientApplication } from "@azure/msal-node";
import type { AccountInfo, ICachePlugin, TokenCacheContext } from "@azure/msal-node";
import type { FolderRole, MailProvider, RawEmail } from "@mailcollect/shared";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { MailSourceAccount } from "./account.js";
import { makeCursor, readConfig, readConfigInt } from "./account.js";
import { abortedError, isAbortError, notConfiguredError, toMailError, unsupportedError } from "./errors.js";
import { buildRawEmail, htmlToText } from "./message.js";
import { pickHeaders } from "./headers.js";
import type {
  AttachmentData,
  AttachmentInfo,
  DeleteOptions,
  DeviceCodeNotice,
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

// 定义已经上移到 types.ts（MailSource.login 需要它），这里保留同名再导出。
export type { DeviceCodeNotice } from "./types.js";

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
const DEFAULT_SEARCH_LIMIT = 25;
/** 带 offline_access 才能拿到 refresh token，跨进程复用缓存。 */
const DEFAULT_GRAPH_SCOPES = ["https://graph.microsoft.com/Mail.Read", "offline_access"] as const;
/**
 * 发信/写操作在默认收信 scope 之外「追加」的委托权限。
 * 未单独授权的旧缓存会在静默取令牌时抛 InteractionRequiredAuthError，映射成 auth 并提示重新授权。
 */
const GRAPH_SEND_SCOPES = ["https://graph.microsoft.com/Mail.Send"] as const;
const GRAPH_WRITE_SCOPES = ["https://graph.microsoft.com/Mail.ReadWrite"] as const;

/**
 * Graph well-known 文件夹：`wellKnownName` 是唯一不随显示语言变化的稳定标记。
 * 对应关系收敛成本仓库的 `FolderRole`（`junkemail` 归 junk，其余未识别一律 other）。
 */
const WELL_KNOWN_FOLDER_ROLES: Readonly<Record<string, FolderRole>> = {
  inbox: "inbox",
  sentitems: "sent",
  drafts: "drafts",
  deleteditems: "trash",
  archive: "archive",
  junkemail: "junk",
};

/** 契约要求必须补齐的五个角色（Inbox/Sent/Drafts/Trash/Archive）。 */
const REQUIRED_FOLDER_ROLES = ["inbox", "sent", "drafts", "trash", "archive"] as const;
const REQUIRED_FOLDER_WELL_KNOWN: Readonly<Record<(typeof REQUIRED_FOLDER_ROLES)[number], string>> = {
  inbox: "inbox",
  sent: "sentitems",
  drafts: "drafts",
  trash: "deleteditems",
  archive: "archive",
};

/** `wellKnownName` 缺失时的兜底：只认英文显示名，本地化显示名不可靠。 */
const DISPLAY_NAME_FOLDER_ROLES: Readonly<Record<string, FolderRole>> = {
  inbox: "inbox",
  "sent items": "sent",
  sent: "sent",
  drafts: "drafts",
  "deleted items": "trash",
  trash: "trash",
  archive: "archive",
  "junk email": "junk",
  junk: "junk",
};

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
  parentFolderId: z.string().nullish(),
  internetMessageId: z.string().nullish(),
  conversationId: z.string().nullish(),
  subject: z.string().nullish(),
  receivedDateTime: z.string().nullish(),
  sentDateTime: z.string().nullish(),
  hasAttachments: z.boolean().nullish(),
  isRead: z.boolean().nullish(),
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

const graphFolderSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().nullish(),
  wellKnownName: z.string().nullish(),
  unreadItemCount: z.number().nullish(),
  totalItemCount: z.number().nullish(),
});

const graphFolderPageSchema = z.object({
  value: z.array(z.unknown()).optional(),
});

const graphAttachmentMetaSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullish(),
  contentType: z.string().nullish(),
  size: z.number().nullish(),
  isInline: z.boolean().nullish(),
});

const graphAttachmentPageSchema = z.object({
  value: z.array(z.unknown()).optional(),
});

const graphAttachmentDownloadSchema = graphAttachmentMetaSchema.extend({
  contentBytes: z.string().nullish(),
});

const graphSearchPageSchema = z.object({
  value: z.array(z.object({ id: z.string().min(1), parentFolderId: z.string().nullish() })).optional(),
});

const graphMoveResultSchema = z.object({
  id: z.string().min(1),
  parentFolderId: z.string().nullish(),
});

const graphDeltaPageSchema = z.object({
  value: z.array(z.unknown()).optional(),
  "@odata.nextLink": z.string().optional(),
  "@odata.deltaLink": z.string().optional(),
});

type GraphRecipient = z.infer<typeof graphRecipientSchema>;
type GraphMessage = z.infer<typeof graphMessageSchema>;
type GraphFolder = z.infer<typeof graphFolderSchema>;
type GraphAttachmentMeta = z.infer<typeof graphAttachmentMetaSchema>;
type GraphDeltaBody = z.infer<typeof graphDeltaPageSchema>;

/** Graph 响应的最小结构；测试可以直接给普通对象，无需构造真 Response。 */
export interface GraphResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  json(): Promise<unknown>;
}

/** 一次请求的传输层参数；`body`/`method` 是 v1.1 写操作新增的可选项。 */
export interface GraphRequestInit {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly method?: string;
  readonly body?: string;
}

/** 传输层注入点。 */
export type GraphFetch = (input: string, init: GraphRequestInit) => Promise<GraphResponse>;

/** 内部请求参数：method/body 让同一传输层承载 GET/POST/PATCH/DELETE。 */
interface GraphSendOptions {
  readonly method?: string;
  readonly body?: string;
  readonly contentType?: string;
  readonly extraHeaders?: Readonly<Record<string, string>>;
}

/** 令牌获取抽象：生产走 MSAL，测试可注入假实现。 */
export interface GraphAuth {
  /**
   * 静默取令牌；缓存失效时抛 MailError("auth")，不阻塞等待用户。
   * `extraScopes` 用于发信/写操作追加 Mail.Send / Mail.ReadWrite。
   */
  getAccessToken(extraScopes?: readonly string[]): Promise<string>;
  /** 设备码登录：会阻塞等待用户在浏览器完成；回调覆盖构造时提供的那个。 */
  login(onDeviceCode?: (notice: DeviceCodeNotice) => void): Promise<void>;
  /** 最近一次设备码提示；注入实现可以不提供。 */
  readonly lastDeviceCodeNotice?: DeviceCodeNotice | null;
}

export interface GraphSourceOptions {
  readonly auth?: GraphAuth | undefined;
  readonly fetch?: GraphFetch | undefined;
  readonly onDeviceCode?: ((notice: DeviceCodeNotice) => void) | undefined;
}

/**
 * `fetch` 的 Graph 扩展：`folderId` 指定只在某个文件夹内做增量（省略时整箱）。
 *
 * 自 v1.1 起 `FetchOptions` 自己也带上了同名的 `folderId`（服务端可以从 `MailSource`
 * 的类型面直接按文件夹拉取）；这里保留同名声明只是为了在 Graph 的签名上标明它支持
 * 这个字段，类型与基类完全一致。
 */
export interface GraphFetchOptions extends FetchOptions {
  readonly folderId?: string | null | undefined;
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
  // 只认账号 config：不读环境变量，也不接受任何全局默认 clientId。
  if (clientId === null) {
    throw notConfiguredError("graph", "缺少 clientId（在账号 config 里填 Azure 应用注册的客户端 id）");
  }
  const cachePath = readConfig(account, "cachePath");
  if (cachePath === null) {
    throw new MailError("protocol", "Graph 配置缺少 cachePath（令牌缓存文件路径必须由调用方指定）", false);
  }
  const scopesText = readConfig(account, "scopes");
  return {
    clientId,
    cachePath,
    // tenant 留空（或只有空白）按 common 处理：个人 Microsoft 账号只能走 common。
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

/** 合并 scope 列表：去重、去空白，保持首次出现的顺序。 */
function mergeScopes(base: readonly string[], extra: readonly string[] = []): string[] {
  const merged: string[] = [];
  for (const scope of [...base, ...extra]) {
    const normalized = scope.trim();
    if (normalized.length > 0 && !merged.includes(normalized)) merged.push(normalized);
  }
  return merged;
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

  async getAccessToken(extraScopes: readonly string[] = []): Promise<string> {
    const account = await this.#resolveAccount();
    if (account === null) throw new MailError("auth", "需要设备码登录（尚未登录 Microsoft Graph）", false);
    try {
      const result = await this.#pca.acquireTokenSilent({ account, scopes: mergeScopes(this.#scopes, extraScopes) });
      return result.accessToken;
    } catch (err) {
      if (err instanceof InteractionRequiredAuthError) {
        this.#account = null;
        const detail =
          extraScopes.length > 0
            ? "缺少发信/写操作权限（Mail.Send / Mail.ReadWrite），需要重新进行设备码登录并同意"
            : "登录已过期，需要重新进行设备码登录";
        throw new MailError("auth", detail, false);
      }
      throw toMailError(err, []);
    }
  }

  async login(onDeviceCode?: (notice: DeviceCodeNotice) => void): Promise<void> {
    const notify = onDeviceCode ?? this.#onDeviceCode;
    // 设备码是唯一的交互式授权机会：一次同意就覆盖本适配器的全部端口
    // （收信 Mail.Read、写操作 Mail.ReadWrite、发信 Mail.Send；offline_access 已在默认 scope 里）。
    const result = await this.#pca.acquireTokenByDeviceCode({
      scopes: mergeScopes(this.#scopes, [...GRAPH_WRITE_SCOPES, ...GRAPH_SEND_SCOPES]),
      deviceCodeCallback: (response) => {
        const notice: DeviceCodeNotice = {
          userCode: response.userCode,
          verificationUri: response.verificationUri,
          message: response.message,
          expiresInSeconds: response.expiresIn,
        };
        this.#lastNotice = notice;
        notify?.(notice);
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

/** Graph 的 ISO 时间字符串 → Date；空/非法返回 null（不造数）。 */
function parseGraphDate(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
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
    // sentAt = 发件人声明的时间（sentDateTime ≈ Date 头）；接收时间单独给。
    sentAt: sentAtOf(message),
    bodyText,
    hasAttachments: message.hasAttachments === true,
    headers: pickHeaders(headerPairs),
  });
}

/** well-known 标记优先；缺失时才用英文显示名兜底（本地化显示名不可靠）。 */
function folderRole(folder: GraphFolder): FolderRole {
  const wellKnown = folder.wellKnownName?.trim().toLowerCase() ?? "";
  if (wellKnown.length > 0) return WELL_KNOWN_FOLDER_ROLES[wellKnown] ?? "other";
  const displayName = folder.displayName?.trim().toLowerCase() ?? "";
  return DISPLAY_NAME_FOLDER_ROLES[displayName] ?? "other";
}

function toFolderInfo(folder: GraphFolder, fallbackName: string): FolderInfo {
  const name = folder.displayName?.trim() ?? "";
  return {
    id: folder.id,
    name: name.length > 0 ? name : fallbackName,
    role: folderRole(folder),
    unreadCount: folder.unreadItemCount ?? 0,
  };
}

function toAttachmentInfo(meta: GraphAttachmentMeta): AttachmentInfo {
  return {
    id: meta.id,
    filename: meta.name?.trim() ?? "",
    mimeType: meta.contentType?.trim() ?? "application/octet-stream",
    size: meta.size ?? 0,
    inline: meta.isInline === true,
  };
}

/**
 * 发件人声明时间（Date 头 ≈ Graph 的 `sentDateTime`），缺失时退回接收时间。
 * 统一 `toISOString()`：与 IMAP/EWS 一致，也把 Graph 可能返回的 7 位小数秒归一化。
 */
function sentAtOf(message: GraphMessage): string {
  const sent = parseGraphDate(message.sentDateTime) ?? parseGraphDate(message.receivedDateTime) ?? new Date();
  return sent.toISOString();
}

/** `MessageBody.receivedAt` 只在真的拿到服务器接收时间时出现。 */
function receivedAtField(receivedAt: Date | null): { readonly receivedAt?: Date } {
  return receivedAt === null ? {} : { receivedAt };
}

function toMessageBody(message: GraphMessage, attachments: readonly AttachmentInfo[]): MessageBody {
  const sender = message.from?.emailAddress ?? null;
  const body = message.body ?? null;
  const isHtml = body?.contentType?.toLowerCase() === "html";
  const content = body?.content ?? null;
  return {
    id: message.id,
    folderId: message.parentFolderId ?? null,
    subject: message.subject ?? "",
    fromName: sender?.name?.trim() ?? null,
    fromEmail: sender?.address?.trim() ?? "",
    to: collectRecipients(message.toRecipients),
    cc: collectRecipients(message.ccRecipients),
    // sentAt = 发件人声明的时间（sentDateTime ≈ Date 头）；接收时间单独给。
    sentAt: sentAtOf(message),
    ...receivedAtField(parseGraphDate(message.receivedDateTime)),
    isRead: message.isRead === true,
    text: body === null ? (message.bodyPreview ?? "") : isHtml ? htmlToText(content ?? "") : (content ?? ""),
    html: isHtml ? content : null,
    attachments,
  };
}

/** KQL 值转义：反斜杠与双引号都不能破坏 `subject:"…"` 的结构。 */
function escapeSearchValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** 文本条件合成 `$search` 表达式；没有文本条件时返回 null（只走 $filter 或普通列举）。 */
function buildSearchExpression(query: MailSearchQuery): string | null {
  const terms: string[] = [];
  if (query.subject !== undefined && query.subject.trim().length > 0) {
    terms.push(`subject:"${escapeSearchValue(query.subject.trim())}"`);
  }
  if (query.from !== undefined && query.from.trim().length > 0) {
    terms.push(`from:"${escapeSearchValue(query.from.trim())}"`);
  }
  if (query.body !== undefined && query.body.trim().length > 0) {
    terms.push(`body:"${escapeSearchValue(query.body.trim())}"`);
  }
  return terms.length > 0 ? terms.join(" ") : null;
}

/** 非文本条件合成 `$filter`；与 `$search` 组合时若服务器拒绝，search() 会映射为 unsupported。 */
function buildSearchFilter(query: MailSearchQuery): string | null {
  const filters: string[] = [];
  if (query.unreadOnly === true) filters.push("isRead eq false");
  if (query.since !== undefined && query.since.trim().length > 0) filters.push(`receivedDateTime ge ${query.since.trim()}`);
  if (query.before !== undefined && query.before.trim().length > 0) filters.push(`receivedDateTime lt ${query.before.trim()}`);
  return filters.length > 0 ? filters.join(" and ") : null;
}

function clampSearchLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(Math.trunc(raw), 1), 200);
}

export class GraphMailSource implements MailSource {
  readonly provider: MailProvider = "graph";
  readonly #account: MailSourceAccount;
  readonly #config: GraphConfig;
  readonly #secrets: readonly string[];
  readonly #auth: GraphAuth;
  readonly #fetch: GraphFetch;
  #closed = false;
  #lastNotice: DeviceCodeNotice | null = null;

  constructor(account: MailSourceAccount, options: GraphSourceOptions = {}) {
    this.#account = account;
    this.#config = readGraphConfig(account);
    this.#secrets = [account.secret];
    this.#auth = options.auth ?? this.#createAuth(options.onDeviceCode);
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * 设备码登录（`MailSource.login`）。
   *
   * 设备码提示走两条通道：本次调用传入的 `onDeviceCode`，以及实例上的
   * `lastDeviceCodeNotice`。两条通道都只是「给用户看的一句话」，不落日志。
   */
  async login(onDeviceCode?: (notice: DeviceCodeNotice) => void): Promise<{ ok: boolean; detail: string }> {
    if (this.#closed) return { ok: false, detail: "protocol: Graph 适配器已关闭" };
    const notify = (notice: DeviceCodeNotice): void => {
      this.#lastNotice = notice;
      onDeviceCode?.(notice);
    };
    try {
      await this.#auth.login(notify);
    } catch (err) {
      return this.#failure(err);
    }
    // MSAL 实现自己也会记录提示；注入实现不回调时，从这里补齐透出。
    this.#lastNotice ??= this.#auth.lastDeviceCodeNotice ?? null;
    return this.verify();
  }

  /** 最近一次设备码提示；未登录或注入的 auth 不提供时为 null。 */
  get lastDeviceCodeNotice(): DeviceCodeNotice | null {
    return this.#lastNotice ?? this.#auth.lastDeviceCodeNotice ?? null;
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

  async fetch(options: GraphFetchOptions = {}): Promise<FetchResult> {
    if (this.#closed) throw new MailError("protocol", "Graph 适配器已关闭", false);
    try {
      const token = await this.#auth.getAccessToken();
      const cursorValue = options.since?.value ?? null;
      const url = cursorValue === null ? this.#startUrl(options) : this.#verifyCursorUrl(cursorValue);
      const page = await this.#deltaPage(url, token, options.signal);

      const emails: RawEmail[] = [];
      const receivedAtByUid = new Map<string, Date>();
      for (const item of page.value) {
        if (options.signal?.aborted === true) throw abortedError();
        const message = toGraphMessage(item);
        if (message === null) continue;
        const email = toRawEmail(this.#account.id, message);
        emails.push(email);
        // Graph 的 receivedDateTime 就是服务器接收时间；缺失就不放进 map（不造数）。
        const receivedAt = parseGraphDate(message.receivedDateTime);
        if (receivedAt !== null) receivedAtByUid.set(email.uid, receivedAt);
        options.onProgress?.(emails.length);
      }

      const next = page.deltaLink ?? page.nextLink;
      if (next === null) throw new MailError("protocol", "Graph 增量响应缺少 deltaLink/nextLink", false);
      return {
        emails,
        cursor: makeCursor(this.#account.id, next),
        // nextLink 还在枚举历史，deltaLink 才是真正的增量基线。
        hasMore: page.deltaLink === null,
        ...(receivedAtByUid.size > 0 ? { receivedAtByUid } : {}),
      };
    } catch (err) {
      throw this.#mapError(err);
    }
  }

  /* ---------------------- v1.1 能力端口（全部 optional） ---------------------- */

  /**
   * 列文件夹并把 Graph 的 `wellKnownName` 收敛成 `FolderRole`。
   * 列表接口不保证返回隐藏文件夹（例如个人账号的 Archive），因此对五个契约要求的
   * 角色再按 well-known 路径逐个补齐；404 表示该账号确实没有这个文件夹，跳过。
   */
  async listFolders(): Promise<readonly FolderInfo[]> {
    if (this.#closed) throw new MailError("protocol", "Graph 适配器已关闭", false);
    try {
      const token = await this.#auth.getAccessToken();
      const select = "$select=id,displayName,wellKnownName,unreadItemCount";
      const body = await this.#json(`${this.#config.baseUrl}/me/mailFolders?$top=100&${select}`, token, undefined);
      const page = graphFolderPageSchema.safeParse(body);
      if (!page.success) throw new MailError("protocol", "Graph 文件夹响应结构无法识别", true, page.error);

      const folders: FolderInfo[] = [];
      const seen = new Set<string>();
      for (const item of page.data.value ?? []) {
        const parsed = graphFolderSchema.safeParse(item);
        if (!parsed.success) continue;
        if (seen.has(parsed.data.id)) continue;
        seen.add(parsed.data.id);
        folders.push(toFolderInfo(parsed.data, parsed.data.id));
      }

      for (const role of REQUIRED_FOLDER_ROLES) {
        if (folders.some((folder) => folder.role === role)) continue;
        const wellKnown = REQUIRED_FOLDER_WELL_KNOWN[role];
        const response = await this.#send(`${this.#config.baseUrl}/me/mailFolders/${wellKnown}?${select}`, token, undefined);
        if (response.status === 404) continue;
        if (!response.ok) throw this.#httpError(response);
        const parsed = graphFolderSchema.safeParse(await this.#readJson(response));
        if (!parsed.success) throw new MailError("protocol", "Graph 文件夹响应结构无法识别", true, parsed.error);
        if (seen.has(parsed.data.id)) continue;
        seen.add(parsed.data.id);
        folders.push(toFolderInfo(parsed.data, wellKnown));
      }
      return folders;
    } catch (err) {
      throw this.#mapError(err);
    }
  }

  /** 读单封：正文、收发件人、已读标记与附件元数据。 */
  async getMessage(ref: MessageRef): Promise<MessageBody> {
    if (this.#closed) throw new MailError("protocol", "Graph 适配器已关闭", false);
    try {
      const token = await this.#auth.getAccessToken();
      const select =
        "id,parentFolderId,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body,bodyPreview,isRead,hasAttachments";
      const body = await this.#json(`${this.#config.baseUrl}/me/messages/${encodeURIComponent(ref.id)}?$select=${select}`, token, undefined);
      const parsed = graphMessageSchema.safeParse(body);
      if (!parsed.success) throw new MailError("protocol", "Graph 邮件响应结构无法识别", true, parsed.error);
      const attachments = parsed.data.hasAttachments === true ? await this.#listAttachments(parsed.data.id, token) : [];
      return toMessageBody(parsed.data, attachments);
    } catch (err) {
      throw this.#mapError(err);
    }
  }

  /** 按附件 id 取原始字节；Graph 只给文件附件（itemAttachment 没有 contentBytes）。 */
  async getAttachment(ref: MessageRef, attachmentId: string): Promise<AttachmentData> {
    if (this.#closed) throw new MailError("protocol", "Graph 适配器已关闭", false);
    try {
      const token = await this.#auth.getAccessToken();
      const url = `${this.#config.baseUrl}/me/messages/${encodeURIComponent(ref.id)}/attachments/${encodeURIComponent(attachmentId)}?$select=id,name,contentType,size,isInline,contentBytes`;
      const parsed = graphAttachmentDownloadSchema.safeParse(await this.#json(url, token, undefined));
      if (!parsed.success) throw new MailError("protocol", "Graph 附件响应结构无法识别", true, parsed.error);
      const contentBytes = parsed.data.contentBytes;
      if (contentBytes === undefined || contentBytes === null || contentBytes.length === 0) {
        throw unsupportedError("Graph 附件下载", "该附件不是文件附件（Graph 不提供字节流）");
      }
      return {
        info: toAttachmentInfo(parsed.data),
        content: new Uint8Array(Buffer.from(contentBytes, "base64")),
      };
    } catch (err) {
      throw this.#mapError(err);
    }
  }

  /** 已读/加旗标：PATCH /me/messages/{id}，只改给出的字段。 */
  async setFlags(ref: MessageRef, patch: MessageFlagsPatch): Promise<void> {
    if (this.#closed) throw new MailError("protocol", "Graph 适配器已关闭", false);
    const payload: Record<string, unknown> = {};
    if (patch.read !== undefined) payload.isRead = patch.read;
    if (patch.flagged !== undefined) payload.flag = { flagStatus: patch.flagged ? "flagged" : "notFlagged" };
    if (Object.keys(payload).length === 0) return;
    try {
      const token = await this.#auth.getAccessToken(GRAPH_WRITE_SCOPES);
      const response = await this.#send(`${this.#config.baseUrl}/me/messages/${encodeURIComponent(ref.id)}`, token, undefined, {
        method: "PATCH",
        body: JSON.stringify(payload),
        contentType: "application/json",
      });
      if (!response.ok) throw this.#httpError(response);
    } catch (err) {
      throw this.#mapError(err);
    }
  }

  /** 移动；Graph 移动后消息 id 会变，返回新定位。 */
  async move(ref: MessageRef, targetFolderId: string): Promise<MessageRef> {
    if (this.#closed) throw new MailError("protocol", "Graph 适配器已关闭", false);
    try {
      const token = await this.#auth.getAccessToken(GRAPH_WRITE_SCOPES);
      const body = await this.#json(
        `${this.#config.baseUrl}/me/messages/${encodeURIComponent(ref.id)}/move`,
        token,
        undefined,
        "POST",
        JSON.stringify({ destinationId: targetFolderId }),
        "application/json",
      );
      const parsed = graphMoveResultSchema.safeParse(body);
      if (!parsed.success) throw new MailError("protocol", "Graph 移动响应结构无法识别", true, parsed.error);
      return { id: parsed.data.id, folderId: parsed.data.parentFolderId ?? targetFolderId };
    } catch (err) {
      throw this.#mapError(err);
    }
  }

  /** 默认移入回收站（deleteditems）；`permanent` 才真正 DELETE。 */
  async delete(ref: MessageRef, options: DeleteOptions = {}): Promise<void> {
    if (this.#closed) throw new MailError("protocol", "Graph 适配器已关闭", false);
    try {
      const token = await this.#auth.getAccessToken(GRAPH_WRITE_SCOPES);
      if (options.permanent === true) {
        const response = await this.#send(`${this.#config.baseUrl}/me/messages/${encodeURIComponent(ref.id)}`, token, undefined, {
          method: "DELETE",
        });
        if (!response.ok) throw this.#httpError(response);
        return;
      }
      await this.#json(
        `${this.#config.baseUrl}/me/messages/${encodeURIComponent(ref.id)}/move`,
        token,
        undefined,
        "POST",
        JSON.stringify({ destinationId: "deleteditems" }),
        "application/json",
      );
    } catch (err) {
      throw this.#mapError(err);
    }
  }

  /**
   * 服务器端搜索：文本条件走 `$search`（Graph KQL），未读/日期走 `$filter`。
   * 服务器拒绝 `$search`（400/415/501）时返回类型化 unsupported，绝不静默返回空数组；
   * 省略 folderId 时搜整个邮箱（与 types.ts 的契约一致）。
   */
  async search(query: MailSearchQuery): Promise<readonly MailSearchHit[]> {
    if (this.#closed) throw new MailError("protocol", "Graph 适配器已关闭", false);
    try {
      const token = await this.#auth.getAccessToken();
      const expression = buildSearchExpression(query);
      const filter = buildSearchFilter(query);
      const params: string[] = [`$top=${clampSearchLimit(query.limit)}`, "$select=id,parentFolderId"];
      if (expression !== null) params.push(`$search=${encodeURIComponent(`"${expression}"`)}`);
      if (filter !== null) params.push(`$filter=${encodeURIComponent(filter)}`);

      const folderId = query.folderId?.trim() ?? "";
      const collection = folderId.length > 0 ? `/me/mailFolders/${encodeURIComponent(folderId)}/messages` : "/me/messages";
      const response = await this.#send(`${this.#config.baseUrl}${collection}?${params.join("&")}`, token, undefined);
      if (!response.ok) {
        if (response.status === 400 || response.status === 415 || response.status === 501) {
          throw unsupportedError("Graph 搜索", `服务器不接受 $search 查询（HTTP ${response.status}）`);
        }
        throw this.#httpError(response);
      }
      const page = graphSearchPageSchema.safeParse(await this.#readJson(response));
      if (!page.success) throw new MailError("protocol", "Graph 搜索响应结构无法识别", true, page.error);
      return (page.data.value ?? []).map((item) => ({
        id: item.id,
        folderId: item.parentFolderId ?? (folderId.length > 0 ? folderId : null),
      }));
    } catch (err) {
      throw this.#mapError(err);
    }
  }

  /**
   * 发信：`POST /me/sendMail`，请求体是 base64 的完整 MIME（Content-Type: text/plain），
   * 收件人/主题由 MIME 头决定，服务端自动保存 Sent。
   *
   * `Mail.Send` 由 `getAccessToken(GRAPH_SEND_SCOPES)` 单独申请：旧缓存没同意这个 scope 时
   * MSAL 抛 InteractionRequiredAuthError → 类型化 auth（提示重新授权），账号收信不受影响。
   * 失败不抛异常：用 `SendResult.ok:false` 带类型化 error 返回。
   */
  async sendViaGraph(request: SendRequest): Promise<SendResult> {
    if (this.#closed) return this.#sendFailure(new MailError("protocol", "Graph 适配器已关闭", false));
    try {
      const token = await this.#auth.getAccessToken(GRAPH_SEND_SCOPES);
      const payload = Buffer.from(request.mime).toString("base64");
      const response = await this.#send(`${this.#config.baseUrl}/me/sendMail`, token, undefined, {
        method: "POST",
        body: payload,
        contentType: "text/plain",
        extraHeaders: { "Content-Transfer-Encoding": "base64" },
      });
      if (!response.ok) throw this.#httpError(response);
      const recipients = request.to.length + request.cc.length + request.bcc.length;
      return {
        ok: true,
        transport: "graph",
        // MIME 发送不回消息 id；调用方用 MIME 头里的客户端 Message-ID。
        messageId: null,
        savedToSent: "server",
        detail: `Graph 已发送（${recipients} 个收件人，服务端保存到 Sent）`,
      };
    } catch (err) {
      return this.#sendFailure(this.#sendError(err));
    }
  }

  async #listAttachments(messageId: string, token: string): Promise<readonly AttachmentInfo[]> {
    const body = await this.#json(
      `${this.#config.baseUrl}/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size,isInline`,
      token,
      undefined,
    );
    const page = graphAttachmentPageSchema.safeParse(body);
    if (!page.success) throw new MailError("protocol", "Graph 附件列表响应结构无法识别", true, page.error);
    const attachments: AttachmentInfo[] = [];
    for (const item of page.data.value ?? []) {
      const parsed = graphAttachmentMetaSchema.safeParse(item);
      if (!parsed.success) continue;
      attachments.push(toAttachmentInfo(parsed.data));
    }
    return attachments;
  }

  #sendFailure(error: MailError): SendResult {
    return { ok: false, transport: "graph", savedToSent: "none", detail: `${error.code}: ${error.message}`, error };
  }

  /** 发信路径的鉴权失败统一提示重新授权（缺 Mail.Send），其余错误原样保留类型。 */
  #sendError(err: unknown): MailError {
    const mapped = this.#mapError(err);
    if (mapped.code !== "auth") return mapped;
    return new MailError("auth", "缺少 Mail.Send 权限或授权已失效：请在账号设置里重新进行设备码登录并同意 Mail.Send", false);
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

  #startUrl(options: GraphFetchOptions): string {
    const top = Math.min(this.#config.initialLimit, Math.max(1, options.limit ?? this.#config.initialLimit));
    const folderId = options.folderId?.trim() ?? "";
    const collection =
      folderId.length > 0 ? `/me/mailFolders/${encodeURIComponent(folderId)}/messages/delta` : "/me/messages/delta";
    return `${this.#config.baseUrl}${collection}?$select=${GRAPH_SELECT_FIELDS.join(",")}&$top=${top}`;
  }

  async #deltaPage(url: string, token: string, signal: AbortSignal | undefined): Promise<GraphDeltaPage> {
    const parsed = graphDeltaPageSchema.safeParse(await this.#readJson(await this.#request(url, token, signal)));
    if (!parsed.success) throw new MailError("protocol", "Graph 响应结构无法识别", true, parsed.error);
    return {
      value: parsed.data.value ?? [],
      nextLink: parsed.data["@odata.nextLink"] ?? null,
      deltaLink: parsed.data["@odata.deltaLink"] ?? null,
    };
  }

  /** 发一次请求但不检查 HTTP 状态：调用方需要自己区分 404/400 等路径（例如搜索、文件夹补齐）。 */
  async #send(
    url: string,
    token: string,
    signal: AbortSignal | undefined,
    options: GraphSendOptions = {},
  ): Promise<GraphResponse> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(options.contentType === undefined ? {} : { "Content-Type": options.contentType }),
      ...options.extraHeaders,
    };
    try {
      return await this.#fetch(url, {
        headers,
        ...(signal === undefined ? {} : { signal }),
        ...(options.method === undefined ? {} : { method: options.method }),
        ...(options.body === undefined ? {} : { body: options.body }),
      });
    } catch (err) {
      if (isAbortError(err)) throw abortedError();
      throw toMailError(err, this.#secrets);
    }
  }

  async #request(url: string, token: string, signal: AbortSignal | undefined): Promise<GraphResponse> {
    const response = await this.#send(url, token, signal);
    if (!response.ok) throw this.#httpError(response);
    return response;
  }

  /** 发请求、检查状态、解析 JSON；`method`/`body` 缺省时就是一次 GET。 */
  async #json(
    url: string,
    token: string,
    signal: AbortSignal | undefined,
    method?: string,
    body?: string,
    contentType?: string,
  ): Promise<unknown> {
    const response = await this.#send(url, token, signal, {
      ...(method === undefined ? {} : { method }),
      ...(body === undefined ? {} : { body }),
      ...(contentType === undefined ? {} : { contentType }),
    });
    if (!response.ok) throw this.#httpError(response);
    return this.#readJson(response);
  }

  async #readJson(response: GraphResponse): Promise<unknown> {
    try {
      return await response.json();
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      throw new MailError("protocol", "Graph 响应不是合法 JSON", true, err);
    }
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
