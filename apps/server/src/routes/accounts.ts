import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context, Hono } from "hono";
import {
  ACCOUNT_DISPLAY_NAME_MAX_LENGTH,
  ACCOUNT_SIGNATURE_MAX_LENGTH,
} from "@mailcollect/shared";
import type {
  Account,
  AccountSendConfig,
  AccountSendInput,
  AccountView,
  AutodiscoverResponse,
  CreateAccountInput,
  DiscoverAccountResponse,
  HealthResponse,
  LlmConfigInput,
  LlmTestInput,
  MailAuthMode,
  MailProvider,
  OnboardingStatusResponse,
  UpdateAccountInput,
  UpdateOnboardingInput,
  UpsertProfileInput,
} from "@mailcollect/shared";
import { API_PREFIX } from "@mailcollect/shared";
import {
  autodiscoverForAccount,
  discoverAutodiscover,
  hasSendConfig,
  MAIL_AUTH_MODES,
  parseAuthMode,
  parseMailProvider,
  readSendConfig,
  redact,
  resolveSmtpPort,
  toMailError,
  validateSendConfig,
  verifySmtp,
} from "@mailcollect/core/mail";
import type {
  AutodiscoverOptions,
  AutodiscoverRequest,
  AutodiscoverResult,
  MailSourceAccount,
  SmtpConfig,
} from "@mailcollect/core/mail";
import { fail } from "./errors.js";
import type { RouteDeps } from "./deps.js";

/**
 * `verifySmtp` 的形状：core 的 `verifySmtp(config)`（T47 落地后直接作为默认值）。
 * 这里先声明形状，测试注入假实现，路由不自己实现 SMTP 握手（避免第二套 SMTP 行为）。
 */
export type SmtpVerifier = (config: SmtpConfig) => Promise<{ ok: boolean; detail?: string }>;

/** Autodiscover 探测的可注入形状（测试用 fixture，不连真实服务器）。 */
export type AutodiscoverProbe = (
  account: MailSourceAccount,
  options?: AutodiscoverOptions,
) => Promise<AutodiscoverResult>;

/** 创建账号前的探测，可注入（同上）。 */
export type DiscoverProbe = (
  request: AutodiscoverRequest,
  options?: AutodiscoverOptions,
) => Promise<AutodiscoverResult>;

