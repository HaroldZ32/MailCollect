import type {
  Account,
  AccountSendConfig,
  AttachmentPayload,
  BroadcastKind,
  BroadcastVerdict,
  Category,
  ChangeLogRow,
  ChangeOp,
  ComposeMode,
  Draft,
  Folder,
  FolderRole,
  InitState,
  MailAuthMode,
  MailProvider,
  OutboxItem,
  OutboxStatus,
  OutgoingMessage,
  RawEmail,
  Rule,
  Tag,
  Task,
  TaskKind,
  TaskOwner,
  TaskStatus,
  TaskTime,
  UserProfile,
} from "@mailcollect/shared";
import { parseRuleTree } from "@mailcollect/shared";
import { StoreError } from "./errors.js";

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
  /** Added by the v1.1 migration; NULL until an outbound password is stored. */
  smtp_secret_cipher: string | null;
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

export const parseArray = (json: string): string[] => {
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

export const toAccount = (row: AccountRow): Account => {
  const config = parseObject(row.config_json);
  return {
    id: row.id,
    provider: row.provider as MailProvider,
    label: row.label,
    email: row.email,
    config,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    // v1.1 outbound settings are parsed out of the non-secret config map; the
    // SMTP/EWS password never appears here — it lives in `smtp_secret_cipher`.
    send: parseSendConfig(config),
  };
};

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

/* ------------------------------------------------------------------------- */
/* v1.1 mappers (categories / rules / tags / folders / drafts / outbox)       */
/* ------------------------------------------------------------------------- */

const MAIL_AUTH_MODES: readonly MailAuthMode[] = ["password", "ntlm", "oauth2", "device-code"];
const COMPOSE_MODES: readonly ComposeMode[] = ["new", "reply", "forward"];
const OUTBOX_STATUSES: readonly OutboxStatus[] = ["queued", "sending", "failed", "sent"];
const FOLDER_ROLES: readonly FolderRole[] = [
  "inbox",
  "sent",
  "drafts",
  "trash",
  "archive",
  "junk",
  "other",
];

const isOneOf = <T extends string>(allowed: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value);

/**
 * Outbound settings live in the non-secret `config` map as plain strings, so a
 * legacy account that never configured SMTP/EWS yields `null` instead of a
 * half-filled object. The password is NOT part of this map.
 */
export function parseSendConfig(config: Record<string, string>): AccountSendConfig | null {
  const smtpHost = (config.smtpHost ?? "").trim();
  const ewsUrl = (config.ewsUrl ?? "").trim();
  if (smtpHost === "" && ewsUrl === "") return null;

  const rawPort = (config.smtpPort ?? "").trim();
  const port = rawPort === "" ? null : Number.parseInt(rawPort, 10);
  const smtpSecure = config.smtpSecure === "1" || config.smtpSecure === "true";
  const smtpUser = (config.smtpUser ?? "").trim();
  const authMode: MailAuthMode = isOneOf(MAIL_AUTH_MODES, config.authMode)
    ? config.authMode
    : "password";

  return {
    smtpHost: smtpHost === "" ? null : smtpHost,
    smtpPort: port !== null && Number.isFinite(port) && port > 0 ? port : null,
    smtpSecure,
    smtpUser: smtpUser === "" ? null : smtpUser,
    ewsUrl: ewsUrl === "" ? null : ewsUrl,
    authMode,
  };
}

export interface CategoryRow {
  id: string;
  name: string;
  enter_todo: number;
  broadcast: number;
  created_at: string;
  updated_at: string;
}

export interface RuleRow {
  id: string;
  name: string;
  category_id: string;
  tree_json: string;
  enabled: number;
  order_index: number;
  created_at: string;
  updated_at: string;
}

export interface TagRow {
  id: string;
  email_id: string;
  category_id: string;
  rule_id: string | null;
  created_at: string;
}

export interface FolderRow {
  account_id: string;
  path: string;
  role: string;
  unread: number;
  updated_at: string;
}

export interface DraftRow {
  id: string;
  account_id: string;
  message_json: string;
  saved_at: string;
}

export interface OutboxRow {
  id: string;
  account_id: string;
  message_json: string;
  status: string;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}

export interface InitStateRow {
  id: number;
  completed: number;
  skipped: number;
  updated_at: string;
}

export const toCategory = (row: CategoryRow): Category => ({
  id: row.id,
  name: row.name,
  enterTodo: row.enter_todo === 1,
  broadcast: row.broadcast === 1,
});

const parseJsonColumn = (json: string, what: string): unknown => {
  try {
    // `JSON.parse` is `any`; binding it to `unknown` keeps the boundary honest
    // without laundering a type through an assertion.
    const parsed: unknown = JSON.parse(json);
    return parsed;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : "unknown parse error";
    throw new StoreError("invalid", `corrupt ${what} JSON: ${detail}`);
  }
};

/**
 * Parses and re-validates a stored rule tree through the shared schema.
 *
 * A rule row is written only after `validateRuleTree`, so a failure here means
 * the database was edited outside the app; surfacing a typed error is better
 * than handing an unvalidated object to the classification engine.
 */
export const toRule = (row: RuleRow): Rule => {
  const parsed = parseRuleTree(parseJsonColumn(row.tree_json, "rule tree"));
  if (!parsed.ok) {
    const detail = parsed.issues.map((issue) => `${issue.path}:${issue.code}`).join(",");
    throw new StoreError("invalid", `rule ${row.id} has an invalid tree (${detail})`);
  }
  return {
    id: row.id,
    name: row.name,
    categoryId: row.category_id,
    tree: parsed.tree,
    enabled: row.enabled === 1,
    order: row.order_index,
  };
};

export const toTag = (row: TagRow): Tag => ({
  id: row.id,
  emailId: row.email_id,
  categoryId: row.category_id,
  ruleId: row.rule_id,
  createdAt: row.created_at,
});

export const toFolder = (row: FolderRow): Folder => ({
  accountId: row.account_id,
  path: row.path,
  role: isOneOf(FOLDER_ROLES, row.role) ? row.role : "other",
  unread: Number(row.unread),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const isAttachmentPayload = (value: unknown): value is AttachmentPayload =>
  isRecord(value) &&
  typeof value.filename === "string" &&
  typeof value.mimeType === "string" &&
  typeof value.size === "number" &&
  typeof value.dataBase64 === "string";

/**
 * Parses the stored outgoing-message snapshot (draft/outbox share the shape).
 * Every field is checked once, at the database boundary; callers get a typed
 * `OutgoingMessage` and never re-validate.
 */
export function parseOutgoingMessage(json: string): OutgoingMessage {
  const raw = parseJsonColumn(json, "outgoing message");
  if (!isRecord(raw)) throw new StoreError("invalid", "outgoing message is not an object");
  if (!isOneOf(COMPOSE_MODES, raw.mode)) throw new StoreError("invalid", "invalid compose mode");
  if (!isStringArray(raw.to)) throw new StoreError("invalid", "invalid to list");
  if (!isStringArray(raw.cc)) throw new StoreError("invalid", "invalid cc list");
  if (!isStringArray(raw.bcc)) throw new StoreError("invalid", "invalid bcc list");
  if (typeof raw.subject !== "string") throw new StoreError("invalid", "invalid subject");
  if (typeof raw.bodyText !== "string") throw new StoreError("invalid", "invalid body text");
  if (raw.bodyHtml !== null && typeof raw.bodyHtml !== "string") {
    throw new StoreError("invalid", "invalid html body");
  }
  if (!Array.isArray(raw.attachments) || !raw.attachments.every(isAttachmentPayload)) {
    throw new StoreError("invalid", "invalid attachments");
  }
  if (typeof raw.includeSignature !== "boolean") {
    throw new StoreError("invalid", "invalid includeSignature");
  }
  if (raw.replyToEmailId !== null && typeof raw.replyToEmailId !== "string") {
    throw new StoreError("invalid", "invalid replyToEmailId");
  }
  return {
    mode: raw.mode,
    to: raw.to,
    cc: raw.cc,
    bcc: raw.bcc,
    subject: raw.subject,
    bodyText: raw.bodyText,
    bodyHtml: raw.bodyHtml,
    attachments: raw.attachments.map((item) => ({ ...item })),
    includeSignature: raw.includeSignature,
    replyToEmailId: raw.replyToEmailId,
  };
}

export const toDraft = (row: DraftRow): Draft => ({
  ...parseOutgoingMessage(row.message_json),
  id: row.id,
  accountId: row.account_id,
  savedAt: row.saved_at,
});

export const toOutboxItem = (row: OutboxRow): OutboxItem => {
  if (!isOneOf(OUTBOX_STATUSES, row.status)) {
    throw new StoreError("invalid", `outbox ${row.id} has an unknown status`);
  }
  return {
    id: row.id,
    accountId: row.account_id,
    message: parseOutgoingMessage(row.message_json),
    status: row.status,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sentAt: row.sent_at,
  };
};

export const toInitState = (row: InitStateRow | undefined): InitState => ({
  completed: row?.completed === 1,
  skipped: row?.skipped === 1,
});

/* ------------------------------ server message ref ---------------------------- */

/**
 * 一封邮件在服务端的定位（`provider_ref_json`）。
 * IMAP 的 uid 是文件夹作用域的，所以 ref 必须同时携带 `folderId`。
 */
export interface ProviderRef {
  readonly id: string;
  /** 服务端文件夹 id/path；POP3/Graph 不需要时为 null。 */
  readonly folderId: string | null;
}

/**
 * 持久化的 ref 状态：
 * - `unknown`：从未记录（v1 旧行 / 刚插入但没给文件夹）→ 调用方可回落到 uid+文件夹；
 * - `unresolved`：服务器已移动但目标定位不可知 → 调用方必须重同步，不得用旧 uid；
 * - `ref`：权威定位。
 */
export type EmailRefState =
  | { readonly kind: "unknown" }
  | { readonly kind: "unresolved" }
  | { readonly kind: "ref"; readonly ref: ProviderRef };

export const UNKNOWN_REF: EmailRefState = { kind: "unknown" };

/** Ref stored after a successful move — the ONLY trustworthy locator afterwards. */
export const serializeEmailRef = (ref: ProviderRef): string =>
  JSON.stringify({ kind: "ref", ref });

/** Ref stored when the adapter moved the message but could not resolve the new id. */
export const UNRESOLVED_REF_JSON = JSON.stringify({ kind: "unresolved" });

/** Parses `provider_ref_json`; anything unreadable is treated as unresolved (never guess). */
export function parseEmailRefState(json: string | null): EmailRefState {
  if (json === null || json.trim() === "") return UNKNOWN_REF;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { kind: "unresolved" };
  }
  if (!isRecord(raw)) return { kind: "unresolved" };
  if (raw["kind"] === "unresolved") return { kind: "unresolved" };
  const ref = raw["ref"];
  if (
    raw["kind"] === "ref" &&
    isRecord(ref) &&
    typeof ref["id"] === "string" &&
    (ref["folderId"] === null || typeof ref["folderId"] === "string")
  ) {
    return { kind: "ref", ref: { id: ref["id"], folderId: ref["folderId"] } };
  }
  return { kind: "unresolved" };
}


/* ------------------------------ email metadata ------------------------------- */

/** 附件元数据（不含字节）。与 `rules/evaluate.ts` 的 `RuleAttachment` 结构一致。 */
export interface EmailAttachmentMeta {
  readonly filename: string;
  readonly mimeType: string;
  readonly size: number;
}

/** 规则求值需要的「邮件附加元数据」；两列都为空时就是空值，不是错误。 */
export interface EmailExtras {
  readonly receivedAt: string | null;
  readonly attachments: readonly EmailAttachmentMeta[];
}

export const EMPTY_EMAIL_EXTRAS: EmailExtras = { receivedAt: null, attachments: [] };

export interface EmailExtrasInput {
  /** 省略 = 保持原值；显式 null = 清空。 */
  readonly receivedAt?: string | null;
  /** 省略 = 保持原值；空数组 = 清空（附件元数据未知）。 */
  readonly attachments?: readonly EmailAttachmentMeta[];
}

const parseAttachments = (json: string | null): EmailAttachmentMeta[] => {
  if (json === null || json.trim() === "") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!isRecord(item)) return [];
    const filename = item["filename"];
    const mimeType = item["mimeType"];
    const size = item["size"];
    if (typeof filename !== "string" || typeof mimeType !== "string" || typeof size !== "number") {
      return [];
    }
    return [{ filename, mimeType, size }];
  });
};

export const serializeAttachments = (
  attachments: readonly EmailAttachmentMeta[],
): string | null => (attachments.length === 0 ? null : JSON.stringify(attachments));

export const toEmailExtras = (row: {
  received_at: string | null;
  attachments_json: string | null;
}): EmailExtras => ({
  receivedAt: row.received_at,
  attachments: parseAttachments(row.attachments_json),
});
