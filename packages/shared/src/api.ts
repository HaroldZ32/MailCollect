import type {
  ChangeLogRow,
  LlmProtocol,
  MailProvider,
  RawEmail,
  SyncProgress,
  Task,
  TaskStatus,
} from "./domain.js";

/**
 * HTTP surface — FROZEN CONTRACT. The UI is written against this file.
 * Every route is under API_PREFIX and (except /health) requires
 * `Authorization: Bearer <token>`.
 */
export const API_PREFIX = "/api";

export type ApiErrorCode =
  | "unauthorized"
  | "not_found"
  | "invalid_input"
  | "upstream_error"
  | "internal";

export interface ApiErrorBody {
  error: { code: ApiErrorCode; message: string };
}

export interface HealthResponse {
  ok: true;
  version: string;
  dbPath: string;
  hasProfile: boolean;
  accountCount: number;
}

/* ---------------------------------- profile --------------------------------- */

export interface UpsertProfileInput {
  displayName: string;
  aliases: string[];
  emails: string[];
  timezone: string;
}

/* --------------------------------- accounts --------------------------------- */

export interface CreateAccountInput {
  provider: MailProvider;
  label: string;
  email: string;
  /** Non-secret settings: host, port, tls, mailbox, user. */
  config: Record<string, string>;
  /** Password / app password / refresh token. Encrypted at rest, never returned. */
  secret: string;
}

export interface AccountView {
  id: string;
  provider: MailProvider;
  label: string;
  email: string;
  enabled: boolean;
  /** Never the secret itself. */
  hasSecret: boolean;
  lastSyncAt: string | null;
  createdAt: string;
}

export interface VerifyAccountResponse {
  ok: boolean;
  detail: string;
}

/* ---------------------------------- emails ---------------------------------- */

export interface EmailListQuery {
  accountId?: string;
  limit?: number;
  cursor?: string;
  search?: string;
}

export interface EmailListResponse {
  items: RawEmail[];
  nextCursor: string | null;
}

/* ----------------------------------- tasks ---------------------------------- */

export interface TaskListQuery {
  status?: TaskStatus;
  /** ISO lower bound on the task's time (dueAt / windowStart). */
  from?: string;
  /** ISO upper bound. */
  to?: string;
  /** Include tasks whose origin is broadcast (default true). */
  includeBroadcast?: boolean;
}

export interface TaskCounts {
  candidate: number;
  confirmed: number;
  dismissed: number;
  done: number;
}

export interface TaskListResponse {
  items: Task[];
  counts: TaskCounts;
}

export interface UpdateTaskInput {
  title?: string;
  detail?: string | null;
  status?: TaskStatus;
  dueAt?: string | null;
  windowStart?: string | null;
  windowEnd?: string | null;
}

export interface BulkDecisionInput {
  /** Task ids to accept as personal TODOs. */
  ids: string[];
  /** When set, remember this decision for the whole mailing list. */
  listId?: string | null;
  decision: "confirm" | "dismiss";
}

/* ------------------------------------ llm ----------------------------------- */

export interface LlmTestInput {
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface LlmTestResponse {
  ok: boolean;
  latencyMs: number;
  detail: string;
}

export interface LlmConfigInput {
  label: string;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  /** Only sent when the user types a key; never returned by the server. */
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  isDefault?: boolean;
}

export interface LlmConfigView {
  id: string;
  label: string;
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  hasKey: boolean;
  isDefault: boolean;
}

/* ----------------------------------- sync ----------------------------------- */

export interface SyncRequest {
  accountId: string;
  /** Ignore the stored cursor and re-fetch from scratch. */
  full?: boolean;
}

export interface SyncResponse {
  jobId: string;
}

export interface ExtractRequest {
  accountId?: string;
  /** Re-run extraction over already-stored emails. */
  emailIds?: string[];
}

/**
 * The reserved cloud-sync seam (R7).
 * A future sync backend only has to reproduce this ordered operation stream.
 */
export interface SyncChangesResponse {
  head: number;
  items: ChangeLogRow[];
}

/* ----------------------------------- SSE ------------------------------------ */

export type ServerEvent =
  | { type: "sync"; data: SyncProgress }
  | { type: "task"; data: Task }
  | { type: "email"; data: { id: string; accountId: string; subject: string } }
  | { type: "extract"; data: { done: number; total: number } }
  | { type: "error"; data: { message: string } };
