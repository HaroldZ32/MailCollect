import type { RawEmail } from "@mailcollect/shared";
import type { RuleAttachment, RuleEmail } from "./evaluate.js";

/**
 * 邮件 → 规则求值的唯一投影（C6）。
 *
 * 为什么需要它：`RawEmail`（shared 冻结）只带同步必需的字段，而规则词表还承诺了
 * `date.which="received"` 与 `attachmentName` / `attachmentMime` / `attachmentSize`。
 * 这些元数据存在 `raw_email.received_at` / `raw_email.attachments_json`（附件只存
 * name/mime/size，**不存字节**），由调用方（同步/富化路径）读出来交给本函数。
 *
 * 空值语义：`receivedAt: null` 与 `attachments: []` 表示「元数据未知」，
 * 求值器按 C6 的「字段缺失 → 叶子 false」处理，不会猜。
 *
 * 同步与后台重算必须共用这一个投影，否则两条路径的分类结果会悄悄分叉。
 */
export interface EmailStateSnapshot {
  readonly folder: string | null;
  readonly isRead: boolean;
}

export interface EmailMetadataSnapshot {
  readonly receivedAt?: string | null;
  readonly attachments?: readonly RuleAttachment[];
}

export function projectRuleEmail(
  email: RawEmail,
  state: EmailStateSnapshot | null,
  extras: EmailMetadataSnapshot | null,
): RuleEmail {
  return {
    id: email.id,
    accountId: email.accountId,
    fromName: email.fromName,
    fromEmail: email.fromEmail,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    bodyText: email.bodyText,
    sentAt: email.sentAt,
    headers: email.headers,
    hasAttachments: email.hasAttachments,
    receivedAt: extras?.receivedAt ?? null,
    attachments: extras?.attachments ?? [],
    ...(state === null ? {} : { folder: state.folder, isRead: state.isRead }),
  };
}
