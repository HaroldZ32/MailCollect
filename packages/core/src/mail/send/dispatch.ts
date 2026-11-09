import type { OutgoingMessage } from "@mailcollect/shared";
import type { MailSourceAccount } from "../account.js";
import { readConfigBool, readConfigInt, readSendConfig, resolveSmtpPort } from "../account.js";
import { notConfiguredError, redact, toMailError } from "../errors.js";
import {
  MailError,
  type MailSource,
  type SendRequest,
  type SendResult,
  type SendTransport,
  type SentCopyState,
} from "../types.js";
import { buildMime, type BuiltMime, type ComposeOriginal } from "./mime.js";
import {
  SmtpClient,
  type SmtpConfig,
  type SmtpDelivery,
  type SmtpTransportPort,
  type SmtpWireFactory,
} from "./smtp.js";
import { mirrorSentMessage, type SentMirrorPort } from "./sent-mirror.js";

/**
 * 按账号选路发信，并把「发出去了没有」与「副本落在哪」分开报告。
 *
 * 选路（需求 C5 / AC-10）：
 * - `graph`：Graph `POST /me/sendMail`——服务端自动保存 Sent，**不再** APPEND（防重复）；
 * - `ews`：EWS `CreateItem`（SendAndSaveCopy）——服务器端 Sent 由 CreateItem 负责；
 *   适配器没有暴露该端口而账号配了 SMTP 时，退回 SMTP，只留本地副本并明说；
 * - `imap` / `pop3`：SMTP 投递。IMAP 成功后 APPEND 到服务器 Sent；APPEND 失败不丢已发事实，
 *   只留本地镜像并在 detail 里给出可读提示；POP3 没有服务器 Sent，只留本地。
 *
 * 本地镜像对**所有成功通道**都写（注入的 `SentMirrorPort`，不直接 import store）。
 * 失败不抛异常：一律返回 `ok:false` 的类型化 `SendResult`，调用方可直接展示/入队。
 *
 * 两个安全细节：
 * - SMTP 专用密码优先于收信 secret（账号可分别设置；T27 从 `getAccountWithSmtpSecret`
 *   取明文后经 `smtpPassword` 传入），两个密码都进 redact 列表；
 * - Bcc 只出现在信封（SMTP RCPT / Graph/EWS 头部）与本地不落库：`smtp.ts` 在 DATA 前
 *   删掉 Bcc 头，本地镜像本来就只有 to/cc。
 */

const SMTP_TIMEOUT_MIN_MS = 1_000;
const SMTP_TIMEOUT_MAX_MS = 120_000;
const DEFAULT_SMTP_TIMEOUT_MS = 30_000;

/** 适配器上与本任务相关的能力端口；测试可只实现需要的成员。 */
export type SendSourcePort = Pick<MailSource, "appendSent" | "sendViaGraph" | "sendViaEws">;

export interface DispatchSendInput {
  readonly account: MailSourceAccount;
  /** 已构造好的收件适配器（同一账号）；dispatch 只调用它的发信/APPEND 端口。 */
  readonly source: SendSourcePort;
  /** 本地「已发送」镜像端口，生产环境传 `store`。 */
  readonly store: SentMirrorPort;
  readonly message: OutgoingMessage;
  /** reply/forward 的原文；mode 为 new 时忽略。 */
  readonly original?: ComposeOriginal | null | undefined;
  /** 发件显示名（From 地址固定为账号地址）。 */
  readonly fromName?: string | null | undefined;
  /** 显式服务器 Sent 文件夹；省略由 IMAP 适配器解析 special-use。 */
  readonly sentFolderId?: string | null | undefined;
  /**
   * 发信专用密码（账号 `smtp_secret_cipher` 的解密结果）。为空时回退 `account.secret`。
   * T27（routes/send.ts）负责从 `store.getAccountWithSmtpSecret(id)` 取 `smtpPassword`
   * 原文并通过本字段传入。
   */
  readonly smtpPassword?: string | null | undefined;
  /** 测试注入：覆盖真实 SMTP 传输；生产不传。 */
  readonly smtpTransport?: SmtpTransportPort | null | undefined;
  /** 测试注入：覆盖 SMTP 传输层（用于观察 DATA 字节与 AUTH 参数）；与 smtpTransport 二选一。 */
  readonly smtpWireFactory?: SmtpWireFactory | undefined;
  /** 测试注入：固定 MIME 头与落库时间。 */
  readonly messageId?: string | undefined;
  readonly date?: Date | undefined;
  readonly sentAt?: string | undefined;
  readonly idFactory?: (() => string) | undefined;
}

export interface SendOutcome {
  /** 与 `MailSource.appendSent` 等同的失败不抛契约。 */
  readonly result: SendResult;
  /** 本地已发送镜像 id；失败或镜像写入失败时为 null。 */
  readonly emailId: string | null;
  /** 客户端 Message-ID；MIME 构造失败时为 null。 */
  readonly messageId: string | null;
}

