import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import type {
  AccountView,
  Category,
  CreateAccountInput,
  InitState,
  LlmConfigInput,
  LlmConfigView,
  LlmProtocol,
  MailAuthMode,
  MailProvider,
  Rule,
  RuleField,
  RuleNode,
  RuleOperator,
  UserProfile,
} from "@mailcollect/shared";
import { api, isApiError } from "../lib/api";
import { Icon } from "./Icon";

/* --------------------------------- 壳层事件 --------------------------------- */

export const ONBOARDING_CHANGED_EVENT = "mailcollect:onboarding-changed";
export const ROUTE_EVENT = "mailcollect:route";

export type ShellRoute = "inbox" | "tasks" | "timeline" | "settings" | "rules" | "onboarding";

/**
 * 请求壳层跳转。App.tsx 不在本写域内，所以导航经 Sidebar（它有 onNavigate）
 * 这一条既有接线完成；没有监听者时事件自然丢弃，不会报错。
 */
export function requestShellRoute(route: ShellRoute): void {
  window.dispatchEvent(new CustomEvent<ShellRoute>(ROUTE_EVENT, { detail: route }));
}

/** 通知壳层「初始化状态变了」，侧栏提示与设置页据此刷新。 */
export function notifyOnboardingChanged(state: InitState): void {
  window.dispatchEvent(new CustomEvent<InitState>(ONBOARDING_CHANGED_EVENT, { detail: state }));
}

/**
 * 向导 / 设置页绕过 useMailData 直接调 api 写入（api.profile / api.accounts / api.llm），
 * 壳层那层状态不会自己知道。这里按资源范围广播一次，useMailData 收到后重取对应切片，
 * Sidebar 重取 health —— 与 T61 的 onboarding 事件同一套窗口事件约定，不另造缓存层。
 */
export const DATA_CHANGED_EVENT = "mailcollect:data-changed";

export interface DataChangedScope {
  readonly profile?: boolean;
  readonly accounts?: boolean;
  readonly llm?: boolean;
}

export function notifyDataChanged(scope: DataChangedScope): void {
  window.dispatchEvent(new CustomEvent<DataChangedScope>(DATA_CHANGED_EVENT, { detail: scope }));
}

/* --------------------------------- 展示常量 --------------------------------- */

const STEPS = [
  { id: "profile", title: "用户档案", hint: "姓名、别名与邮箱决定「点名给我」这条种子规则能否建出来" },
  { id: "account", title: "邮箱账号", hint: "IMAP / POP3 / Microsoft Graph / 本地 Exchange（EWS）" },
  { id: "llm", title: "LLM 供应商", hint: "可选：没有 LLM 也能用纯字段规则分类" },
] as const;

type StepId = (typeof STEPS)[number]["id"];

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
  ews: "本地 Exchange（EWS）",
};

const PROVIDER_PORT: Record<MailProvider, string> = {
  imap: "993",
  pop3: "995",
  graph: "",
  ews: "",
};

interface LlmPreset {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly model: string;
  readonly protocol: LlmProtocol;
}

const LLM_PRESETS: readonly LlmPreset[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    protocol: "openai-compatible",
  },
  {
    id: "kimi",
    name: "Kimi 月之暗面",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    protocol: "openai-compatible",
  },
  {
    id: "qwen",
    name: "通义千问",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    protocol: "openai-compatible",
  },
  {
    id: "ollama",
    name: "Ollama 本地",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:7b",
    protocol: "openai-compatible",
  },
];

/**
 * 条件树的人类可读渲染。
 *
 * `RULE_FIELDS` / `RULE_OPERATOR_LABELS` 是 shared 的运行时导出，但 ui 只允许
 * `shared(types only)`（AGENTS.md §7），所以这里维护一份展示用词表；词表与
 * C6 字段清单一一对应，缺项回退到字段键本身，不会渲染出 undefined。
 */
const FIELD_LABEL: Readonly<Record<RuleField, string>> = {
  from: "发件人",
  to: "收件人",
  cc: "抄送",
  subject: "主题",
  body: "正文",
  date: "日期",
  listId: "List-Id",
  precedence: "Precedence",
  autoSubmitted: "Auto-Submitted",
  hasAttachments: "有无附件",
  attachmentName: "附件文件名",
  attachmentMime: "附件 MIME",
  attachmentSize: "附件大小",
  isRead: "已读状态",
  folder: "所在文件夹",
  account: "所属账号",
  "to.count": "To 人数",
  "cc.count": "Cc 人数",
  "recipient.count": "To + Cc 人数",
  iAmInTo: "我在 To 里",
  "from.isNoReply": "发件人是 no-reply",
};

