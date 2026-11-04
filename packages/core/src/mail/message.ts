import type { RawEmail } from "@mailcollect/shared";
import { simpleParser } from "mailparser";
import { pickMailparserHeaders } from "./headers.js";

/**
 * RawEmail 的组装与 MIME/HTML 解析。
 *
 * 边界：这里只做「传输层表示 → RawEmail」的转换。引文剥离、签名剥离、线程装配
 * 都是 pipeline 泳道的事，`bodyText` 保持解析出的纯文本原样。
 */

/** 组装 RawEmail 所需的字段（id/createdAt 由这里补齐）。 */
export interface ParsedEmailFields {
  readonly uid: string;
  readonly messageId: string;
  readonly threadId: string | null;
  readonly fromName: string | null;
  readonly fromEmail: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  readonly sentAt: string;
  readonly bodyText: string;
  readonly hasAttachments: boolean;
  readonly headers: Record<string, string>;
}

/** 用适配器拿到的字段构造一条本地邮件记录。 */
export function buildRawEmail(accountId: string, fields: ParsedEmailFields): RawEmail {
  return {
    id: `${accountId}:${fields.uid}`,
    accountId,
    uid: fields.uid,
    messageId: fields.messageId,
    threadId: fields.threadId,
    fromName: fields.fromName,
    fromEmail: fields.fromEmail,
    to: [...fields.to],
    cc: [...fields.cc],
    subject: fields.subject,
    sentAt: fields.sentAt,
    bodyText: fields.bodyText,
    hasAttachments: fields.hasAttachments,
    headers: fields.headers,
    createdAt: new Date().toISOString(),
  };
}

/** Date 头缺失时的兜底：先试内部投递时间，再退回当前时间。 */
export function toDate(value: Date | string | null | undefined): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === "string" && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
}

/** 把 AddressObject（或数组）里的地址摊平成字符串数组。 */
function collectAddresses(input: unknown): string[] {
  if (input === null || input === undefined) return [];
  const groups = Array.isArray(input) ? input : [input];
  const addresses: string[] = [];
  for (const group of groups) {
    if (typeof group !== "object" || group === null || !("value" in group)) continue;
    const values: unknown = Reflect.get(group, "value");
    if (!Array.isArray(values)) continue;
    for (const item of values) {
      if (typeof item !== "object" || item === null) continue;
      const address: unknown = Reflect.get(item, "address");
      if (typeof address === "string" && address.trim().length > 0) addresses.push(address.trim());
    }
  }
  return addresses;
}

/**
 * 线程提示：优先取 In-Reply-To，其次取 References 的第一条。
 * 真正的线程装配在 pipeline，这里只给「最近的父消息 id」。
 */
function threadHint(inReplyTo: string | undefined, references: string | string[] | undefined): string | null {
  const direct = inReplyTo?.trim();
  if (direct !== undefined && direct.length > 0) return direct;
  const list = Array.isArray(references) ? references : [references];
  for (const reference of list) {
    const text = reference?.trim();
    if (text !== undefined && text.length > 0) return text;
  }
  return null;
}

const HTML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/**
 * 极简 HTML → 纯文本。
 *
 * 不引入额外依赖：只处理块级换行、标签剥离与常见实体。Graph 的 HTML 正文
 * 走这里；更复杂的清洗（引文/签名）仍归 pipeline。
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/gi, (match) => HTML_ENTITIES[match.slice(1, -1).toLowerCase()] ?? match)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * 解析一封原始 MIME 邮件（IMAP 的 BODY[] / POP3 的 RETR 结果）。
 *
 * @param receivedAt 服务器内部投递时间；Date 头缺失时用它兜底。
 */
export async function parseMimeEmail(
  accountId: string,
  uid: string,
  source: Buffer | string,
  receivedAt: Date | null,
): Promise<RawEmail> {
  const parsed = await simpleParser(source);
  const sender = parsed.from?.value[0];
  const senderName = sender?.name?.trim() ?? "";
  const senderEmail = sender?.address?.trim() ?? "";
  const sentAt = parsed.date ?? receivedAt ?? new Date();

  return buildRawEmail(accountId, {
    uid,
    // Message-ID 可能缺失：给一个按账号+uid 稳定的兜底，保证去重键始终可用。
    messageId: parsed.messageId ?? `<${accountId}.${uid}@mailcollect.local>`,
    threadId: threadHint(parsed.inReplyTo, parsed.references),
    fromName: senderName.length > 0 ? senderName : null,
    fromEmail: senderEmail,
    to: collectAddresses(parsed.to),
    cc: collectAddresses(parsed.cc),
    subject: parsed.subject ?? "",
    sentAt: sentAt.toISOString(),
    bodyText: parsed.text ?? "",
    hasAttachments: parsed.attachments.length > 0,
    headers: pickMailparserHeaders(parsed.headers),
  });
}