export interface AccountsRouteOptions {
  /** SMTP 连接验证；生产接 core `verifySmtp`，测试注入假实现。 */
  readonly verifySmtp?: SmtpVerifier;
  /** 已存在账号的 Autodiscover 重探测。 */
  readonly autodiscover?: AutodiscoverProbe;
  /** 创建账号前的探测。 */
  readonly discover?: DiscoverProbe;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** 解析 JSON body；语法错误当成「请求体非法」而不是 500。 */
const readJson = async (c: Context): Promise<unknown> => {
  try {
    return await c.req.json();
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
};

const invalidInput = (message: string) => {
  const { body, status } = fail("invalid_input", message, 400);
  return { body, status } as const;
};

const MAIL_SEND_HINT =
  "（Graph 发信需要在设备码授权页同意 Mail.Send；缺权限请重新登录并同意该项）";

type SendParse =
  | { readonly kind: "absent" }
  | { readonly kind: "value"; readonly value: AccountSendInput }
  | { readonly kind: "error"; readonly message: string };

/** 只接受已知字段与对应类型；未知字段忽略（shared 类型的超集由这里收窄）。 */
const parseSendInput = (raw: unknown): SendParse => {
  if (raw === undefined || raw === null) return { kind: "absent" };
  if (!isRecord(raw)) return { kind: "error", message: "send 必须是对象" };

  const value: AccountSendInput = {};
  for (const key of ["smtpHost", "smtpUser", "smtpPassword", "ewsUrl"] as const) {
    const field = raw[key];
    if (field === undefined) continue;
    if (typeof field !== "string") return { kind: "error", message: `send.${key} 必须是字符串` };
    value[key] = field;
  }
  const port = raw["smtpPort"];
  if (port !== undefined) {
    if (typeof port !== "number" || !Number.isInteger(port)) {
      return { kind: "error", message: "send.smtpPort 必须是整数" };
    }
    value.smtpPort = port;
  }
  const secure = raw["smtpSecure"];
  if (secure !== undefined) {
    if (typeof secure !== "boolean") return { kind: "error", message: "send.smtpSecure 必须是布尔值" };
    value.smtpSecure = secure;
  }
  const authMode = raw["authMode"];
  if (authMode !== undefined) {
    if (typeof authMode !== "string") return { kind: "error", message: "send.authMode 必须是字符串" };
    const parsed = parseAuthMode(authMode);
    if (parsed === null) {
      return { kind: "error", message: `send.authMode 只能是 ${MAIL_AUTH_MODES.join(" / ")}` };
    }
    value.authMode = parsed;
  }
  // 非密身份设置：字符串 + 长度上限；显式 null = 清除（落成空串，读回为 null）。
  const identityFields = [
    { key: "signature", max: ACCOUNT_SIGNATURE_MAX_LENGTH },
    { key: "displayName", max: ACCOUNT_DISPLAY_NAME_MAX_LENGTH },
  ] as const;
  for (const field of identityFields) {
    const fieldValue = raw[field.key];
    if (fieldValue === undefined) continue;
    if (fieldValue === null) {
      value[field.key] = "";
      continue;
    }
    if (typeof fieldValue !== "string") {
      return { kind: "error", message: `send.${field.key} 必须是字符串（null 表示清除）` };
    }
    if (fieldValue.length > field.max) {
      return { kind: "error", message: `send.${field.key} 超过 ${field.max} 字符上限` };
    }
    value[field.key] = fieldValue;
  }
  return { kind: "value", value };
};

/** 发信字段摊平成 config 字符串表，只为交给 `validateSendConfig` 校验。 */
const flattenSend = (send: AccountSendInput): Record<string, string> => {
  const flat: Record<string, string> = {};
  if (send.smtpHost !== undefined) flat["smtpHost"] = send.smtpHost;
  if (send.smtpPort !== undefined) flat["smtpPort"] = String(send.smtpPort);
  if (send.smtpSecure !== undefined) flat["smtpSecure"] = send.smtpSecure ? "1" : "0";
  if (send.smtpUser !== undefined) flat["smtpUser"] = send.smtpUser;
  if (send.ewsUrl !== undefined) flat["ewsUrl"] = send.ewsUrl;
  if (send.authMode !== undefined) flat["authMode"] = send.authMode;
  if (send.signature !== undefined) flat["signature"] = send.signature;
  if (send.displayName !== undefined) flat["displayName"] = send.displayName;
  // smtpPassword 故意不摊平：它是密文字段，只经 store 的加密列走。
  return flat;
};

const outboundConfig = (
  config: Record<string, string>,
  send: AccountSendInput | undefined,
): Record<string, string> => (send === undefined ? { ...config } : { ...config, ...flattenSend(send) });

/**
 * 输出前的 URL 脱敏：只保留 scheme + host + path。
 *
 * EWS URL 可能来自旧版账号配置或对端 Autodiscover XML，二者都可能内嵌 `user:pass@`；
 * 任何响应/错误体都不得回显凭据（C2 / T54），所以统一在出口处剥离并标记，供调用方提示用户。
 */
interface SafeUrl {
  readonly value: string | null;
  readonly removedCredentials: boolean;
  readonly malformed: boolean;
}

const sanitizeUrlForOutput = (raw: string | null | undefined): SafeUrl => {
  const text = raw?.trim() ?? "";
  if (text === "") return { value: null, removedCredentials: false, malformed: false };
  try {
    const url = new URL(text);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return { value: null, removedCredentials: false, malformed: true };
    }
    return {
      value: `${url.protocol}//${url.host}${url.pathname}`,
      removedCredentials: url.username !== "" || url.password !== "",
      malformed: false,
    };
  } catch (error) {
    if (error instanceof TypeError) {
      return { value: null, removedCredentials: false, malformed: true };
    }
    throw error;
  }
};

/** detail/错误文案的最后一道闸：任何 `scheme://user:pass@` 的 userinfo 都抹掉。 */
const stripUrlCredentials = (text: string): string =>
  text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu, "$1");

