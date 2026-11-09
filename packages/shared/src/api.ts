import type {
  AccountSendConfig,
  AttachmentMeta,
  Category,
  ChangeLogRow,
  Draft,
  Folder,
  InitState,
  LlmProtocol,
  MailAuthMode,
  MailProvider,
  MessageBody,
  OutboxItem,
  OutboxStatus,
  OutgoingMessage,
  RawEmail,
  Rule,
  SyncProgress,
  Task,
  TaskStatus,
} from "./domain.js";
import type { RuleTree } from "./rules.js";

/**
 * HTTP surface — FROZEN CONTRACT. The UI is written against this file.
 * Every route is under API_PREFIX and (except /health) requires
 * `Authorization: Bearer <token>`.
 */
export const API_PREFIX = "/api";

export type ApiErrorCode =
  | "unauthorized"
  | "not_found"
  | "invalid_input"
  | "upstream_error"
  | "internal";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}

export interface HealthResponse {
  ok: true;
  version: string;
  dbPath: string;
  hasProfile: boolean;
  accountCount: number;
}

/* ---------------------------------- profile --------------------------------- */

export interface UpsertProfileInput {
  displayName: string;
  aliases: string[];
  emails: string[];
  timezone: string;
}

/* --------------------------------- accounts --------------------------------- */

export interface CreateAccountInput {
  provider: MailProvider;
  label: string;
  email: string;
  /** Non-secret settings: host, port, tls, mailbox, user. */
  config: Record<string, string>;
  /**
   * v1.1: 非密身份设置可直接放在 `config` 里（服务端按字符串原样落库）：
   * `config.signature`（纯文本签名）与 `config.displayName`（From 显示名）。
   * 推荐改用类型化入口 `send.signature` / `send.displayName`；两者同时出现时以
   * `send` 为准。
   */
  /** Password / app password / refresh token. Encrypted at rest, never returned. */
  secret: string;
  /**
   * v1.1: outbound settings (SMTP / EWS). Optional for receive-only accounts.
   *
   * `send.smtpPassword` is the ONLY canonical place for an SMTP/EWS password —
   * there is no top-level duplicate, so no precedence question can arise.
   */
  send?: AccountSendInput;
}

/** v1.1 发信设置入参；字段与 `AccountSendConfig` 对齐，密码只写不读。 */
export interface AccountSendInput {
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  /** SMTP/EWS password. Encrypted at rest, never returned by any endpoint. */
  smtpPassword?: string;
  ewsUrl?: string;
  authMode?: MailAuthMode;
  /**
   * v1.1: 纯文本签名（发送时自动追加到正文；单封 `includeSignature=false` 可关）。
   * 最长 `ACCOUNT_SIGNATURE_MAX_LENGTH`（2000）字符；服务端落库到非密
   * `config.signature`。若同时出现 `config.signature`，以本字段为准。
   */
  signature?: string;
  /**
   * v1.1: From 显示名（`显示名 <账号地址>`；From 地址固定为账号地址）。
   * 最长 `ACCOUNT_DISPLAY_NAME_MAX_LENGTH`（200）字符；落库到非密
   * `config.displayName`。若同时出现 `config.displayName`，以本字段为准。
   */
  displayName?: string;
}

/** v1.1 账号编辑（发信字段、密文轮换）；未出现的字段保持不变。 */
export interface UpdateAccountInput {
  label?: string;
  enabled?: boolean;
  config?: Record<string, string>;
  /** 发信设置与密码的唯一入口（`send.smtpPassword`）；无顶层同义字段。 */
  send?: AccountSendInput;
  /** Rotate the inbound password / refresh token when present. */
  secret?: string;
}

export interface AccountView {
  id: string;
  provider: MailProvider;
  label: string;
  email: string;
  enabled: boolean;
  /** Never the secret itself. */
  hasSecret: boolean;
  lastSyncAt: string | null;
  createdAt: string;
  /** v1.1: parsed outbound settings (non-secret); null/absent on legacy rows. */
  send?: AccountSendConfig | null;
  /** Whether an SMTP/EWS password is stored for this account. */
  hasSmtpPassword?: boolean;
  /**
   * v1.1: 账号纯文本签名（非密读回值）；`null` / 缺省 = 未设置。
   * 与 `send?.signature` 同源；对没有发信连接配置（`send=null`，如 Graph 账号）
   * 的账号同样有效。最长 `ACCOUNT_SIGNATURE_MAX_LENGTH`（2000）字符。
   */
  signature?: string | null;
  /**
   * v1.1: From 显示名（非密读回值）；`null` / 缺省 = 只用账号地址。
   * 最长 `ACCOUNT_DISPLAY_NAME_MAX_LENGTH`（200）字符。
   */
  displayName?: string | null;
}

