import type {
  AccountView,
  ApiErrorBody,
  ApiErrorCode,
  AccountSendInput,
  AttachmentListResponse,
  AttachmentMeta,
  AutodiscoverResponse,
  BroadcastVerdict,
  BulkDecisionInput,
  Category,
  CategoryListResponse,
  CreateAccountInput,
  CreateCategoryInput,
  CreateRuleInput,
  DiscoverAccountInput,
  DiscoverAccountResponse,
  Draft,
  DraftListQuery,
  DraftListResponse,
  EmailListQuery,
  EmailListResponse,
  Folder,
  FolderListQuery,
  FolderListResponse,
  HealthResponse,
  LlmConfigInput,
  LlmConfigView,
  LlmTestInput,
  LlmTestResponse,
  MessageDetailResponse,
  MessageListQuery,
  MessageListResponse,
  MoveMessageInput,
  OnboardingStatusResponse,
  OutboxActionResponse,
  OutboxItem,
  OutboxListQuery,
  OutboxListResponse,
  RawEmail,
  RecomputeRequest,
  RecomputeResponse,
  RecomputeStatusResponse,
  ReorderRulesInput,
  Rule,
  RuleListResponse,
  SaveDraftInput,
  SaveDraftResponse,
  SendMessageInput,
  SendMessageResponse,
  SyncRequest,
  SyncResponse,
  Task,
  TaskListQuery,
  TaskListResponse,
  UpdateCategoryInput,
  UpdateAccountInput,
  UpdateMessageInput,
  UpdateOnboardingInput,
  UpdateRuleInput,
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
  return (window.__MAILCOLLECT__?.apiBase ?? "").replace(/\/+$/, "");
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

type QueryValue = string | number | boolean | readonly string[] | undefined;

function queryString(params: Readonly<Record<string, QueryValue>>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== "") search.append(key, item);
      }
      continue;
    }
    if (value === "") continue;
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
  /** 调用方取消：数据层在 key 变化/强制刷新时中止在途请求。 */
  readonly signal?: AbortSignal;
}

/** v1.1 读请求可选的取消通道（写请求不暴露：写操作一旦发出不应被切面板中止）。 */
/**
 * UI 侧「可清除」的发信入参。服务端 `PATCH /api/accounts/:id` 的
 * `send.signature` / `send.displayName` 接受显式 `null` 表示清除
 * （见 apps/server/src/routes/accounts.ts 的 parseSendInput），
 * 但 shared 的 `AccountSendInput` 目前仍是 `string`。这里只做类型跟随，
 * 不改任何运行行为；shared 补上 `null` 后删掉本类型即可。
 */
export type ClearableAccountSendInput = Omit<AccountSendInput, "signature" | "displayName"> & {
  readonly signature?: string | null;
  readonly displayName?: string | null;
};

export type UpdateAccountPayload = Omit<UpdateAccountInput, "send"> & {
  readonly send?: ClearableAccountSendInput;
};

export interface RequestOptions {
  readonly signal?: AbortSignal;
}

const ATTACHMENT_TIMEOUT_MS = 120_000;

/** 把调用方 signal 与服务端超时合成为一个 signal；超时与主动取消在 catch 里分开映射。 */
function composeSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller === undefined ? timeout : AbortSignal.any([caller, timeout]);
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

async function issueRequest(path: string, init: JsonRequest = {}): Promise<Response> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.auth !== false) headers["authorization"] = `Bearer ${resolveToken()}`;

  let response: Response;
  try {
    response = await fetch(`${resolveApiBase()}${API_PREFIX}${path}`, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: composeSignal(init.signal, init.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      // 主动取消：原样上抛，由数据层忽略；只有服务端超时才算连接故障。
      if (init.signal?.aborted === true) throw error;
      throw new ApiError("network", "请求超时，本地服务可能没有启动", 0);
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
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

  return response;
}

async function requestJson<T>(path: string, init: JsonRequest = {}): Promise<T> {
  const response = await issueRequest(path, init);
  return parseContract<T>(await response.json());
}

/**
 * 状态型写端点：shared 未冻结单体响应信封（可能在 {ok:true} / {item} / 空体之间）。
 * 这里只校验 HTTP 状态并容忍任意 JSON 体，避免把 UI 绑死在未固定的信封上。
 */
async function requestOk(path: string, init: JsonRequest = {}): Promise<void> {
  const response = await issueRequest(path, init);
  try {
    await response.json();
  } catch (error) {
    if (error instanceof SyntaxError) return;
    throw error;
  }
}

/**
 * 单体实体信封（accounts/categories/rules 的 create/update）：shared 未冻结响应类型。
 * 同时接受 {account|category|rule}、{item} 与裸对象，服务端信封落地后再收紧。
 */
function unwrapEntity<T>(payload: unknown, key: string): T {
  if (isRecord(payload)) {
    const wrapped = payload[key];
    if (wrapped !== undefined) return wrapped as T;
    const item = payload["item"];
    if (item !== undefined) return item as T;
  }
  return payload as T;
}

export interface AttachmentBlob {
  readonly blob: Blob;
  /** 取自 Content-Disposition；服务端未给出时回退到附件的 AttachmentMeta。 */
  readonly filename: string | null;
  readonly mimeType: string | null;
}

function filenameFromDisposition(value: string | null): string | null {
  if (value === null) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (encoded !== null) {
    const raw = encoded[1];
    if (raw === undefined) return null;
    try {
      return decodeURIComponent(raw);
    } catch (error) {
      if (error instanceof URIError) return null;
      throw error;
    }
  }
  const quoted = /filename="([^"]+)"/i.exec(value);
  if (quoted !== null) {
    const raw = quoted[1];
    return raw === undefined ? null : raw;
  }
  const bare = /filename=([^;]+)/i.exec(value);
  if (bare === null) return null;
  const raw = bare[1];
  return raw === undefined ? null : raw.trim();
}


