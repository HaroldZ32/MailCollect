import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AccountView,
  BulkDecisionInput,
  CreateAccountInput,
  LlmConfigInput,
  LlmConfigView,
  LlmTestInput,
  LlmTestResponse,
  Task,
  TaskCounts,
  TaskTime,
  UpdateTaskInput,
  UpsertProfileInput,
  UserProfile,
  VerifyAccountResponse,
} from "@mailcollect/shared";
import { api, ApiError, hasInjectedRuntime, isApiError } from "./api";
import { createMockAccounts, createMockLlmConfigs, createMockProfile, createMockTasks } from "./mock";

export type ConnectionMode = "loading" | "live" | "demo" | "offline";

export interface Notice {
  readonly kind: "ok" | "error";
  readonly text: string;
}

export interface MailData {
  readonly mode: ConnectionMode;
  readonly error: string | null;
  readonly notice: Notice | null;
  readonly profile: UserProfile | null;
  readonly accounts: readonly AccountView[];
  readonly tasks: readonly Task[];
  readonly llmConfigs: readonly LlmConfigView[];
  readonly counts: TaskCounts;
  readonly retry: () => void;
  readonly enterDemo: () => void;
  readonly refresh: () => void;
  readonly dismissNotice: () => void;
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
  for (const task of tasks) counts[task.status] += 1;
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

export function useMailData(): MailData {
  const [mode, setMode] = useState<ConnectionMode>("loading");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [accounts, setAccounts] = useState<readonly AccountView[]>([]);
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [llmConfigs, setLlmConfigs] = useState<readonly LlmConfigView[]>([]);

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

  return {
    mode,
    error,
    notice,
    profile,
    accounts,
    tasks,
    llmConfigs,
    counts,
    retry,
    enterDemo: loadDemo,
    refresh,
    dismissNotice,
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