export interface VerifyAccountResponse {
  ok: boolean;
  detail: string;
}

/** Autodiscover 结果类型：识别到 Office 365 时应提示改用 Graph 设备码。 */
export type AutodiscoverKind = "exchange-online" | "exchange-onprem" | "unknown";

/** POST /api/accounts/:id/autodiscover — 对**已存在账号**的重探测。 */
export interface AutodiscoverResponse {
  ok: boolean;
  kind: AutodiscoverKind;
  ewsUrl: string | null;
  authMode: MailAuthMode | null;
  /** 可读错误；不含凭据。 */
  detail: string;
}

/**
 * POST /api/accounts/discover — **创建账号前**的探测（向导第②步可直接用）。
 *
 * 该端点不依赖已存在的账号 id。失败时向导仍可手填，并允许走
 * 「先 POST /api/accounts 建账号，随后 PATCH /api/accounts/:id 补
 * EWS URL / SMTP 参数」的两段式 fallback；探测不是创建账号的前置条件。
 */
export interface DiscoverAccountInput {
  /** 邮箱地址；探测按域名进行。 */
  email: string;
  /** 可选密码 / 应用密码，仅供 Autodiscover 探测。只写不读，不落非密文。 */
  secret?: string;
  /** 可选的用户意图提示（例如已选定 IMAP）；省略时按域名探测。 */
  providerHint?: MailProvider;
}

export interface DiscoverAccountResponse {
  ok: boolean;
  kind: AutodiscoverKind;
  /** 推荐账号类型；识别到 Office 365 时为 "graph"。 */
  provider: MailProvider | null;
  /** 可直接填入创建表单的非密文配置（host/port/tls/ewsUrl 等）。 */
  config: Record<string, string>;
  /** 候选发信设置（SMTP/EWS）；无法推断时为 null。 */
  send: AccountSendConfig | null;
  /** 可读错误；失败时仍可手填，不阻塞进入下一步。 */
  detail: string;
}

/* ---------------------------------- emails ---------------------------------- */

export interface EmailListQuery {
  accountId?: string;
  limit?: number;
  cursor?: string;
  search?: string;
}

export interface EmailListResponse {
  items: RawEmail[];
  nextCursor: string | null;
}

/* ----------------------------------- tasks ---------------------------------- */

export interface TaskListQuery {
  status?: TaskStatus;
  /** ISO lower bound on the task's time (dueAt / windowStart). */
  from?: string;
  /** ISO upper bound. */
  to?: string;
  /** Include tasks whose origin is broadcast (default true). */
  includeBroadcast?: boolean;
}

export interface TaskCounts {
  candidate: number;
  confirmed: number;
  dismissed: number;
  done: number;
}

export interface TaskListResponse {
  items: Task[];
  counts: TaskCounts;
}

export interface UpdateTaskInput {
  title?: string;
  detail?: string | null;
  status?: TaskStatus;
  dueAt?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
}

export interface BulkDecisionInput {
  /** Task ids to accept as personal TODOs. */
  ids: string[];
  /** When set, remember this decision for the whole mailing list. */
  listId?: string | null;
  decision: "confirm" | "dismiss";
}

/* ------------------------------------ llm ----------------------------------- */

