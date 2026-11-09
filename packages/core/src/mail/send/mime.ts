import { randomUUID } from "node:crypto";
import type { AttachmentPayload, ComposeMode } from "@mailcollect/shared";
import { MailError, type SendRequest } from "../types.js";

/**
 * 出站 MIME 构造（RFC 5322 + RFC 2045/2047/2231）。
 *
 * 一封待发邮件只在这里拼一次：SMTP DATA、Graph `sendMail`、EWS `CreateItem`、
 * IMAP APPEND 四条通道共用同一份字节，避免各通道各拼一套导致 Sent 副本与实发不一致。
 *
 * 约定：
 * - 整体 ASCII：非 ASCII 的头部走 RFC 2047 编码字，正文与附件一律 base64，
 *   因此 `mime` 的字节与 UTF-8 字符串一一对应；行尾统一 CRLF。
 * - `Bcc` 头会写进 MIME：Graph/EWS 只从 MIME 头取收件人，缺了 Bcc 就不投递。
 *   SMTP 通道不依赖中继替我们删（RFC 6409 并无此承诺）：`smtp.ts` 在 DATA 前用
 *   `stripBccHeader()` 删除 Bcc 头（RFC 5322 §3.6.3 的投递做法），信封里的 bcc
 *   地址仍由 `SendRequest.bcc` 交给 RCPT。
 * - 头部值出现 CR/LF 一律报 `protocol`：拒绝头注入，而不是静默转义。
 */

const CRLF = "\r\n";
/** base64 每行长度（RFC 2045 要求 ≤76）。 */
const BASE64_LINE = 76;
/** 头部行软上限（RFC 5322 建议 78，硬上限 998 由调用方保证）。 */
const FOLD_AT = 78;
/** 单个编码字里 UTF-8 字节上限：`=?UTF-8?B?…?=` 总长 ≤75，留足余量。 */
const ENCODED_WORD_BYTES = 45;
const MAX_ECHO_LENGTH = 80;