const OP_LABEL: Readonly<Record<RuleOperator, string>> = {
  equals: "等于",
  notEquals: "不等于",
  contains: "包含",
  notContains: "不包含",
  wholeWord: "整词匹配",
  startsWith: "前缀是",
  endsWith: "后缀是",
  in: "属于列表",
  exists: "存在",
  notExists: "不存在",
  before: "早于",
  after: "晚于",
  between: "介于",
  gt: "大于",
  lt: "小于",
  gte: "大于等于",
  lte: "小于等于",
  isTrue: "成立",
  isFalse: "不成立",
};

function formatLeafValue(node: Extract<RuleNode, { kind: "field" }>): string {
  if (node.value === undefined) return "";
  if (typeof node.value === "string") return node.value;
  if (typeof node.value === "number") return String(node.value);
  if (typeof node.value === "boolean") return node.value ? "是" : "否";
  if (Array.isArray(node.value)) return node.value.join(" / ");
  return `${node.value.from} → ${node.value.to}`;
}

function humanizeRule(node: RuleNode, depth = 0): string {
  if (node.kind === "field") {
    const field = FIELD_LABEL[node.field] ?? node.field;
    const op = OP_LABEL[node.op] ?? node.op;
    const value = formatLeafValue(node);
    return value === "" ? `${field} ${op}` : `${field} ${op}「${value}」`;
  }
  if (node.kind === "semantic") return `AI 判定「${node.expr}」`;
  if (node.kind === "not") return `非(${humanizeRule(node.child, depth + 1)})`;
  const joiner = node.kind === "and" ? " 且 " : " 或 ";
  const body = node.children.map((child) => humanizeRule(child, depth + 1)).join(joiner);
  return node.children.length > 1 ? `(${body})` : body;
}

