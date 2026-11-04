import type {
  AccountView,
  ApiErrorBody,
  ApiErrorCode,
  BroadcastVerdict,
  BulkDecisionInput,
  CreateAccountInput,
  EmailListQuery,
  EmailListResponse,
  HealthResponse,
  LlmConfigInput,
  LlmConfigView,
  LlmTestInput,
  LlmTestResponse,
  RawEmail,
  SyncRequest,
  SyncResponse,
  Task,
  TaskListQuery,
  TaskListResponse,
  UpdateTaskInput,
  UpsertProfileInput,
  UserProfile,
  VerifyAccountResponse,
} from "@mailcollect/shared";

export interface MailCollectRuntime {
  readonly apiBase?: string;
  readonly token?: string;
}

declare global {
  interface Window {
    __MAILCOLLECT__?: MailCollectRuntime;
  }
}

// 与 packages/shared/src/api.ts 的冻结契约保持一致；用本地常量避免把 shared 的运行时依赖（zod）打进首屏 chunk。
const API_PREFIX = "/api";

export const TOKEN_STORAGE_KEY = "mailcollect.token";
const DEV_FALLBACK_TOKEN = "dev-local-token";
const DEFAULT_TIMEOUT_MS = 15_000;

const API_ERROR_CODES: readonly ApiErrorCode[] = [
  "unauthorized",
  "not_found",
  "invalid_input",
  "upstream_error",
  "internal",
];

export type ApiFailureCode = ApiErrorCode | "network";

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiFailureCode;

  constructor(code: ApiFailureCode, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function isApiError(value: unknown): value is ApiError {
  return value instanceof ApiError;
}

function readStoredToken(): string | null {
  try {
    const stored = window.localStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored === null) return null;
    const trimmed = stored.trim();
    return trimmed === "" ? null : trimmed;
  } catch (error) {
    if (error instanceof DOMException) return null;
    throw error;
  }
}

export function resolveApiBase(): string {
  return window.__MAILCOLLECT__?.apiBase ?? "";
}

export function resolveToken(): string {
  const injected = window.__MAILCOLLECT__?.token;
  if (typeof injected === "string" && injected.trim() !== "") return injected;
  return readStoredToken() ?? DEV_FALLBACK_TOKEN;
}

export function storeToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
  } catch (error) {
    if (error instanceof DOMException) return;
    throw error;
  }
}

export function clearStoredToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch (error) {
    if (error instanceof DOMException) return;
    throw error;
  }
}

export function hasInjectedRuntime(): boolean {
  return window.__MAILCOLLECT__ !== undefined;
}

export function hasStoredToken(): boolean {
  return readStoredToken() !== null;
}

function queryString(params: Readonly<Record<string, string | number | boolean | undefined>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === "" ? "" : `?${encoded}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && API_ERROR_CODES.some((code) => code === value);
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (!isRecord(value)) return false;
  const error = value["error"];
  if (!isRecord(error)) return false;
  return isApiErrorCode(error["code"]) && typeof error["message"] === "string";
}

interface JsonRequest {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly body?: unknown;
  readonly auth?: boolean;
  readonly timeoutMs?: number;
}

async function readErrorPayload(response: Response): Promise<ApiErrorBody | null> {
  try {
    const payload: unknown = await response.json();
    return isApiErrorBody(payload) ? payload : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

/**
 * 信任边界：服务端与本包同仓、共享同一份冻结的 TypeScript 契约（packages/shared/src/api.ts），
 * 浏览器侧不重复做运行期校验；解析失败由调用方的错误分支兜底。
 */
function parseContract<T>(payload: unknown): T {
  return payload as T;
}

async function requestJson<T>(path: string, init: JsonRequest = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.auth !== false) headers["authorization"] = `Bearer ${resolveToken()}`;

  let response: Response;
  try {
    response = await fetch(`${resolveApiBase()}${API_PREFIX}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new ApiError("network", "请求超时，本地服务可能没有启动", 0);
    }
    if (error instanceof TypeError) {
      throw new ApiError("network", "无法连接本地服务", 0);
    }
    throw error;
  }

  if (!response.ok) {
    const payload = await readErrorPayload(response);
    if (payload !== null) throw new ApiError(payload.error.code, payload.error.message, response.status);
    throw new ApiError("internal", `请求失败（HTTP ${response.status}）`, response.status);
  }

  return parseContract<T>(await response.json());
}

