import type { AccountSendConfig, MailAuthMode, MailProvider, SyncCursor } from "@mailcollect/shared";

/**
 * 适配器构造入参。与 `MailSourceFactory` 的入参形状保持一致（FROZEN CONTRACT 见 types.ts）。
 *
 * 凭据只经 `secret` 传入：IMAP/POP3 是密码或应用专用密码，Graph 不使用。
 * 适配器不读环境变量、不读凭据文件，也不会把 `secret` 写回任何地方。
 */
export interface MailSourceAccount {
  readonly id: string;
  readonly provider: MailProvider;
  readonly email: string;
  readonly config: Readonly<Record<string, string>>;
  readonly secret: string;
}

/** 任何带 `config` 的对象都能读配置；适配器与账号视图共用同一套读取器。 */
export type ConfigHolder = Pick<MailSourceAccount, "config">;

/** 读取非敏感配置项；空白值按缺失处理，返回 null。 */
export function readConfig(holder: ConfigHolder, key: string): string | null {
  const value = holder.config[key];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 读取整数配置项并夹到 [min, max]；无法解析时返回 null（交给调用方取默认值）。 */
export function readConfigInt(holder: ConfigHolder, key: string, min: number, max: number): number | null {
  const raw = readConfig(holder, key);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, min), max);
}

