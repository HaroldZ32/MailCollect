import type {
  AttachmentMeta,
  FolderRole,
  MailProvider,
  MessageBody as MessageBodyContent,
  RawEmail,
  SyncCursor,
} from "@mailcollect/shared";

/** Why a mailbox operation failed. Adapters must map vendor errors onto these. */
export type MailErrorCode =
  /** 凭据被拒绝，或令牌缺少必要 scope。不可重试，需要用户改密码/重新授权。 */
  | "auth"
  /** 连接、DNS、超时、连接被重置等传输层问题。通常可重试。 */
  | "network"
  /** 服务器有响应，但内容/状态不符合协议，或账号配置不完整。 */
  | "protocol"
  /** 当前版本没有这个协议的适配器（旧码，保留兼容）。 */
  | "not_supported"
  /** 账号或适配器缺少必要配置（未填 EWS URL、未注册 ews 适配器、缺 clientId）。 */
  | "not_configured"
  /** 协议本身支持，但当前服务器/账号不支持这个操作（例如 Graph 搜索不可用）。 */
  | "unsupported"
  /** 供应商限流，稍后重试。 */
  | "rate_limited";

export class MailError extends Error {
  override readonly name = "MailError";
  constructor(
    readonly code: MailErrorCode,
    message: string,
    readonly retryable: boolean = false,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface FetchOptions {
  /** Resume position. `undefined` means "first sync" and adapters fetch a bounded window. */
  since?: SyncCursor | undefined;
  /**
   * 只拉这个文件夹（协议原生 id/path，来自 `listFolders()` 的 `FolderInfo.id`）。
   * 省略或 `null` 表示适配器默认范围（收件箱 / 整个邮箱）。
   *
   * v1.1 契约：
   * - Graph 把它落到 `/me/mailFolders/{id}/messages/delta`；
   * - IMAP 会先选中该文件夹再增量拉取（`ImapMailSource.fetchFolder()` 是同一能力的显式入口）；
   * - 只有一个邮箱的适配器（POP3）**忽略**它：等价 Inbox，不报错、不丢邮件；
   * - 尚未实现按文件夹增量的适配器（当前是 EWS）同样忽略它，语义与 POP3 一致；
   *   调用方不得把「忽略」当成「已按文件夹过滤」，也不得因此报错；
   * - 游标是「文件夹作用域」的：同一个账号切文件夹同步时，调用方要为每个文件夹分别保存 `since`。
   *
   * `null` 与省略同义（兼容 Graph 既有的 `folderId: string | null`）。
   */
  folderId?: string | null | undefined;
  /** Hard cap on messages returned by this call. */
  limit?: number;
  /** Called with the running count so the server can push SSE progress. */
  onProgress?: (fetched: number) => void;
  signal?: AbortSignal;
}

export interface FetchResult {
  emails: RawEmail[];
  /** Next resume position; null when the source is exhausted. */
  cursor: SyncCursor | null;
  /** True when the adapter stopped early because of `limit`. */
  hasMore: boolean;
  /**
   * 每封邮件的**服务器接收时间**，key 是 `RawEmail.uid`。
   *
   * 语义：邮件服务器记录的接收时间——IMAP `INTERNALDATE`、Graph `receivedDateTime`、
   * EWS `DateTimeReceived`。它**不是**发件人写在 `Date` 头里的时间，后者是
   * `RawEmail.sentAt` 的来源；两者可以不同（时钟漂移、跨时区、邮件转发）。
   *
   * 协议本身不提供时（POP3）整个字段缺省；某一封拿不到就不放进去。绝不造数，
   * 也绝不拿 `sentAt` 顶替。落库需要 ISO 字符串时用 `receivedAt.toISOString()`。
   */
  readonly receivedAtByUid?: ReadonlyMap<string, Date> | undefined;
}

/**
 * Device-code prompt the adapter must surface to the user.
 * It is not a credential, but it must never be written to a log.
 */
export interface DeviceCodeNotice {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly message: string;
  readonly expiresInSeconds: number;
}

/* ------------------------------ v1.1 能力端口 ------------------------------ */

/**
 * 一封邮件在服务端的定位。
 *
 * IMAP 的 uid 是「邮箱作用域」的：同一个 uid 在不同文件夹里是两封不同的邮件，
 * 所以改动类操作必须带上 `folderId`。POP3/Graph/EWS 只要 `id`，可以省略。
 */
export interface MessageRef {
  readonly id: string;
  /** 服务端文件夹 id/路径；IMAP 必带。 */
  readonly folderId?: string | null;
}

/** 一个文件夹的规范化视图。`role` 把各协议的 special-use/well-known 标记收敛成同一套语义。 */
export interface FolderInfo {
  /** 协议原生定位：IMAP 路径、Graph folder id、EWS folder id。 */
  readonly id: string;
  /** 展示名（人类可读，未做翻译）。 */
  readonly name: string;
  /** 规范化角色；认不出的文件夹一律 `other`。 */
  readonly role: FolderRole;
  /** 服务器报告的未读数；协议不提供时为 0。 */
  readonly unreadCount: number;
}

/** 附件元数据（不含字节）；在 shared 的 `AttachmentMeta` 之上补一个内嵌标记。 */
export interface AttachmentInfo extends AttachmentMeta {
  /** 内嵌资源（inline/related，如正文里的图片）；这类附件不进附件列表渲染。 */
  readonly inline: boolean;
}

/** 附件原始字节；不做解码，也不解析内容。 */
export interface AttachmentData {
  readonly info: AttachmentInfo;
  readonly content: Uint8Array;
}

/**
 * 一封邮件的完整内容：正文（纯文本 + html）与附件元数据。
 *
 * `text`/`html` 复用 shared 的 `MessageBody`，字段名与服务端返回给 UI 的正文一致；
 * `html` 是原始 HTML，出站前由服务端统一 sanitize。
 */
export interface MessageBody extends MessageBodyContent {
  /** 服务端定位 id（IMAP uid / Graph message id）。 */
  readonly id: string;
  /** 所在文件夹 id；POP3 没有文件夹概念时为 null。 */
  readonly folderId: string | null;
  readonly subject: string;
  readonly fromName: string | null;
  readonly fromEmail: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  /**
   * ISO 8601，发件人写在 `Date` 头里的时间（发件人声明）。
   * 邮件没有 `Date` 头时才退回服务器接收时间——那是兜底，不是语义。
   */
  readonly sentAt: string;
  /**
   * 邮件服务器记录的接收时间（IMAP `INTERNALDATE` / Graph `receivedDateTime` /
   * EWS `DateTimeReceived`）。与 `sentAt` 是两个概念，**不要**互相顶替。
   * 协议本身不提供时缺省——POP3 没有服务器接收时间，永远拿不到这个字段。
   */
  readonly receivedAt?: Date | undefined;
  readonly isRead: boolean;
  readonly attachments: readonly AttachmentInfo[];
}

/** 只改给出的字段，其余旗标保持不变。 */
export interface MessageFlagsPatch {
  readonly read?: boolean;
  readonly flagged?: boolean;
}

export interface DeleteOptions {
  /** true = 跳过回收站彻底删除；默认 false（移到 Trash）。 */
  readonly permanent?: boolean;
}

/**
 * 服务器端搜索条件。字段之间是「与」；同一个字段内是子串匹配，
 * 大小写与中英文不敏感由适配器负责（IMAP 走服务器 SEARCH，POP3 没有这个端口）。
 */
export interface MailSearchQuery {
  /** 限定文件夹；省略时搜 Inbox（Graph/EWS 搜整个邮箱）。 */
  readonly folderId?: string;
  readonly subject?: string;
  readonly from?: string;
  readonly body?: string;
  readonly since?: string;
  readonly before?: string;
  readonly unreadOnly?: boolean;
  /** 硬上限，默认由适配器决定。 */
  readonly limit?: number;
}

/** 一条搜索命中：只给定位，正文仍要 `getMessage` 取。 */
export interface MailSearchHit {
  readonly id: string;
  readonly folderId: string | null;
}

/** 发信/写副本走哪条通道。`imap` 只用于把已发送副本 APPEND 进服务器 Sent。 */
export type SendTransport = "smtp" | "graph" | "ews" | "imap";

/** 「已发送」副本落在哪：服务器端、仅本地、没有。 */
export type SentCopyState = "server" | "local" | "none";

/**
 * 一条待投递的邮件：完整 MIME 字节 + SMTP 信封。
 *
 * MIME 由调用方（`mail/send/mime.ts`）构造一次，SMTP / Graph / EWS / IMAP APPEND
 * 四条通道共用，避免各适配器重复拼 MIME。
 */
export interface SendRequest {
  /** 完整 MIME（RFC 5322 + RFC 2045，UTF-8 字节），头部已含 To/Cc/Bcc/Subject/Message-ID。 */
  readonly mime: Uint8Array;
  /** 信封收件人（纯地址，不含尖括号）。 */
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  /** 信封发件人（SMTP MAIL FROM）。 */
  readonly from: string;
  /** 服务器 Sent 文件夹 id；省略时适配器自己解析 well-known Sent。 */
  readonly sentFolderId?: string | null;
}

/**
 * 发信/写副本的结果。失败不抛异常：调用方要能区分「已发出但副本没写成」，
 * 所以失败分支同样带 `savedToSent` 与类型化 `error`。
 */
export type SendResult =
  | {
      readonly ok: true;
      readonly transport: SendTransport;
      /** 服务端消息 id；协议不回 id（Graph MIME 发送）时为 null，用客户端 Message-ID。 */
      readonly messageId: string | null;
      readonly savedToSent: SentCopyState;
      /** 给用户看的说明，成功路径也有。 */
      readonly detail: string;
    }
  | {
      readonly ok: false;
      readonly transport: SendTransport;
      readonly savedToSent: SentCopyState;
      readonly detail: string;
      /** 类型化原因；文案已擦除 secret。 */
      readonly error: MailError;
    };

/**
 * One mailbox, one adapter. Implementations live in this directory:
 * `imap.ts`, `pop3.ts`, `graph.ts`, `ews.ts`.
 *
 * FROZEN CONTRACT —— v1.1 扩宽（任务 mail-foundation）：`MailSource` 增加下列
 * 全部 optional 的能力端口，收件三件套 `verify/fetch/close` 与 `login/watch`
 * 的签名一字未动，因此既有适配器不改一行也仍然满足接口。
 */
export interface MailSource {
  readonly provider: MailProvider;
  /** Validate credentials and report server identity. Fetches no messages. */
  verify(): Promise<{ ok: boolean; detail: string }>;
  /** Fetch new messages since `options.since`. */
  fetch(options?: FetchOptions): Promise<FetchResult>;
  /**
   * Optional push notification. Returns an unsubscribe function, or null when
   * the provider has no push capability (POP3).
   */
  watch?(onNew: () => void): Promise<(() => void) | null>;
  /**
   * Optional interactive login (device-code flow). Only adapters that need a
   * user gesture implement it (Microsoft Graph); IMAP/POP3 leave it undefined.
   * The prompt goes to `onDeviceCode` and to the adapter's own
   * `lastDeviceCodeNotice` accessor, and is never logged.
   */
  login?(onDeviceCode?: (notice: DeviceCodeNotice) => void): Promise<{ ok: boolean; detail: string }>;
  close(): Promise<void>;

  /* ---------- v1.1 能力端口：全部 optional，未实现的适配器保持可编译 ---------- */

  /** 列文件夹，并把协议的 special-use / well-known 标记规范化成 `FolderRole`。 */
  listFolders?(): Promise<readonly FolderInfo[]>;
  /** 读单封邮件：正文（纯文本 + html）与附件元数据；POP3 只有 Inbox。 */
  getMessage?(ref: MessageRef): Promise<MessageBody>;
  /** 按附件 id 取原始字节。 */
  getAttachment?(ref: MessageRef, attachmentId: string): Promise<AttachmentData>;
  /** 已读/加旗标（IMAP `\Seen`、Graph `isRead`、EWS `MarkAsRead`）。 */
  setFlags?(ref: MessageRef, patch: MessageFlagsPatch): Promise<void>;
  /**
   * 移动到目标文件夹；返回**目标文件夹内**的新定位。
   *
   * 移动会改变服务端 id（IMAP 的 uid 是文件夹作用域的，Graph 也会换 id），所以返回的
   * `MessageRef` 必须指向目标文件夹里的那条消息，绝不能拿旧 id 顶上。
   *
   * 返回 `null` 表示「移动已成功，但无法可靠解析目标文件夹里的新引用」（IMAP 没有 UIDPLUS
   * 且按 Message-ID 定位不到唯一一封）。这时调用方必须重新同步该文件夹，**不得**用旧 ref
   * 去读/标/删——旧 uid 在目标文件夹里可能指向另一封邮件。
   */
  move?(ref: MessageRef, targetFolderId: string): Promise<MessageRef | null>;
  /** 删除；默认进回收站，`permanent` 才是彻底删除。 */
  delete?(ref: MessageRef, options?: DeleteOptions): Promise<void>;
  /** 服务器端搜索（IMAP SEARCH / Graph `$search` / EWS FindItem）。 */
  search?(query: MailSearchQuery): Promise<readonly MailSearchHit[]>;
  /** 把已发送副本写进服务器 Sent（IMAP APPEND）。失败返回 `ok:false`，不抛。 */
  appendSent?(request: SendRequest): Promise<SendResult>;
  /** Graph `POST /me/sendMail`；MIME 由调用方构造，服务端自动存 Sent。 */
  sendViaGraph?(request: SendRequest): Promise<SendResult>;
  /** EWS `CreateItem` + Sent 副本；MIME 由调用方构造。 */
  sendViaEws?(request: SendRequest): Promise<SendResult>;
}

export type MailSourceFactory = (account: {
  id: string;
  provider: MailProvider;
  email: string;
  config: Record<string, string>;
  secret: string;
}) => MailSource;
