import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AccountView,
  BulkDecisionInput,
  CreateAccountInput,
  LlmConfigInput,
  LlmConfigView,
  LlmTestInput,
  LlmTestResponse,
  SyncProgress,
  Task,
  TaskCounts,
  TaskTime,
  UpdateTaskInput,
  UpsertProfileInput,
  UserProfile,
  VerifyAccountResponse,
} from "@mailcollect/shared";
import { api, ApiError, eventsUrl, hasInjectedRuntime, isApiError, resolveToken } from "./api";
import { createMockAccounts, createMockLlmConfigs, createMockProfile, createMockTasks } from "./mock";

export type ConnectionMode = "loading" | "live" | "demo" | "offline";

export interface Notice {
  readonly kind: "ok" | "error";
  readonly text: string;
}

export interface ExtractProgress {
  readonly done: number;
  readonly total: number;
}

export type DeviceLoginPhase = "requesting" | "waiting" | "failed";

export interface DeviceLoginState {
  readonly accountId: string;
  readonly phase: DeviceLoginPhase;
  readonly userCode: string | null;
  readonly verificationUri: string | null;
  readonly message: string | null;
  readonly expiresInSeconds: number;
  readonly startedAt: number;
  readonly error: string | null;
}

export interface MailData {
  readonly mode: ConnectionMode;
  readonly error: string | null;
  readonly notice: Notice | null;
  readonly streamError: string | null;
  readonly extractProgress: ExtractProgress | null;
  readonly syncProgress: SyncProgress | null;
  readonly resyncToken: number;
  readonly deviceLogin: DeviceLoginState | null;
  readonly graphLoggedIn: Readonly<Record<string, boolean>>;
  readonly streamConnected: boolean;
  readonly canLoginDevice: boolean;
  readonly profile: UserProfile | null;
  readonly accounts: readonly AccountView[];
  readonly tasks: readonly Task[];
  readonly llmConfigs: readonly LlmConfigView[];
  readonly counts: TaskCounts;
  readonly retry: () => void;
  readonly enterDemo: () => void;
  readonly refresh: () => void;
  readonly dismissNotice: () => void;
  readonly dismissStreamError: () => void;
  readonly loginAccount: (accountId: string) => Promise<boolean>;
  readonly retryDeviceLogin: () => Promise<boolean>;
  readonly dismissDeviceLogin: () => void;
  readonly saveProfile: (input: UpsertProfileInput) => Promise<boolean>;
  readonly addAccount: (input: CreateAccountInput) => Promise<boolean>;
  readonly removeAccount: (accountId: string) => Promise<boolean>;
  readonly verifyAccount: (accountId: string) => Promise<VerifyAccountResponse>;
  readonly updateTask: (taskId: string, input: UpdateTaskInput) => Promise<boolean>;
  readonly bulkDecision: (input: BulkDecisionInput) => Promise<boolean>;
  readonly saveLlmConfig: (input: LlmConfigInput) => Promise<boolean>;
  readonly setDefaultLlmConfig: (configId: string) => Promise<boolean>;
  readonly removeLlmConfig: (configId: string) => Promise<boolean>;
  readonly testLlm: (input: LlmTestInput) => Promise<LlmTestResponse>;
  readonly syncAccount: (accountId: string, full?: boolean) => Promise<boolean>;
  readonly runExtract: () => Promise<boolean>;
}

interface LiveData {
  readonly profile: UserProfile | null;
  readonly accounts: readonly AccountView[];
  readonly tasks: readonly Task[];
  readonly llmConfigs: readonly LlmConfigView[];
}

function emptyCounts(): TaskCounts {
  return { candidate: 0, confirmed: 0, dismissed: 0, done: 0 };
}

function deriveCounts(tasks: readonly Task[]): TaskCounts {
  const counts = emptyCounts();
  for (const task of tasks) {
    if (task.owner === "other") continue;
    counts[task.status] += 1;
  }
  return counts;
}

function failureText(error: unknown): string {
  if (isApiError(error)) {
    if (error.code === "unauthorized") return "访问令牌无效：请到设置页填入服务端令牌后重试。";
    if (error.code === "network") return "本地服务不可达：请启动 apps/server，或继续使用演示数据。";
    return error.message;
  }
  if (error instanceof SyntaxError) {
    return "本地服务返回了非 API 响应：请确认 /api 反向代理指向 apps/server。";
  }
  if (error instanceof Error) return error.message;
  return "发生未知错误";
}

