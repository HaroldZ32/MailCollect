import { MailError, type MailErrorCode } from "./types.js";

/**
 * 供应商错误 → `MailError` 的统一映射。
 *
 * 两条硬约束：
 * 1. 绝不把 vendor 原始异常直接向上抛（调用方只会看到 MailError）；
 * 2. 消息里出现的 secret 一律替换为 `***`，避免密码/令牌经错误信息泄漏。
 */
const MIN_SECRET_LENGTH = 4;

const AUTH_TEXT_PATTERN = /auth|login|password|credential|invalid.?user|invalid.?grant|invalid.?client|token.?expired|unauthori[sz]ed|forbidden/i;
const RATE_TEXT_PATTERN = /throttl|too.?(many|frequent)|rate.?limit|login.?delay|try again later/i;
const NETWORK_TEXT_PATTERN = /socket|network|timed? ?out|timeout|econn|enotfound|eai_again|unreachable|connection (closed|reset|refused)|disconnect/i;

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

/** 把文本中所有 secret 替换为 `***`；过短的串不参与替换，避免误伤正常文本。 */
export function redact(text: string, secrets: readonly string[]): string {
  let safe = text;
  for (const secret of secrets) {
    if (secret.length < MIN_SECRET_LENGTH) continue;
    safe = safe.split(secret).join("***");
  }
  return safe;
}

/** 单个错误的分类结果。 */
interface ErrorSignal {
  readonly code: MailErrorCode;
  readonly retryable: boolean;
}

/** 按错误码、HTTP 状态与消息文本给 vendor 错误归类。 */
function classifyError(err: unknown): ErrorSignal {
  const vendorCode = readStringField(err, "code") ?? readStringField(err, "serverResponseCode") ?? "";
  const status = readNumberField(err, "status") ?? readNumberField(err, "statusCode");
  const text = `${vendorCode} ${readStringField(err, "responseText") ?? ""} ${errorText(err)}`;

  if (status === 429 || RATE_TEXT_PATTERN.test(text)) return { code: "rate_limited", retryable: true };
  if (NETWORK_ERROR_CODES.has(vendorCode)) return { code: "network", retryable: true };
  if (readBooleanField(err, "authenticationFailed") || status === 401 || status === 403) {
    return { code: "auth", retryable: false };
  }
  if (AUTH_TEXT_PATTERN.test(text)) return { code: "auth", retryable: false };
  if (NETWORK_TEXT_PATTERN.test(text)) return { code: "network", retryable: true };
  if (status !== null && status >= 500) return { code: "network", retryable: true };
  return { code: "protocol", retryable: false };
}

/**
 * 把任意 vendor 错误包装为 `MailError`。
 * 已经是 `MailError` 的直接返回，避免二次包装丢掉原始 code。
 */
export function toMailError(err: unknown, secrets: readonly string[]): MailError {
  if (err instanceof MailError) return err;
  const signal = classifyError(err);
  return new MailError(signal.code, redact(errorText(err), secrets), signal.retryable, err);
}