export interface EmailDetail {
  readonly email: RawEmail;
  readonly verdict: BroadcastVerdict | null;
  /** 服务端归一化后的 List-Id（去尖括号、小写），用于「记住该列表」。 */
  readonly listId: string | null;
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
    /**
     * PATCH /api/accounts/:id —— 发信字段、身份（签名/显示名）、启用状态与密文轮换
     * （未出现的字段保持不变）。身份字段传 `null` 表示清除。
     */
    update: async (accountId: string, input: UpdateAccountPayload): Promise<AccountView> => {
      const payload = await requestJson<{ account: AccountView }>(
        `/accounts/${encodeURIComponent(accountId)}`,
        { method: "PATCH", body: input },
      );
      return unwrapEntity<AccountView>(payload, "account");
    },
    /** POST /api/accounts/discover —— 创建账号前的探测（向导第②步）。 */
    discover: (input: DiscoverAccountInput): Promise<DiscoverAccountResponse> =>
      requestJson<DiscoverAccountResponse>("/accounts/discover", { method: "POST", body: input }),
    /** POST /api/accounts/:id/autodiscover —— 对已存在账号的重探测。 */
    autodiscover: (accountId: string): Promise<AutodiscoverResponse> =>
      requestJson<AutodiscoverResponse>(`/accounts/${encodeURIComponent(accountId)}/autodiscover`, {
        method: "POST",
      }),
    remove: async (accountId: string): Promise<void> => {
      await requestJson<{ ok: boolean }>(`/accounts/${encodeURIComponent(accountId)}`, {
        method: "DELETE",
      });
    },
    verify: (accountId: string): Promise<VerifyAccountResponse> =>
      requestJson<VerifyAccountResponse>(`/accounts/${encodeURIComponent(accountId)}/verify`, {
        method: "POST",
      }),
    /** Graph 设备码登录：202 立即返回，码与结果通过 SSE 推送。 */
    login: async (accountId: string): Promise<void> => {
      await requestJson<{ ok: boolean }>(`/accounts/${encodeURIComponent(accountId)}/login`, {
        method: "POST",
      });
    },
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

  /* ------------------------------- v1.1 -------------------------------- */

  onboarding: {
    get: (options: RequestOptions = {}): Promise<OnboardingStatusResponse> =>
      requestJson<OnboardingStatusResponse>("/onboarding", { signal: options.signal }),
    update: (input: UpdateOnboardingInput): Promise<OnboardingStatusResponse> =>
      requestJson<OnboardingStatusResponse>("/onboarding", { method: "PUT", body: input }),
  },

  categories: {
    list: async (options: RequestOptions = {}): Promise<readonly Category[]> => {
      const payload = await requestJson<CategoryListResponse>("/categories", { signal: options.signal });
      return payload.items;
    },
    create: async (input: CreateCategoryInput): Promise<Category> => {
      const payload = await requestJson<{ category: Category }>("/categories", {
        method: "POST",
        body: input,
      });
      return unwrapEntity<Category>(payload, "category");
    },
    update: async (categoryId: string, input: UpdateCategoryInput): Promise<Category> => {
      const payload = await requestJson<{ category: Category }>(
        `/categories/${encodeURIComponent(categoryId)}`,
        { method: "PATCH", body: input },
      );
      return unwrapEntity<Category>(payload, "category");
    },
    /**
     * `confirm` 只作用于非空分类：第一次不带 confirm，服务端用 409 文案说明将连带删除的
     * 规则/邮件数量；用户确认后再带 `?confirm=true` 真正删除。空分类不带 confirm 也直接删。
     */
    remove: (categoryId: string, options: { readonly confirm?: boolean } = {}): Promise<void> =>
      requestOk(
        `/categories/${encodeURIComponent(categoryId)}${options.confirm === true ? "?confirm=true" : ""}`,
        { method: "DELETE" },
      ),
  },

