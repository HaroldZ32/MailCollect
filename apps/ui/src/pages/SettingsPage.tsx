import { useEffect, useState } from "react";
import clsx from "clsx";
import type {
  ACCOUNT_DISPLAY_NAME_MAX_LENGTH,
  ACCOUNT_SIGNATURE_MAX_LENGTH,
  AccountSendConfig,
  AccountSendInput,
  AccountView,
  CreateAccountInput,
  InitState,
  LlmConfigInput,
  LlmConfigView,
  LlmProtocol,
  LlmTestInput,
  LlmTestResponse,
  MailAuthMode,
  MailProvider,
  UpsertProfileInput,
  UserProfile,
  VerifyAccountResponse,
} from "@mailcollect/shared";
import {
  api,
  apiBaseLabel,
  clearStoredToken,
  hasInjectedRuntime,
  hasStoredToken,
  isApiError,
  storeToken,
  type ClearableAccountSendInput,
} from "../lib/api";
import { formatDateTime, hueFor, initials } from "../lib/format";
import { GlassCard } from "../components/GlassCard";
import { Icon } from "../components/Icon";
import {
  DATA_CHANGED_EVENT,
  ONBOARDING_CHANGED_EVENT,
  notifyDataChanged,
  requestShellRoute,
  type DataChangedScope,
} from "../components/OnboardingWizard";
import type { ConnectionMode, SaveResult } from "../lib/useMailData";

const TIMEZONES: readonly string[] = [
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Asia/Singapore",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Moscow",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "UTC",
];

const PROVIDER_LABEL: Record<MailProvider, string> = {
  imap: "IMAP",
  pop3: "POP3",
  graph: "Microsoft Graph",
  ews: "Exchange (EWS)",
};

const DEFAULT_PORT: Record<MailProvider, string> = {
  imap: "993",
  pop3: "995",
  graph: "",
  // 本地 Exchange 没有可填的入站端口：EWS 走 https 端点（隐式 TLS 443），
  // 端口由 ewsUrl 决定，所以这里留空而不是猜 25/587。
  ews: "",
};

/**
 * 签名 / 显示名长度上限：数值来自 shared 的 `ACCOUNT_SIGNATURE_MAX_LENGTH` /
 * `ACCOUNT_DISPLAY_NAME_MAX_LENGTH`（服务端校验用同一常量）。这里用 `typeof`
 * 标注而不是运行时 import —— `ui → shared(types only)`（AGENTS.md §7），
 * 而 shared 一旦改数值，下面两行就会在 typecheck 里报错，不会悄悄漂移。
 */
const SIGNATURE_MAX_LENGTH: typeof ACCOUNT_SIGNATURE_MAX_LENGTH = 2000;
const DISPLAY_NAME_MAX_LENGTH: typeof ACCOUNT_DISPLAY_NAME_MAX_LENGTH = 200;

/** SMTP 发信端口的两个标准档位（与 core/account.ts 的推断一致）。 */
const SMTP_PORT_IMPLICIT_TLS = "465";
const SMTP_PORT_STARTTLS = "587";

const AUTH_MODE_LABEL: Record<MailAuthMode, string> = {
  password: "密码（Basic）",
  ntlm: "NTLM",
  oauth2: "OAuth2",
  "device-code": "设备码",
};

interface LlmPreset {
  readonly id: string;
  readonly name: string;
  readonly protocol: LlmProtocol;
  readonly baseUrl: string;
  readonly model: string;
  readonly keyHint: string;
}

const LLM_PRESETS: readonly LlmPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    keyHint: "sk-…",
  },
  {
    id: "kimi",
    name: "Kimi 月之暗面",
    protocol: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    keyHint: "sk-…",
  },
  {
    id: "qwen",
    name: "通义千问",
    protocol: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    keyHint: "sk-…",
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    keyHint: "sk-…",
  },
  {
    id: "anthropic-compat",
    name: "Claude（OpenAI 兼容层）",
    protocol: "openai-compatible",
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-5",
    keyHint: "sk-ant-…",
  },
  {
    id: "ollama",
    name: "Ollama 本地",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b",
    keyHint: "本地无需 Key",
  },
  {
    id: "gateway",
    name: "自定义网关",
    protocol: "openai-compatible",
    baseUrl: "",
    model: "",
    keyHint: "one-api / LiteLLM 地址",
  },
];

const MODE_LABEL: Record<ConnectionMode, string> = {
  loading: "连接中",
  live: "已连接",
  demo: "演示数据",
  offline: "未连接",
};

function buildAccountConfig(
  provider: MailProvider,
  host: string,
  port: string,
  user: string,
  email: string,
  clientId: string,
  tenant: string,
): Record<string, string> {
  if (provider === "graph") {
    const config: Record<string, string> = { clientId: clientId.trim() };
    if (tenant.trim() !== "") config["tenant"] = tenant.trim();
    return config;
  }
  if (provider === "ews") return {};
  const config: Record<string, string> = {
    host: host.trim(),
    user: user.trim() === "" ? email : user.trim(),
    mailbox: "INBOX",
  };
  if (port.trim() !== "") config["port"] = port.trim();
  if (provider === "imap") config["tls"] = "true";
  return config;
}

/** 发信聚合草稿：全部字段来自表单，密码只在这里短暂停留，保存后立即清空。 */
interface SendDraft {
  readonly smtpHost: string;
  readonly smtpPort: string;
  readonly smtpSecure: boolean;
  readonly smtpUser: string;
  readonly smtpPassword: string;
  readonly ewsUrl: string;
  readonly authMode: MailAuthMode;
  /** 纯文本签名；空串 = 清除（PATCH 写 null）。 */
  readonly signature: string;
  /** From 显示名；空串 = 清除（PATCH 写 null）。 */
  readonly displayName: string;
}

const EMPTY_SEND_DRAFT: SendDraft = {
  smtpHost: "",
  smtpPort: "",
  smtpSecure: true,
  smtpUser: "",
  smtpPassword: "",
  ewsUrl: "",
  authMode: "password",
  signature: "",
  displayName: "",
};

/**
 * 发信字段 → `AccountSendInput`。非密文字段同时进 `config`（由 store 合并），
 * 密码只走 `smtpPassword` 的加密列，绝不写进 config、也绝不回显。
 * 全空时返回 undefined，避免给纯收信账号写一堆空字段。
 */
function buildSendInput(
  provider: MailProvider,
  draft: SendDraft,
): { readonly send: AccountSendInput | undefined; readonly error: string | null } {
  const smtpHost = draft.smtpHost.trim();
  const smtpUser = draft.smtpUser.trim();
  const ewsUrl = draft.ewsUrl.trim();
  const rawPort = draft.smtpPort.trim();

  let smtpPort: number | undefined;
  if (rawPort !== "") {
    const parsed = Number.parseInt(rawPort, 10);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535 || String(parsed) !== rawPort) {
      return { send: undefined, error: "SMTP 端口必须是 1-65535 之间的整数" };
    }
    smtpPort = parsed;
  }

  const send: AccountSendInput = {};
  if (smtpHost !== "") send.smtpHost = smtpHost;
  if (smtpPort !== undefined) send.smtpPort = smtpPort;
  if (smtpHost !== "") send.smtpSecure = draft.smtpSecure;
  if (smtpUser !== "") send.smtpUser = smtpUser;
  if (draft.smtpPassword !== "") send.smtpPassword = draft.smtpPassword;
  if (ewsUrl !== "") send.ewsUrl = ewsUrl;
  if (provider === "ews" || smtpHost !== "") send.authMode = draft.authMode;
  // 身份文本：非空才带（创建路径不带清除语义）。
  if (draft.signature.trim() !== "") send.signature = draft.signature;
  if (draft.displayName.trim() !== "") send.displayName = draft.displayName;

  return { send: Object.keys(send).length === 0 ? undefined : send, error: null };
}