const ASCII_PRINTABLE = /^[\x20-\x7e]*$/;
const DISPLAY_NAME_SPECIALS = /[()<>@,;:\\".[\]]/;
/** 只做「至少有一个 @ 且无空白/尖括号」的宽松校验；真正的可投递性由服务器判定。 */
const EMAIL_LIKE = /^[^@\s<>]+@[^@\s<>]+$/;

/** 回复/转发的原文来源；服务端从本地已存邮件里取。 */
export interface ComposeOriginal {
  /** 原邮件 Message-ID；回复时写 `In-Reply-To`/`References`。 */
  readonly messageId: string;
  /** 原邮件已有的 References（父链），回复时接在末尾。 */
  readonly references?: readonly string[] | undefined;
  readonly fromName?: string | null | undefined;
  readonly fromEmail: string;
  readonly to?: readonly string[] | undefined;
  readonly subject?: string | undefined;
  /** ISO 8601 或 Date；只用于引用块的展示。 */
  readonly date?: string | Date | null | undefined;
  readonly bodyText: string;
  readonly bodyHtml?: string | null | undefined;
}

/** `buildMime` 入参：`OutgoingMessage` + 账号身份 + 原文。 */
export interface MimeComposeInput {
  readonly mode: ComposeMode;
  /** 发件地址（纯地址或 `Name <addr>`）；共享契约要求 From 固定为账号地址。 */
  readonly from: string;
  readonly fromName?: string | null | undefined;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly bodyText: string;
  /** 只有显式给出 HTML 才生成 `multipart/alternative`；null = 纯文本单体。 */
  readonly bodyHtml?: string | null | undefined;
  readonly attachments?: readonly AttachmentPayload[] | undefined;
  /** reply / forward 的原文；mode 为 new 时忽略。 */
  readonly original?: ComposeOriginal | null | undefined;
  /** 测试注入：固定 Message-ID 与时间，生产不传。 */
  readonly messageId?: string | undefined;
  readonly date?: Date | undefined;
  readonly sentFolderId?: string | null | undefined;
}

export interface BuiltMime {
  readonly mime: Uint8Array;
  /** 与 MIME 同一份字节的信封；SMTP/APPEND/Graph 共用。 */
  readonly request: SendRequest;
  /** 客户端 Message-ID（带尖括号）。 */
  readonly messageId: string;
  readonly subject: string;
  /** 回复时的 `In-Reply-To`；非回复为 null。 */
  readonly inReplyTo: string | null;
  /** `References` 链（含本封回复的父消息）。 */
  readonly references: readonly string[];
  /** 实际投递的纯文本（含引用原文）。 */
  readonly text: string;
  /** 实际投递的 HTML；纯文本模式为 null。 */
  readonly html: string | null;
}

/** 回复主题：已有 Re: 前缀（大小写、空格不敏感）则不重复添加。 */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^re\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`.trimEnd();
}

/** 转发主题：已有 Fwd:/Fw: 前缀则不重复添加。 */
export function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  return /^(fwd?|fw)\s*:/i.test(trimmed) ? trimmed : `Fwd: ${trimmed}`.trimEnd();
}

/** 构造一封完整的 MIME 邮件；任何非法输入抛类型化 `MailError`。 */
export function buildMime(input: MimeComposeInput): BuiltMime {
  const sender = extractMailbox(input.from, "发件地址");
  const to = input.to.map((value) => extractMailbox(value, "收件人"));
  const cc = input.cc.map((value) => extractMailbox(value, "抄送"));
  const bcc = input.bcc.map((value) => extractMailbox(value, "密送"));
  if (to.length + cc.length + bcc.length === 0) {
    throw new MailError("protocol", "没有收件人：To/Cc/Bcc 至少需要一个地址", false);
  }

  const original = input.mode === "new" ? null : (input.original ?? null);
  const subject =
    input.mode === "reply"
      ? replySubject(input.subject)
      : input.mode === "forward"
        ? forwardSubject(input.subject)
        : input.subject.trim();
  assertHeaderValue("主题", subject);

  const messageId = assertHeaderValue("Message-ID", input.messageId?.trim() ?? makeMessageId(sender.address));
  const displayMessageId = wrapMessageId(messageId);
  const threading = input.mode === "reply" && original !== null ? threadHeaders(original) : { inReplyTo: null, references: [] };
  const text = withOriginalText(input.mode, input.bodyText, original);
  const html = input.bodyHtml === null || input.bodyHtml === undefined ? null : withOriginalHtml(input.mode, input.bodyHtml, original);

  const date = input.date ?? new Date();
  const headers: string[] = [
    `From: ${formatMailbox(sender.name.length > 0 ? sender.name : (input.fromName ?? null), sender.address)}`,
  ];
  if (to.length > 0) headers.push(`To: ${to.map((item) => formatMailbox(item.name.length > 0 ? item.name : null, item.address)).join(", ")}`);
  if (cc.length > 0) headers.push(`Cc: ${cc.map((item) => formatMailbox(item.name.length > 0 ? item.name : null, item.address)).join(", ")}`);
  if (bcc.length > 0) headers.push(`Bcc: ${bcc.map((item) => formatMailbox(item.name.length > 0 ? item.name : null, item.address)).join(", ")}`);
  headers.push(foldHeader("Subject", encodeUnstructured(subject)));
  headers.push(`Date: ${rfc5322Date(date)}`);
  headers.push(`Message-ID: ${displayMessageId}`);
  if (threading.inReplyTo !== null) headers.push(foldHeader("In-Reply-To", threading.inReplyTo));
  if (threading.references.length > 0) headers.push(foldHeader("References", threading.references.join(" ")));
  headers.push("MIME-Version: 1.0");

  // mixed 与嵌套的 alternative 必须用不同 boundary，否则外层解析会在内层分隔行上误切。
  const suffix = randomUUID().replace(/-/g, "");
  const mixedBoundary = `----=_MailCollect_M_${suffix}`;
  const alternativeBoundary = `----=_MailCollect_A_${suffix}`;
  const alternative = html === null ? null : buildAlternative(text, html, alternativeBoundary);
  const attachments = input.attachments ?? [];
  const body =
    attachments.length === 0
      ? (alternative ?? buildTextEntity(text, "plain"))
      : buildMultipart(
          [alternative ?? buildTextEntity(text, "plain"), ...attachments.map((attachment) => buildAttachmentEntity(attachment))],
          mixedBoundary,
          "mixed",
        );

  const message = `${headers.join(CRLF)}${CRLF}${body}`;
  const mime = new Uint8Array(Buffer.from(message, "utf8"));

  return {
    mime,
    request: {
      mime,
      to: to.map((item) => item.address),
      cc: cc.map((item) => item.address),
      bcc: bcc.map((item) => item.address),
      from: sender.address,
      sentFolderId: input.sentFolderId ?? null,
    },
    messageId: displayMessageId,
    subject,
    inReplyTo: threading.inReplyTo,
    references: threading.references,
    text,
    html,
  };
}

/* ------------------------------- 引用原文 ------------------------------- */

function withOriginalText(mode: ComposeMode, bodyText: string, original: ComposeOriginal | null): string {
  if (original === null || mode === "new") return bodyText;
  const block = mode === "reply" ? quoteReplyText(original) : formatForwardText(original);
  const base = bodyText.trimEnd();
  return base.length === 0 ? block : `${base}${CRLF}${CRLF}${block}`;
}

function withOriginalHtml(mode: ComposeMode, bodyHtml: string, original: ComposeOriginal | null): string {
  if (original === null || mode === "new") return bodyHtml;
  const block = mode === "reply" ? quoteReplyHtml(original) : formatForwardHtml(original);
  return `${bodyHtml}${block}`;
}

function senderLabel(original: ComposeOriginal): string {
  const name = original.fromName?.trim() ?? "";
  return name.length > 0 ? `${name} <${original.fromEmail}>` : original.fromEmail;
}

function originalDateLabel(original: ComposeOriginal): string {
  if (original.date === null || original.date === undefined) return "";
  const date = original.date instanceof Date ? original.date : new Date(original.date);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function quoteReplyText(original: ComposeOriginal): string {
  const when = originalDateLabel(original);
  const lead = when.length > 0 ? `在 ${when}，${senderLabel(original)} 写道：` : `${senderLabel(original)} 写道：`;
  const quoted = original.bodyText
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join(CRLF);
  return `${lead}${CRLF}${quoted}`;
}

function quoteReplyHtml(original: ComposeOriginal): string {
  return `<blockquote>${original.bodyHtml ?? `<pre>${escapeHtml(original.bodyText)}</pre>`}</blockquote>`;
}

function formatForwardText(original: ComposeOriginal): string {
  const lines = [`---------- 转发的邮件 ----------`, `发件人: ${senderLabel(original)}`];
  const when = originalDateLabel(original);
  if (when.length > 0) lines.push(`日期: ${when}`);
  if (original.subject !== undefined) lines.push(`主题: ${original.subject}`);
  if (original.to !== undefined && original.to.length > 0) lines.push(`收件人: ${original.to.join(", ")}`);
  lines.push("", original.bodyText);
  return lines.join(CRLF);
}

function formatForwardHtml(original: ComposeOriginal): string {
  const rows = [`<div><b>发件人:</b> ${escapeHtml(senderLabel(original))}</div>`];
  const when = originalDateLabel(original);
  if (when.length > 0) rows.push(`<div><b>日期:</b> ${escapeHtml(when)}</div>`);
  if (original.subject !== undefined) rows.push(`<div><b>主题:</b> ${escapeHtml(original.subject)}</div>`);
  if (original.to !== undefined && original.to.length > 0) rows.push(`<div><b>收件人:</b> ${escapeHtml(original.to.join(", "))}</div>`);
  const body = original.bodyHtml ?? `<pre>${escapeHtml(original.bodyText)}</pre>`;
  return `<div class="forward">---------- 转发的邮件 ----------<br>${rows.join("")}<hr>${body}</div>`;
}

function threadHeaders(original: ComposeOriginal): { inReplyTo: string | null; references: readonly string[] } {
  const inReplyTo = wrapMessageId(original.messageId.trim());
  if (inReplyTo.length === 0) return { inReplyTo: null, references: [] };
  const references: string[] = [];
  for (const reference of original.references ?? []) {
    const normalized = wrapMessageId(reference.trim());
    if (normalized.length > 0 && !references.includes(normalized)) references.push(normalized);
  }
  if (!references.includes(inReplyTo)) references.push(inReplyTo);
  return { inReplyTo, references };
}

/* ------------------------------ 地址与头部 ------------------------------ */

interface Mailbox {
  readonly name: string;
  readonly address: string;
}

function extractMailbox(raw: string, label: string): Mailbox {
  const text = assertHeaderValue(label, raw).trim();
  if (text.length === 0) throw new MailError("protocol", `${label}为空`, false);
  const angled = /^(.*?)<([^<>]+)>\s*$/.exec(text);
  if (angled !== null) {
    const name = (angled[1] ?? "").trim().replace(/^"(.*)"$/, "$1").replace(/\\(["\\])/g, "$1");
    const address = (angled[2] ?? "").trim();
    if (!EMAIL_LIKE.test(address)) throw new MailError("protocol", `${label}不合法：${clip(address)}`, false);
    return { name, address };
  }
  if (!EMAIL_LIKE.test(text)) throw new MailError("protocol", `${label}不合法：${clip(text)}`, false);
  return { name: "", address: text };
}

function formatMailbox(name: string | null, address: string): string {
  const display = name?.trim() ?? "";
  if (display.length === 0) return address;
  return `${formatDisplayName(display)} <${address}>`;
}

function formatDisplayName(name: string): string {
  if (!ASCII_PRINTABLE.test(name)) return encodeWord(name);
  if (DISPLAY_NAME_SPECIALS.test(name) || /^\s|\s$/.test(name)) {
    return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return name;
}

/** 头部值统一入口：去掉换行即为拒绝（头注入）。 */
function assertHeaderValue(label: string, value: string): string {
  if (/[\r\n]/.test(value)) {
    throw new MailError("protocol", `邮件头「${label}」不能包含换行`, false);
  }
  return value;
}

/** RFC 2047 B 编码；纯 ASCII 原样返回。 */
function encodeUnstructured(value: string): string {
  if (value.length === 0) return "";
  return ASCII_PRINTABLE.test(value) ? value : encodeWord(value);
}

function encodeWord(value: string): string {
  const chunks: string[] = [];
  let current = "";
  let bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > ENCODED_WORD_BYTES && current.length > 0) {
      chunks.push(current);
      current = "";
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, "utf8").toString("base64")}?=`).join(" ");
}

