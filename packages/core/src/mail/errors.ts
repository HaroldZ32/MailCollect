import type { MailProvider } from "@mailcollect/shared";
import { MailError, type MailErrorCode } from "./types.js";

/**
 * 供应商错误 → `MailError` 的统一映射。
 *
 * 三条硬约束：
 * 1. 绝不把 vendor 原始异常直接向上抛（调用方只会看到 MailError）；
 * 2. 消息里出现的 secret 一律替换为 `***`，避免密码/令牌经错误信息泄漏；
 * 3. 消息要「可读」：先给一句中文结论（连接/认证/超时/限流/不支持），
 *    再附擦除过 secret 的供应商原文，排障时不用去猜 vendor 的内部 code。
 */
/** 脱敏占位符；所有长度 ≥1 的 secret 都替换成它。 */
const REDACTED_PLACEHOLDER = "***";

/** 供应商没给可识别文本时的兜底；不参与「可读文案」拼接，避免出现「未知错误：未知错误」。 */
const UNKNOWN_VENDOR_TEXT = "未知的邮件服务错误";

const AUTH_TEXT_PATTERN =
  /auth|login|password|credential|invalid.?user|invalid.?grant|invalid.?client|token.?expired|unauthori[sz]ed|forbidden|access.?denied|invalid.?authentication/i;
const RATE_TEXT_PATTERN = /throttl|too.?(many|frequent)|rate.?limit|login.?delay|try again later/i;
const NETWORK_TEXT_PATTERN = /socket|network|timed? ?out|timeout|econn|enotfound|eai_again|unreachable|connection (closed|reset|refused)|disconnect/i;
const UNSUPPORTED_TEXT_PATTERN = /not.?support|unsupported|not.?implemented|invalid.?operation|ErrorInvalidOperation/i;

/** IMAP/POP3/TLS/DNS 层会透传的 Node 错误码。 */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "ETIMEOUT",
  "NoConnection",
  "EConnectionClosed",
]);

/** 各协议自己的认证失败码；命中即按 auth 处理，不再看文本。 */
const AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "AUTHENTICATIONFAILED",
  "AUTHORIZATIONFAILED",
  "EAUTH",
  "INVALIDCREDENTIALS",
  "LOGIN_FAILED",
  "InvalidAuthenticationToken",
  "Authorization_RequestDenied",
  "ErrorAccessDenied",
  "ErrorInvalidCredentials",
  "invalid_grant",
]);

