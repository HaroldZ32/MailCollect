import { useEffect, useState } from "react";
import clsx from "clsx";
import type {
  AccountView,
  CreateAccountInput,
  LlmConfigInput,
  LlmConfigView,
  LlmProtocol,
  LlmTestInput,
  LlmTestResponse,
  MailProvider,
  UpsertProfileInput,
  UserProfile,
  VerifyAccountResponse,
} from "@mailcollect/shared";
import {
  apiBaseLabel,
  clearStoredToken,
  hasInjectedRuntime,
  hasStoredToken,
  storeToken,
} from "../lib/api";
import { formatDateTime, hueFor, initials } from "../lib/format";
import { GlassCard } from "../components/GlassCard";
import { Icon } from "../components/Icon";
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
};

const DEFAULT_PORT: Record<MailProvider, string> = {
  imap: "993",
  pop3: "995",
  graph: "",
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
  const config: Record<string, string> = {
    host: host.trim(),
    user: user.trim() === "" ? email : user.trim(),
    mailbox: "INBOX",
  };
  if (port.trim() !== "") config["port"] = port.trim();
  if (provider === "imap") config["tls"] = "true";
  return config;
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
  const [accountBusy, setAccountBusy] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [verifyBusyId, setVerifyBusyId] = useState<string | null>(null);
  const [verifyResults, setVerifyResults] = useState<Readonly<Record<string, VerifyAccountResponse>>>({});

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

  const submitProfile = (): void => {
    if (displayName.trim() === "") return;
    setProfileBusy(true);
    void onSaveProfile({
      displayName: displayName.trim(),
      aliases: [...aliases],
      emails: [...profileEmails],
      timezone,
    }).finally(() => setProfileBusy(false));
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
    setAccountError(null);
    setAccountBusy(true);
    void onAddAccount({
      provider,
      label: accountLabel.trim() === "" ? accountEmail.trim() : accountLabel.trim(),
      email: accountEmail.trim(),
      config: buildAccountConfig(provider, host, port, user, accountEmail, clientId, tenant),
      secret: provider === "graph" ? "" : secret,
    })
      .then((result) => {
        if (!result.ok) {
          setAccountError(result.message ?? "保存账号失败");
          return;
        }
        setAccountLabel("");
        setAccountEmail("");
        setHost("");
        setPort(DEFAULT_PORT.imap);
        setUser("");
        setSecret("");
        setClientId("");
        setTenant("");
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
    void onRemoveAccount(account.id);
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
        if (ok) setApiKey("");
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

  return (
    <div className="settings">
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
                  }}
                >
                  <option value="imap">IMAP</option>
                  <option value="pop3">POP3（只读拉取）</option>
                  <option value="graph">Microsoft Graph</option>
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

              {provider === "graph" ? null : (
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
            </div>

            {accountError === null ? null : (
              <div className="test-result is-error">
                <Icon name="alert" size={14} />
                {accountError}
              </div>
            )}

            <div className="form-actions">
              <button type="button" className="btn btn--primary btn--sm" disabled={accountBusy} onClick={submitAccount}>
                <Icon name="plus" size={13} />
                {accountBusy ? "保存中…" : "保存账号"}
              </button>
              <span className="field-hint">
                {provider === "graph"
                  ? "保存后在账号列表点「登录 Microsoft」完成设备码授权；cachePath 由服务端自动推导。"
                  : "保存后可以点「验证」测试连通性，验证失败不会删除账号。"}
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
                    {result === undefined ? null : (
                      <div className={clsx("test-result", result.ok ? "is-ok" : "is-error")}>
                        <Icon name={result.ok ? "check" : "alert"} size={13} />
                        {result.detail}
                      </div>
                    )}
                  </div>
                  <div className="account-actions">
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
                    <button type="button" className="btn btn--sm" onClick={() => void onSetDefaultLlm(config.id)}>
                      设为默认
                    </button>
                  )}
                  <button type="button" className="btn btn--sm btn--danger" onClick={() => void onRemoveLlm(config.id)}>
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