function noticeOf(error: unknown): Notice {
  return { kind: "error", text: failureText(error) };
}

async function fetchLiveData(): Promise<LiveData> {
  const [profile, accounts, taskResponse, llmConfigs] = await Promise.all([
    api.profile.get(),
    api.accounts.list(),
    api.tasks.list(),
    api.llm.list(),
  ]);
  return { profile, accounts, tasks: taskResponse.items, llmConfigs };
}

function mergeTime(time: TaskTime | null, patch: UpdateTaskInput): TaskTime | null {
  const touchesTime =
    patch.dueAt !== undefined || patch.windowStart !== undefined || patch.windowEnd !== undefined;
  if (!touchesTime) return time;
  const base: TaskTime = time ?? {
    phrase: null,
    dueAt: null,
    windowStart: null,
    windowEnd: null,
    timezone: "Asia/Shanghai",
    confidence: 0,
  };
  return {
    ...base,
    dueAt: patch.dueAt !== undefined ? patch.dueAt : base.dueAt,
    windowStart: patch.windowStart !== undefined ? patch.windowStart : base.windowStart,
    windowEnd: patch.windowEnd !== undefined ? patch.windowEnd : base.windowEnd,
  };
}

function applyTaskPatch(task: Task, patch: UpdateTaskInput): Task {
  return {
    ...task,
    title: patch.title ?? task.title,
    detail: patch.detail !== undefined ? patch.detail : task.detail,
    status: patch.status ?? task.status,
    time: mergeTime(task.time, patch),
    updatedAt: new Date().toISOString(),
  };
}

function mergeTasks(current: readonly Task[], updated: readonly Task[]): Task[] {
  const byId = new Map(updated.map((task) => [task.id, task]));
  return current.map((task) => byId.get(task.id) ?? task);
}

function upsertLlm(current: readonly LlmConfigView[], incoming: LlmConfigView): LlmConfigView[] {
  const exists = current.some((config) => config.id === incoming.id);
  const base = exists
    ? current.map((config) => {
        if (config.id === incoming.id) return incoming;
        return incoming.isDefault ? { ...config, isDefault: false } : config;
      })
    : [...current, incoming];
  return incoming.isDefault ? base.map((config) => ({ ...config, isDefault: config.id === incoming.id })) : base;
}