/** 超时判定：lib 的 `timeout` 标志、错误码或文本里任一处出现都算。 */
const TIMEOUT_TEXT_PATTERN = /timed? ?out|timeout/i;
const TIMEOUT_ERROR_CODES: ReadonlySet<string> = new Set([
  "ETIMEDOUT",
  "ETIMEOUT",
  "CONNECT_TIMEOUT",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** 从任意值里读一个字符串字段；不是对象或字段不存在时返回 null。 */
function readStringField(source: unknown, field: string): string | null {
  if (typeof source !== "object" || source === null) return null;
  if (!(field in source)) return null;
  const value: unknown = Reflect.get(source, field);
  return typeof value === "string" ? value : null;
}

/** 从任意值里读一个数字字段。 */
function readNumberField(source: unknown, field: string): number | null {
  if (typeof source !== "object" || source === null) return null;
  if (!(field in source)) return null;
  const value: unknown = Reflect.get(source, field);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 从任意值里读一个布尔字段，只有严格的 true 才算。 */
function readBooleanField(source: unknown, field: string): boolean {
  if (typeof source !== "object" || source === null) return false;
  if (!(field in source)) return false;
  const value: unknown = Reflect.get(source, field);
  return value === true;
}

/** 取错误文本；只取 message，不 dump 整个异常对象（可能带凭据或邮件内容）。 */
function errorText(err: unknown): string {
  if (err instanceof Error) return err.message.length > 0 ? err.message : err.name;
  const text = readStringField(err, "message");
  return text ?? "未知的邮件服务错误";
}

/** 调用方主动取消（AbortSignal）识别。DOMException 与 Error 都按 name 判断。 */
export function isAbortError(err: unknown): boolean {
  return readStringField(err, "name") === "AbortError";
}

/** 取消不是供应商错误：统一成不可重试的 network。 */
export function abortedError(): MailError {
  return new MailError("network", "同步已取消", false);
}

/**
 * 把文本中所有 secret 替换为 `***`。
 *
 * 任何非空 secret 都替换——包括长度 1-3 的短密码：短密码同样是凭据，宁可把
 * 正常文本打得难看，也不能让它以明文出现在错误信息/日志里。
 * 空串不参与替换（`"".split("")` 会把整段文本拆碎）。
 */
export function redact(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    safe = safe.split(secret).join(REDACTED_PLACEHOLDER);
  }
  return safe;
}

/** 单个错误的分类结果。 */
interface ErrorSignal {
  readonly code: MailErrorCode;
  readonly retryable: boolean;
}

/** 拼可读文案时要带上的上下文；都不含凭据。 */
export interface MailErrorContext {
  /** 出错的主机名。 */
  readonly host?: string | null;
  /** 正在做的操作，例如 "IMAP 登录"、"SMTP 发信"。 */
  readonly operation?: string | null;
}

/** 分类结论的中文说明；按 code 全量覆盖，新增 code 时这里会编译失败。 */
const CODE_HINTS: Readonly<Record<MailErrorCode, string>> = {
  auth: "认证失败：请检查账号、密码/应用专用密码，或重新授权",
  network: "连接邮件服务器失败",
  protocol: "邮件服务器返回了无法识别的响应",
  not_supported: "当前版本不支持这个邮箱协议",
  not_configured: "缺少必要配置",
  unsupported: "当前服务器不支持这个操作",
  rate_limited: "邮件服务器限流，请稍后重试",
};

const TIMEOUT_HINT = "连接邮件服务器超时：网络不通、被防火墙拦截或服务器无响应";

/** 超时判定：lib 的 `timeout` 标志、错误码或文本任一处出现都算。 */
function looksLikeTimeout(err: unknown, text: string): boolean {
  if (readBooleanField(err, "timeout")) return true;
  const code = readStringField(err, "code") ?? "";
  if (TIMEOUT_ERROR_CODES.has(code)) return true;
  return TIMEOUT_TEXT_PATTERN.test(text);
}

/** 按错误码、HTTP 状态与消息文本给 vendor 错误归类。 */
function classifyError(err: unknown, vendorMessage: string): ErrorSignal {
  const vendorCode = readStringField(err, "code") ?? readStringField(err, "serverResponseCode") ?? "";
  const status = readNumberField(err, "status") ?? readNumberField(err, "statusCode");
  const text = `${vendorCode} ${readStringField(err, "responseText") ?? ""} ${vendorMessage}`;

  if (status === 429 || RATE_TEXT_PATTERN.test(text)) return { code: "rate_limited", retryable: true };
  if (readBooleanField(err, "authenticationFailed") || status === 401 || status === 403) {
    return { code: "auth", retryable: false };
  }
  if (AUTH_ERROR_CODES.has(vendorCode) || AUTH_TEXT_PATTERN.test(text)) return { code: "auth", retryable: false };
  if (NETWORK_ERROR_CODES.has(vendorCode) || looksLikeTimeout(err, text)) {
    return { code: "network", retryable: true };
  }
  if (UNSUPPORTED_TEXT_PATTERN.test(vendorCode) || UNSUPPORTED_TEXT_PATTERN.test(vendorMessage)) {
    return { code: "unsupported", retryable: false };
  }
  if (NETWORK_TEXT_PATTERN.test(text)) return { code: "network", retryable: true };
  if (status !== null && status >= 500) return { code: "network", retryable: true };
  return { code: "protocol", retryable: false };
}

/** 中文结论 + 操作/主机 + 擦除过 secret 的供应商原文。 */
function readableMessage(
  code: MailErrorCode,
  vendorText: string,
  timedOut: boolean,
  context: MailErrorContext | undefined,
): string {
  const hint = code === "network" && timedOut ? TIMEOUT_HINT : CODE_HINTS[code];
  const operation = context?.operation ? `【${context.operation}】` : "";
  const host = context?.host ? `（${context.host}）` : "";
  const vendor = vendorText.trim();
  const detail = vendor.length > 0 && vendor !== UNKNOWN_VENDOR_TEXT ? `：${vendor}` : "";
  return `${operation}${hint}${host}${detail}`;
}

/**
 * 把任意 vendor 错误包装为可读的 `MailError`。
 * 已经是 `MailError` 的直接返回，避免二次包装丢掉原始 code。
 *
 * 不把 vendor 原始异常挂到 `cause`：它常带着连接配置（含密码），日志一打印 cause 就泄漏；
 * 排障需要的信息已经拼进可读文案（供应商原文已擦除 secret）。
 */
export function toMailError(err: unknown, secrets: readonly string[], context?: MailErrorContext): MailError {
  if (err instanceof MailError) return err;
  const vendorText = redact(errorText(err), secrets);
  const signal = classifyError(err, vendorText);
  const message = readableMessage(signal.code, vendorText, looksLikeTimeout(err, vendorText), context);
  return new MailError(signal.code, message, signal.retryable);
}

/** 错误主体：邮箱协议，或发信通道（SMTP 不属于 `MailSource`）。 */
export type MailChannel = MailProvider | "smtp";

/**
 * 缺少配置类错误：未填 EWS URL、未注册 ews 适配器、缺 clientId、缺 smtpHost。
 * 这类错误不可重试，文案里只说缺什么，不回显任何配置值。
 */
export function notConfiguredError(channel: MailChannel, detail: string): MailError {
  return new MailError("not_configured", `「${channel}」缺少必要配置：${detail}`, false);
}

/** 协议支持、但当前服务器/账号不支持该操作（例如 Graph 搜索不可用）。 */
export function unsupportedError(operation: string, detail: string): MailError {
  return new MailError("unsupported", `${operation} 不被当前服务器支持：${detail}`, false);
}