/**
 * PATCH 用的身份载荷：空串显式写 `null`（服务端「null = 清除」→ 落空串 → 读回 null），
 * 与读回语义一致；只有非空才写文本。连接字段沿用 `buildSendInput` 的结果。
 */
function withClearableIdentity(
  base: AccountSendInput | undefined,
  draft: SendDraft,
): ClearableAccountSendInput {
  const signature = draft.signature.trim();
  const displayName = draft.displayName.trim();
  return {
    ...(base ?? {}),
    signature: signature === "" ? null : signature,
    displayName: displayName === "" ? null : displayName,
  };
}

function describeFailure(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "未知错误";
}

/** 本地已保存的发信视图：`undefined` = 没有本地覆盖，`null` = 已清空。 */
function currentSend(
  account: AccountView,
  override: AccountSendConfig | null | undefined,
): AccountSendConfig | null {
  return override === undefined ? (account.send ?? null) : override;
}

/** 身份覆盖：PATCH 成功后立即生效的本地快照（避免依赖 props 刷新时机）。 */
interface IdentitySnapshot {
  readonly signature: string | null;
  readonly displayName: string | null;
}

/** 服务端返回的账号视图 → 编辑草稿；密码位置永远留空，签名/显示名取自读回值。 */
function sendDraftFrom(
  account: AccountView,
  sendOverride: AccountSendConfig | null | undefined,
  identityOverride: IdentitySnapshot | undefined,
): SendDraft {
  const send = currentSend(account, sendOverride);
  const identity: IdentitySnapshot = identityOverride ?? {
    signature: account.signature ?? null,
    displayName: account.displayName ?? null,
  };
  return {
    smtpHost: send?.smtpHost ?? "",
    smtpPort: send?.smtpPort === null || send?.smtpPort === undefined ? "" : String(send.smtpPort),
    smtpSecure: send?.smtpSecure ?? true,
    smtpUser: send?.smtpUser ?? "",
    smtpPassword: "",
    ewsUrl: send?.ewsUrl ?? "",
    authMode: send?.authMode ?? "password",
    signature: identity.signature ?? "",
    displayName: identity.displayName ?? "",
  };
}

function sendSummary(
  account: AccountView,
  override: AccountSendConfig | null | undefined,
  identity: IdentitySnapshot | undefined,
): string {
  const send = currentSend(account, override);
  const parts: string[] = [];
  if (send !== null && send.ewsUrl !== null) parts.push(`EWS ${send.ewsUrl}`);
  if (send !== null && send.smtpHost !== null) {
    const port = send.smtpPort ?? (send.smtpSecure ? SMTP_PORT_IMPLICIT_TLS : SMTP_PORT_STARTTLS);
    parts.push(`SMTP ${send.smtpHost}:${port}`);
  }
  // 「发信已配置」只看连接字段：仅填签名/显示名不算配好连接。
  const connection =
    parts.length === 0
      ? "发信：未配置（只收不发）"
      : `发信：${parts.join(" · ")} · 认证 ${AUTH_MODE_LABEL[send?.authMode ?? "password"]} · ${
          account.hasSmtpPassword === true ? "SMTP 密码已保存" : "缺 SMTP 密码"
        }`;
  const signature = identity === undefined ? (account.signature ?? null) : identity.signature;
  const displayName = identity === undefined ? (account.displayName ?? null) : identity.displayName;
  const identityText = `签名 ${signature === null || signature.trim() === "" ? "未设置" : `${signature.length} 字`} · 显示名 ${
    displayName === null || displayName.trim() === "" ? "账号地址" : displayName
  }`;
  return `${connection} · ${identityText}`;
}

interface SendDraftFormProps {
  readonly draft: SendDraft;
  readonly provider: MailProvider;
  readonly idPrefix: string;
  readonly onChange: (next: SendDraft) => void;
}

/**
 * 发信字段控件：创建账号与「账号内二次编辑」共用同一套控件和文案，
 * 避免两处各写一遍 SMTP/EWS 字段。密码永远是 `type=password` 且不回填。
 */
function SendDraftForm({ draft, provider, idPrefix, onChange }: SendDraftFormProps) {
  const patch = (next: Partial<SendDraft>): void => onChange({ ...draft, ...next });
  return (
    <>
      {provider === "ews" ? (
        <>
          <div className="form-row form-row--full">
            <label className="field-label" htmlFor={`${idPrefix}-ews-url`}>
              EWS 端点
            </label>
            <input
              id={`${idPrefix}-ews-url`}
              className="input"
              value={draft.ewsUrl}
              placeholder="https://mail.corp.com/EWS/Exchange.asmx"
              onChange={(event) => patch({ ewsUrl: event.target.value })}
            />
            <span className="field-hint">
              https 走隐式 TLS（443），端口由端点决定；URL 里不能带用户名或密码——凭据只进加密密文列。
            </span>
          </div>
          <div className="form-row">
            <label className="field-label" htmlFor={`${idPrefix}-auth-mode`}>
              认证方式
            </label>
            <select
              id={`${idPrefix}-auth-mode`}
              className="select"
              value={draft.authMode}
              onChange={(event) => patch({ authMode: event.target.value as MailAuthMode })}
            >
              <option value="password">密码（Basic）</option>
              <option value="ntlm">NTLM</option>
            </select>
            <span className="field-hint">本地 Exchange 只支持密码 / NTLM；OAuth 走 Graph 账号。</span>
          </div>
        </>
      ) : null}

      {/* 身份设置：签名与显示名是**非密**字段，与发信连接解耦（Graph 账号也适用）。 */}
      <div className="form-row form-row--full">
        <span className="field-label">签名与显示名（非密，纯文本）</span>
        <span className="field-hint">
          签名由服务端在发送时追加，撰写页的「附加账号签名」勾选只负责开/关；清空并保存会写回 null。
        </span>
      </div>

      <div className="form-row">
        <label className="field-label" htmlFor={`${idPrefix}-display-name`}>
          From 显示名
        </label>
        <input
          id={`${idPrefix}-display-name`}
          className="input"
          value={draft.displayName}
          placeholder="只填显示名，地址固定为账号地址"
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          onChange={(event) => patch({ displayName: event.target.value })}
        />
        <span className="field-hint">
          {draft.displayName.length} / {DISPLAY_NAME_MAX_LENGTH} · 留空则只用账号地址
        </span>
      </div>

      <div className="form-row form-row--full">
        <label className="field-label" htmlFor={`${idPrefix}-signature`}>
          纯文本签名
        </label>
        <textarea
          id={`${idPrefix}-signature`}
          className="textarea"
          value={draft.signature}
          rows={5}
          placeholder={"——\n李四\nlisi@corp.example"}
          maxLength={SIGNATURE_MAX_LENGTH}
          onChange={(event) => patch({ signature: event.target.value })}
        />
        <span className="field-hint">
          {draft.signature.length} / {SIGNATURE_MAX_LENGTH} · 纯文本，不渲染 HTML；空 = 不追加
        </span>
      </div>

      {provider === "graph" ? null : (
        <>
      <div className="form-row form-row--full">
        <span className="field-label">发信（SMTP，可选）</span>
        <span className="field-hint">
          {provider === "ews"
            ? "EWS 端点本身就能发信，SMTP 只是备用通道；"
            : "IMAP / POP3 必须配 SMTP 才能发信；"}
          不填就是只收不发，密码与收信密码分开加密。
        </span>
      </div>

      <div className="form-row">
        <label className="field-label" htmlFor={`${idPrefix}-smtp-host`}>
          SMTP 服务器
        </label>
        <input
          id={`${idPrefix}-smtp-host`}
          className="input"
          value={draft.smtpHost}
          placeholder="smtp.example.com"
          onChange={(event) => patch({ smtpHost: event.target.value })}
        />
      </div>

      <div className="form-row">
        <label className="field-label" htmlFor={`${idPrefix}-smtp-port`}>
          SMTP 端口
        </label>
        <input
          id={`${idPrefix}-smtp-port`}
          className="input"
          inputMode="numeric"
          value={draft.smtpPort}
          placeholder={`${SMTP_PORT_IMPLICIT_TLS}（SSL）/ ${SMTP_PORT_STARTTLS}（STARTTLS）`}
          onChange={(event) => patch({ smtpPort: event.target.value })}
        />
        <label
          htmlFor={`${idPrefix}-smtp-secure`}
          style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}
        >
          <input
            id={`${idPrefix}-smtp-secure`}
            type="checkbox"
            checked={draft.smtpSecure}
            onChange={(event) => {
              const next = event.target.checked;
              patch({
                smtpSecure: next,
                smtpPort:
                  draft.smtpPort.trim() === ""
                    ? next
                      ? SMTP_PORT_IMPLICIT_TLS
                      : SMTP_PORT_STARTTLS
                    : draft.smtpPort,
              });
            }}
          />
          <span className="field-hint">隐式 TLS（465）；取消勾选则按 STARTTLS（587）</span>
        </label>
      </div>

      <div className="form-row">
        <label className="field-label" htmlFor={`${idPrefix}-smtp-user`}>
          SMTP 用户名
        </label>
        <input
          id={`${idPrefix}-smtp-user`}
          className="input"
          value={draft.smtpUser}
          placeholder="通常与收信用户名相同"
          autoComplete="off"
          onChange={(event) => patch({ smtpUser: event.target.value })}
        />
      </div>

      <div className="form-row form-row--full">
        <label className="field-label" htmlFor={`${idPrefix}-smtp-password`}>
          SMTP 密码
        </label>
        <input
          id={`${idPrefix}-smtp-password`}
          className="input"
          type="password"
          value={draft.smtpPassword}
          placeholder="只提交一次，保存后不回显"
          autoComplete="new-password"
          onChange={(event) => patch({ smtpPassword: event.target.value })}
        />
        <span className="field-hint">与收信密码分开加密；接口只返回 hasSmtpPassword 布尔。</span>
      </div>
        </>
      )}
    </>
  );
}