export interface EmailDetail {
  readonly email: RawEmail;
  readonly verdict: BroadcastVerdict | null;
}

export interface LlmConfigResponse {
  readonly config: LlmConfigView;
}

export const api = {
  health: (): Promise<HealthResponse> => requestJson<HealthResponse>("/health", { auth: false }),

  profile: {
    get: async (): Promise<UserProfile | null> => {
      const payload = await requestJson<{ profile: UserProfile | null }>("/profile");
      return payload.profile;
    },
    save: async (input: UpsertProfileInput): Promise<UserProfile> => {
      const payload = await requestJson<{ profile: UserProfile }>("/profile", {
        method: "PUT",
        body: input,
      });
      return payload.profile;
    },
  },

  accounts: {
    list: async (): Promise<readonly AccountView[]> => {
      const payload = await requestJson<{ items: AccountView[] }>("/accounts");
      return payload.items;
    },
    create: async (input: CreateAccountInput): Promise<AccountView> => {
      const payload = await requestJson<{ account: AccountView }>("/accounts", {
        method: "POST",
        body: input,
      });
      return payload.account;
    },
    remove: async (accountId: string): Promise<void> => {
      await requestJson<{ ok: boolean }>(`/accounts/${encodeURIComponent(accountId)}`, {
        method: "DELETE",
      });
    },
    verify: (accountId: string): Promise<VerifyAccountResponse> =>
      requestJson<VerifyAccountResponse>(`/accounts/${encodeURIComponent(accountId)}/verify`, {
        method: "POST",
      }),
  },

  emails: {
    list: (query: EmailListQuery): Promise<EmailListResponse> =>
      requestJson<EmailListResponse>(
        `/emails${queryString({
          accountId: query.accountId,
          limit: query.limit,
          cursor: query.cursor,
          search: query.search,
        })}`,
      ),
    get: (emailId: string): Promise<EmailDetail> =>
      requestJson<EmailDetail>(`/emails/${encodeURIComponent(emailId)}`),
  },

  tasks: {
    list: (query: TaskListQuery = {}): Promise<TaskListResponse> =>
      requestJson<TaskListResponse>(
        `/tasks${queryString({
          status: query.status,
          from: query.from,
          to: query.to,
          includeBroadcast: query.includeBroadcast,
        })}`,
      ),
    update: async (taskId: string, input: UpdateTaskInput): Promise<Task> => {
      const payload = await requestJson<{ task: Task }>(`/tasks/${encodeURIComponent(taskId)}`, {
        method: "PATCH",
        body: input,
      });
      return payload.task;
    },
    bulk: async (input: BulkDecisionInput): Promise<readonly Task[]> => {
      const payload = await requestJson<{ items: Task[] }>("/tasks/bulk", {
        method: "POST",
        body: input,
      });
      return payload.items;
    },
  },

  llm: {
    test: (input: LlmTestInput): Promise<LlmTestResponse> =>
      requestJson<LlmTestResponse>("/llm/test", { method: "POST", body: input }),
    list: async (): Promise<readonly LlmConfigView[]> => {
      const payload = await requestJson<{ items: LlmConfigView[] }>("/llm/configs");
      return payload.items;
    },
    save: async (input: LlmConfigInput): Promise<LlmConfigView> => {
      const payload = await requestJson<LlmConfigResponse>("/llm/configs", {
        method: "POST",
        body: input,
      });
      return payload.config;
    },
    setDefault: (configId: string): Promise<{ ok: boolean }> =>
      requestJson<{ ok: boolean }>(`/llm/configs/${encodeURIComponent(configId)}/default`, {
        method: "POST",
      }),
    remove: async (configId: string): Promise<void> => {
      await requestJson<{ ok: boolean }>(`/llm/configs/${encodeURIComponent(configId)}`, {
        method: "DELETE",
      });
    },
  },

  sync: {
    start: (input: SyncRequest): Promise<SyncResponse> =>
      requestJson<SyncResponse>("/sync", { method: "POST", body: input }),
  },

  extract: {
    run: async (): Promise<void> => {
      await requestJson<{ ok: boolean }>("/extract", { method: "POST", body: {} });
    },
  },
};

export function eventsUrl(token: string): string {
  return `${resolveApiBase()}${API_PREFIX}/events?token=${encodeURIComponent(token)}`;
}

export function apiBaseLabel(): string {
  const base = resolveApiBase();
  return base === "" ? "同源（经 Vite /api 代理）" : base;
}
