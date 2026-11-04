/**
 * Domain types — FROZEN CONTRACT.
 * Changing these requires the captain; members must not edit unilaterally.
 */

/** Wire protocol used to talk to a mailbox. */
export type MailProvider = "imap" | "pop3" | "graph";

/** Wire protocol used to talk to an LLM provider. */
export type LlmProtocol = "openai-compatible" | "anthropic-messages";

export interface UserProfile {
  id: string;
  /** Primary display name, e.g. "张三". */
  displayName: string;
  /** Name variants that may appear in email bodies: "张三", "张 三", "San Zhang". */
  aliases: string[];
  /** Every mailbox address that belongs to this person. */
  emails: string[];
  /** IANA zone, e.g. "Asia/Shanghai". Time resolution is anchored here. */
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

export interface Account {
  id: string;
  provider: MailProvider;
  label: string;
  email: string;
  /** Non-secret connection settings (host/port/tls/user/mailbox). Secrets live elsewhere. */
  config: Record<string, string>;
  enabled: boolean;
  createdAt: string;
}

export interface LlmConfig {
  id: string;
  label: string;
  protocol: LlmProtocol;
  /** e.g. https://api.deepseek.com/v1 — a gateway baseURL works identically. */
  baseUrl: string;
  model: string;
  /** Reference into the encrypted secret store; never the key itself. */
  apiKeyRef: string | null;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  isDefault: boolean;
}

/** A message as stored locally, already normalised. */
export interface RawEmail {
  id: string;
  accountId: string;
  /** Server-side identity: IMAP uid / POP3 UIDL / Graph message id. */
  uid: string;
  messageId: string;
  threadId: string | null;
  fromName: string | null;
  fromEmail: string;
  to: string[];
  cc: string[];
  subject: string;
  /** ISO 8601 with offset, taken from the Date header. */
  sentAt: string;
  /** Plain text with quoted history and signature REMOVED. */
  bodyText: string;
  hasAttachments: boolean;
  /** Only the headers the pipeline is allowed to reason about. */
  headers: Record<string, string>;
  createdAt: string;
}

/** Opaque incremental-sync position, provider specific. */
export interface SyncCursor {
  accountId: string;
  /** "uidvalidity:lastUid" | pop3 uidl set hash | Graph deltaLink. */
  value: string;
  updatedAt: string;
}

export type BroadcastKind = "personal" | "broadcast" | "uncertain";

export interface BroadcastVerdict {
  kind: BroadcastKind;
  /** Machine-readable reasons, e.g. "header:list-id", "to-count:>=10". */
  signals: string[];
}

/** Who is supposed to act. Only `me` becomes a TODO automatically. */
export type TaskOwner = "me" | "other" | "unassigned" | "everyone";

/** action = plain to-do; deadline = hard due date; window = a time range. */
export type TaskKind = "action" | "deadline" | "window";

export type TaskStatus = "candidate" | "confirmed" | "dismissed" | "done";

export interface TaskTime {
  /** The literal phrase the model found, e.g. "周五下班前". */
  phrase: string | null;
  /** Resolved deterministically from the phrase + email Date + IANA zone. */
  dueAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  timezone: string;
  confidence: number;
}

export interface Task {
  id: string;
  userId: string;
  title: string;
  detail: string | null;
  owner: TaskOwner;
  ownerName: string | null;
  kind: TaskKind;
  status: TaskStatus;
  /** Where the task came from — drives the "this is a broadcast" reminder. */
  origin: BroadcastKind;
  confidence: number;
  /** Verbatim sentence from the email that justifies this task. */
  evidenceQuote: string;
  sourceEmailId: string;
  threadId: string | null;
  time: TaskTime | null;
  createdAt: string;
  updatedAt: string;
}

/** Append-only change record — the reserved cloud-sync seam. */
export type ChangeOp = "insert" | "update" | "delete";

export interface ChangeLogRow {
  seq: number;
  entity: string;
  entityId: string;
  rev: string;
  deviceId: string;
  op: ChangeOp;
  /** JSON of the changed entity (or a tombstone for delete). */
  payload: string;
  ts: string;
}

export interface SyncPort {
  /** Every change after `since` (exclusive), ordered by seq. */
  changes(since: number, limit?: number): Promise<ChangeLogRow[]>;
  /** Highest seq currently stored. */
  head(): Promise<number>;
}

export interface SyncProgress {
  accountId: string;
  phase: "connect" | "fetch" | "store" | "extract" | "done" | "error";
  fetched: number;
  stored: number;
  message?: string;
}