function avatarBackground(seed: string): string {
  const hue = hueFor(seed);
  return `linear-gradient(140deg, hsl(${hue + 6} 92% 70%), hsl(${hue} 80% 54%))`;
}

export interface SettingsPageProps {
  readonly mode: ConnectionMode;
  readonly profile: UserProfile | null;
  readonly accounts: readonly AccountView[];
  readonly llmConfigs: readonly LlmConfigView[];
  readonly onSaveProfile: (input: UpsertProfileInput) => Promise<boolean>;
  readonly onAddAccount: (input: CreateAccountInput) => Promise<SaveResult>;
  readonly onRemoveAccount: (accountId: string) => Promise<boolean>;
  readonly onVerifyAccount: (accountId: string) => Promise<VerifyAccountResponse>;
  readonly onSaveLlm: (input: LlmConfigInput) => Promise<boolean>;
  readonly onSetDefaultLlm: (configId: string) => Promise<boolean>;
  readonly onRemoveLlm: (configId: string) => Promise<boolean>;
  readonly onTestLlm: (input: LlmTestInput) => Promise<LlmTestResponse>;
  readonly onRetry: () => void;
  readonly canLoginDevice: boolean;
  readonly graphLoggedIn: Readonly<Record<string, boolean>>;
  readonly onLoginAccount: (accountId: string) => Promise<boolean>;
}

