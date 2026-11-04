-- MailCollect schema — FROZEN CONTRACT (captain only).
-- All timestamps are ISO 8601 strings in UTC; presentation converts to the
-- profile timezone. JSON columns hold serialised arrays/objects.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_profile (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  aliases_json TEXT NOT NULL,
  emails_json  TEXT NOT NULL,
  timezone     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS account (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL,
  provider      TEXT NOT NULL,
  label         TEXT NOT NULL,
  email         TEXT NOT NULL,
  config_json   TEXT NOT NULL,
  secret_cipher TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_sync_at  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sync_cursor (
  account_id TEXT PRIMARY KEY REFERENCES account(id) ON DELETE CASCADE,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS raw_email (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  uid             TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  thread_id       TEXT,
  from_name       TEXT,
  from_email      TEXT NOT NULL,
  to_json         TEXT NOT NULL,
  cc_json         TEXT NOT NULL,
  subject         TEXT NOT NULL,
  sent_at         TEXT NOT NULL,
  body_text       TEXT NOT NULL,
  has_attachments INTEGER NOT NULL DEFAULT 0,
  headers_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  -- Null until the extraction pipeline has processed this message.
  extracted_at    TEXT,
  extraction_note TEXT,
  UNIQUE (account_id, uid)
);
CREATE INDEX IF NOT EXISTS idx_raw_email_sent   ON raw_email (sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_email_thread ON raw_email (thread_id);

CREATE TABLE IF NOT EXISTS broadcast_verdict (
  email_id     TEXT PRIMARY KEY REFERENCES raw_email(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  signals_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
  id              TEXT PRIMARY KEY,
  user_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  detail          TEXT,
  owner           TEXT NOT NULL,
  owner_name      TEXT,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL,
  origin          TEXT NOT NULL,
  confidence      REAL NOT NULL,
  evidence_quote  TEXT NOT NULL,
  source_email_id TEXT NOT NULL REFERENCES raw_email(id) ON DELETE CASCADE,
  thread_id       TEXT,
  time_phrase     TEXT,
  due_at          TEXT,
  window_start    TEXT,
  window_end      TEXT,
  timezone        TEXT,
  time_confidence REAL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  -- Re-extracting the same email must not duplicate its tasks.
  UNIQUE (source_email_id, title)
);
CREATE INDEX IF NOT EXISTS idx_task_status ON task (status);
CREATE INDEX IF NOT EXISTS idx_task_due    ON task (due_at);

-- Remembers "always add / always ignore" for a mailing list (R4).
CREATE TABLE IF NOT EXISTS broadcast_decision (
  list_id    TEXT PRIMARY KEY,
  decision   TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Append-only outbox: the reserved cloud-sync seam (R7).
CREATE TABLE IF NOT EXISTS change_log (
  seq       INTEGER PRIMARY KEY AUTOINCREMENT,
  entity    TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  rev       TEXT NOT NULL,
  device_id TEXT NOT NULL,
  op        TEXT NOT NULL,
  payload   TEXT NOT NULL,
  ts        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_change_seq ON change_log (seq);