/** 只按空格折行：编码字之间的折叠空白在解码时会被忽略。 */
function foldHeader(name: string, value: string): string {
  const prefix = `${name}: `;
  const words = value.split(" ");
  const lines: string[] = [];
  let current = prefix;
  for (const word of words) {
    if (current === prefix) {
      current = `${prefix}${word}`;
      continue;
    }
    if (current.length + 1 + word.length > FOLD_AT) {
      lines.push(current);
      current = `  ${word}`;
    } else {
      current = `${current} ${word}`;
    }
  }
  lines.push(current);
  return lines.join(CRLF);
}

function rfc5322Date(date: Date): string {
  const text = date.toUTCString();
  return text.endsWith(" GMT") ? `${text.slice(0, -4)} +0000` : text;
}

function makeMessageId(address: string): string {
  const at = address.lastIndexOf("@");
  const domain = at >= 0 ? address.slice(at + 1).replace(/[^A-Za-z0-9.-]/g, "") : "";
  return `<${randomUUID()}@${domain.length > 0 ? domain : "mailcollect.local"}>`;
}

function wrapMessageId(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) return text;
  return text.startsWith("<") && text.endsWith(">") ? text : `<${text.replace(/[<>]/g, "")}>`;
}

function clip(text: string): string {
  return text.length <= MAX_ECHO_LENGTH ? text : `${text.slice(0, MAX_ECHO_LENGTH)}…`;
}

