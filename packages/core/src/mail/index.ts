import type { MailSource } from "./types.js";
import { MailError } from "./types.js";
import type { MailSourceAccount } from "./account.js";
import type { MailSourceFactory } from "./types.js";
import { ImapMailSource } from "./imap.js";
import { Pop3MailSource } from "./pop3.js";
import { GraphMailSource } from "./graph.js";

export * from "./types.js";
export * from "./account.js";
export * from "./errors.js";
export * from "./headers.js";
export * from "./message.js";
export { ImapMailSource } from "./imap.js";
export type { ImapClientLike, ImapFetchMessageLike, ImapMailboxLike, ImapSourceOptions } from "./imap.js";
export { Pop3MailSource } from "./pop3.js";
export type { Pop3ClientLike, Pop3ConnectionOptions, Pop3SourceOptions } from "./pop3.js";
export { GraphMailSource, MsalDeviceCodeAuth } from "./graph.js";
export type { DeviceCodeNotice, GraphAuth, GraphFetch, GraphResponse, GraphSourceOptions } from "./graph.js";

/**
 * 按 `account.provider` 构造适配器。
 *
 * 凭据只从 `account.secret` 进来；本函数不读环境变量、不读任何凭据文件。
 */
export function createMailSource(account: MailSourceAccount): MailSource {
  switch (account.provider) {
    case "imap":
      return new ImapMailSource(account);
    case "pop3":
      return new Pop3MailSource(account);
    case "graph":
      return new GraphMailSource(account);
    default: {
      // provider 是联合类型；运行时仍来自持久化配置，因此保留显式兜底。
      const provider: never = account.provider;
      throw new MailError("not_supported", `不支持的邮箱协议：${String(provider)}`, false);
    }
  }
}

/** 与冻结的 `MailSourceFactory` 形状对齐（工厂入参比 MailSourceAccount 更宽）。 */
export const mailSourceFactory: MailSourceFactory = createMailSource;