const EWS_URL_CREDENTIALS_HINT =
  "（URL 内嵌的凭据已从响应中移除；密码请保存到加密凭据里，或重新手工填写 EWS URL）";

/** 可读错误：已经过 `toMailError` 的类型化映射，且消息已按 secret 擦除。 */
const describeError = (error: unknown, secrets: readonly string[]): string => {
  const mapped = toMailError(error, secrets);
  // toMailError 对已是 MailError 的输入原样返回；这里再擦一次，保证任何来源都不带 secret。
  return `${mapped.code}: ${stripUrlCredentials(redact(mapped.message, secrets))}`;
};

type ParseConfigResult =
  | { readonly kind: "value"; readonly value: Record<string, string> }
  | { readonly kind: "error"; readonly message: string };

const parseConfig = (raw: unknown): ParseConfigResult => {
  if (raw === undefined || raw === null) return { kind: "value", value: {} };
  if (!isRecord(raw)) return { kind: "error", message: "config 必须是对象" };
  const value: Record<string, string> = {};
  for (const [key, field] of Object.entries(raw)) {
    if (typeof field !== "string") return { kind: "error", message: `config.${key} 必须是字符串` };
    value[key] = field;
  }
  return { kind: "value", value };
};

/** 身份文本读回：trim 后空串视为未设置（`null`）。 */
const normalizeIdentityText = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/**
 * 非密身份文本的长度校验（`config.signature` / `config.displayName` 直填路径）。
 * 只报「哪一项超长」，不回显内容。
 */
const identityTextIssue = (config: Readonly<Record<string, string>>): string | null => {
  const signature = config["signature"];
  if (signature !== undefined && signature.length > ACCOUNT_SIGNATURE_MAX_LENGTH) {
    return `config.signature 超过 ${ACCOUNT_SIGNATURE_MAX_LENGTH} 字符上限`;
  }
  const displayName = config["displayName"];
  if (displayName !== undefined && displayName.length > ACCOUNT_DISPLAY_NAME_MAX_LENGTH) {
    return `config.displayName 超过 ${ACCOUNT_DISPLAY_NAME_MAX_LENGTH} 字符上限`;
  }
  return null;
};

const emptySendConfig = (overrides: Partial<AccountSendConfig> = {}): AccountSendConfig => ({
  smtpHost: null,
  smtpPort: null,
  smtpSecure: true,
  smtpUser: null,
  ewsUrl: null,
  authMode: "password",
  ...overrides,
});

/**
 * 身份、账号与外部服务配置：初始化状态、用户档案、邮箱账号（含 Exchange/SMTP
 * 发信字段）、Autodiscover 探测、LLM 供应商凭据。所有密文只写不读。
 *
 * 路由不实现 SMTP 握手：发信验证经 {@link SmtpVerifier} 注入（生产为 core 的
 * `verifySmtp`），保证树里只有一套 SMTP 行为。
 */