function describeFailure(error: unknown): string {
  if (isApiError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return "未知错误";
}

const SEED_RULE_PREFIX = "seed-rule-";

/* ---------------------------------- 组件 ---------------------------------- */

/**
 * 全屏三步初始化向导（C3 / AC-01 / AC-02 / AC-03）。
 *
 * 行为要点：
 * - 三步各自可跳过，「跳过全部」写 `skipped=true` 后退出全屏；
 * - 「完成」写 `completed=true`（服务端幂等播种种子规则），随后展示种子规则，
 *   可确认 / 编辑（跳规则页）/ 删除；
 * - 任何一步失败都只显示可读错误，不阻塞下一步或跳过；
 * - 不提供清空/重置数据。
 */
export function OnboardingWizard() {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [stepIndex, setStepIndex] = useState(0);
  const [phase, setPhase] = useState<"steps" | "seeds">("steps");
  const [initState, setInitState] = useState<InitState | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [stepNotice, setStepNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);

  // 第①步：用户档案
  const [displayName, setDisplayName] = useState("");
  const [aliases, setAliases] = useState<readonly string[]>([]);
  const [emails, setEmails] = useState<readonly string[]>([]);
  const [timezone, setTimezone] = useState("Asia/Shanghai");
  const [aliasDraft, setAliasDraft] = useState("");
  const [emailDraft, setEmailDraft] = useState("");

  // 第②步：邮箱账号
  const [provider, setProvider] = useState<MailProvider>("imap");
  const [accountEmail, setAccountEmail] = useState("");
  const [accountLabel, setAccountLabel] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(PROVIDER_PORT.imap);
  const [user, setUser] = useState("");
  const [secret, setSecret] = useState("");
  const [clientId, setClientId] = useState("");
  const [tenant, setTenant] = useState("");
  const [ewsUrl, setEwsUrl] = useState("");
  const [authMode, setAuthMode] = useState<MailAuthMode>("password");

  // 第③步：LLM
  const [presetId, setPresetId] = useState<string>("deepseek");
  const [llmBaseUrl, setLlmBaseUrl] = useState("https://api.deepseek.com/v1");
  const [llmModel, setLlmModel] = useState("deepseek-chat");
  const [llmLabel, setLlmLabel] = useState("DeepSeek");
  const [protocol, setProtocol] = useState<LlmProtocol>("openai-compatible");
  const [apiKey, setApiKey] = useState("");
  const [llmTest, setLlmTest] = useState<string | null>(null);

  // 种子规则页
  const [seeds, setSeeds] = useState<readonly Rule[] | null>(null);
  const [categories, setCategories] = useState<readonly Category[]>([]);
  const [seedError, setSeedError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState<ReadonlySet<string>>(new Set());

  const step = STEPS[stepIndex] as (typeof STEPS)[number];

  const loadSeeds = useCallback(async (): Promise<void> => {
    const [rules, cats] = await Promise.all([api.rules.list(), api.categories.list()]);
    if (!mounted.current) return;
    setSeeds(rules.filter((rule) => rule.id.startsWith(SEED_RULE_PREFIX)));
    setCategories(cats);
  }, []);

  // 首屏：读取状态并预填已有配置，已经配好的步骤不再重复要求填写。
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      api.onboarding.get({ signal: controller.signal }),
      api.profile.get(),
      api.accounts.list(),
      api.llm.list(),
    ])
      .then(([state, profile, accounts, llmConfigs]: [
        InitState,
        UserProfile | null,
        readonly AccountView[],
        readonly LlmConfigView[],
      ]) => {
        if (!mounted.current) return;
        setInitState(state);
        if (profile !== null) {
          setDisplayName(profile.displayName);
          setAliases(profile.aliases);
          setEmails(profile.emails);
          setTimezone(profile.timezone);
        }
        const firstAccount = accounts[0];
        if (firstAccount !== undefined) {
          setProvider(firstAccount.provider);
          setAccountEmail(firstAccount.email);
          setAccountLabel(firstAccount.label);
        }
        const firstLlm = llmConfigs[0];
        if (firstLlm !== undefined) {
          setLlmLabel(firstLlm.label);
          setLlmBaseUrl(firstLlm.baseUrl);
          setLlmModel(firstLlm.model);
          setPresetId("");
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (!mounted.current) return;
        setInitError(`读取初始化状态失败：${describeFailure(error)}`);
      });
    return () => controller.abort();
  }, []);

  // A（T66）：完成后再从设置页 / 侧栏「初始化」进来，必须回到三步向导的第一屏。
  // 只在前一轮已经走到结束页（seeds）时重置——向导进行到一半时切面板再回来应保留输入。
  const resetForReopen = useCallback((): void => {
    setPhase("steps");
    setStepIndex(0);
    setSeeds(null);
    setConfirmed(new Set<string>());
    setSeedError(null);
    setStepError(null);
    setStepNotice(null);
    setLlmTest(null);
  }, []);

  useEffect(() => {
    if (phase !== "seeds") return;
    const onRoute = (event: Event): void => {
      if ((event as CustomEvent<ShellRoute>).detail === "onboarding") resetForReopen();
    };
    window.addEventListener(ROUTE_EVENT, onRoute);
    return () => window.removeEventListener(ROUTE_EVENT, onRoute);
  }, [phase, resetForReopen]);

  const addAlias = (): void => {
    const value = aliasDraft.trim();
    if (value === "" || aliases.includes(value)) return;
    setAliases([...aliases, value]);
    setAliasDraft("");
  };

  const addEmail = (): void => {
    const value = emailDraft.trim().toLowerCase();
    if (value === "" || !value.includes("@") || emails.includes(value)) return;
    setEmails([...emails, value]);
    setEmailDraft("");
  };

  const saveProfileAndNext = (): void => {
    if (displayName.trim() === "") {
      setStepError("姓名必填：它决定「点名给我」匹配谁。也可以直接跳过这一步。");
      return;
    }
    setStepError(null);
    setStepNotice(null);
    setBusy(true);
    void api.profile
      .save({
        displayName: displayName.trim(),
        aliases: [...aliases],
        emails: [...emails],
        timezone,
      })
      .then(() => {
        notifyDataChanged({ profile: true });
        if (!mounted.current) return;
        setStepNotice("档案已保存；「点名给我」种子规则会按姓名/邮箱展开。");
        setStepIndex(1);
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setStepError(`保存档案失败：${describeFailure(error)}`);
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const runDiscover = (): void => {
    const email = accountEmail.trim();
    if (!email.includes("@")) {
      setStepError("先填邮箱地址，再跑自动发现");
      return;
    }
    setStepError(null);
    setStepNotice(null);
    setDiscovering(true);
    void api.accounts
      .discover({ email, providerHint: provider, ...(secret === "" ? {} : { secret }) })
      .then((result) => {
        if (!mounted.current) return;
        setStepNotice(result.detail === "" ? "自动发现完成" : result.detail);
        if (result.provider !== null) {
          setProvider(result.provider);
          setPort(PROVIDER_PORT[result.provider]);
        }
        const discoveredHost = result.config["host"];
        if (discoveredHost !== undefined) setHost(discoveredHost);
        const discoveredPort = result.config["port"];
        if (discoveredPort !== undefined) setPort(discoveredPort);
        const discoveredUrl = result.config["ewsUrl"];
        if (discoveredUrl !== undefined) setEwsUrl(discoveredUrl);
        if (result.send !== null) {
          if (result.send.ewsUrl !== null) setEwsUrl(result.send.ewsUrl);
          setAuthMode(result.send.authMode);
        }
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        // 探测失败是常态，允许手填，绝不阻塞进入下一步。
        setStepError(`自动发现失败（可手填）：${describeFailure(error)}`);
      })
      .finally(() => {
        if (mounted.current) setDiscovering(false);
      });
  };

  const saveAccountAndNext = (): void => {
    if (!accountEmail.includes("@")) {
      setStepError("请填写有效的邮箱地址；也可以直接跳过这一步。");
      return;
    }
    if (provider === "graph" && clientId.trim() === "") {
      setStepError("Graph 账号需要 clientId；没有就先跳过，之后在设置页补。");
      return;
    }
    if (provider === "ews" && ewsUrl.trim() === "") {
      setStepError("本地 Exchange 需要 EWS 端点：先跑自动发现，或手填 https://<主机>/EWS/Exchange.asmx。");
      return;
    }
    const config: Record<string, string> =
      provider === "graph"
        ? { clientId: clientId.trim(), ...(tenant.trim() === "" ? {} : { tenant: tenant.trim() }) }
        : provider === "ews"
          ? { ewsUrl: ewsUrl.trim(), authMode }
          : {
              host: host.trim(),
              user: user.trim() === "" ? accountEmail.trim() : user.trim(),
              mailbox: "INBOX",
              ...(port.trim() === "" ? {} : { port: port.trim() }),
              ...(provider === "imap" ? { tls: "true" } : {}),
            };
    const input: CreateAccountInput = {
      provider,
      label: accountLabel.trim() === "" ? accountEmail.trim() : accountLabel.trim(),
      email: accountEmail.trim(),
      config,
      secret: provider === "graph" ? "" : secret,
    };
    setStepError(null);
    setStepNotice(null);
    setBusy(true);
    void api.accounts
      .create(input)
      .then(() => {
        notifyDataChanged({ accounts: true });
        if (!mounted.current) return;
        // 凭据一提交就清空本地状态，DOM 里不再留任何明文。
        setSecret("");
        setStepNotice("账号已保存，验证与发信设置可以在设置页继续。");
        setStepIndex(2);
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setStepError(`保存账号失败：${describeFailure(error)}`);
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const runLlmTest = (): void => {
    if (llmBaseUrl.trim() === "" || llmModel.trim() === "") {
      setStepError("baseURL 与模型名都必填");
      return;
    }
    setStepError(null);
    setLlmTest(null);
    setBusy(true);
    void api.llm
      .test({
        protocol,
        baseUrl: llmBaseUrl.trim(),
        model: llmModel.trim(),
        ...(apiKey === "" ? {} : { apiKey }),
      })
      .then((result) => {
        if (!mounted.current) return;
        setLlmTest(`${result.ok ? "连接成功" : "连接失败"} · ${result.latencyMs}ms · ${result.detail}`);
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setStepError(`测试失败：${describeFailure(error)}`);
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const finish = (): void => {
    setStepError(null);
    setBusy(true);
    void api.onboarding
      .update({ completed: true })
      .then((state) => {
        if (!mounted.current) return;
        setInitState(state);
        notifyOnboardingChanged(state);
        return loadSeeds();
      })
      .then(() => {
        if (!mounted.current) return;
        setPhase("seeds");
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setStepError(`写入完成标记失败：${describeFailure(error)}`);
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const saveLlmAndFinish = (): void => {
    if (llmBaseUrl.trim() === "" || llmModel.trim() === "") {
      finish();
      return;
    }
    setStepError(null);
    setBusy(true);
    const input: LlmConfigInput = {
      label: llmLabel.trim() === "" ? llmModel.trim() : llmLabel.trim(),
      protocol,
      baseUrl: llmBaseUrl.trim(),
      model: llmModel.trim(),
      ...(apiKey === "" ? {} : { apiKey }),
      isDefault: true,
    };
    void api.llm
      .save(input)
      .then(() => {
        notifyDataChanged({ llm: true });
        if (!mounted.current) return;
        setApiKey("");
        return api.onboarding.update({ completed: true });
      })
      .then((state) => {
        if (!mounted.current) return;
        if (state !== undefined) {
          setInitState(state);
          notifyOnboardingChanged(state);
        }
        return loadSeeds();
      })
      .then(() => {
        if (!mounted.current) return;
        setPhase("seeds");
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setStepError(`保存 LLM 供应商失败：${describeFailure(error)}`);
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const skipAll = (): void => {
    setStepError(null);
    setBusy(true);
    void api.onboarding
      .update({ skipped: true })
      .then((state) => {
        if (!mounted.current) return;
        setInitState(state);
        notifyOnboardingChanged(state);
        requestShellRoute("inbox");
      })
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setStepError(`记录「已跳过」失败：${describeFailure(error)}`);
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };

  const skipStep = (): void => {
    setStepError(null);
    setStepNotice(null);
    setLlmTest(null);
    setSecret("");
    if (stepIndex < STEPS.length - 1) {
      setStepIndex(stepIndex + 1);
      return;
    }
    finish();
  };

  const removeSeed = (seed: Rule): void => {
    const confirmedDelete = window.confirm(
      `删除种子规则「${seed.name}」？删除后不会在下次启动时重新出现（服务端写墓碑）。`,
    );
    if (!confirmedDelete) return;
    setSeedError(null);
    void api.rules
      .remove(seed.id)
      .then(() => loadSeeds())
      .catch((error: unknown) => {
        if (!mounted.current) return;
        setSeedError(`删除失败：${describeFailure(error)}`);
      });
  };

  const categoryName = useMemo(() => {
    const map = new Map<string, string>();
    for (const category of categories) map.set(category.id, category.name);
    return (id: string): string => map.get(id) ?? id;
  }, [categories]);

  const leave = (): void => {
    requestShellRoute("inbox");
  };

  const progress = phase === "seeds" ? STEPS.length : stepIndex;
  const title = phase === "seeds" ? "初始化完成" : `第 ${stepIndex + 1} / ${STEPS.length} 步 · ${step.title}`;

  return (
    <div
      className="dialog-backdrop"
      style={{ zIndex: 90, padding: 0, alignItems: "stretch", justifyItems: "stretch" }}
      role="dialog"
      aria-modal="true"
      aria-label="初始化向导"
      data-testid="onboarding-wizard"
    >
      <div
        className="dialog-card"
        style={{
          width: "min(980px, 100%)",
          maxHeight: "min(880px, 96vh)",
          margin: "auto",
          display: "flex",
          flexDirection: "column",
          gap: 0,
          padding: 0,
          overflow: "hidden",
        }}
      >
        {/* 头部：品牌 + 步骤条 + 退出 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "18px 22px 14px",
            borderBottom: "1px solid rgba(15, 37, 64, 0.08)",
          }}
        >
          <div className="dialog-icon is-iris">
            <Icon name="spark" size={18} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="dialog-title">{title}</div>
            <div className="dialog-sub">
              {phase === "seeds"
                ? "种子规则只在首次初始化时创建一次；删除后不会重播。"
                : step.hint}
            </div>
          </div>
          <button
            type="button"
            className="dialog-close"
            aria-label="退出向导"
            title="退出向导（下次启动仍会提示未完成）"
            onClick={leave}
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        {/* 步骤条 */}
        <div style={{ display: "flex", gap: 8, padding: "12px 22px 0" }}>
          {STEPS.map((entry, index) => {
            const done = phase === "seeds" || index < progress;
            const active = phase === "steps" && index === stepIndex;
            return (
              <div
                key={entry.id}
                style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}
                aria-current={active ? "step" : undefined}
              >
                <div
                  style={{
                    height: 4,
                    borderRadius: 999,
                    background: done
                      ? "hsl(258 70% 62%)"
                      : active
                        ? "hsl(258 70% 78%)"
                        : "rgba(15, 37, 64, 0.1)",
                  }}
                />
                <span className={clsx("chip", active ? "chip--iris" : done ? "chip--success" : "chip--muted")}>
                  {index + 1}. {entry.title}
                </span>
              </div>
            );
          })}
        </div>

        {/* 内容区 */}
        <div style={{ flex: 1, overflowY: "auto", padding: "16px 22px 8px" }}>
          {initError === null ? null : (
            <div className="test-result is-error">
              <Icon name="alert" size={14} />
              {initError}
            </div>
          )}

          {phase === "steps" && step.id === "profile" ? (
            <div className="form-grid">
              <div className="form-row">
                <label className="field-label" htmlFor="wizard-name">
                  显示名
                </label>
                <input
                  id="wizard-name"
                  className="input"
                  value={displayName}
                  placeholder="例如：张三"
                  onChange={(event) => setDisplayName(event.target.value)}
                />
                <span className="field-hint">它和别名/邮箱一起决定「点名给我」匹配哪些词。</span>
              </div>
              <div className="form-row">
                <label className="field-label" htmlFor="wizard-zone">
                  IANA 时区
                </label>
                <select
                  id="wizard-zone"
                  className="select"
                  value={timezone}
                  onChange={(event) => setTimezone(event.target.value)}
                >
                  {(TIMEZONES.includes(timezone) ? TIMEZONES : [timezone, ...TIMEZONES]).map((zone) => (
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
                      <span className="field-hint">可以加「张 三」「San Zhang」这类写法。</span>
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
                    {emails.length === 0 ? (
                      <span className="field-hint">至少填一个常用邮箱，用于区分群发与点名。</span>
                    ) : (
                      emails.map((email) => (
                        <span className="alias-pill" key={email}>
                          {email}
                          <button
                            type="button"
                            className="alias-remove"
                            aria-label={`移除邮箱 ${email}`}
                            onClick={() => setEmails(emails.filter((item) => item !== email))}
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
          ) : null}

          {phase === "steps" && step.id === "account" ? (
            <div className="form-grid">
              <div className="form-row">
                <label className="field-label" htmlFor="wizard-provider">
                  协议
                </label>
                <select
                  id="wizard-provider"
                  className="select"
                  value={provider}
                  onChange={(event) => {
                    const next = event.target.value as MailProvider;
                    setProvider(next);
                    setPort(PROVIDER_PORT[next]);
                    setStepError(null);
                  }}
                >
                  <option value="imap">IMAP</option>
                  <option value="pop3">POP3（只读拉取）</option>
                  <option value="graph">Microsoft Graph</option>
                  <option value="ews">本地 Exchange（EWS）</option>
                </select>
              </div>

              <div className="form-row">
                <label className="field-label" htmlFor="wizard-email">
                  邮箱地址
                </label>
                <input
                  id="wizard-email"
                  className="input"
                  type="email"
                  value={accountEmail}
                  placeholder="name@example.com"
                  onChange={(event) => setAccountEmail(event.target.value)}
                />
              </div>

              <div className="form-row">
                <label className="field-label" htmlFor="wizard-label">
                  显示名称
                </label>
                <input
                  id="wizard-label"
                  className="input"
                  value={accountLabel}
                  placeholder="例如：公司邮箱"
                  onChange={(event) => setAccountLabel(event.target.value)}
                />
              </div>

              {provider === "graph" ? (
                <>
                  <div className="form-row form-row--full">
                    <label className="field-label" htmlFor="wizard-client-id">
                      Client ID
                    </label>
                    <input
                      id="wizard-client-id"
                      className="input"
                      value={clientId}
                      placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                      onChange={(event) => setClientId(event.target.value)}
                    />
                    <span className="field-hint">
                      在 Azure 门户 → 应用注册里获取；设备码登录可以去设置页再完成，允许跳过。
                    </span>
                  </div>
                  <div className="form-row form-row--full">
                    <label className="field-label" htmlFor="wizard-tenant">
                      Tenant
                    </label>
                    <input
                      id="wizard-tenant"
                      className="input"
                      value={tenant}
                      placeholder="留空按 common"
                      onChange={(event) => setTenant(event.target.value)}
                    />
                  </div>
                </>
              ) : provider === "ews" ? (
                <>
                  <div className="form-row form-row--full">
                    <label className="field-label" htmlFor="wizard-ews-url">
                      EWS 端点
                    </label>
                    <input
                      id="wizard-ews-url"
                      className="input"
                      value={ewsUrl}
                      placeholder="https://mail.corp.com/EWS/Exchange.asmx"
                      onChange={(event) => setEwsUrl(event.target.value)}
                    />
                    <span className="field-hint">
                      https 走隐式 TLS（443）；URL 里不能带用户名密码，凭据只进加密密文列。
                    </span>
                  </div>
                  <div className="form-row">
                    <label className="field-label" htmlFor="wizard-auth-mode">
                      认证方式
                    </label>
                    <select
                      id="wizard-auth-mode"
                      className="select"
                      value={authMode}
                      onChange={(event) => setAuthMode(event.target.value as MailAuthMode)}
                    >
                      <option value="password">密码（Basic）</option>
                      <option value="ntlm">NTLM</option>
                    </select>
                  </div>
                </>
              ) : (
                <>
                  <div className="form-row">
                    <label className="field-label" htmlFor="wizard-host">
                      服务器
                    </label>
                    <input
                      id="wizard-host"
                      className="input"
                      value={host}
                      placeholder={provider === "imap" ? "imap.example.com" : "pop.example.com"}
                      onChange={(event) => setHost(event.target.value)}
                    />
                  </div>
                  <div className="form-row">
                    <label className="field-label" htmlFor="wizard-port">
                      端口
                    </label>
                    <input
                      id="wizard-port"
                      className="input"
                      inputMode="numeric"
                      value={port}
                      onChange={(event) => setPort(event.target.value)}
                    />
                  </div>
                  <div className="form-row">
                    <label className="field-label" htmlFor="wizard-user">
                      用户名
                    </label>
                    <input
                      id="wizard-user"
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
                  <label className="field-label" htmlFor="wizard-secret">
                    密码 / 应用专用密码
                  </label>
                  <input
                    id="wizard-secret"
                    className="input"
                    type="password"
                    value={secret}
                    placeholder="只提交给服务端，保存后不回显"
                    autoComplete="new-password"
                    onChange={(event) => setSecret(event.target.value)}
                  />
                  <span className="field-hint">AES-256-GCM 加密落盘；保存成功后输入框立即清空。</span>
                </div>
              )}
            </div>
          ) : null}

          {phase === "steps" && step.id === "llm" ? (
            <div>
              <div className="preset-grid" style={{ marginBottom: 14 }}>
                {LLM_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className={clsx("preset", presetId === preset.id && "is-active")}
                    onClick={() => {
                      setPresetId(preset.id);
                      setLlmLabel(preset.name);
                      setProtocol(preset.protocol);
                      setLlmBaseUrl(preset.baseUrl);
                      setLlmModel(preset.model);
                      setApiKey("");
                      setLlmTest(null);
                    }}
                  >
                    <span className="preset-name">{preset.name}</span>
                    <span className="preset-meta">{preset.model}</span>
                  </button>
                ))}
              </div>

              <div className="form-grid">
                <div className="form-row">
                  <label className="field-label" htmlFor="wizard-llm-label">
                    显示名称
                  </label>
                  <input
                    id="wizard-llm-label"
                    className="input"
                    value={llmLabel}
                    onChange={(event) => setLlmLabel(event.target.value)}
                  />
                </div>
                <div className="form-row">
                  <label className="field-label" htmlFor="wizard-llm-model">
                    模型名
                  </label>
                  <input
                    id="wizard-llm-model"
                    className="input"
                    value={llmModel}
                    placeholder="deepseek-chat"
                    onChange={(event) => setLlmModel(event.target.value)}
                  />
                </div>
                <div className="form-row form-row--full">
                  <label className="field-label" htmlFor="wizard-llm-url">
                    Base URL
                  </label>
                  <input
                    id="wizard-llm-url"
                    className="input"
                    value={llmBaseUrl}
                    placeholder="https://api.deepseek.com/v1"
                    onChange={(event) => setLlmBaseUrl(event.target.value)}
                  />
                </div>
                <div className="form-row form-row--full">
                  <label className="field-label" htmlFor="wizard-llm-key">
                    API Key
                  </label>
                  <input
                    id="wizard-llm-key"
                    className="input"
                    type="password"
                    value={apiKey}
                    placeholder="只提交一次，保存后清空"
                    autoComplete="off"
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  <span className="field-hint">不填 Key 也可以保存（例如本地 Ollama）；服务端只返回 hasKey。</span>
                </div>
              </div>

              {llmTest === null ? null : (
                <div className="settings-note" style={{ marginTop: 10 }}>
                  {llmTest}
                </div>
              )}
            </div>
          ) : null}

          {phase === "seeds" ? (
            <div>
              {seedError === null ? null : (
                <div className="test-result is-error">
                  <Icon name="alert" size={14} />
                  {seedError}
                </div>
              )}

              {seeds === null ? (
                <div className="settings-note">正在读取种子规则…</div>
              ) : seeds.length === 0 ? (
                <div className="settings-note">
                  服务端没有返回种子规则：它们只在首次「完成/跳过」初始化时创建一次，
                  之后被删除就不会重播。可以到规则页手动创建。
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {seeds.map((seed) => (
                    <div key={seed.id} className="task-card" style={{ padding: 14 }}>
                      <div className="task-card-top">
                        <div className="task-title">{seed.name}</div>
                        <span className="chip chip--iris">{categoryName(seed.categoryId)}</span>
                        <span className={clsx("chip", seed.enabled ? "chip--success" : "chip--muted")}>
                          {seed.enabled ? "启用" : "停用"}
                        </span>
                        {confirmed.has(seed.id) ? <span className="chip chip--success">已确认</span> : null}
                      </div>
                      <div className="field-hint" style={{ marginTop: 6, wordBreak: "break-word" }}>
                        {humanizeRule(seed.tree)}
                      </div>
                      <div className="form-actions" style={{ marginTop: 10 }}>
                        <button
                          type="button"
                          className="btn btn--sm"
                          onClick={() =>
                            setConfirmed((previous) => {
                              const next = new Set(previous);
                              next.add(seed.id);
                              return next;
                            })
                          }
                        >
                          <Icon name="check" size={13} />
                          确认保留
                        </button>
                        <button type="button" className="btn btn--sm" onClick={() => requestShellRoute("rules")}>
                          <Icon name="bolt" size={13} />
                          去规则页编辑条件
                        </button>
                        <button
                          type="button"
                          className="btn btn--sm btn--danger"
                          onClick={() => removeSeed(seed)}
                        >
                          <Icon name="trash" size={13} />
                          删除
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="settings-note" style={{ marginTop: 12 }}>
                有档案身份词时会有两条（点名给我 / 群发通知）；没有身份词时只会建「群发/通知」一条，
                补完档案后「点名给我」会自动出现。删除种子规则会写墓碑，之后不会重播。
              </div>
            </div>
          ) : null}

          {stepError === null ? null : (
            <div className="test-result is-error" style={{ marginTop: 12 }}>
              <Icon name="alert" size={14} />
              {stepError}
            </div>
          )}
          {stepNotice === null ? null : (
            <div className="test-result is-ok" style={{ marginTop: 12 }}>
              <Icon name="check" size={14} />
              {stepNotice}
            </div>
          )}
          {initState === null ? null : (
            <div className="field-hint" style={{ marginTop: 10 }}>
              当前状态：{initState.completed ? "已完成" : initState.skipped ? "已跳过" : "未完成"}
              （写在服务端，重启后仍保留）。
            </div>
          )}
        </div>

        {/* 底部动作 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "14px 22px 18px",
            borderTop: "1px solid rgba(15, 37, 64, 0.08)",
            flexWrap: "wrap",
          }}
        >
          {phase === "seeds" ? (
            <button type="button" className="btn btn--primary" onClick={leave}>
              <Icon name="arrow-right" size={14} />
              进入收件箱
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn"
                disabled={stepIndex === 0 || busy}
                onClick={() => {
                  setStepError(null);
                  setStepNotice(null);
                  setStepIndex(Math.max(0, stepIndex - 1));
                }}
              >
                <Icon name="chevron-left" size={14} />
                上一步
              </button>

              {step.id === "profile" ? (
                <button type="button" className="btn btn--primary" disabled={busy} onClick={saveProfileAndNext}>
                  <Icon name="check" size={14} />
                  {busy ? "保存中…" : "保存并继续"}
                </button>
              ) : null}

              {step.id === "account" ? (
                <>
                  <button type="button" className="btn btn--primary" disabled={busy} onClick={saveAccountAndNext}>
                    <Icon name="check" size={14} />
                    {busy ? "保存中…" : "保存并继续"}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    disabled={discovering || busy}
                    title="按邮箱域名跑 Autodiscover，识别 Exchange / Office 365"
                    onClick={runDiscover}
                  >
                    <Icon name="search" size={14} />
                    {discovering ? "探测中…" : "自动发现"}
                  </button>
                </>
              ) : null}

              {step.id === "llm" ? (
                <>
                  <button type="button" className="btn btn--primary" disabled={busy} onClick={saveLlmAndFinish}>
                    <Icon name="check" size={14} />
                    {busy ? "保存中…" : "保存并完成"}
                  </button>
                  <button type="button" className="btn" disabled={busy} onClick={runLlmTest}>
                    <Icon name="bolt" size={14} />
                    测试连接
                  </button>
                </>
              ) : null}

              <button type="button" className="btn btn--quiet" disabled={busy} onClick={skipStep}>
                跳过这一步
              </button>

              <span style={{ flex: 1 }} />

              <button type="button" className="btn btn--quiet" disabled={busy} onClick={skipAll}>
                跳过全部，稍后在设置里配
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
