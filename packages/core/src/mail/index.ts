import type { MailSource } from "./types.js";
import { MailError } from "./types.js";
import type { MailSourceAccount } from "./account.js";
import { readConfig } from "./account.js";
import { notConfiguredError } from "./errors.js";
import type { MailSourceFactory } from "./types.js";
import { ImapMailSource } from "./imap.js";
import { Pop3MailSource } from "./pop3.js";
import { GraphMailSource } from "./graph.js";
import type { GraphSourceOptions } from "./graph.js";
import { EwsMailSource } from "./ews.js";
import type { EwsSourceOptions } from "./ews.js";

export * from "./types.js";
export * from "./account.js";
export * from "./errors.js";
export * from "./headers.js";
export * from "./message.js";
// 发信通道（mime / smtp / dispatch / sent-mirror）：服务端发信 lane 只 import
// "@mailcollect/core/mail" 就能拿到完整 API，不必深入内部路径。
// send/* 只依赖 types/errors/account（单向），这里再导出不会形成循环导入。
export * from "./send/index.js";
export { ImapMailSource } from "./imap.js";
export type { ImapClientLike, ImapFetchMessageLike, ImapMailboxLike, ImapSourceOptions } from "./imap.js";
export { Pop3MailSource } from "./pop3.js";
export type { Pop3ClientLike, Pop3ConnectionOptions, Pop3SourceOptions } from "./pop3.js";
export { GraphMailSource, MsalDeviceCodeAuth } from "./graph.js";
export type {
  GraphAuth,
  GraphFetch,
  GraphFetchOptions,
  GraphRequestInit,
  GraphResponse,
  GraphSourceOptions,
} from "./graph.js";
export { EwsMailSource, NtlmClient, md4, parseNtlmChallenge } from "./ews.js";
export type { EwsFetch, EwsRequestInit, EwsResponse, EwsSourceOptions, NtlmClientOptions } from "./ews.js";
export {
  autodiscoverEndpoints,
  autodiscoverForAccount,
  buildAutodiscoverRequestXml,
  discoverAutodiscover,
  parseXmlDocument,
} from "./autodiscover.js";
export type {
  AutodiscoverFetch,
  AutodiscoverInit,
  AutodiscoverKind,
  AutodiscoverOptions,
  AutodiscoverRequest,
  AutodiscoverResponse,
  AutodiscoverResult,
  XmlElement,
} from "./autodiscover.js";
// DeviceCodeNotice 现在定义在 types.ts，由上面的 `export *` 导出，名字不变。

/**
 * Graph 账号的配置透传。
 *
 * `clientId` / `tenant` / `scopes` 全部来自账号自身的 `config`（不读环境变量）：
 * 工厂不改写、不剥离，把 account 原样交给 `GraphMailSource`——tenant 默认 `common`、
 * scopes 默认 `Mail.Read + offline_access` 由适配器解析，那边是唯一解析点。
 * 这里只做一次前置校验：缺 `clientId` 给类型化 not_configured、不崩溃、不静默挂起，
 * 而不是让它落到适配器深处再抛 protocol。
 */
function prepareGraphAccount(account: MailSourceAccount): MailSourceAccount {
  if (readConfig(account, "clientId") === null) {
    throw notConfiguredError("graph", "缺少 clientId（在账号 config 里填 Azure 应用注册的客户端 id）");
  }
  return account;
}

/** 工厂第二参：Graph 与 EWS 各自的注入点；其他适配器忽略。 */
export interface MailSourceOptions extends GraphSourceOptions {
  /** EWS 的传输注入（测试/特殊部署）。 */
  readonly ews?: EwsSourceOptions | undefined;
}

/**
 * 按 `account.provider` 构造适配器。
 *
 * 凭据只从 `account.secret` 进来；本函数不读环境变量、不读任何凭据文件。
 *
 * 第二参只对 Graph / EWS 有效（设备码回调 / 传输层注入）。IMAP/POP3 没有交互式登录，
 * 直接忽略它；单参调用保持完全兼容（`mailSourceFactory` 仍是单参形状）。
 */
export function createMailSource(account: MailSourceAccount, options: MailSourceOptions = {}): MailSource {
  switch (account.provider) {
    case "imap":
      return new ImapMailSource(account);
    case "pop3":
      return new Pop3MailSource(account);
    case "graph":
      return new GraphMailSource(prepareGraphAccount(account), options);
    case "ews":
      // 未填 ewsUrl 时构造函数抛类型化 not_configured，不崩、不静默挂起。
      return new EwsMailSource(account, options.ews ?? {});
    default: {
      // provider 是联合类型；运行时仍来自持久化配置，因此保留显式兜底。
      const provider: never = account.provider;
      throw new MailError("not_supported", `不支持的邮箱协议：${String(provider)}`, false);
    }
  }
}

/** 与冻结的 `MailSourceFactory` 形状对齐（工厂入参比 MailSourceAccount 更宽）。 */
export const mailSourceFactory: MailSourceFactory = createMailSource;