/** 读取布尔配置项；只有明确写出的 1/0、true/false 等才生效，其余走 fallback。 */
export function readConfigBool(holder: ConfigHolder, key: string, fallback: boolean): boolean {
  const raw = readConfig(holder, key)?.toLowerCase() ?? null;
  switch (raw) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

/** 生成一次同步的游标；`value` 的格式由各适配器自己定义。 */
export function makeCursor(accountId: string, value: string): SyncCursor {
  return { accountId, value, updatedAt: new Date().toISOString() };
}

/* ------------------------------ 协议与认证方式 ------------------------------ */

/**
 * 支持的邮箱协议。与 shared 的 `MailProvider` 一一对应：`satisfies` 会在任一
 * 一边增删协议时让这里编译失败，避免两处漂移。
 */
export const MAIL_PROVIDERS = ["imap", "pop3", "graph", "ews"] as const satisfies readonly MailProvider[];

/**
 * 归一化持久化/HTTP 传来的协议名。
 * 认不出时返回 null：调用方必须显式报 not_configured/not_supported，不能猜默认值。
 */
export function parseMailProvider(raw: string | null | undefined): MailProvider | null {
  switch (raw?.trim().toLowerCase() ?? "") {
    case "imap":
      return "imap";
    case "pop3":
      return "pop3";
    case "graph":
      return "graph";
    case "ews":
      return "ews";
    default:
      return null;
  }
}

/** 认证方式；与 shared 的 `MailAuthMode` 一一对应（同上，靠 `satisfies` 保证）。 */
export const MAIL_AUTH_MODES = ["password", "ntlm", "oauth2", "device-code"] as const satisfies readonly MailAuthMode[];

/** 认不出的认证方式返回 null，由调用方决定报错还是取默认值。 */
export function parseAuthMode(raw: string | null | undefined): MailAuthMode | null {
  switch (raw?.trim().toLowerCase() ?? "") {
    case "password":
      return "password";
    case "ntlm":
      return "ntlm";
    case "oauth2":
      return "oauth2";
    case "device-code":
      return "device-code";
    default:
      return null;
  }
}

/* -------------------------------- 发信配置 -------------------------------- */

/** 发信字段在 `Account.config` 里的键名；与 shared `AccountSendConfig` 字段同名。 */
export const SEND_CONFIG_KEYS = {
  smtpHost: "smtpHost",
  smtpPort: "smtpPort",
  smtpSecure: "smtpSecure",
  smtpUser: "smtpUser",
  ewsUrl: "ewsUrl",
  authMode: "authMode",
  signature: "signature",
  displayName: "displayName",
} as const;

/**
 * 不允许以明文出现在 config 里的字段名。
 * 校验只报字段名、绝不回显字段值——错误信息、日志、API 响应都不许带凭据。
 */
const PLAINTEXT_SECRET_KEYS = [
  "password",
  "passwd",
  "pwd",
  "smtpPassword",
  "ewsPassword",
  "secret",
  "clientSecret",
  "refreshToken",
  "accessToken",
] as const;

const SMTP_PORT_MIN = 1;
const SMTP_PORT_MAX = 65_535;
/** 隐式 TLS（SMTPS）的默认端口。 */
const SMTP_PORT_IMPLICIT_TLS = 465;
/** STARTTLS 的默认端口。 */
const SMTP_PORT_STARTTLS = 587;
/** 明文 / STARTTLS 的备用端口。 */
const SMTP_PORT_PLAIN = 25;
/** 端口未知、也没写 `smtpSecure` 时的保守默认：按隐式 TLS 处理，不悄悄降级成明文。 */
const SMTP_SECURE_FALLBACK = true;
const AUTH_MODE_DEFAULT: MailAuthMode = "password";

/**
 * 没有显式写 `smtpSecure` 时，按端口推断语义：
 * 465 是隐式 TLS，587/25 是 STARTTLS（secure=false，先明文握手再升级）。
 * 端口未知时退回保守默认（隐式 TLS）。
 *
 * 这样 `{smtpPort: "587"}` 不会被解读成「在 STARTTLS 端口上直接握手 TLS」。
 */
function defaultSmtpSecure(port: number | null): boolean {
  switch (port) {
    case SMTP_PORT_IMPLICIT_TLS:
      return true;
    case SMTP_PORT_STARTTLS:
    case SMTP_PORT_PLAIN:
      return false;
    default:
      return SMTP_SECURE_FALLBACK;
  }
}

/** 端口字符串 → 端口号；不是 1-65535 的整数时返回 null（不夹取，避免把错配置读成对的）。 */
function parsePort(raw: string | null): number | null {
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = Number.parseInt(raw, 10);
  if (parsed < SMTP_PORT_MIN || parsed > SMTP_PORT_MAX) return null;
  return parsed;
}

/** 配置文件里的布尔值只认这些写法；其余（含拼错）一律不算。 */
function isBooleanToken(raw: string): boolean {
  switch (raw.trim().toLowerCase()) {
    case "1":
    case "0":
    case "true":
    case "false":
    case "yes":
    case "no":
    case "on":
    case "off":
      return true;
    default:
      return false;
  }
}

/** 只接受 http/https 的绝对 URL；解析失败返回 null。 */
function parseHttpUrl(raw: string): URL | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

/** URL 里是否内嵌了用户名/密码（userinfo）。 */
function hasUrlCredentials(url: URL): boolean {
  return url.username !== "" || url.password !== "";
}

/**
 * 对外输出的 ewsUrl：剥掉 URL 里的 userinfo（`https://user:pass@host/…`）。
 *
 * `config` 是非密列，`AccountView.send` 会回显它；即使历史数据里已经混进了
 * `user:pass@`，读路径也只输出 scheme + host + path。凭据只能走加密 secret store。
 * 非法 URL 返回 null（问题由 `validateSendConfig` 报告，读路径不抛异常）。
 */
function ewsUrlForOutput(raw: string | null): string | null {
  if (raw === null) return null;
  const url = parseHttpUrl(raw);
  if (url === null) return null;
  if (!hasUrlCredentials(url)) return raw;
  return `${url.origin}${url.pathname}${url.search}`;
}

/**
 * 解析账号里的发信配置（`AccountSendConfig`）。
 *
 * 只读非敏字段：密码/令牌经 `secret`（或加密 secret store）进来，本函数既不读也不返回它们。
 * 非法值降级为 null/默认值，具体问题由 `validateSendConfig` 报告；读路径不抛异常。
 */
export function readSendConfig(holder: ConfigHolder): AccountSendConfig {
  const smtpPort = parsePort(readConfig(holder, SEND_CONFIG_KEYS.smtpPort));
  // 签名/显示名是可选的非密身份设置：未写（或空白）时键不出现，读回方视为「未设置」。
  const signature = readConfig(holder, SEND_CONFIG_KEYS.signature);
  const displayName = readConfig(holder, SEND_CONFIG_KEYS.displayName);
  return {
    smtpHost: readConfig(holder, SEND_CONFIG_KEYS.smtpHost),
    smtpPort,
    // 显式 smtpSecure 优先；没写时按端口推断（465 隐式 TLS，587/25 STARTTLS）。
    smtpSecure: readConfigBool(holder, SEND_CONFIG_KEYS.smtpSecure, defaultSmtpSecure(smtpPort)),
    smtpUser: readConfig(holder, SEND_CONFIG_KEYS.smtpUser),
    // 出站前脱敏：URL 里内嵌的 user:pass 绝不回显（config 是非密列）。
    ewsUrl: ewsUrlForOutput(readConfig(holder, SEND_CONFIG_KEYS.ewsUrl)),
    authMode: parseAuthMode(readConfig(holder, SEND_CONFIG_KEYS.authMode)) ?? AUTH_MODE_DEFAULT,
    ...(signature === null ? {} : { signature }),
    ...(displayName === null ? {} : { displayName }),
  };
}

/** 发信实际使用的端口：显式配置优先，否则按 secure 取 465/587。 */
export function resolveSmtpPort(config: AccountSendConfig): number {
  if (config.smtpPort !== null) return config.smtpPort;
  return config.smtpSecure ? SMTP_PORT_IMPLICIT_TLS : SMTP_PORT_STARTTLS;
}

/**
 * 账号是否配了发信通道（SMTP 或 EWS）。
 * 发信前先问它，缺配置就直接报 not_configured，而不是等到连接失败。
 */
export function hasSendConfig(config: AccountSendConfig): boolean {
  return config.smtpHost !== null || config.ewsUrl !== null;
}

/**
 * 校验发信配置，返回可读问题清单（空数组 = 通过）。
 *
 * 只描述「缺什么/哪项非法」，不回显配置值；明文凭据只报字段名。
 * 收信账号可以没有发信配置，因此这里只校验已出现的字段与 EWS 必填项；
 * 「要发信但缺 smtpHost」由发送通道在发信时按 not_configured 处理。
 */
export function validateSendConfig(config: Readonly<Record<string, string>>, provider: MailProvider): readonly string[] {
  const issues: string[] = [];

  for (const key of PLAINTEXT_SECRET_KEYS) {
    if (!(key in config)) continue;
    issues.push(`发信配置里出现明文凭据字段「${key}」：密码/令牌必须存进加密 secret store，config 只放非敏字段`);
  }

  const port = readRaw(config, SEND_CONFIG_KEYS.smtpPort);
  if (port !== null && parsePort(port) === null) {
    issues.push(`smtpPort 必须是 ${SMTP_PORT_MIN}-${SMTP_PORT_MAX} 之间的整数`);
  }

  const secure = readRaw(config, SEND_CONFIG_KEYS.smtpSecure);
  if (secure !== null && !isBooleanToken(secure)) {
    issues.push("smtpSecure 只能是 true/false/1/0/yes/no/on/off");
  }

  const authModeRaw = readRaw(config, SEND_CONFIG_KEYS.authMode);
  const authMode = parseAuthMode(authModeRaw);
  if (authModeRaw !== null && authMode === null) {
    issues.push(`authMode 只能是 ${MAIL_AUTH_MODES.join("/")}`);
  }

  const ewsUrl = readRaw(config, SEND_CONFIG_KEYS.ewsUrl);
  if (ewsUrl !== null) {
    const url = parseHttpUrl(ewsUrl);
    if (url === null) {
      issues.push("ewsUrl 不是合法的 http(s) URL");
    } else {
      // 内嵌 user:pass 的 URL 是明文凭据：config 是非密列、AccountView 会回显，必须拒。
      // 文案不能带上 URL 本身（那里面就有密码），只说怎么填。
      if (hasUrlCredentials(url)) {
        issues.push("ewsUrl 不能包含用户名或密码：凭据只能存进加密 secret store，URL 只填 https://<主机>/EWS/Exchange.asmx");
      }
      if (url.protocol === "http:") issues.push("ewsUrl 应使用 https：Exchange 2016+ 默认拒绝明文 EWS");
    }
  }

  if (readRaw(config, SEND_CONFIG_KEYS.smtpUser) !== null && readRaw(config, SEND_CONFIG_KEYS.smtpHost) === null) {
    issues.push("配置了 smtpUser 但缺少 smtpHost");
  }

  if (provider === "ews") {
    if (ewsUrl === null) issues.push("本地 Exchange 账号缺少 ewsUrl（先跑 Autodiscover，或手工填写）");
    const mode = authMode ?? AUTH_MODE_DEFAULT;
    if (mode !== "password" && mode !== "ntlm") {
      issues.push("EWS 只支持 password/ntlm 认证（Kerberos/OAuth 未承诺）");
    }
  }

  return issues;
}

/** 从不带账号信息的裸 config 里读一项；空白按缺失处理。 */
function readRaw(config: Readonly<Record<string, string>>, key: string): string | null {
  const value = config[key];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
