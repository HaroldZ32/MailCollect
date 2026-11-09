import type { RawEmail } from "@mailcollect/shared";

/**
 * 本地「已发送」镜像。
 *
 * 只依赖注入的 store 端口，不 import `store/`：核心包与存储层的边由调用方接线，
 * 单测用内存假端口即可验证「写入 raw_email 并在同一事务里入账 change_log」的契约。
 *
 * 已发送副本的去重键：`uid = Message-ID`（同一封邮件重试/重放只落一行），
 * `id = "<accountId>:sent:<uid>"` 与收件 `raw_email.id = "<accountId>:<uid>"` 不冲突。
 */

const MAX_UID_LENGTH = 300;

/**
 * `store.upsertEmails` 的形状：插入新行并返回新 id；存储层内部负责追加 `change_log`。
 * 返回 `inserted: 0` 表示同 `(account_id, uid)` 已存在，调用方应视为幂等成功。
 */
export interface SentMirrorPort {
  upsertEmails(emails: readonly RawEmail[]): { inserted: number; ids: readonly string[] };
}

export interface SentMirrorInput {
  readonly accountId: string;
  readonly fromName?: string | null | undefined;
  readonly fromEmail: string;
  /** 信封 To（不含 Bcc，避免把密送对象落进可展示的本地镜像）。 */
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly subject: string;
  /** 实际投递的纯文本（含引用原文）。 */
  readonly bodyText: string;
  /** 客户端 Message-ID，带不带尖括号都可以。 */
  readonly messageId: string;
  readonly threadId?: string | null | undefined;
  readonly inReplyTo?: string | null | undefined;
  readonly references?: readonly string[] | undefined;
  readonly hasAttachments?: boolean | undefined;
  /** 测试注入；默认当前时间。 */
  readonly sentAt?: string | undefined;
  /** 测试注入；默认按账号+uid 生成。 */
  readonly id?: string | undefined;
}

export interface SentMirrorRecord {
  readonly email: RawEmail;
  /** false = 同键已存在（幂等重放），没有新写行。 */
  readonly inserted: boolean;
  readonly id: string;
}

/** `raw_email.uid` 归一：去掉尖括号与换行，超长截断（列是 TEXT，但错误信息里会回显）。 */
export function sentMirrorUid(messageId: string): string {
  const trimmed = messageId.trim().replace(/[\r\n]/g, "").replace(/^</, "").replace(/>$/, "");
  const uid = trimmed.length > 0 ? trimmed : "unknown-message-id";
  return uid.length <= MAX_UID_LENGTH ? uid : uid.slice(0, MAX_UID_LENGTH);
}

/** 组装一条已发送 `RawEmail` 并写入注入的 store 端口。 */
export function mirrorSentMessage(store: SentMirrorPort, input: SentMirrorInput): SentMirrorRecord {
  const uid = sentMirrorUid(input.messageId);
  const id = input.id ?? `${input.accountId}:sent:${uid}`;
  const sentAt = input.sentAt ?? new Date().toISOString();
  const headers: Record<string, string> = { "message-id": wrapMessageId(uid) };
  const inReplyTo = input.inReplyTo?.trim();
  if (inReplyTo !== undefined && inReplyTo.length > 0) headers["in-reply-to"] = wrapMessageId(inReplyTo);
  const references = (input.references ?? []).map((reference) => wrapMessageId(reference.trim())).filter((reference) => reference.length > 0);
  if (references.length > 0) headers.references = references.join(" ");

  const email: RawEmail = {
    id,
    accountId: input.accountId,
    uid,
    messageId: wrapMessageId(uid),
    threadId: input.threadId ?? null,
    fromName: input.fromName ?? null,
    fromEmail: input.fromEmail,
    to: [...input.to],
    cc: [...input.cc],
    subject: input.subject,
    sentAt,
    bodyText: input.bodyText,
    hasAttachments: input.hasAttachments === true,
    headers,
    createdAt: sentAt,
  };

  const result = store.upsertEmails([email]);
  return { email, inserted: result.inserted > 0, id };
}

function wrapMessageId(raw: string): string {
  const text = raw.trim();
  if (text.length === 0) return text;
  return text.startsWith("<") && text.endsWith(">") ? text : `<${text.replace(/[<>]/g, "")}>`;
}
