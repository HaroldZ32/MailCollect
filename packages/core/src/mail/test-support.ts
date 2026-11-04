import type { MailProvider } from "@mailcollect/shared";
import type { MailSourceAccount } from "./account.js";

/**
 * 仅供单元测试使用：构造一个全字段可控的账号。
 * 测试不连真实邮箱，`secret` 只用于验证「不会被写进错误信息」。
 */
export function makeAccount(
  provider: MailProvider,
  config: Record<string, string> = {},
  secret = "s3cret-app-password",
): MailSourceAccount {
  return { id: "acc-1", provider, email: "user@example.com", config, secret };
}

export interface RawEmailFields {
  readonly messageId?: string;
  readonly from?: string;
  readonly to?: string;
  readonly subject?: string;
  readonly body?: string;
  readonly date?: string;
  readonly extraHeaders?: readonly string[];
}

/** 仅供单元测试使用：拼一封最小 RFC822 邮件。 */
export function rawEmail(fields: RawEmailFields = {}): string {
  return [
    `Message-ID: <${fields.messageId ?? "msg-1@example.com"}>`,
    `From: ${fields.from ?? "Alice <alice@example.com>"}`,
    `To: ${fields.to ?? "user@example.com"}`,
    `Subject: ${fields.subject ?? "Hello"}`,
    `Date: ${fields.date ?? "04 Nov 2026 09:00:00 +0800"}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    ...(fields.extraHeaders ?? []),
    "",
    fields.body ?? "Hello world.",
  ].join("\r\n");
}
