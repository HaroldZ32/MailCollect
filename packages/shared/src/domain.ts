import type { RuleTree } from "./rules.js";

/**
 * Domain types — FROZEN CONTRACT.
 * Changing these requires the captain; members must not edit unilaterally.
 */

/** Wire protocol used to talk to a mailbox. v1.1 adds on-prem Exchange (EWS). */
export type MailProvider = "imap" | "pop3" | "graph" | "ews";

/** Wire protocol used to talk to an LLM provider. */
export type LlmProtocol = "openai-compatible" | "anthropic-messages";

export interface UserProfile {
  id: string;
  /** Primary display name, e.g. "张三". */
  displayName: string;
  /** Name variants that may appear in email bodies: "张三", "张 三", "San Zhang". */
  aliases: string[];
  /** Every mailbox address that belongs to this person. */
  emails: string[];
  /** IANA zone, e.g. "Asia/Shanghai". Time resolution is anchored here. */
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface Account {
  id: string;
  provider: MailProvider;
  label: string;
  email: string;
  /** Non-secret connection settings (host/port/tls/user/mailbox). Secrets live elsewhere. */
  config: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  /**
   * v1.1 outbound settings (SMTP / EWS), parsed from {@link Account.config}.
   * Optional so legacy rows and existing constructors keep compiling; the
   * password/refresh token still lives in the encrypted secret store.
   */
  send?: AccountSendConfig | null;
}

export interface LlmConfig {
  id: string;
  label: string;
  protocol: LlmProtocol;
  /** e.g. https://api.deepseek.com/v1 — a gateway baseURL works identically. */
  baseUrl: string;
  model: string;
  /** Reference into the encrypted secret store; never the key itself. */
  apiKeyRef: string | null;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  isDefault: boolean;
}

/** A message as stored locally, already normalised. */
export interface RawEmail {
  id: string;
  accountId: string;
  /** Server-side identity: IMAP uid / POP3 UIDL / Graph message id. */
  uid: string;
  messageId: string;
  threadId: string | null;
  fromName: string | null;
  fromEmail: string;
  to: string[];
  cc: string[];
  subject: string;
  /** ISO 8601 with offset, taken from the Date header. */
  sentAt: string;
  /** Plain text with quoted history and signature REMOVED. */
  bodyText: string;
  hasAttachments: boolean;
  /** Only the headers the pipeline is allowed to reason about. */
  headers: Record<string, string>;
  createdAt: string;
}

/** Opaque incremental-sync position, provider specific. */
export interface SyncCursor {
  accountId: string;
  /** "uidvalidity:lastUid" | pop3 uidl set hash | Graph deltaLink. */
  value: string;
  updatedAt: string;
}

export type BroadcastKind = "personal" | "broadcast" | "uncertain";

export interface BroadcastVerdict {
  kind: BroadcastKind;
  /** Machine-readable reasons, e.g. "header:list-id", "to-count:>=10". */
  signals: string[];
}

/** Who is supposed to act. Only `me` becomes a TODO automatically. */
export type TaskOwner = "me" | "other" | "unassigned" | "everyone";

/** action = plain to-do; deadline = hard due date; window = a time range. */
export type TaskKind = "action" | "deadline" | "window";

export type TaskStatus = "candidate" | "confirmed" | "dismissed" | "done";

export interface TaskTime {
  /** The literal phrase the model found, e.g. "周五下班前". */
  phrase: string | null;
  /** Resolved deterministically from the phrase + email Date + IANA zone. */
  dueAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  timezone: string;
  confidence: number;
}

export interface Task {
  id: string;
  userId: string;
  title: string;
  detail: string | null;
  owner: TaskOwner;
  ownerName: string | null;
  kind: TaskKind;
  status: TaskStatus;
  /** Where the task came from — drives the "this is a broadcast" reminder. */
  origin: BroadcastKind;
  confidence: number;
  /** Verbatim sentence from the email that justifies this task. */
  evidenceQuote: string;
  sourceEmailId: string;
  threadId: string | null;
  time: TaskTime | null;
  createdAt: string;
  updatedAt: string;
}

/** Append-only change record — the reserved cloud-sync seam. */
export type ChangeOp = "insert" | "update" | "delete";

export interface ChangeLogRow {
  seq: number;
  entity: string;
  entityId: string;
  rev: string;
  deviceId: string;
  op: ChangeOp;
  /** JSON of the changed entity (or a tombstone for delete). */
  payload: string;
  ts: string;
}

export interface SyncPort {
  /** Every change after `since` (exclusive), ordered by seq. */
  changes(since: number, limit?: number): Promise<ChangeLogRow[]>;
  /** Highest seq currently stored. */
  head(): Promise<number>;
}

export interface SyncProgress {
  accountId: string;
  phase: "connect" | "fetch" | "store" | "extract" | "done" | "error";
  fetched: number;
  stored: number;
  message?: string;
}

/* ------------------------------- v1.1 新增 ------------------------------- */

/** Outbound authentication mode for SMTP / EWS. */
export type MailAuthMode = "password" | "ntlm" | "oauth2" | "device-code";

/**
 * 账号签名的长度上限（字符数）。UI 输入框与服务端校验共用同一个常量，
 * 避免两处各写一个数字。纯文本，不做 HTML 渲染。
 */
export const ACCOUNT_SIGNATURE_MAX_LENGTH = 2000;

/** 账号 From 显示名的长度上限（字符数）。 */
export const ACCOUNT_DISPLAY_NAME_MAX_LENGTH = 200;

/**
 * 账号发信设置（非密文字段视图）。密码 / 令牌仍走加密 secret store，
 * 只以引用进出；`Account.config` 保留原始字符串记录，本类型是解析后的结果。
 *
 * 签名与显示名是**非密**身份设置，持久化在 `Account.config` 的
 * `signature` / `displayName` 字符串键：
 * - `signature`：纯文本签名，发送时自动追加到正文；单封可用
 *   `OutgoingMessage.includeSignature=false` 关闭；
 * - `displayName`：From 显示名（`显示名 <账号地址>`）；From 地址固定为账号地址，
 *   别名发件不在 v1。
 */
export interface AccountSendConfig {
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecure: boolean;
  smtpUser: string | null;
  ewsUrl: string | null;
  authMode: MailAuthMode;
  /**
   * v1.1: 纯文本签名（读回值）；`null` / 缺省 = 不追加。
   * 最长 {@link ACCOUNT_SIGNATURE_MAX_LENGTH} 字符。
   */
  signature?: string | null;
  /**
   * v1.1: From 显示名（读回值）；`null` / 缺省 = 只用账号地址。
   * 最长 {@link ACCOUNT_DISPLAY_NAME_MAX_LENGTH} 字符。
   */
  displayName?: string | null;
}

/**
 * 分类。邮件级准入完全由「规则→分类」决定：
 * - `enterTodo=true` 且 `broadcast=false` → 进入 LLM 待办抽取；
 * - `broadcast=true` → 只进群发提醒卡片，不抽取；
 * - 两个开关互不抑制，多标签时各自取 OR。
 */
export interface Category {
  id: string;
  /** 名称唯一（「未分类」是计算态，不可创建/指派/删除）。 */
  name: string;
  enterTodo: boolean;
  broadcast: boolean;
}

/** 计算态：没有任何规则命中的邮件。不是可持久化的分类。 */
export const UNCATEGORIZED_ID = "__uncategorized__";
export const UNCATEGORIZED_NAME = "未分类";

/** 一条规则：名称 + 目标分类 + 条件树 + 启停 + 顺序。顺序只影响展示/求值顺序，不抑制命中。 */
export interface Rule {
  id: string;
  name: string;
  categoryId: string;
  tree: RuleTree;
  enabled: boolean;
  order: number;
}

/** 邮件↔分类的多对多标签；一次重算 = 先移除旧标签再加新标签（幂等）。 */
export interface Tag {
  id: string;
  emailId: string;
  categoryId: string;
  /** 产生该标签的规则；同一分类被多条规则命中时保留首个。 */
  ruleId: string | null;
  createdAt: string;
}

/** Provider folder role. POP3 only ever reports `inbox`. */
export type FolderRole = "inbox" | "sent" | "drafts" | "trash" | "archive" | "junk" | "other";

export interface Folder {
  accountId: string;
  /** Provider-native folder path / id (display path). */
  path: string;
  role: FolderRole;
  /** Server-reported unread count. */
  unread: number;
}

/** 附件元数据（不含字节）。 */
export interface AttachmentMeta {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

/** 邮件详情正文；`html` 已由服务端 sanitize（script、on* 事件、iframe、javascript: URL 已移除）。 */
export interface MessageBody {
  text: string;
  html: string | null;
}

/** 撰写模式：决定 Re:/Fwd: 前缀与引用原文。 */
export type ComposeMode = "new" | "reply" | "forward";

/** 用户选择待发送的附件字节（草稿与发件箱同构，base64 便于 JSON 往返）。 */
export interface AttachmentPayload {
  filename: string;
  mimeType: string;
  size: number;
  dataBase64: string;
}

/** 草稿与发件箱共用的待发送邮件。 */
export interface OutgoingMessage {
  mode: ComposeMode;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
  attachments: AttachmentPayload[];
  /** 发送时是否追加账号签名（默认 true，单封可关）。 */
  includeSignature: boolean;
  /** 被回复/转发的本地邮件 id；服务端据此生成 In-Reply-To/References 与引用原文。 */
  replyToEmailId: string | null;
}

/**
 * 本地草稿（停输 3 秒或切换邮件自动保存；发送成功或手动删除后清理）。
 * upsert 键是 `(accountId, id)`：`id` 由客户端在第一次自动保存前生成
 * （见 `api.ts` 的 `SaveDraftInput.draftId`）。
 */
export interface Draft extends OutgoingMessage {
  id: string;
  accountId: string;
  savedAt: string;
}

export type OutboxStatus = "queued" | "sending" | "failed" | "sent";

/** 离线发件队列项（SQLite `outbox` 一行；重启后不依赖草稿行恢复）。 */
export interface OutboxItem {
  id: string;
  accountId: string;
  /** 入队时的完整消息快照。 */
  message: OutgoingMessage;
  status: OutboxStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

/** 初始化向导的持久化状态；三步各自的跳过不单独持久化。 */
export interface InitState {
  completed: boolean;
  skipped: boolean;
}