/** 实际发信通道；`ews` 只在适配器提供了 CreateItem 端口时出现。 */
export type SendChannel = "smtp" | "graph" | "ews";

/** 只读选路，不产生副作用；调用方可在发信前展示「将走哪条通道」。 */
export function resolveSendChannel(account: MailSourceAccount, source: SendSourcePort): SendChannel {
  switch (account.provider) {
    case "graph":
      return "graph";
    case "ews":
      return source.sendViaEws !== undefined ? "ews" : "smtp";
    case "imap":
    case "pop3":
      return "smtp";
  }
}

/**
 * 从账号配置解析 SMTP 参数；缺 smtpHost 返回 null（由调用方报 not_configured）。
 *
 * 密码优先级：显式 `smtpPassword`（账号单独设置的 SMTP/EWS 密码）→ `account.secret`
 * （收信密码）。回退只发生在「没有设置专用密码」时，保持旧账号行为不变。
 */
export function smtpConfigForAccount(account: MailSourceAccount, smtpPassword?: string | null): SmtpConfig | null {
  const send = readSendConfig(account);
  if (send.smtpHost === null) return null;
  // 密码不做 trim（合法密码可能含空格）；只有「缺省/纯空白」才回退收信 secret。
  const dedicated = smtpPassword ?? "";
  const hasDedicated = dedicated.trim().length > 0;
  return {
    host: send.smtpHost,
    port: resolveSmtpPort(send),
    secure: send.smtpSecure,
    // 未显式填 smtpUser 时按惯例用账号邮箱登录；服务器不宣告 AUTH 时不会发认证命令。
    user: send.smtpUser ?? account.email,
    password: hasDedicated ? dedicated : account.secret,
    timeoutMs: readConfigInt(account, "smtpTimeoutMs", SMTP_TIMEOUT_MIN_MS, SMTP_TIMEOUT_MAX_MS) ?? DEFAULT_SMTP_TIMEOUT_MS,
    allowInsecure: readConfigBool(account, "smtpAllowInsecure", false),
  };
}

/** 发送一封已经由服务端组装好的 `OutgoingMessage`。 */
export async function dispatchSend(input: DispatchSendInput): Promise<SendOutcome> {
  const channel = resolveSendChannel(input.account, input.source);
  const transport: SendTransport = channel;

  let built: BuiltMime;
  try {
    built = buildMime({
      mode: input.message.mode,
      from: input.account.email,
      fromName: input.fromName ?? null,
      to: input.message.to,
      cc: input.message.cc,
      bcc: input.message.bcc,
      subject: input.message.subject,
      bodyText: input.message.bodyText,
      bodyHtml: input.message.bodyHtml,
      attachments: input.message.attachments,
      original: input.original ?? null,
      messageId: input.messageId,
      date: input.date,
      sentFolderId: input.sentFolderId ?? null,
    });
  } catch (err) {
    return failure(transport, toMailError(err, secretsOf(input.account, input.smtpPassword)), null);
  }

  switch (channel) {
    case "graph":
      return dispatchViaAdapter(input, built, "graph", transport);
    case "ews":
      return dispatchViaAdapter(input, built, "ews", transport);
    case "smtp":
      return dispatchViaSmtp(input, built, transport);
  }
}

async function dispatchViaAdapter(
  input: DispatchSendInput,
  built: BuiltMime,
  channel: "graph" | "ews",
  transport: SendTransport,
): Promise<SendOutcome> {
  const send = channel === "graph" ? input.source.sendViaGraph : input.source.sendViaEws;
  if (send === undefined) {
    const detail =
      channel === "graph"
        ? "缺少 Graph 发信端口（适配器未注册 sendViaGraph）"
        : "缺少 EWS 发信端口（适配器未注册 sendViaEws，且账号没有 SMTP 配置）";
    return failure(transport, notConfiguredError(channel, detail), built.messageId);
  }

  let result: SendResult;
  try {
    result = await send.call(input.source, built.request);
  } catch (err) {
    return failure(transport, toMailError(err, secretsOf(input.account, input.smtpPassword)), built.messageId);
  }
  if (!result.ok) return { result, emailId: null, messageId: built.messageId };

  const mirrored = mirrorSafely(input, built);
  const detail = mirrored.warning === null ? result.detail : `${result.detail}；${mirrored.warning}`;
  return { result: { ...result, detail }, emailId: mirrored.emailId, messageId: built.messageId };
}