function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}`;
}

const TASK_STATUS_VALUES: readonly Task["status"][] = ["candidate", "confirmed", "dismissed", "done"];
const TASK_ORIGIN_VALUES: readonly Task["origin"][] = ["personal", "broadcast", "uncertain"];
const SYNC_PHASE_VALUES: readonly SyncProgress["phase"][] = ["connect", "fetch", "store", "extract", "done", "error"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isTaskPayload(value: unknown): value is Task {
  if (!isRecord(value)) return false;
  const status = value["status"];
  const origin = value["origin"];
  return (
    typeof value["id"] === "string" &&
    typeof value["title"] === "string" &&
    typeof value["evidenceQuote"] === "string" &&
    typeof value["confidence"] === "number" &&
    TASK_STATUS_VALUES.some((item) => item === status) &&
    TASK_ORIGIN_VALUES.some((item) => item === origin)
  );
}

function isExtractProgress(value: unknown): value is ExtractProgress {
  return (
    isRecord(value) && typeof value["done"] === "number" && typeof value["total"] === "number"
  );
}

function isSyncProgress(value: unknown): value is SyncProgress {
  if (!isRecord(value)) return false;
  const phase = value["phase"];
  return (
    typeof value["accountId"] === "string" &&
    typeof value["fetched"] === "number" &&
    typeof value["stored"] === "number" &&
    SYNC_PHASE_VALUES.some((item) => item === phase)
  );
}

function isDeviceCodePayload(value: unknown): value is {
  readonly accountId: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly message: string;
  readonly expiresInSeconds: number;
} {
  return (
    isRecord(value) &&
    typeof value["accountId"] === "string" &&
    typeof value["userCode"] === "string" &&
    typeof value["verificationUri"] === "string" &&
    typeof value["message"] === "string" &&
    typeof value["expiresInSeconds"] === "number"
  );
}

function isDeviceLoginPayload(value: unknown): value is {
  readonly accountId: string;
  readonly ok: boolean;
  readonly detail: string;
} {
  return (
    isRecord(value) &&
    typeof value["accountId"] === "string" &&
    typeof value["ok"] === "boolean" &&
    typeof value["detail"] === "string"
  );
}

function parseEventData(event: MessageEvent): unknown {
  const raw: unknown = event.data;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function streamErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const message = value["message"];
  return typeof message === "string" && message.trim() !== "" ? message : null;
}

export function useMailData(): MailData {
  const [mode, setMode] = useState<ConnectionMode>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [accounts, setAccounts] = useState<readonly AccountView[]>([]);
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [llmConfigs, setLlmConfigs] = useState<readonly LlmConfigView[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [extractProgress, setExtractProgress] = useState<ExtractProgress | null>(null);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [resyncToken, setResyncToken] = useState(0);
  const [deviceLogin, setDeviceLogin] = useState<DeviceLoginState | null>(null);
  const [graphLoggedIn, setGraphLoggedIn] = useState<Readonly<Record<string, boolean>>>({});
  const [streamConnected, setStreamConnected] = useState(false);
  const streamConnectedRef = useRef(false);
  const deviceLoginAccountRef = useRef<string | null>(null);

  const counts = useMemo(() => deriveCounts(tasks), [tasks]);

  const pushNotice = useCallback((kind: Notice["kind"], text: string) => {
    setNotice({ kind, text });
  }, []);

  const loadDemo = useCallback(() => {
    setProfile(createMockProfile());
    setAccounts(createMockAccounts());
    setTasks(createMockTasks());
    setLlmConfigs(createMockLlmConfigs());
    setError(null);
    setMode("demo");
  }, []);

  const applyLiveData = useCallback((data: LiveData) => {
    setProfile(data.profile);
    setAccounts(data.accounts);
    setTasks(data.tasks);
    setLlmConfigs(data.llmConfigs);
  }, []);

  const bootstrap = useCallback(async () => {
    setMode("loading");
    setError(null);
    const injected = hasInjectedRuntime();
    try {
      const health = await api.health();
      if (!health.ok) throw new ApiError("internal", "本地服务健康检查未通过", 500);
      applyLiveData(await fetchLiveData());
      setMode("live");
    } catch (caught) {
      // 未注入运行时（纯浏览器）时，健康检查失败一律回落到演示数据；注入运行时则报连接错误。
      const unauthorized = isApiError(caught) && caught.code === "unauthorized";
      if (!injected && !unauthorized) {
        loadDemo();
        return;
      }
      setMode("offline");
      setError(failureText(caught));
    }
  }, [applyLiveData, loadDemo]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const reloadAccounts = useCallback(async (): Promise<void> => {
    try {
      setAccounts(await api.accounts.list());
    } catch (caught) {
      if (isApiError(caught) && (caught.code === "network" || caught.code === "unauthorized")) return;
      pushNotice("error", failureText(caught));
    }
  }, [pushNotice]);

  const loginAccount = useCallback(
    async (accountId: string): Promise<boolean> => {
      if (mode !== "live" || !streamConnected) {
        pushNotice("error", "需要连接服务端并保持实时连接，才能登录 Microsoft 账号");
        return false;
      }
      setDeviceLogin({
        accountId,
        phase: "requesting",
        userCode: null,
        verificationUri: null,
        message: null,
        expiresInSeconds: 0,
        startedAt: Date.now(),
        error: null,
      });
      deviceLoginAccountRef.current = accountId;
      try {
        await api.accounts.login(accountId);
        return true;
      } catch (caught) {
        deviceLoginAccountRef.current = null;
        setDeviceLogin(null);
        pushNotice("error", failureText(caught));
        return false;
      }
    },
    [mode, pushNotice, streamConnected],
  );

  const dismissDeviceLogin = useCallback(() => {
    deviceLoginAccountRef.current = null;
    setDeviceLogin(null);
  }, []);

  const retryDeviceLogin = useCallback(async (): Promise<boolean> => {
    const accountId = deviceLoginAccountRef.current;
    if (accountId === null) return false;
    return loginAccount(accountId);
  }, [loginAccount]);

  const reloadTasks = useCallback(async (): Promise<void> => {
    try {
      const response = await api.tasks.list();
      setTasks(response.items);
    } catch (caught) {
      if (isApiError(caught) && (caught.code === "network" || caught.code === "unauthorized")) return;
      pushNotice("error", failureText(caught));
    }
  }, [pushNotice]);

  useEffect(() => {
    if (mode !== "live") return;
    const token = resolveToken();
    if (token === "") return;

    let disposed = false;
    let source: EventSource | null = null;
    let retryTimer: number | null = null;
    let retryDelay = 1000;

    const onMessage = (handler: (payload: unknown) => void) => (event: Event): void => {
      if (!(event instanceof MessageEvent)) return;
      handler(parseEventData(event));
    };

    const connect = (): void => {
      if (disposed) return;
      const next = new EventSource(eventsUrl(token));
      source = next;

      next.addEventListener("open", () => {
        if (disposed) return;
        retryDelay = 1000;
        setStreamConnected(true);
        setStreamError(null);
        if (streamConnectedRef.current) {
          void reloadTasks();
          setResyncToken((previous) => previous + 1);
        }
        streamConnectedRef.current = true;
      });

      next.addEventListener("task", onMessage((payload) => {
        if (!isTaskPayload(payload)) return;
        const incoming = payload;
        setTasks((previous) => {
          const index = previous.findIndex((task) => task.id === incoming.id);
          if (index === -1) return [...previous, incoming];
          const copy = previous.slice();
          copy[index] = incoming;
          return copy;
        });
      }));

      next.addEventListener("extract", onMessage((payload) => {
        if (!isExtractProgress(payload)) return;
        setExtractProgress(payload);
      }));

      next.addEventListener("sync", onMessage((payload) => {
        if (!isSyncProgress(payload)) return;
        if (payload.phase === "error") {
          setSyncProgress(null);
          setStreamError(payload.message ?? "同步失败");
          return;
        }
        if (payload.phase === "done") {
          setSyncProgress(null);
          return;
        }
        setSyncProgress(payload);
      }));

      next.addEventListener("device-code", onMessage((payload) => {
        if (!isDeviceCodePayload(payload)) return;
        if (deviceLoginAccountRef.current !== payload.accountId) return;
        setDeviceLogin({
          accountId: payload.accountId,
          phase: "waiting",
          userCode: payload.userCode,
          verificationUri: payload.verificationUri,
          message: payload.message,
          expiresInSeconds: payload.expiresInSeconds,
          startedAt: Date.now(),
          error: null,
        });
      }));

      next.addEventListener("device-login", onMessage((payload) => {
        if (!isDeviceLoginPayload(payload)) return;
        const active = deviceLoginAccountRef.current === payload.accountId;
        if (payload.ok) {
          setGraphLoggedIn((previous) => ({ ...previous, [payload.accountId]: true }));
          if (active) {
            deviceLoginAccountRef.current = null;
            setDeviceLogin(null);
          }
          void reloadAccounts();
          pushNotice("ok", payload.detail.trim() === "" ? "Microsoft 登录成功" : payload.detail);
          return;
        }
        if (active) {
          setDeviceLogin((previous) =>
            previous === null ? null : { ...previous, phase: "failed", error: payload.detail },
          );
          return;
        }
        pushNotice("error", `Microsoft 登录失败：${payload.detail}`);
      }));

      next.addEventListener("error", (event: Event) => {
        if (disposed) return;
        if (event instanceof MessageEvent) {
          setStreamError(streamErrorMessage(parseEventData(event)) ?? "服务端推送了一条错误事件");
          return;
        }
        source?.close();
        source = null;
        setStreamConnected(false);
        setStreamError("实时连接已断开，正在重连…");
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      });
    };

    connect();

    return () => {
      disposed = true;
      setStreamConnected(false);
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [mode, reloadAccounts, reloadTasks, pushNotice]);

  const retry = useCallback(() => {
    void bootstrap();
  }, [bootstrap]);

  const refresh = useCallback(() => {
    if (mode === "demo") {
      loadDemo();
      pushNotice("ok", "演示数据已重置");
      return;
    }
    if (mode === "offline" || mode === "loading") {
      void bootstrap();
      return;
    }
    void (async () => {
      try {
        applyLiveData(await fetchLiveData());
        pushNotice("ok", "已刷新");
      } catch (caught) {
        pushNotice("error", failureText(caught));
      }
    })();
  }, [applyLiveData, bootstrap, loadDemo, mode, pushNotice]);

  const saveProfile = useCallback(
    async (input: UpsertProfileInput): Promise<boolean> => {
      if (mode === "demo") {
        const now = new Date().toISOString();
        setProfile((previous) => ({
          ...(previous ?? createMockProfile()),
          ...input,
          updatedAt: now,
        }));
        pushNotice("ok", "档案已保存（演示数据，仅本次会话）");
        return true;
      }
      if (mode !== "live") return false;
      try {
        setProfile(await api.profile.save(input));
        pushNotice("ok", "档案已保存");
        return true;
      } catch (caught) {
        pushNotice("error", failureText(caught));
        return false;
      }
    },
    [mode, pushNotice],
  );

  const addAccount = useCallback(
    async (input: CreateAccountInput): Promise<boolean> => {
      if (mode === "demo") {
        const account: AccountView = {
          id: newId("acc-demo"),
          provider: input.provider,
          label: input.label || input.email,
          email: input.email,
          enabled: true,
          hasSecret: input.secret !== "",
          lastSyncAt: null,
          createdAt: new Date().toISOString(),
        };
        setAccounts((previous) => [...previous, account]);
        pushNotice("ok", "账号已添加（演示数据，仅本次会话）");
        return true;
      }
      if (mode !== "live") return false;
      try {
        const account = await api.accounts.create(input);
        setAccounts((previous) => [...previous, account]);
        pushNotice("ok", "账号已添加");
        return true;
      } catch (caught) {
        pushNotice("error", failureText(caught));
        return false;
      }
    },
    [mode, pushNotice],
  );

  const removeAccount = useCallback(
    async (accountId: string): Promise<boolean> => {
      if (mode === "demo") {
        setAccounts((previous) => previous.filter((account) => account.id !== accountId));
        pushNotice("ok", "账号已移除（演示数据）");
        return true;
      }
      if (mode !== "live") return false;
      try {
        await api.accounts.remove(accountId);
        setAccounts((previous) => previous.filter((account) => account.id !== accountId));
        pushNotice("ok", "账号已移除");
        return true;
      } catch (caught) {
        pushNotice("error", failureText(caught));
        return false;
      }
    },
    [mode, pushNotice],
  );

  const verifyAccount = useCallback(
    async (accountId: string): Promise<VerifyAccountResponse> => {
      if (mode === "demo") {
        const account = accounts.find((item) => item.id === accountId);
        return {
          ok: true,
          detail: `演示数据：模拟验证通过（${account?.email ?? accountId}），未真正连接邮箱。`,
        };
      }
      if (mode !== "live") return { ok: false, detail: "当前没有可用连接" };
      try {
        return await api.accounts.verify(accountId);
      } catch (caught) {
        return { ok: false, detail: failureText(caught) };
      }
    },
    [accounts, mode],
  );

  const updateTask = useCallback(
    async (taskId: string, input: UpdateTaskInput): Promise<boolean> => {
      if (mode === "demo") {
        setTasks((previous) =>
          previous.map((task) => (task.id === taskId ? applyTaskPatch(task, input) : task)),
        );
        return true;
      }
      if (mode !== "live") return false;
      try {
        const updated = await api.tasks.update(taskId, input);
        setTasks((previous) => previous.map((task) => (task.id === taskId ? updated : task)));
        return true;
      } catch (caught) {
        pushNotice("error", failureText(caught));
        return false;
      }
    },
    [mode, pushNotice],
  );

  const bulkDecision = useCallback(
    async (input: BulkDecisionInput): Promise<boolean> => {
      const confirmed = input.decision === "confirm";
      if (input.ids.length === 0) return false;
      if (mode === "demo") {
        setTasks((previous) =>
          previous.map((task) =>
            input.ids.includes(task.id)
              ? {
                  ...task,
                  status: confirmed ? "confirmed" : "dismissed",
                  updatedAt: new Date().toISOString(),
                }
              : task,
          ),
        );
        pushNotice("ok", confirmed ? "已加入待办（演示数据）" : "已忽略（演示数据）");
        return true;
      }
      if (mode !== "live") return false;
      try {
        const updated = await api.tasks.bulk(input);
        setTasks((previous) => mergeTasks(previous, updated));
        pushNotice("ok", confirmed ? "已加入待办" : "已忽略");
        return true;
      } catch (caught) {
        pushNotice("error", failureText(caught));
        return false;
      }
    },
    [mode, pushNotice],
  );

  const saveLlmConfig = useCallback(
    async (input: LlmConfigInput): Promise<boolean> => {
      if (mode === "demo") {
        const config: LlmConfigView = {
          id: newId("llm-demo"),
          label: input.label,
          protocol: input.protocol,
          baseUrl: input.baseUrl,
          model: input.model,
          hasKey: typeof input.apiKey === "string" && input.apiKey !== "",
          isDefault: input.isDefault === true,
        };
        setLlmConfigs((previous) => upsertLlm(previous, config));
        pushNotice("ok", "供应商配置已保存（演示数据，Key 不会落盘）");
        return true;
      }
      if (mode !== "live") return false;
      try {
        const config = await api.llm.save(input);
        setLlmConfigs((previous) => upsertLlm(previous, config));
        pushNotice("ok", "供应商配置已保存");
        return true;
      } catch (caught) {
        pushNotice("error", failureText(caught));
        return false;
      }
    },
    [mode, pushNotice],
  );

  const setDefaultLlmConfig = useCallback(
    async (configId: string): Promise<boolean> => {
      if (mode === "demo") {
        setLlmConfigs((previous) =>
          previous.map((config) => ({ ...config, isDefault: config.id === configId })),
        );
        pushNotice("ok", "已设为默认（演示数据）");
        return true;
      }
      if (mode !== "live") return false;
      try {
        await api.llm.setDefault(configId);
        setLlmConfigs((previous) =>
          previous.map((config) => ({ ...config, isDefault: config.id === configId })),
        );
        pushNotice("ok", "已设为默认供应商");
        return true;
      } catch (caught) {
        pushNotice("error", failureText(caught));
        return false;
      }
    },
    [mode, pushNotice],
  );

  const removeLlmConfig = useCallback(
    async (configId: string): Promise<boolean> => {
      if (mode === "demo") {
        setLlmConfigs((previous) => previous.filter((config) => config.id !== configId));
        pushNotice("ok", "已删除（演示数据）");
        return true;
      }
      if (mode !== "live") return false;
      try {
        await api.llm.remove(configId);
        setLlmConfigs((previous) => previous.filter((config) => config.id !== configId));
        pushNotice("ok", "已删除");
        return true;
      } catch (caught) {
        pushNotice("error", failureText(caught));
        return false;
      }
    },
    [mode, pushNotice],
  );

  const testLlm = useCallback(
    async (input: LlmTestInput): Promise<LlmTestResponse> => {
      if (mode === "demo") {
        await new Promise((resolve) => window.setTimeout(resolve, 420));
        return {
          ok: true,
          latencyMs: 42,
          detail: "演示数据：未真正请求供应商，接入服务端后会返回真实延迟与错误详情。",
        };
      }
      try {
        return await api.llm.test(input);
      } catch (caught) {
        return { ok: false, latencyMs: 0, detail: failureText(caught) };
      }
    },
    [mode],
  );

  const syncAccount = useCallback(
    async (accountId: string, full = false): Promise<boolean> => {
      if (mode === "demo") {
        pushNotice("ok", "演示数据：模拟同步完成，未连接真实邮箱");
        return true;
      }
      if (mode !== "live") return false;
      try {
        await api.sync.start({ accountId, full });
        pushNotice("ok", "同步任务已提交，完成后点「刷新」查看结果");
        return true;
      } catch (caught) {
        pushNotice("error", failureText(caught));
        return false;
      }
    },
    [mode, pushNotice],
  );

  const runExtract = useCallback(async (): Promise<boolean> => {
    if (mode === "demo") {
      pushNotice("ok", "演示数据：模拟抽取完成");
      return true;
    }
    if (mode !== "live") return false;
    try {
      await api.extract.run();
      pushNotice("ok", "抽取任务已提交，完成后点「刷新」查看结果");
      return true;
    } catch (caught) {
      pushNotice("error", failureText(caught));
      return false;
    }
  }, [mode, pushNotice]);

  const dismissNotice = useCallback(() => setNotice(null), []);
  const dismissStreamError = useCallback(() => setStreamError(null), []);

  return {
    mode,
    error,
    notice,
    streamError,
    extractProgress,
    syncProgress,
    resyncToken,
    deviceLogin,
    graphLoggedIn,
    streamConnected,
    canLoginDevice: mode === "live" && streamConnected,
    profile,
    accounts,
    tasks,
    llmConfigs,
    counts,
    retry,
    enterDemo: loadDemo,
    refresh,
    dismissNotice,
    dismissStreamError,
    loginAccount,
    retryDeviceLogin,
    dismissDeviceLogin,
    saveProfile,
    addAccount,
    removeAccount,
    verifyAccount,
    updateTask,
    bulkDecision,
    saveLlmConfig,
    setDefaultLlmConfig,
    removeLlmConfig,
    testLlm,
    syncAccount,
    runExtract,
  };
}
