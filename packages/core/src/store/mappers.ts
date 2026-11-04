import type {
  Account,
  BroadcastKind,
  BroadcastVerdict,
  ChangeLogRow,
  ChangeOp,
  MailProvider,
  RawEmail,
  Task,
  TaskKind,
  TaskOwner,
  TaskStatus,
  TaskTime,
  UserProfile,
} from "@mailcollect/shared";

export interface ProfileRow {
  id: string;
  display_name: string;
  aliases_json: string;
  emails_json: string;
  timezone: string;
  created_at: string;
  updated_at: string;
}

export interface AccountRow {
  id: string;
  user_id: string;
  provider: string;
  label: string;
  email: string;
  config_json: string;
  secret_cipher: string | null;
  enabled: number;
  last_sync_at: string | null;
  created_at: string;
}

export interface EmailRow {
  id: string;
  account_id: string;
  uid: string;
  message_id: string;
  thread_id: string | null;
  from_name: string | null;
  from_email: string;
  to_json: string;
  cc_json: string;
  subject: string;
  sent_at: string;
  body_text: string;
  has_attachments: number;
  headers_json: string;
  created_at: string;
}

export interface TaskRow {
  id: string;
  user_id: string;
  title: string;
  detail: string | null;
  owner: string;
  owner_name: string | null;
  kind: string;
  status: string;
  origin: string;
  confidence: number;
  evidence_quote: string;
  source_email_id: string;
  thread_id: string | null;
  time_phrase: string | null;
  due_at: string | null;
  window_start: string | null;
  window_end: string | null;
  timezone: string | null;
  time_confidence: number | null;
  created_at: string;
  updated_at: string;
}

export interface VerdictRow {
  email_id: string;
  kind: string;
  signals_json: string;
}

export interface LlmConfigRow {
  id: string;
  label: string;
  protocol: string;
  base_url: string;
  model: string;
  api_key_cipher: string | null;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  is_default: number;
  created_at: string;
}

const parseArray = (json: string): string[] => {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

const parseObject = (json: string): Record<string, string> => {
  try {
    const value: unknown = JSON.parse(json);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return out;
    }
    return {};
  } catch {
    return {};
  }
};

export const toProfile = (row: ProfileRow): UserProfile => ({
  id: row.id,
  displayName: row.display_name,
  aliases: parseArray(row.aliases_json),
  emails: parseArray(row.emails_json),
  timezone: row.timezone,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toAccount = (row: AccountRow): Account => ({
  id: row.id,
  provider: row.provider as MailProvider,
  label: row.label,
  email: row.email,
  config: parseObject(row.config_json),
  enabled: row.enabled === 1,
  createdAt: row.created_at,
});

export const toEmail = (row: EmailRow): RawEmail => ({
  id: row.id,
  accountId: row.account_id,
  uid: row.uid,
  messageId: row.message_id,
  threadId: row.thread_id,
  fromName: row.from_name,
  fromEmail: row.from_email,
  to: parseArray(row.to_json),
  cc: parseArray(row.cc_json),
  subject: row.subject,
  sentAt: row.sent_at,
  bodyText: row.body_text,
  hasAttachments: row.has_attachments === 1,
  headers: parseObject(row.headers_json),
  createdAt: row.created_at,
});

export const toTaskTime = (row: TaskRow): TaskTime | null => {
  if (!row.due_at && !row.window_start && !row.window_end && !row.time_phrase) return null;
  return {
    phrase: row.time_phrase,
    dueAt: row.due_at,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    timezone: row.timezone ?? "UTC",
    confidence: row.time_confidence ?? 0,
  };
};

export const toTask = (row: TaskRow): Task => ({
  id: row.id,
  userId: row.user_id,
  title: row.title,
  detail: row.detail,
  owner: row.owner as TaskOwner,
  ownerName: row.owner_name,
  kind: row.kind as TaskKind,
  status: row.status as TaskStatus,
  origin: row.origin as BroadcastKind,
  confidence: row.confidence,
  evidenceQuote: row.evidence_quote,
  sourceEmailId: row.source_email_id,
  threadId: row.thread_id,
  time: toTaskTime(row),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toVerdict = (row: VerdictRow): BroadcastVerdict => ({
  kind: row.kind as BroadcastKind,
  signals: parseArray(row.signals_json),
});

/** Raw shape of a `change_log` row — snake_case on purpose (DB column names). */
export interface ChangeLogDbRow {
  seq: number;
  entity: string;
  entity_id: string;
  rev: string;
  device_id: string;
  op: string;
  payload: string;
  ts: string;
}

/**
 * Maps a DB row onto the FROZEN `ChangeLogRow` contract (camelCase).
 * Skipping this was a real defect: the sync seam was returning `entity_id`.
 */
export const toChangeLogRow = (row: ChangeLogDbRow): ChangeLogRow => ({
  seq: Number(row.seq),
  entity: row.entity,
  entityId: row.entity_id,
  rev: row.rev,
  deviceId: row.device_id,
  op: row.op as ChangeOp,
  payload: row.payload,
  ts: row.ts,
});