export function registerAccounts(
  app: Hono,
  deps: RouteDeps,
  options: AccountsRouteOptions = {},
): void {
  const { store, services, version } = deps;

  const hasSmtpPassword = (accountId: string): boolean => {
    // 只为判断「是否已存发信密码」而短暂解密，值立即丢弃、绝不进入响应。
    const loaded = store.getAccountWithSmtpSecret(accountId);
    return (loaded?.smtpPassword ?? "").length > 0;
  };

  const toView = (account: Account): AccountView => {
    const withSecret = store.getAccountWithSecret(account.id);
    const sendConfig = readSendConfig(account);
    return {
      id: account.id,
      provider: account.provider,
      label: account.label,
      email: account.email,
      enabled: account.enabled,
      hasSecret: Boolean(withSecret?.secret),
      lastSyncAt: store.getLastSync(account.id),
      createdAt: account.createdAt,
      send: hasSendConfig(sendConfig) ? sendConfig : null,
      hasSmtpPassword: hasSmtpPassword(account.id),
      // 签名/显示名与发信连接解耦：Graph 账号 send=null 也能带签名。
      signature: normalizeIdentityText(sendConfig.signature),
      displayName: normalizeIdentityText(sendConfig.displayName),
    };
  };

  /** 发信端验证：静态配置校验 + 可注入的 SMTP 连接验证；EWS 随收信验证。 */
  const verifyOutbound = async (
    account: Account,
    secrets: readonly string[],
  ): Promise<{ ok: boolean; detail: string } | null> => {
    const sendConfig = readSendConfig(account);
    if (!hasSendConfig(sendConfig)) return null;

    const issues = validateSendConfig(account.config, account.provider);
    if (issues.length > 0) return { ok: false, detail: `发信配置有问题：${issues.join("；")}` };
    if (sendConfig.smtpHost === null) {
      return { ok: true, detail: "发信走 EWS CreateItem，已随收信验证检查" };
    }

    const smtpPassword = store.getAccountWithSmtpSecret(account.id)?.smtpPassword ?? "";
    // 生产用 core 的 verifySmtp（唯一一套 SMTP 握手）；测试注入假实现。
    const verifier = options.verifySmtp ?? verifySmtp;
    const config: SmtpConfig = {
      host: sendConfig.smtpHost,
      port: resolveSmtpPort(sendConfig),
      secure: sendConfig.smtpSecure,
      user: sendConfig.smtpUser,
      password: smtpPassword,
    };
    try {
      const result = await verifier(config);
      return {
        ok: result.ok,
        detail: redact(result.detail ?? (result.ok ? "SMTP 连接成功" : "SMTP 验证失败"), [
          ...secrets,
          smtpPassword,
        ]),
      };
    } catch (error) {
      return { ok: false, detail: describeError(error, [...secrets, smtpPassword]) };
    }
  };

  /* -------------------------------- onboarding ------------------------------- */

  app.get(`${API_PREFIX}/onboarding`, (c) => {
    const state: OnboardingStatusResponse = store.getInitState();
    return c.json(state);
  });

  app.put(`${API_PREFIX}/onboarding`, async (c) => {
    const raw = await readJson(c);
    if (!isRecord(raw)) return c.json(invalidInput("请求体必须是 JSON 对象").body, 400);
    const patch: UpdateOnboardingInput = {};
    if (raw["completed"] !== undefined) {
      if (typeof raw["completed"] !== "boolean") {
        return c.json(invalidInput("completed 必须是布尔值").body, 400);
      }
      patch.completed = raw["completed"];
    }
    if (raw["skipped"] !== undefined) {
      if (typeof raw["skipped"] !== "boolean") {
        return c.json(invalidInput("skipped 必须是布尔值").body, 400);
      }
      patch.skipped = raw["skipped"];
    }
    // store.setInitState 在首次完成/跳过时幂等地播种两条种子规则（AC-03）。
    const state: OnboardingStatusResponse = store.setInitState(patch);
    return c.json(state);
  });

  /* ---------------------------------- health --------------------------------- */

  app.get(`${API_PREFIX}/health`, (c) => {
    const body: HealthResponse = {
      ok: true,
      version,
      dbPath: "sqlite",
      hasProfile: store.getProfile() !== null,
      accountCount: store.listAccounts().length,
    };
    return c.json(body);
  });

  /* --------------------------------- profile -------------------------------- */

  app.get(`${API_PREFIX}/profile`, (c) => c.json({ profile: store.getProfile() }));

  app.put(`${API_PREFIX}/profile`, async (c) => {
    const input = (await c.req.json()) as UpsertProfileInput;
    if (!input?.displayName?.trim()) {
      const { body, status } = fail("invalid_input", "姓名必填", 400);
      return c.json(body, status as 400);
    }
    const profile = store.upsertProfile({
      displayName: input.displayName.trim(),
      aliases: Array.isArray(input.aliases) ? input.aliases : [],
      emails: Array.isArray(input.emails) ? input.emails : [],
      timezone: input.timezone || "Asia/Shanghai",
    });
    return c.json({ profile });
  });

  /* -------------------------------- accounts -------------------------------- */

  app.get(`${API_PREFIX}/accounts`, (c) =>
    c.json({ items: store.listAccounts().map(toView) }),
  );

  app.post(`${API_PREFIX}/accounts`, async (c) => {
    const raw = await readJson(c);
    if (!isRecord(raw)) return c.json(invalidInput("请求体必须是 JSON 对象").body, 400);

    const provider: MailProvider | null = parseMailProvider(
      typeof raw["provider"] === "string" ? raw["provider"] : null,
    );
    if (provider === null) return c.json(invalidInput("provider 必须是 imap/pop3/graph/ews 之一").body, 400);
    const email = typeof raw["email"] === "string" ? raw["email"].trim() : "";
    if (email === "") return c.json(invalidInput("email 必填").body, 400);

    const parsedConfig = parseConfig(raw["config"]);
    if (parsedConfig.kind === "error") return c.json(invalidInput(parsedConfig.message).body, 400);
    const config: Record<string, string> = { ...parsedConfig.value };

    const parsedSend = parseSendInput(raw["send"]);
    if (parsedSend.kind === "error") return c.json(invalidInput(parsedSend.message).body, 400);
    const send = parsedSend.kind === "value" ? parsedSend.value : undefined;

    const label = typeof raw["label"] === "string" && raw["label"].trim() !== "" ? raw["label"].trim() : email;
    const secret = typeof raw["secret"] === "string" ? raw["secret"] : "";

    if (provider === "graph") {
      // MSAL needs a writable cache path; the UI cannot know the data directory,
      // so the server derives a stable per-mailbox one instead of failing later
      // with "Graph 配置缺少 cachePath".
      if (!config["clientId"]) {
        return c.json(
          invalidInput("Graph 账号需要 clientId（在你自己的 Azure 应用注册里获取）").body,
          400,
        );
      }
      if (!config["cachePath"] && deps.dataDir) {
        const safe = email.replace(/[^a-zA-Z0-9._-]/g, "_");
        const dir = join(deps.dataDir, "graph-cache");
        mkdirSync(dir, { recursive: true });
        config["cachePath"] = join(dir, `${safe}.json`);
      }
    }

    const outbound = outboundConfig(config, send);
    // 明文凭据字段、非法端口/认证方式、URL 内嵌 userinfo 都在这里拒绝（C2）。
    const issues = validateSendConfig(outbound, provider);
    if (issues.length > 0) return c.json(invalidInput(issues.join("；")).body, 400);
    const identityIssue = identityTextIssue(outbound);
    if (identityIssue !== null) return c.json(invalidInput(identityIssue).body, 400);

    const account = store.createAccount({
      provider,
      label,
      email,
      config,
      secret,
      ...(send === undefined ? {} : { send }),
    } satisfies CreateAccountInput);
    return c.json({ account: toView(account) }, 201);
  });

  app.patch(`${API_PREFIX}/accounts/:id`, async (c) => {
    const accountId = c.req.param("id");
    const existing = store.getAccountWithSecret(accountId);
    if (!existing) {
      const { body, status } = fail("not_found", "账号不存在", 404);
      return c.json(body, status as 404);
    }

    const raw = await readJson(c);
    if (!isRecord(raw)) return c.json(invalidInput("请求体必须是 JSON 对象").body, 400);

    const patch: UpdateAccountInput = {};
    if (raw["label"] !== undefined) {
      if (typeof raw["label"] !== "string" || raw["label"].trim() === "") {
        return c.json(invalidInput("label 必须是非空字符串").body, 400);
      }
      patch.label = raw["label"].trim();
    }
    if (raw["enabled"] !== undefined) {
      if (typeof raw["enabled"] !== "boolean") {
        return c.json(invalidInput("enabled 必须是布尔值").body, 400);
      }
      patch.enabled = raw["enabled"];
    }
    if (raw["secret"] !== undefined) {
      if (typeof raw["secret"] !== "string") {
        return c.json(invalidInput("secret 必须是字符串").body, 400);
      }
      patch.secret = raw["secret"];
    }
    if (raw["config"] !== undefined) {
      const parsedConfig = parseConfig(raw["config"]);
      if (parsedConfig.kind === "error") return c.json(invalidInput(parsedConfig.message).body, 400);
      patch.config = parsedConfig.value;
    }
    const parsedSend = parseSendInput(raw["send"]);
    if (parsedSend.kind === "error") return c.json(invalidInput(parsedSend.message).body, 400);
    if (parsedSend.kind === "value") patch.send = parsedSend.value;

    // PATCH 与 POST 用同一条校验（明文凭据、端口、认证方式、URL userinfo、身份文本长度）。
    const outbound = outboundConfig(patch.config ?? existing.account.config, patch.send);
    const issues = validateSendConfig(outbound, existing.account.provider);
    if (issues.length > 0) return c.json(invalidInput(issues.join("；")).body, 400);
    const identityIssue = identityTextIssue(outbound);
    if (identityIssue !== null) return c.json(invalidInput(identityIssue).body, 400);

    const account = store.updateAccount(accountId, patch);
    if (!account) {
      const { body, status } = fail("not_found", "账号不存在", 404);
      return c.json(body, status as 404);
    }
    return c.json({ account: toView(account) });
  });

  app.delete(`${API_PREFIX}/accounts/:id`, (c) => {
    const ok = store.deleteAccount(c.req.param("id"));
    if (!ok) {
      const { body, status } = fail("not_found", "账号不存在", 404);
      return c.json(body, status as 404);
    }
    return c.json({ ok: true });
  });

  app.post(`${API_PREFIX}/accounts/discover`, async (c) => {
    const raw = await readJson(c);
    if (!isRecord(raw)) return c.json(invalidInput("请求体必须是 JSON 对象").body, 400);
    const email = typeof raw["email"] === "string" ? raw["email"].trim() : "";
    if (email === "") return c.json(invalidInput("email 必填").body, 400);
    const secret = typeof raw["secret"] === "string" ? raw["secret"] : "";

    const hintRaw = raw["providerHint"];
    let hint: MailProvider | null = null;
    if (hintRaw !== undefined) {
      if (typeof hintRaw !== "string") return c.json(invalidInput("providerHint 必须是字符串").body, 400);
      hint = parseMailProvider(hintRaw);
      if (hint === null) {
        return c.json(invalidInput("providerHint 必须是 imap/pop3/graph/ews 之一").body, 400);
      }
    }

    const respond = (overrides: Partial<DiscoverAccountResponse>): DiscoverAccountResponse => ({
      ok: false,
      kind: "unknown",
      provider: null,
      config: {},
      send: null,
      detail: "",
      ...overrides,
    });

    if (hint === "imap" || hint === "pop3") {
      return c.json(
        respond({
          provider: hint,
          detail: `${hint.toUpperCase()} 没有标准自动发现协议：请手工填写服务器地址；Autodiscover 只在 Exchange 域可用`,
        }),
      );
    }
    if (hint === "graph") {
      return c.json(
        respond({
          ok: true,
          kind: "exchange-online",
          provider: "graph",
          send: emptySendConfig({ authMode: "device-code" }),
          detail: "已按你的选择使用 Microsoft Graph 设备码登录（无需 Autodiscover）",
        }),
      );
    }

    const discover = options.discover ?? discoverAutodiscover;
    try {
      const result = await discover({ email, secret });
      const kind = result.kind === "graph" ? "exchange-online" : "exchange-onprem";
      const provider: MailProvider = result.kind === "graph" ? "graph" : "ews";
      const detail = stripUrlCredentials(redact(result.detail, [secret]));
      if (provider === "graph") {
        return c.json(
          respond({
            ok: true,
            kind,
            provider,
            send: emptySendConfig({ authMode: "device-code" }),
            detail,
          }),
        );
      }
      // 对端 XML 可能把 `user:pass@` 塞进 EwsUrl：剥离后才允许出现在响应里（T54-F2）。
      const ews = sanitizeUrlForOutput(result.ewsUrl);
      if (ews.value === null) {
        return c.json(
          respond({
            ok: false,
            kind,
            provider: "ews",
            detail: `${detail}；Autodiscover 返回的 EWS 地址不可用，请手工填写 EWS URL（原值不回显）`,
          }),
        );
      }
      return c.json(
        respond({
          ok: true,
          kind,
          provider,
          config: { ewsUrl: ews.value, authMode: "password" },
          send: emptySendConfig({ ewsUrl: ews.value, authMode: "password" }),
          detail: ews.removedCredentials ? `${detail}${EWS_URL_CREDENTIALS_HINT}` : detail,
        }),
      );
    } catch (error) {
      return c.json(respond({ detail: describeError(error, [secret]) }));
    }
  });

  app.post(`${API_PREFIX}/accounts/:id/autodiscover`, async (c) => {
    const loaded = store.getAccountWithSecret(c.req.param("id"));
    if (!loaded) {
      const { body, status } = fail("not_found", "账号不存在", 404);
      return c.json(body, status as 404);
    }
    // 旧版 v1 行可能把 user:pass 写进 config.ewsUrl：探测前先换成脱敏值，
    // 响应也只回 scheme+host+path，绝不回显原值（C2 / T54-F1）。
    const configuredUrl = sanitizeUrlForOutput(loaded.account.config["ewsUrl"]);
    if (configuredUrl.malformed) {
      return c.json({
        ok: false,
        kind: "unknown",
        ewsUrl: null,
        authMode: null,
        detail:
          "账号配置里的 ewsUrl 不是合法的 http(s) 地址：请重新手工填写（原值可能含凭据，已从响应中隐去）",
      } satisfies AutodiscoverResponse);
    }
    const sendView = readSendConfig(loaded.account);
    const probeConfig: Record<string, string> = { ...loaded.account.config };
    if (sendView.ewsUrl === null) delete probeConfig["ewsUrl"];
    else probeConfig["ewsUrl"] = sendView.ewsUrl;

    const account: MailSourceAccount = {
      id: loaded.account.id,
      provider: loaded.account.provider,
      email: loaded.account.email,
      config: probeConfig,
      secret: loaded.secret,
    };
    const probe = options.autodiscover ?? autodiscoverForAccount;
    try {
      const result = await probe(account);
      const kind = result.kind === "graph" ? "exchange-online" : "exchange-onprem";
      const authMode: MailAuthMode =
        result.kind === "graph" ? "device-code" : readSendConfig(account).authMode;
      const resultUrl = sanitizeUrlForOutput(result.ewsUrl);
      const detail = stripUrlCredentials(redact(result.detail, [loaded.secret]));
      const stripped = configuredUrl.removedCredentials || resultUrl.removedCredentials;
      return c.json({
        ok: true,
        kind,
        ewsUrl: result.kind === "graph" ? null : resultUrl.value,
        authMode,
        detail: stripped ? `${detail}${EWS_URL_CREDENTIALS_HINT}` : detail,
      } satisfies AutodiscoverResponse);
    } catch (error) {
      return c.json({
        ok: false,
        kind: "unknown",
        ewsUrl: null,
        authMode: null,
        detail: describeError(error, [loaded.secret]),
      } satisfies AutodiscoverResponse);
    }
  });

  app.post(`${API_PREFIX}/accounts/:id/verify`, async (c) => {
    const accountId = c.req.param("id");
    const loaded = store.getAccountWithSecret(accountId);
    if (!loaded) {
      // 保持 v1 端点语义：200/400 + {ok,detail}，而不是换成 404 错误体。
      return c.json({ ok: false, detail: "账号不存在" }, 400);
    }

    let inbound: { ok: boolean; detail: string };
    try {
      inbound = await services.verifyAccount(accountId);
    } catch (error) {
      // 缺 clientId / ewsUrl 等 not_configured 在这里收敛成可读结果（AC-06）。
      inbound = { ok: false, detail: describeError(error, [loaded.secret]) };
    }

    const outbound = await verifyOutbound(loaded.account, [loaded.secret]);
    const ok = inbound.ok && (outbound?.ok ?? true);
    const parts = [outbound === null ? inbound.detail : `收信：${inbound.detail}；发信：${outbound.detail}`];
    if (loaded.account.provider === "graph") parts.push(MAIL_SEND_HINT);
    return c.json(
      { ok, detail: stripUrlCredentials(redact(parts.join(""), [loaded.secret])) },
      ok ? 200 : 400,
    );
  });

  app.post(`${API_PREFIX}/accounts/:id/login`, async (c) => {
    const accountId = c.req.param("id");
    const loaded = store.getAccountWithSecret(accountId);
    if (!loaded) {
      const { body, status } = fail("not_found", "账号不存在", 404);
      return c.json(body, status as 404);
    }
    void services.loginAccount(accountId, deps.events.emit).catch((error: unknown) => {
      const base = error instanceof Error ? error.message : "登录失败";
      const hint = loaded.account.provider === "graph" ? MAIL_SEND_HINT : "";
      deps.events.emit({
        type: "device-login",
        data: {
          accountId,
          ok: false,
          detail: stripUrlCredentials(redact(`${base}${hint}`, [loaded.secret])),
        },
      });
    });
    return c.json({ ok: true }, 202);
  });

  /* ----------------------------------- llm ---------------------------------- */

  app.post(`${API_PREFIX}/llm/test`, async (c) => {
    const input = (await c.req.json()) as LlmTestInput;
    const result = await services.testLlm(input);
    return c.json(result);
  });

  app.get(`${API_PREFIX}/llm/configs`, (c) => c.json({ items: store.listLlmConfigs() }));

  app.post(`${API_PREFIX}/llm/configs`, async (c) => {
    const input = (await c.req.json()) as LlmConfigInput;
    if (!input?.baseUrl || !input.model) {
      const { body, status } = fail("invalid_input", "baseUrl 与 model 必填", 400);
      return c.json(body, status as 400);
    }
    const config = store.upsertLlmConfig(input);
    return c.json({ config }, 201);
  });

  app.post(`${API_PREFIX}/llm/configs/:id/default`, (c) => {
    const ok = store.setDefaultLlmConfig(c.req.param("id"));
    if (!ok) {
      const { body, status } = fail("not_found", "配置不存在", 404);
      return c.json(body, status as 404);
    }
    return c.json({ ok: true });
  });

  app.delete(`${API_PREFIX}/llm/configs/:id`, (c) => {
    const ok = store.deleteLlmConfig(c.req.param("id"));
    if (!ok) {
      const { body, status } = fail("not_found", "配置不存在", 404);
      return c.json(body, status as 404);
    }
    return c.json({ ok: true });
  });
}