async function dispatchViaSmtp(
  input: DispatchSendInput,
  built: BuiltMime,
  transport: SendTransport,
): Promise<SendOutcome> {
  const config = smtpConfigForAccount(input.account, input.smtpPassword);
  if (config === null) {
    const detail =
      input.account.provider === "ews"
        ? "EWS 适配器未提供 CreateItem 端口，且账号缺少 smtpHost（在账号发信设置里填 SMTP 服务器、端口与用户名）"
        : "缺少 smtpHost（在账号发信设置里填 SMTP 服务器、端口与用户名）";
    return failure(transport, notConfiguredError("smtp", detail), built.messageId);
  }

  const smtp =
    input.smtpTransport ??
    (input.smtpWireFactory === undefined ? new SmtpClient(config) : new SmtpClient(config, input.smtpWireFactory));
  let delivery: SmtpDelivery;
  try {
    delivery = await smtp.send(built.request);
  } catch (err) {
    return failure(transport, toMailError(err, secretsOf(input.account, input.smtpPassword)), built.messageId);
  }

  // 先落本地镜像：服务器 APPEND 失败时用户至少还有一份已发送记录。
  const mirrored = mirrorSafely(input, built);
  let savedToSent: SentCopyState = mirrored.emailId === null ? "none" : "local";
  let detail = delivery.detail;
  let messageId: string | null = null;

  if (input.account.provider === "imap" && input.source.appendSent !== undefined) {
    const appended = await appendSafely(
      input.source.appendSent,
      built.request,
      input.source,
      input.account,
      input.smtpPassword,
    );
    if (appended.ok) {
      savedToSent = "server";
      messageId = appended.messageId;
      detail = `${detail}；服务器「已发送」已写入`;
    } else {
      detail = `${detail}；${mirrored.emailId === null ? "本地「已发送」也未能写入" : "已在本地「已发送」保留副本"}，服务器「已发送」写入失败：${appended.detail}`;
    }
  } else if (input.account.provider === "pop3") {
    detail = `${detail}；POP3 账号只在本地「已发送」保留副本`;
  } else if (input.account.provider === "ews") {
    detail = `${detail}；EWS 适配器未提供 CreateItem 副本端口，本次只在本地「已发送」保留副本`;
  } else {
    detail = `${detail}；IMAP 适配器未提供 APPEND 端口，本次只在本地「已发送」保留副本`;
  }
  if (mirrored.warning !== null) {
    detail = `${detail}；${mirrored.warning}`;
    if (savedToSent === "local") savedToSent = "none";
  }

  return {
    result: { ok: true, transport, messageId, savedToSent, detail },
    emailId: mirrored.emailId,
    messageId: built.messageId,
  };
}

/** APPEND 端口按契约返回 ok:false 而不抛；仍兜底捕获异常实现，避免发信结果被异常击穿。 */
async function appendSafely(
  append: NonNullable<SendSourcePort["appendSent"]>,
  request: SendRequest,
  source: SendSourcePort,
  account: MailSourceAccount,
  smtpPassword?: string | null,
): Promise<SendResult> {
  try {
    return await append.call(source, request);
  } catch (err) {
    const error = toMailError(err, secretsOf(account, smtpPassword));
    return { ok: false, transport: "imap", savedToSent: "local", detail: error.message, error };
  }
}

interface MirrorOutcome {
  readonly emailId: string | null;
  readonly warning: string | null;
}

/** 本地镜像失败不影响「已发出」的事实，只把可读提示拼回 detail。 */
function mirrorSafely(input: DispatchSendInput, built: BuiltMime): MirrorOutcome {
  try {
    const record = mirrorSentMessage(input.store, {
      accountId: input.account.id,
      fromName: input.fromName ?? null,
      fromEmail: input.account.email,
      to: built.request.to,
      cc: built.request.cc,
      subject: built.subject,
      bodyText: built.text,
      messageId: built.messageId,
      threadId: input.message.mode === "reply" ? (built.inReplyTo ?? null) : null,
      inReplyTo: built.inReplyTo,
      references: built.references,
      hasAttachments: input.message.attachments.length > 0,
      sentAt: input.sentAt,
      id: input.idFactory?.(),
    });
    return { emailId: record.id, warning: null };
  } catch (err) {
    const message = redact(
      err instanceof Error ? err.message : String(err),
      secretsOf(input.account, input.smtpPassword),
    );
    return { emailId: null, warning: `本地「已发送」镜像写入失败：${message}` };
  }
}

function failure(transport: SendTransport, error: MailError, messageId: string | null): SendOutcome {
  return {
    result: { ok: false, transport, savedToSent: "none", detail: error.message, error },
    emailId: null,
    messageId,
  };
}

function secretsOf(account: MailSourceAccount, smtpPassword?: string | null): readonly string[] {
  // 用原文而不是 trim 后的值，保证 redact 匹配的正是实际发出去的密码。
  const secrets = [account.secret, smtpPassword ?? ""].filter((secret) => secret.length > 0);
  return [...new Set(secrets)];
}