export function SettingsPage({
  mode,
  profile,
  accounts,
  llmConfigs,
  onSaveProfile,
  onAddAccount,
  onRemoveAccount,
  onVerifyAccount,
  onSaveLlm,
  onSetDefaultLlm,
  onRemoveLlm,
  onTestLlm,
  onRetry,
  canLoginDevice,
  graphLoggedIn,
  onLoginAccount,
}: SettingsPageProps) {
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [aliases, setAliases] = useState<readonly string[]>(profile?.aliases ?? []);
  const [profileEmails, setProfileEmails] = useState<readonly string[]>(profile?.emails ?? []);
  const [timezone, setTimezone] = useState(profile?.timezone ?? "Asia/Shanghai");
  const [aliasDraft, setAliasDraft] = useState("");
  const [emailDraft, setEmailDraft] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);

  const [showAddAccount, setShowAddAccount] = useState(false);
  const [provider, setProvider] = useState<MailProvider>("imap");
  const [accountLabel, setAccountLabel] = useState("");
  const [accountEmail, setAccountEmail] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(DEFAULT_PORT.imap);
  const [user, setUser] = useState("");
  const [secret, setSecret] = useState("");
  const [clientId, setClientId] = useState("");
  const [tenant, setTenant] = useState("");
  const [sendDraft, setSendDraft] = useState<SendDraft>(EMPTY_SEND_DRAFT);
  const [discovering, setDiscovering] = useState(false);
  const [discoverNote, setDiscoverNote] = useState<string | null>(null);
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [verifyBusyId, setVerifyBusyId] = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<Readonly<Record<string, VerifyAccountResponse>>>({});

  // 发信设置的二次编辑（PATCH /accounts/:id）：草稿按账号展开，密码位置永远留空。
  const [sendEditorId, setSendEditorId] = useState<string | null>(null);
  const [sendEditorDraft, setSendEditorDraft] = useState<SendDraft>(EMPTY_SEND_DRAFT);
  const [sendEditorBusy, setSendEditorBusy] = useState(false);
  const [sendEditorError, setSendEditorError] = useState<string | null>(null);
  const [sendEditorNotice, setSendEditorNotice] = useState<string | null>(null);
  const [sendOverrides, setSendOverrides] = useState<Readonly<Record<string, AccountSendConfig | null>>>({});
  const [identityOverrides, setIdentityOverrides] = useState<Readonly<Record<string, IdentitySnapshot>>>({});

  // 初始化状态（重新打开向导入口 + 未配置提示联动）。
  const [initState, setInitState] = useState<InitState | null>(null);
  const [initLoading, setInitLoading] = useState(false);

  // 旧 profile：v1→v1.1 迁移后的只读快照，可导出 JSON。
  const [legacyProfile, setLegacyProfile] = useState<UserProfile | null>(null);
  const [legacyError, setLegacyError] = useState<string | null>(null);

  const [presetId, setPresetId] = useState<string>("deepseek");
  const [llmLabel, setLlmLabel] = useState("DeepSeek");
  const [protocol, setProtocol] = useState<LlmProtocol>("openai-compatible");
  const [baseUrl, setBaseUrl] = useState("https://api.deepseek.com/v1");
  const [model, setModel] = useState("deepseek-chat");
  const [apiKey, setApiKey] = useState("");
  const [llmBusy, setLlmBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<LlmTestResponse | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);

  const [tokenDraft, setTokenDraft] = useState("");
  const [tokenStored, setTokenStored] = useState(hasStoredToken());

  useEffect(() => {
    if (profile === null) return;
    setDisplayName(profile.displayName);
    setAliases(profile.aliases);
    setProfileEmails(profile.emails);
    setTimezone(profile.timezone);
  }, [profile]);

  const loadInitState = (signal?: AbortSignal): void => {
    if (mode !== "live") return;
    setInitLoading(true);
    void api.onboarding
      .get(signal === undefined ? {} : { signal })
      .then((state) => setInitState(state))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setInitState(null);
      })
      .finally(() => setInitLoading(false));
  };

  // 初始化状态与旧 profile 都是「服务端才知道」的事实：只在真实连接下取，
  // 演示/离线时静默降级为空，不阻塞设置页的其它功能。
  useEffect(() => {
    if (mode !== "live") {
      setInitState(null);
      setLegacyProfile(null);
      setLegacyError(null);
      return;
    }
    const controller = new AbortController();
    loadInitState(controller.signal);
    void api.profile
      .get()
      .then((serverProfile) => {
        if (controller.signal.aborted) return;
        setLegacyProfile(serverProfile);
        setLegacyError(null);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setLegacyProfile(null);
        setLegacyError(describeFailure(error));
      });
    const onChanged = (): void => loadInitState();
    window.addEventListener(ONBOARDING_CHANGED_EVENT, onChanged);
    // 向导保存档案后旧 profile 卡也要立刻更新（本页是 keep-alive 面板，不会自动重挂载）。
    const onDataChanged = (event: Event): void => {
      const scope = (event as CustomEvent<DataChangedScope>).detail;
      if (scope?.profile !== true) return;
      void api.profile
        .get()
        .then((next) => {
          if (!controller.signal.aborted) setLegacyProfile(next);
        })
        .catch(() => {
          // 保持旧值，等下一次事件或重新挂载。
        });
    };
    window.addEventListener(DATA_CHANGED_EVENT, onDataChanged);
    return () => {
      controller.abort();
      window.removeEventListener(ONBOARDING_CHANGED_EVENT, onChanged);
      window.removeEventListener(DATA_CHANGED_EVENT, onDataChanged);
    };
    // mode 决定是否拉取；loadInitState 只读 api，不依赖渲染态。
  }, [mode]);

  const timezones = TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES];

  const addAlias = (): void => {
    const value = aliasDraft.trim();
    if (value === "" || aliases.includes(value)) return;
    setAliases([...aliases, value]);
    setAliasDraft("");
  };

  const addEmail = (): void => {
    const value = emailDraft.trim().toLowerCase();
    if (value === "" || !value.includes("@") || profileEmails.includes(value)) return;
    setProfileEmails([...profileEmails, value]);
    setEmailDraft("");
  };

  /** 创建账号前的 Autodiscover 探测：只填非密文字段，失败不阻塞，允许手填。 */
  const runDiscover = (): void => {
    const email = accountEmail.trim();
    if (!email.includes("@")) {
      setAccountError("先填邮箱地址，再跑自动发现");
      return;
    }
    setAccountError(null);
    setDiscoverNote(null);
    setDiscovering(true);
    void api.accounts
      .discover({
        email,
        providerHint: provider,
        ...(secret === "" ? {} : { secret }),
      })
      .then((result) => {
        setDiscoverNote(result.detail === "" ? "自动发现完成" : result.detail);
        if (result.provider !== null) {
          setProvider(result.provider);
          setPort(DEFAULT_PORT[result.provider]);
        }
        const discoveredHost = result.config["host"];
        if (discoveredHost !== undefined) setHost(discoveredHost);
        const discoveredPort = result.config["port"];
        if (discoveredPort !== undefined) setPort(discoveredPort);
        const discoveredUrl = result.config["ewsUrl"];
        if (discoveredUrl !== undefined) {
          setSendDraft((previous) => ({ ...previous, ewsUrl: discoveredUrl }));
        }
        if (result.send !== null) {
          setSendDraft((previous) => ({
            ...previous,
            ewsUrl: result.send?.ewsUrl ?? previous.ewsUrl,
            smtpHost: result.send?.smtpHost ?? previous.smtpHost,
            smtpPort:
              result.send?.smtpPort === null || result.send?.smtpPort === undefined
                ? previous.smtpPort
                : String(result.send.smtpPort),
            smtpSecure: result.send?.smtpSecure ?? previous.smtpSecure,
            smtpUser: result.send?.smtpUser ?? previous.smtpUser,
            authMode: result.send?.authMode ?? previous.authMode,
          }));
        }
      })
      .catch((error: unknown) => {
        // 探测失败是常态（内网封锁 / 无 DNS），只提示可手填，不阻塞创建。
        setDiscoverNote(null);
        setAccountError(`自动发现失败（可手填）：${describeFailure(error)}`);
      })
      .finally(() => setDiscovering(false));
  };

  const openSendEditor = (account: AccountView): void => {
    if (sendEditorId === account.id) {
      setSendEditorId(null);
      return;
    }
    setSendEditorDraft(sendDraftFrom(account, sendOverrides[account.id], identityOverrides[account.id]));
    setSendEditorId(account.id);
    setSendEditorError(null);
    setSendEditorNotice(null);
  };

  const saveSendEditor = (account: AccountView): void => {
    const built = buildSendInput(account.provider, sendEditorDraft);
    if (built.error !== null) {
      setSendEditorError(built.error);
      return;
    }
    setSendEditorError(null);
    setSendEditorNotice(null);
    setSendEditorBusy(true);
    // 身份字段总是随 PATCH 提交：空串显式写 null（清空语义），非空写文本。
    void api.accounts
      .update(account.id, { send: withClearableIdentity(built.send, sendEditorDraft) })
      .then((updated) => {
        setSendOverrides((previous) => ({ ...previous, [account.id]: updated.send ?? null }));
        setIdentityOverrides((previous) => ({
          ...previous,
          [account.id]: {
            signature: updated.signature ?? null,
            displayName: updated.displayName ?? null,
          },
        }));
        notifyDataChanged({ accounts: true });
        setSendEditorNotice("发信与身份设置已保存");
        // 密码一提交就清空本地草稿，DOM 里不再留任何明文。
        setSendEditorDraft((previous) => ({ ...previous, smtpPassword: "" }));
      })
      .catch((error: unknown) => setSendEditorError(describeFailure(error)))
      .finally(() => setSendEditorBusy(false));
  };

  const exportProfileJson = (): void => {
    const payload = legacyProfile;
    if (payload === null) return;
    const text = JSON.stringify(payload, null, 2);
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "mailcollect-profile.json";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const reopenWizard = (): void => {
    requestShellRoute("onboarding");
  };

  const submitProfile = (): void => {
    if (displayName.trim() === "") return;
    setProfileBusy(true);
    void onSaveProfile({
      displayName: displayName.trim(),
      aliases: [...aliases],
      emails: [...profileEmails],
      timezone,
    })
      .then((ok) => {
        if (ok) notifyDataChanged({ profile: true });
      })
      .finally(() => setProfileBusy(false));
  };

  const submitAccount = (): void => {
    if (!accountEmail.includes("@")) {
      setAccountError("请填写有效的邮箱地址");
      return;
    }
    if (provider === "graph" && clientId.trim() === "") {
      setAccountError("Graph 账号需要 clientId（在你自己的 Azure 应用注册里获取）");
      return;
    }
    if (provider === "ews" && sendDraft.ewsUrl.trim() === "") {
      setAccountError(
        "本地 Exchange 账号需要 EWS URL：先跑自动发现，或手填 https://<主机>/EWS/Exchange.asmx（https 走隐式 TLS 443）",
      );
      return;
    }
    const built = buildSendInput(provider, sendDraft);
    if (built.error !== null) {
      setAccountError(built.error);
      return;
    }
    setAccountError(null);
    setAccountBusy(true);
    void onAddAccount({
      provider,
      label: accountLabel.trim() === "" ? accountEmail.trim() : accountLabel.trim(),
      email: accountEmail.trim(),
      config: buildAccountConfig(provider, host, port, user, accountEmail, clientId, tenant),
      secret: provider === "graph" ? "" : secret,
      ...(built.send === undefined ? {} : { send: built.send }),
    })
      .then((result) => {
        if (!result.ok) {
          setAccountError(result.message ?? "保存账号失败");
          return;
        }
        notifyDataChanged({ accounts: true });
        setAccountLabel("");
        setAccountEmail("");
        setHost("");
        setPort(DEFAULT_PORT.imap);
        setUser("");
        setSecret("");
        setClientId("");
        setTenant("");
        setSendDraft(EMPTY_SEND_DRAFT);
        setDiscoverNote(null);
        setShowAddAccount(false);
      })
      .finally(() => setAccountBusy(false));
  };

  const verifyAccount = (accountId: string): void => {
    setVerifyBusyId(accountId);
    void onVerifyAccount(accountId)
      .then((result) => {
        setVerifyResults((previous) => ({ ...previous, [accountId]: result }));
      })
      .finally(() => setVerifyBusyId(null));
  };

  const removeAccount = (account: AccountView): void => {
    const confirmed = window.confirm(`移除账号「${account.label}」？已同步的邮件会保留。`);
    if (!confirmed) return;
    void onRemoveAccount(account.id).then((ok) => {
      if (ok) notifyDataChanged({ accounts: true });
    });
  };

  const applyPreset = (preset: LlmPreset): void => {
    setPresetId(preset.id);
    setLlmLabel(preset.name);
    setProtocol(preset.protocol);
    setBaseUrl(preset.baseUrl);
    setModel(preset.model);
    setApiKey("");
    setTestResult(null);
    setLlmError(null);
  };

  const submitLlm = (): void => {
    if (baseUrl.trim() === "" || model.trim() === "") {
      setLlmError("baseURL 与模型名都必填");
      return;
    }
    setLlmError(null);
    setLlmBusy(true);
    void onSaveLlm({
      label: llmLabel.trim() === "" ? model.trim() : llmLabel.trim(),
      protocol,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      ...(apiKey === "" ? {} : { apiKey }),
      isDefault: llmConfigs.length === 0,
    })
      .then((ok) => {
        if (!ok) return;
        notifyDataChanged({ llm: true });
        setApiKey("");
      })
      .finally(() => setLlmBusy(false));
  };

  const runTest = (): void => {
    setTesting(true);
    setTestResult(null);
    void onTestLlm({
      protocol,
      baseUrl: baseUrl.trim(),
      model: model.trim(),
      ...(apiKey === "" ? {} : { apiKey }),
    })
      .then((result) => setTestResult(result))
      .finally(() => setTesting(false));
  };

  const saveToken = (): void => {
    if (tokenDraft.trim() === "") return;
    storeToken(tokenDraft.trim());
    setTokenDraft("");
    setTokenStored(true);
    onRetry();
  };

  const clearToken = (): void => {
    clearStoredToken();
    setTokenStored(false);
    onRetry();
  };

  const tokenSource = hasInjectedRuntime()
    ? "Electron 每次启动注入"
    : tokenStored
      ? "本机 localStorage"
      : "开发默认 dev-local-token";

  const missingLabels: string[] = [];
  if (profile === null) missingLabels.push("用户档案");
  if (accounts.length === 0) missingLabels.push("邮箱账号");
  if (llmConfigs.length === 0) missingLabels.push("LLM 供应商");

  const initChipClass =
    initState === null
      ? "chip--muted"
      : initState.completed
        ? "chip--success"
        : initState.skipped
          ? "chip--warning"
          : "chip--accent";
  const initLabel = initLoading
    ? "读取中…"
    : initState === null
      ? "状态未知"
      : initState.completed
        ? "已完成"
        : initState.skipped
          ? "已跳过"
          : "未完成";

  return (
    <div className="settings">
      {/* 初始化与引导：重开向导的唯一入口 + 未配置提示联动（C3）。 */}
      <GlassCard>
        <div className="card-head">
          <div className="card-head-icon is-iris">
            <Icon name="spark" size={17} />
          </div>
          <div className="card-head-text">
            <h2 className="card-title">初始化与引导</h2>
            <p className="card-sub">
              三步向导可随时重开：用户档案 · 邮箱账号 · LLM 供应商。向导只写「完成/跳过」标记，
              不清空任何已有数据，也不提供重置入口。
            </p>
          </div>
          <div className="section-spacer" style={{ flex: 1 }} />
          <span className={clsx("chip", initChipClass)}>{initLabel}</span>
        </div>

        <div className="connection-list">
          <div className="connection-row">
            <span className="connection-key">用户档案</span>
            <span className={clsx("chip", profile === null ? "chip--warning" : "chip--success")}>
              {profile === null ? "未配置" : "已配置"}
            </span>
          </div>
          <div className="connection-row">
            <span className="connection-key">邮箱账号</span>
            <span className={clsx("chip", accounts.length === 0 ? "chip--warning" : "chip--success")}>
              {accounts.length === 0 ? "未配置" : `${accounts.length} 个`}
            </span>
          </div>
          <div className="connection-row">
            <span className="connection-key">LLM 供应商</span>
            <span className={clsx("chip", llmConfigs.length === 0 ? "chip--warning" : "chip--success")}>
              {llmConfigs.length === 0 ? "未配置" : `${llmConfigs.length} 个`}
            </span>
          </div>
        </div>

        <div className="settings-note">
          {missingLabels.length === 0
            ? "三项都已配置：收件、规则分类与待办抽取可以工作。"
            : `还缺：${missingLabels.join("、")}。可以重开向导补齐，也可以留在本页手动填写——两者写的是同一份配置。`}
        </div>

        <div className="form-actions">
          <button type="button" className="btn btn--primary" onClick={reopenWizard}>
            <Icon name="spark" size={14} />
            重新打开初始化向导
          </button>
          <span className="field-hint">「跳过」之后不再自动全屏，只保留这里的入口与侧栏未配置提示。</span>
        </div>
      </GlassCard>

      <div className="settings-grid">
        <GlassCard>
          <div className="card-head">
            <div className="card-head-icon">
              <Icon name="user" size={17} />
            </div>
            <div className="card-head-text">
              <h2 className="card-title">用户档案</h2>
              <p className="card-sub">姓名与别名用于判定「点名给我的」，时区用于解析时间短语。</p>
            </div>
          </div>

          <div className="form-grid">
            <div className="form-row">
              <label className="field-label" htmlFor="profile-name">
                姓名
              </label>
              <input
                id="profile-name"
                className="input"
                value={displayName}
                placeholder="例如：张三"
                onChange={(event) => setDisplayName(event.target.value)}
              />
            </div>

            <div className="form-row">
              <label className="field-label" htmlFor="profile-zone">
                IANA 时区
              </label>
              <select
                id="profile-zone"
                className="select"
                value={timezone}
                onChange={(event) => setTimezone(event.target.value)}
              >
                {timezones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone}
                  </option>
                ))}
              </select>
            </div>

            <div className="form-row form-row--full">
              <span className="field-label">姓名别名</span>
              <div className="alias-editor">
                <div className="alias-list">
                  {aliases.length === 0 ? (
                    <span className="field-hint">还没有别名，可以加「张 三」「San Zhang」这类写法。</span>
                  ) : (
                    aliases.map((alias) => (
                      <span className="alias-pill" key={alias}>
                        {alias}
                        <button
                          type="button"
                          className="alias-remove"
                          aria-label={`移除别名 ${alias}`}
                          onClick={() => setAliases(aliases.filter((item) => item !== alias))}
                        >
                          <Icon name="close" size={10} />
                        </button>
                      </span>
                    ))
                  )}
                </div>
                <div className="inline-add">
                  <input
                    className="input"
                    value={aliasDraft}
                    placeholder="输入一个别名后回车"
                    aria-label="新增别名"
                    onChange={(event) => setAliasDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addAlias();
                      }
                    }}
                  />
                  <button type="button" className="btn btn--sm" onClick={addAlias}>
                    <Icon name="plus" size={13} />
                    添加
                  </button>
                </div>
              </div>
            </div>

            <div className="form-row form-row--full">
              <span className="field-label">我的邮箱地址</span>
              <div className="alias-editor">
                <div className="alias-list">
                  {profileEmails.length === 0 ? (
                    <span className="field-hint">至少填一个常用邮箱，用于区分群发与点名。</span>
                  ) : (
                    profileEmails.map((email) => (
                      <span className="alias-pill" key={email}>
                        {email}
                        <button
                          type="button"
                          className="alias-remove"
                          aria-label={`移除邮箱 ${email}`}
                          onClick={() => setProfileEmails(profileEmails.filter((item) => item !== email))}
                        >
                          <Icon name="close" size={10} />
                        </button>
                      </span>
                    ))
                  )}
                </div>
                <div className="inline-add">
                  <input
                    className="input"
                    type="email"
                    value={emailDraft}
                    placeholder="name@example.com"
                    aria-label="新增邮箱"
                    onChange={(event) => setEmailDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addEmail();
                      }
                    }}
                  />
                  <button type="button" className="btn btn--sm" onClick={addEmail}>
                    <Icon name="plus" size={13} />
                    添加
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="btn btn--primary"
              disabled={profileBusy || displayName.trim() === ""}
              onClick={submitProfile}
            >
              <Icon name="check" size={14} />
              {profileBusy ? "保存中…" : "保存档案"}
            </button>
            <span className="field-hint">保存后会用于之后的抽取；已抽取的历史记录不会自动重跑。</span>
          </div>
        </GlassCard>

        <GlassCard>
          <div className="card-head">
            <div className="card-head-icon">
              <Icon name="server" size={17} />
            </div>
            <div className="card-head-text">
              <h2 className="card-title">连接与令牌</h2>
              <p className="card-sub">界面只走 HTTP/SSE；令牌优先由 Electron 注入。</p>
            </div>
          </div>

          <div className="connection-list">
            <div className="connection-row">
              <span className="connection-key">接口地址</span>
              <span className="code">{apiBaseLabel()}</span>
            </div>
            <div className="connection-row">
              <span className="connection-key">令牌来源</span>
              <span className="code">{tokenSource}</span>
            </div>
            <div className="connection-row">
              <span className="connection-key">当前状态</span>
              <span className={clsx("chip", mode === "live" && "chip--success", mode === "demo" && "chip--warning", mode === "offline" && "chip--danger")}>
                {MODE_LABEL[mode]}
              </span>
            </div>
          </div>

          <div className="form-row" style={{ marginTop: 14 }}>
            <label className="field-label" htmlFor="token-input">
              覆盖访问令牌
            </label>
            <div className="inline-add">
              <input
                id="token-input"
                className="input"
                type="password"
                value={tokenDraft}
                placeholder="输入服务端令牌，保存后不回显"
                autoComplete="off"
                onChange={(event) => setTokenDraft(event.target.value)}
              />
              <button type="button" className="btn btn--primary btn--sm" disabled={tokenDraft.trim() === ""} onClick={saveToken}>
                保存并重连
              </button>
            </div>
            <span className="field-hint">
              令牌只写入本机 localStorage，不会回显；Electron 注入时以注入值为准。
            </span>
          </div>

          <div className="danger-zone">
            <button type="button" className="btn btn--sm" onClick={onRetry}>
              <Icon name="refresh" size={13} />
              重新连接
            </button>
            <button type="button" className="btn btn--sm btn--quiet" disabled={!tokenStored} onClick={clearToken}>
              清除本机令牌
            </button>
          </div>

          <div className="settings-note">
            {mode === "demo"
              ? "当前展示的是演示数据：启动 apps/server 后点「重新连接」即可切到真实数据，演示数据不会写入任何存储。"
              : "服务端除 /api/health 外都需要 Bearer 令牌；断网时已同步的数据仍可浏览。"}
          </div>
        </GlassCard>

        <GlassCard>
          <div className="card-head">
            <div className="card-head-icon">
              <Icon name="user" size={17} />
            </div>
            <div className="card-head-text">
              <h2 className="card-title">旧 profile（只读）</h2>
              <p className="card-sub">
                v1 → v1.1 迁移会把旧档案原样保留；这里只读展示服务端当前记录，可导出为 JSON。
              </p>
            </div>
            <div className="section-spacer" style={{ flex: 1 }} />
            <button
              type="button"
              className="btn btn--sm"
              disabled={legacyProfile === null}
              onClick={exportProfileJson}
            >
              <Icon name="paperclip" size={13} />
              导出 JSON
            </button>
          </div>

          {mode !== "live" ? (
            <div className="settings-note">演示/离线状态读不到服务端档案；连上服务端后这里显示只读快照。</div>
          ) : legacyError !== null ? (
            <div className="test-result is-error">
              <Icon name="alert" size={13} />
              读取档案失败：{legacyError}
            </div>
          ) : legacyProfile === null ? (
            <div className="settings-note">服务端还没有档案：向导第①步保存后会出现在这里。</div>
          ) : (
            <>
              <div className="connection-list">
                <div className="connection-row">
                  <span className="connection-key">显示名</span>
                  <span className="code">{legacyProfile.displayName}</span>
                </div>
                <div className="connection-row">
                  <span className="connection-key">时区</span>
                  <span className="code">{legacyProfile.timezone}</span>
                </div>
                <div className="connection-row">
                  <span className="connection-key">姓名别名</span>
                  <span className="code">
                    {legacyProfile.aliases.length === 0 ? "—" : legacyProfile.aliases.join(" / ")}
                  </span>
                </div>
                <div className="connection-row">
                  <span className="connection-key">邮箱</span>
                  <span className="code">
                    {legacyProfile.emails.length === 0 ? "—" : legacyProfile.emails.join(" / ")}
                  </span>
                </div>
              </div>
              <details style={{ marginTop: 12 }}>
                <summary className="field-hint" style={{ cursor: "pointer" }}>
                  查看 JSON 原文
                </summary>
                <pre className="code" style={{ whiteSpace: "pre-wrap", marginTop: 8 }}>
                  {JSON.stringify(legacyProfile, null, 2)}
                </pre>
              </details>
              <div className="settings-note">
                这份快照只有档案字段（显示名 / 别名 / 邮箱 / 时区），不含任何凭据；导出文件名为
                mailcollect-profile.json。
              </div>
            </>
          )}
        </GlassCard>
      </div>

      <GlassCard>
        <div className="card-head">
          <div className="card-head-icon">
            <Icon name="users" size={17} />
          </div>
          <div className="card-head-text">
            <h2 className="card-title">邮箱账号</h2>
            <p className="card-sub">密码/令牌在服务端加密落盘，这里只看到「已保存凭据」的状态。</p>
          </div>
          <div className="section-spacer" style={{ flex: 1 }} />
          <button type="button" className="btn btn--sm" onClick={() => setShowAddAccount((previous) => !previous)}>
            <Icon name="plus" size={13} />
            {showAddAccount ? "收起表单" : "添加账号"}
          </button>
        </div>

        {showAddAccount ? (
          <div className="alias-editor" style={{ marginBottom: 14 }}>
            <div className="form-grid">
              <div className="form-row">
                <label className="field-label" htmlFor="account-provider">
                  协议
                </label>
                <select
                  id="account-provider"
                  className="select"
                  value={provider}
                  onChange={(event) => {
                    const next = event.target.value as MailProvider;
                    setProvider(next);
                    setPort(DEFAULT_PORT[next]);
                    setAccountError(null);
                    setDiscoverNote(null);
                  }}
                >
                  <option value="imap">IMAP</option>
                  <option value="pop3">POP3（只读拉取）</option>
                  <option value="graph">Microsoft Graph</option>
                  <option value="ews">本地 Exchange（EWS）</option>
                </select>
              </div>

              <div className="form-row">
                <label className="field-label" htmlFor="account-email">
                  邮箱地址
                </label>
                <input
                  id="account-email"
                  className="input"
                  type="email"
                  value={accountEmail}
                  placeholder="name@example.com"
                  onChange={(event) => setAccountEmail(event.target.value)}
                />
              </div>

              <div className="form-row">
                <label className="field-label" htmlFor="account-label">
                  显示名称
                </label>
                <input
                  id="account-label"
                  className="input"
                  value={accountLabel}
                  placeholder="例如：公司邮箱"
                  onChange={(event) => setAccountLabel(event.target.value)}
                />
              </div>

              {provider === "graph" ? (
                <>
                  <div className="form-row form-row--full">
                    <label className="field-label" htmlFor="account-client-id">
                      Client ID（应用程序(客户端) ID）
                    </label>
                    <input
                      id="account-client-id"
                      className="input"
                      value={clientId}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      onChange={(event) => setClientId(event.target.value)}
                    />
                    <span className="field-hint">
                      在 Azure 门户 → 应用注册 → 你的应用里复制「应用程序(客户端) ID」；需要允许公共客户端流程。{" "}
                      <a href="https://portal.azure.com" target="_blank" rel="noreferrer">
                        打开 Azure 门户 ↗
                      </a>
                    </span>
                  </div>
                  <div className="form-row">
                    <label className="field-label" htmlFor="account-tenant">
                      租户 ID（可选）
                    </label>
                    <input
                      id="account-tenant"
                      className="input"
                      value={tenant}
                      placeholder="common"
                      onChange={(event) => setTenant(event.target.value)}
                    />
                    <span className="field-hint">
                      留空按 common 处理；单租户应用可填 Directory (tenant) ID。
                    </span>
                  </div>
                  <div className="form-row form-row--full">
                    <span className="field-hint">
                      保存后在账号列表点「登录 Microsoft」，用设备码完成授权；这里不需要粘贴令牌。
                    </span>
                  </div>
                </>
              ) : null}

              {provider === "graph" || provider === "ews" ? null : (
                <>
                  <div className="form-row">
                    <label className="field-label" htmlFor="account-host">
                      服务器
                    </label>
                    <input
                      id="account-host"
                      className="input"
                      value={host}
                      placeholder={provider === "imap" ? "imap.example.com" : "pop.example.com"}
                      onChange={(event) => setHost(event.target.value)}
                    />
                  </div>
                  <div className="form-row">
                    <label className="field-label" htmlFor="account-port">
                      端口
                    </label>
                    <input
                      id="account-port"
                      className="input"
                      inputMode="numeric"
                      value={port}
                      onChange={(event) => setPort(event.target.value)}
                    />
                  </div>
                  <div className="form-row">
                    <label className="field-label" htmlFor="account-user">
                      用户名
                    </label>
                    <input
                      id="account-user"
                      className="input"
                      value={user}
                      placeholder="留空则使用邮箱地址"
                      onChange={(event) => setUser(event.target.value)}
                    />
                  </div>
                </>
              )}

              {provider === "graph" ? null : (
                <div className="form-row form-row--full">
                  <label className="field-label" htmlFor="account-secret">
                    密码 / 应用专用密码
                  </label>
                  <input
                    id="account-secret"
                    className="input"
                    type="password"
                    value={secret}
                    placeholder="只提交给服务端，保存后不回显"
                    autoComplete="new-password"
                    onChange={(event) => setSecret(event.target.value)}
                  />
                  <span className="field-hint">凭据由服务端 AES-256-GCM 加密落盘，接口只返回 hasSecret。</span>
                </div>
              )}

              <SendDraftForm
                draft={sendDraft}
                provider={provider}
                idPrefix="account"
                onChange={setSendDraft}
              />
            </div>

            {accountError === null ? null : (
              <div className="test-result is-error">
                <Icon name="alert" size={14} />
                {accountError}
              </div>
            )}

            {discoverNote === null ? null : (
              <div className="test-result is-ok">
                <Icon name="check" size={14} />
                {discoverNote}
              </div>
            )}

            <div className="form-actions">
              <button type="button" className="btn btn--primary btn--sm" disabled={accountBusy} onClick={submitAccount}>
                <Icon name="plus" size={13} />
                {accountBusy ? "保存中…" : "保存账号"}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                title="按邮箱域名跑 Autodiscover，识别 Exchange / Office 365；失败可手填"
                disabled={discovering || accountEmail.trim() === ""}
                onClick={runDiscover}
              >
                <Icon name="search" size={13} />
                {discovering ? "探测中…" : "自动发现"}
              </button>
              <span className="field-hint">
                {provider === "graph"
                  ? "保存后在账号列表点「登录 Microsoft」完成设备码授权；cachePath 由服务端自动推导。"
                  : provider === "ews"
                    ? "自动发现失败不影响保存：手填 EWS 端点即可；发信可以用同一个 EWS 端点。"
                    : "自动发现只对 Exchange 域有效；IMAP/POP3 手填服务器即可。验证失败不会删除账号。"}
              </span>
            </div>
          </div>
        ) : null}

        {accounts.length === 0 ? (
          <div className="settings-note">还没有邮箱账号。添加一个 IMAP / POP3 / Graph 账号后即可同步与抽取。</div>
        ) : (
          <>
            {accounts.some((account) => account.provider === "graph") && !canLoginDevice ? (
              <div className="settings-note">
                Microsoft 设备码登录需要服务端连接与实时事件流；当前是演示/未连接状态，点击「登录 Microsoft」会提示需要连接服务端。
              </div>
            ) : null}
            <div className="account-list">
            {accounts.map((account) => {
              const result = verifyResults[account.id];
              return (
                <div className="account-row" key={account.id}>
                  <div className="avatar avatar--sm" style={{ background: avatarBackground(account.label) }}>
                    {initials(account.label)}
                  </div>
                  <div className="account-main">
                    <div className="account-title">
                      <span className={`provider provider--${account.provider}`}>{PROVIDER_LABEL[account.provider]}</span>
                      {account.label}
                      {account.enabled ? null : <span className="chip chip--warning">已停用</span>}
                      <span className={account.hasSecret ? "chip chip--success" : "chip chip--warning"}>
                        {account.hasSecret ? "已保存凭据" : "缺少凭据"}
                      </span>
                      {account.provider === "graph" && graphLoggedIn[account.id] === true ? (
                        <span className="chip chip--accent">已登录</span>
                      ) : null}
                    </div>
                    <div className="account-meta">
                      {account.email} · 上次同步 {account.lastSyncAt === null ? "从未" : formatDateTime(account.lastSyncAt)}
                    </div>
                    <div className="account-meta">
                      {sendSummary(account, sendOverrides[account.id], identityOverrides[account.id])}
                    </div>
                    {result === undefined ? null : (
                      <div className={clsx("test-result", result.ok ? "is-ok" : "is-error")}>
                        <Icon name={result.ok ? "check" : "alert"} size={13} />
                        {result.detail}
                      </div>
                    )}
                    {sendEditorId === account.id ? (
                      <div className="alias-editor" style={{ marginTop: 10 }}>
                        <div className="form-grid">
                          <SendDraftForm
                            draft={sendEditorDraft}
                            provider={account.provider}
                            idPrefix={`send-${account.id}`}
                            onChange={setSendEditorDraft}
                          />
                        </div>
                        {sendEditorError === null ? null : (
                          <div className="test-result is-error">
                            <Icon name="alert" size={13} />
                            {sendEditorError}
                          </div>
                        )}
                        {sendEditorNotice === null ? null : (
                          <div className="test-result is-ok">
                            <Icon name="check" size={13} />
                            {sendEditorNotice}
                          </div>
                        )}
                        <div className="form-actions">
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            disabled={sendEditorBusy}
                            onClick={() => saveSendEditor(account)}
                          >
                            <Icon name="check" size={13} />
                            {sendEditorBusy ? "保存中…" : "保存发信设置"}
                          </button>
                          <button
                            type="button"
                            className="btn btn--sm btn--quiet"
                            onClick={() => setSendEditorId(null)}
                          >
                            收起
                          </button>
                          <span className="field-hint">
                            只 PATCH 这些字段；密码留空 = 保持原密文不变，填了才轮换；
                            签名 / 显示名清空保存 = 写回 null。
                          </span>
                        </div>
                      </div>
                    ) : null}
                  </div>
                  <div className="account-actions">
                    <button
                      type="button"
                      className="btn btn--sm"
                      title="签名 / 显示名 / SMTP / EWS 设置"
                      onClick={() => openSendEditor(account)}
                    >
                      <Icon name="settings" size={13} />
                      签名 / 发信
                    </button>
                    {account.provider === "graph" ? (
                      <button
                        type="button"
                        className="btn btn--sm"
                        title={canLoginDevice ? "使用 Microsoft 设备码登录" : "需要连接服务端与实时事件流"}
                        onClick={() => {
                          void onLoginAccount(account.id);
                        }}
                      >
                        <Icon name="key" size={13} />
                        登录 Microsoft
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--sm"
                        disabled={verifyBusyId === account.id}
                        onClick={() => verifyAccount(account.id)}
                      >
                        {verifyBusyId === account.id ? "验证中…" : "验证"}
                      </button>
                    )}
                    <button type="button" className="btn btn--sm btn--danger" onClick={() => removeAccount(account)}>
                      <Icon name="trash" size={13} />
                      移除
                    </button>
                  </div>
                </div>
              );
            })}
            </div>
          </>
        )}
      </GlassCard>

      <GlassCard>
        <div className="card-head">
          <div className="card-head-icon is-iris">
            <Icon name="spark" size={17} />
          </div>
          <div className="card-head-text">
            <h2 className="card-title">LLM 供应商</h2>
            <p className="card-sub">预设或自定义 baseURL 都走同一套结构化输出校验；Key 只在保存/测试时提交一次。</p>
          </div>
        </div>

        {llmConfigs.length === 0 ? null : (
          <div className="llm-list">
            {llmConfigs.map((config) => (
              <div className="account-row" key={config.id}>
                <div className="broadcast-icon">
                  <Icon name="key" size={15} />
                </div>
                <div className="account-main">
                  <div className="account-title">
                    {config.label}
                    {config.isDefault ? <span className="chip chip--accent">默认</span> : null}
                    <span className="chip">{config.protocol === "openai-compatible" ? "OpenAI 兼容" : "Anthropic"}</span>
                    <span className={config.hasKey ? "chip chip--success" : "chip"}>
                      {config.hasKey ? "Key 已保存" : "未保存 Key"}
                    </span>
                  </div>
                  <div className="account-meta">
                    {config.baseUrl} · {config.model}
                  </div>
                </div>
                <div className="account-actions">
                  {config.isDefault ? null : (
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={() => {
                        void onSetDefaultLlm(config.id).then((ok) => {
                          if (ok) notifyDataChanged({ llm: true });
                        });
                      }}
                    >
                      设为默认
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn--sm btn--danger"
                    onClick={() => {
                      void onRemoveLlm(config.id).then((ok) => {
                        if (ok) notifyDataChanged({ llm: true });
                      });
                    }}
                  >
                    <Icon name="trash" size={13} />
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="preset-grid">
          {LLM_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              className={clsx("preset", preset.id === presetId && "is-active")}
              onClick={() => applyPreset(preset)}
            >
              <span className="preset-name">{preset.name}</span>
              <span className="preset-meta">
                {preset.baseUrl === "" ? "自定义地址" : preset.baseUrl.replace(/^https?:\/\//, "")}
              </span>
            </button>
          ))}
        </div>

        <div className="form-grid">
          <div className="form-row">
            <label className="field-label" htmlFor="llm-label">
              配置名称
            </label>
            <input
              id="llm-label"
              className="input"
              value={llmLabel}
              placeholder="例如：DeepSeek 主力"
              onChange={(event) => setLlmLabel(event.target.value)}
            />
          </div>

          <div className="form-row">
            <label className="field-label" htmlFor="llm-protocol">
              协议
            </label>
            <select
              id="llm-protocol"
              className="select"
              value={protocol}
              onChange={(event) => setProtocol(event.target.value as LlmProtocol)}
            >
              <option value="openai-compatible">OpenAI 兼容</option>
              <option value="anthropic-messages" disabled>
                Anthropic 原生 Messages（后端暂未实现，请用 Claude 兼容层）
              </option>
            </select>
          </div>

          <div className="form-row">
            <label className="field-label" htmlFor="llm-base">
              baseURL
            </label>
            <input
              id="llm-base"
              className="input"
              value={baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </div>

          <div className="form-row">
            <label className="field-label" htmlFor="llm-model">
              模型名
            </label>
            <input
              id="llm-model"
              className="input"
              value={model}
              placeholder="deepseek-chat"
              onChange={(event) => setModel(event.target.value)}
            />
          </div>

          <div className="form-row form-row--full">
            <label className="field-label" htmlFor="llm-key">
              API Key
            </label>
            <input
              id="llm-key"
              className="input"
              type="password"
              value={apiKey}
              placeholder={LLM_PRESETS.find((preset) => preset.id === presetId)?.keyHint ?? "sk-…"}
              autoComplete="off"
              onChange={(event) => setApiKey(event.target.value)}
            />
            <span className="field-hint">Key 只提交一次：保存后输入框立即清空，服务端只返回 hasKey 标记。</span>
          </div>
        </div>

        {llmError === null ? null : (
          <div className="test-result is-error">
            <Icon name="alert" size={14} />
            {llmError}
          </div>
        )}

        {testResult === null ? null : (
          <div className={clsx("test-result", testResult.ok ? "is-ok" : "is-error")}>
            <Icon name={testResult.ok ? "check" : "alert"} size={14} />
            <span>
              {testResult.ok ? "连接成功" : "连接失败"} · {testResult.latencyMs}ms · {testResult.detail}
            </span>
          </div>
        )}

        <div className="form-actions">
          <button type="button" className="btn btn--primary" disabled={llmBusy} onClick={submitLlm}>
            <Icon name="check" size={14} />
            {llmBusy ? "保存中…" : "保存供应商"}
          </button>
          <button type="button" className="btn" disabled={testing || baseUrl.trim() === "" || model.trim() === ""} onClick={runTest}>
            <Icon name="bolt" size={14} />
            {testing ? "测试中…" : "测试连接"}
          </button>
          <span className="field-hint">测试会把 Key 直接发给服务端一次，不落盘、不回显。</span>
        </div>
      </GlassCard>
    </div>
  );
}