  rules: {
    list: async (options: RequestOptions = {}): Promise<readonly Rule[]> => {
      const payload = await requestJson<RuleListResponse>("/rules", { signal: options.signal });
      return payload.items;
    },
    create: async (input: CreateRuleInput): Promise<Rule> => {
      const payload = await requestJson<{ rule: Rule }>("/rules", { method: "POST", body: input });
      return unwrapEntity<Rule>(payload, "rule");
    },
    update: async (ruleId: string, input: UpdateRuleInput): Promise<Rule> => {
      const payload = await requestJson<{ rule: Rule }>(`/rules/${encodeURIComponent(ruleId)}`, {
        method: "PATCH",
        body: input,
      });
      return unwrapEntity<Rule>(payload, "rule");
    },
    remove: (ruleId: string): Promise<void> =>
      requestOk(`/rules/${encodeURIComponent(ruleId)}`, { method: "DELETE" }),
    /** 拖拽排序：`ids` 是新的展示顺序；结果以 GET /rules 为准。 */
    reorder: (input: ReorderRulesInput): Promise<void> =>
      requestOk("/rules/reorder", { method: "POST", body: input }),
    recompute: (input: RecomputeRequest = {}): Promise<RecomputeResponse> =>
      requestJson<RecomputeResponse>("/rules/recompute", { method: "POST", body: input }),
    recomputeStatus: (jobId: string): Promise<RecomputeStatusResponse> =>
      requestJson<RecomputeStatusResponse>(`/rules/recompute/${encodeURIComponent(jobId)}`),
  },

  folders: {
    list: async (query: FolderListQuery, options: RequestOptions = {}): Promise<readonly Folder[]> => {
      const payload = await requestJson<FolderListResponse>(
        `/folders${queryString({ accountId: query.accountId })}`,
        { signal: options.signal },
      );
      return payload.items;
    },
  },

  messages: {
    list: (query: MessageListQuery = {}, options: RequestOptions = {}): Promise<MessageListResponse> =>
      requestJson<MessageListResponse>(
        `/messages${queryString({
          accountId: query.accountId,
          folder: query.folder,
          categoryIds: query.categoryIds,
          search: query.search,
          unreadOnly: query.unreadOnly,
          limit: query.limit,
          cursor: query.cursor,
        })}`,
        { signal: options.signal },
      ),
    get: (messageId: string, options: RequestOptions = {}): Promise<MessageDetailResponse> =>
      requestJson<MessageDetailResponse>(`/messages/${encodeURIComponent(messageId)}`, {
        signal: options.signal,
      }),
    update: (messageId: string, input: UpdateMessageInput): Promise<void> =>
      requestOk(`/messages/${encodeURIComponent(messageId)}`, { method: "PATCH", body: input }),
    move: (messageId: string, input: MoveMessageInput): Promise<void> =>
      requestOk(`/messages/${encodeURIComponent(messageId)}/move`, { method: "POST", body: input }),
  },

  attachments: {
    list: async (messageId: string, options: RequestOptions = {}): Promise<readonly AttachmentMeta[]> => {
      const payload = await requestJson<AttachmentListResponse>(
        `/messages/${encodeURIComponent(messageId)}/attachments`,
        { signal: options.signal },
      );
      return payload.items;
    },
    /** GET /api/messages/:id/attachments/:attachmentId 返回原始字节，不是 JSON。 */
    download: async (
      messageId: string,
      attachmentId: string,
      options: RequestOptions = {},
    ): Promise<AttachmentBlob> => {
      const response = await issueRequest(
        `/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
        { signal: options.signal, timeoutMs: ATTACHMENT_TIMEOUT_MS },
      );
      return {
        blob: await response.blob(),
        filename: filenameFromDisposition(response.headers.get("content-disposition")),
        mimeType: response.headers.get("content-type"),
      };
    },
  },

  send: {
    submit: (input: SendMessageInput): Promise<SendMessageResponse> =>
      requestJson<SendMessageResponse>("/send", { method: "POST", body: input }),
  },

  drafts: {
    list: async (query: DraftListQuery = {}, options: RequestOptions = {}): Promise<readonly Draft[]> => {
      const payload = await requestJson<DraftListResponse>(
        `/drafts${queryString({ accountId: query.accountId })}`,
        { signal: options.signal },
      );
      return payload.items;
    },
    save: async (input: SaveDraftInput): Promise<Draft> => {
      const payload = await requestJson<SaveDraftResponse>("/drafts", { method: "PUT", body: input });
      return payload.draft;
    },
    remove: (draftId: string): Promise<void> =>
      requestOk(`/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" }),
  },

  outbox: {
    list: async (
      query: OutboxListQuery = {},
      options: RequestOptions = {},
    ): Promise<readonly OutboxItem[]> => {
      const payload = await requestJson<OutboxListResponse>(
        `/outbox${queryString({ accountId: query.accountId, status: query.status })}`,
        { signal: options.signal },
      );
      return payload.items;
    },
    retry: async (outboxId: string): Promise<OutboxItem> => {
      const payload = await requestJson<OutboxActionResponse>(
        `/outbox/${encodeURIComponent(outboxId)}/retry`,
        { method: "POST" },
      );
      return payload.item;
    },
    remove: async (outboxId: string): Promise<OutboxItem> => {
      const payload = await requestJson<OutboxActionResponse>(
        `/outbox/${encodeURIComponent(outboxId)}`,
        { method: "DELETE" },
      );
      return payload.item;
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