/* ------------------------------- MIME 部件 ------------------------------- */

function buildTextEntity(body: string, subtype: "plain" | "html"): string {
  return [
    `Content-Type: text/${subtype}; charset="utf-8"`,
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(body, "utf8")),
  ].join(CRLF);
}

function buildAlternative(text: string, html: string, boundary: string): string {
  return buildMultipart([buildTextEntity(text, "plain"), buildTextEntity(html, "html")], boundary, "alternative");
}

function buildMultipart(parts: readonly string[], boundary: string, subtype: "mixed" | "alternative"): string {
  const lines = [`Content-Type: multipart/${subtype}; boundary="${boundary}"`, "", "This is a multi-part message in MIME format."];
  for (const part of parts) {
    lines.push(`--${boundary}`);
    lines.push(part);
  }
  lines.push(`--${boundary}--`, "");
  return lines.join(CRLF);
}

function buildAttachmentEntity(attachment: AttachmentPayload): string {
  const filename = assertHeaderValue("附件文件名", attachment.filename.length > 0 ? attachment.filename : "attachment.bin");
  const mimeType = normalizeMimeType(attachment.mimeType);
  const data = Buffer.from(attachment.dataBase64, "base64");
  return [
    `Content-Type: ${mimeType}; ${parameter("name", filename)}`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; ${parameter("filename", filename)}`,
    "",
    base64Lines(data),
  ].join(CRLF);
}

/** 附件参数：ASCII 直接引号化；非 ASCII 附 RFC 2231 扩展（`filename*=`）。 */
/** 附件类型只接受 `type/subtype` token；非法值降级为 octet-stream，避免把参数注入 Content-Type。 */
function normalizeMimeType(raw: string): string {
  const value = assertHeaderValue("附件类型", raw.trim());
  return /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(value) ? value : "application/octet-stream";
}

function parameter(name: string, value: string): string {
  if (ASCII_PRINTABLE.test(value)) {
    return `${name}="${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return `${name}="${asciiFallback(value)}"; ${name}*=UTF-8''${rfc2231(value)}`;
}

function asciiFallback(value: string): string {
  const fallback = value.replace(/[^\x20-\x7e]+/g, "_").replace(/["\\]/g, "_");
  return fallback.length > 0 ? fallback : "attachment";
}

function rfc2231(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9!#$&+\-.^_`|~]/.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

function base64Lines(data: Uint8Array): string {
  const encoded = Buffer.from(data).toString("base64");
  const lines: string[] = [];
  for (let index = 0; index < encoded.length; index += BASE64_LINE) {
    lines.push(encoded.slice(index, index + BASE64_LINE));
  }
  return lines.join(CRLF);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