export interface LlmTestInput {
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface LlmTestResponse {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

export interface LlmConfigInput {
  label: string;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  /** Only sent when the user types a key; never returned by the server. */
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  isDefault?: boolean;
}

export interface LlmConfigView {
  id: string;
  label: string;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  isDefault: boolean;
}

/* ----------------------------------- sync ----------------------------------- */

export interface SyncRequest {
  accountId: string;
  /** Ignore the stored cursor and re-fetch from scratch. */
  full?: boolean;
}

export interface SyncResponse {
  jobId: string;
}

export interface ExtractRequest {
  accountId?: string;
  /** Re-run extraction over already-stored emails. */
  emailIds?: string[];
}

/**
 * The reserved cloud-sync seam (R7).
 * A future sync backend only has to reproduce this ordered operation stream.
 */
export interface SyncChangesResponse {
  head: number;
  items: ChangeLogRow[];
}

/* ----------------------------------- SSE ------------------------------------ */

/** v1.1: 一封邮件完成分类后的标签状态；空数组 = 未分类。 */
export interface ClassificationEventData {
  emailId: string;
  accountId: string;
  categoryIds: string[];
}

/** v1.1: 发件箱状态机变化（queued/sending/failed/sent）。 */
export interface SendEventData {
  outboxId: string;
  accountId: string;
  status: OutboxStatus;
  /** Local "sent" mirror id once the transport accepted the message. */
  emailId: string | null;
  /** Readable failure reason; never contains credentials. */
  error: string | null;
}

export type ServerEvent =
  | { type: "sync"; data: SyncProgress }
  | { type: "task"; data: Task }
  | { type: "email"; data: { id: string; accountId: string; subject: string } }
  | { type: "extract"; data: { done: number; total: number } }
  | { type: "error"; data: { message: string } }
  /** Microsoft Graph device-code login: show this to the user, then wait. */
  | {
      type: "device-code";
      data: {
        accountId: string;
        userCode: string;
        verificationUri: string;
        message: string;
        expiresInSeconds: number;
      };
    }
  | {
      type: "device-login";
      data: { accountId: string; ok: boolean; detail: string };
    }
  /** v1.1: 新邮件分类完成 / 重算后单封邮件的标签更新。 */
  | { type: "classification"; data: ClassificationEventData }
  /** v1.1: 后台重算进度；`finished=true` 表示本轮结束。 */
  | { type: "recompute"; data: RecomputeProgress }
  /** v1.1: 发件箱状态机变化。 */
  | { type: "send"; data: SendEventData };

/* -------------------------------- onboarding -------------------------------- */

/** GET /api/onboarding — 持久化的初始化状态。 */
export type OnboardingStatusResponse = InitState;

/** PUT /api/onboarding — 记录「完成」或「跳过」；未出现的字段保持不变。 */
export interface UpdateOnboardingInput {
  completed?: boolean;
  skipped?: boolean;
}

/* --------------------------------- categories -------------------------------- */

/** GET /api/categories */
export interface CategoryListResponse {
  items: Category[];
}

/** POST /api/categories — 名称唯一；「未分类」不可创建。 */
export interface CreateCategoryInput {
  name: string;
  enterTodo: boolean;
  broadcast: boolean;
}

/** PATCH /api/categories/:id */
export interface UpdateCategoryInput {
  name?: string;
  enterTodo?: boolean;
  broadcast?: boolean;
}

/* ----------------------------------- rules ---------------------------------- */

/** GET /api/rules */
export interface RuleListResponse {
  items: Rule[];
}

/** POST /api/rules — 目标分类必须存在；tree 走 shared 的 AST 校验。 */
export interface CreateRuleInput {
  name: string;
  categoryId: string;
  tree: RuleTree;
  enabled?: boolean;
  order?: number;
}

/** PATCH /api/rules/:id */
export interface UpdateRuleInput {
  name?: string;
  categoryId?: string;
  tree?: RuleTree;
  enabled?: boolean;
  order?: number;
}

/** POST /api/rules/reorder — 拖拽排序；`ids` 按展示顺序排列。 */
export interface ReorderRulesInput {
  ids: string[];
}

/** POST /api/rules/recompute — 后台重算已存邮件的标签。 */
export interface RecomputeRequest {
  accountId?: string;
  /** 只重算指定的邮件；省略 = 全部已存邮件。 */
  emailIds?: string[];
}

export interface RecomputeResponse {
  jobId: string;
}

/** SSE `recompute` 载荷，也是 GET /api/rules/recompute/:jobId 的响应。 */
export interface RecomputeProgress {
  jobId: string;
  done: number;
  total: number;
  finished: boolean;
}

export type RecomputeStatusResponse = RecomputeProgress;

/* --------------------------------- folders ---------------------------------- */

/** GET /api/folders?accountId= */
export interface FolderListQuery {
  accountId: string;
}

export interface FolderListResponse {
  items: Folder[];
}

/* --------------------------------- messages --------------------------------- */

/** GET /api/messages — 本地已同步邮件，按文件夹分页。 */
export interface MessageListQuery {
  accountId?: string;
  /** Folder path from {@link Folder.path}; omitted = inbox. */
  folder?: string;
  /** 分类多选筛选，ANY 语义（命中任一选中分类即显示）。 */
  categoryIds?: string[];
  /** 本地搜索：主题/发件人/正文，中英文、大小写不敏感。 */
  search?: string;
  unreadOnly?: boolean;
  limit?: number;
  cursor?: string;
}

export interface MessageListItem {
  id: string;
  accountId: string;
  folder: string;
  fromName: string | null;
  fromEmail: string;
  subject: string;
  /** 纯文本预览（已剥离引文/签名并截断）。 */
  snippet: string;
  sentAt: string;
  isRead: boolean;
  hasAttachments: boolean;
  /** 命中的分类 id；空数组 = 未分类。 */
  categoryIds: string[];
}

export interface MessageListResponse {
  items: MessageListItem[];
  nextCursor: string | null;
}

/** GET /api/messages/:id — 邮件详情（HTML 已 sanitize）。 */
export interface MessageDetailResponse {
  message: RawEmail;
  body: MessageBody;
  attachments: AttachmentMeta[];
  folder: string;
  isRead: boolean;
  categoryIds: string[];
}

/** PATCH /api/messages/:id — 已读/未读。 */
export interface UpdateMessageInput {
  isRead?: boolean;
}

/** POST /api/messages/:id/move — 移动/归档（folder 为目标路径或角色名）。 */
export interface MoveMessageInput {
  folder: string;
}

/* -------------------------------- attachments -------------------------------- */

export interface AttachmentListResponse {
  items: AttachmentMeta[];
}

/**
 * GET /api/messages/:id/attachments/:attachmentId 返回原始字节；
 * 这些是响应头/文件名信息，不是 JSON body。
 */
export interface AttachmentDownloadResponse {
  filename: string;
  mimeType: string;
  size: number;
}

/* ----------------------------------- send ----------------------------------- */

export type SendStatus = "sent" | "queued" | "failed";

/** POST /api/send — 撰写/回复/转发统一入口（单封发送，不做群发/合并）。 */
export interface SendMessageInput {
  accountId: string;
  message: OutgoingMessage;
  /** 发送成功后清理该草稿行。 */
  draftId?: string | null;
  /** 直接入队（离线场景）；省略 = 在线则立即投递。 */
  queueOnly?: boolean;
}

export interface SendMessageResponse {
  status: SendStatus;
  /** queued / failed 时指向发件箱行。 */
  outboxId: string | null;
  /** sent 时的本地「已发送」镜像 id。 */
  emailId: string | null;
  /** failed 时的可读原因；永不包含凭据。 */
  error: string | null;
}

/* ---------------------------------- drafts ---------------------------------- */

/**
 * PUT /api/drafts — 保存/覆盖草稿（停输 3 秒或切换邮件触发）。
 *
 * **upsert 键 = `(accountId, draftId)`**：`draftId` 由客户端在第一次自动保存前
 * 生成并固定下来（例如 `crypto.randomUUID()`），同一编辑会话的每次自动保存都带
 * 同一个值：
 * - 带 `draftId` 且已存在同键行 → 覆盖保存，不新增行；`Draft.id === draftId`；
 * - 带 `draftId` 但行不存在 → 以该 id 创建；
 * - 省略 `draftId` → 服务端新建一行并在 `SaveDraftResponse.draft.id` 返回新 id，
 *   客户端必须把它回填到后续自动保存里（仅兼容路径）；
 * - 发送成功或 `DELETE /api/drafts/:id` 后该键失效；重启后按同一键恢复。
 * 单用户单设备冲突按最后写入生效（last-write-wins）。
 */
export interface SaveDraftInput extends OutgoingMessage {
  accountId: string;
  /** 客户端生成的稳定草稿身份；与 accountId 一起构成 upsert 键。 */
  draftId?: string;
}

export interface SaveDraftResponse {
  draft: Draft;
}

/** GET /api/drafts */
export interface DraftListQuery {
  accountId?: string;
}

export interface DraftListResponse {
  items: Draft[];
}

/* ---------------------------------- outbox ---------------------------------- */

/** GET /api/outbox — 离线发件队列。 */
export interface OutboxListQuery {
  accountId?: string;
  status?: OutboxStatus;
}

export interface OutboxListResponse {
  items: OutboxItem[];
}

/** POST /api/outbox/:id/retry、DELETE /api/outbox/:id 的响应。 */
export interface OutboxActionResponse {
  item: OutboxItem;
}
