-- MailCollect v1.1 schema — additive migration (v1 -> v1.1).
--
-- WHY THIS FILE EXISTS: `schema.sql` is a FROZEN v1 contract (captain only), so
-- the v1.1 table set is delivered as a second, versioned script that
-- `migrate.ts` executes right after `schema.sql`. Every statement is
-- `CREATE ... IF NOT EXISTS`, so running it against a half-migrated database is
-- a no-op; column additions (which SQLite cannot express idempotently) are
-- applied in `migrate.ts` after a `PRAGMA table_info` check.
--
-- Data preservation (C2): nothing here drops or rewrites a v1 table. profile,
-- account, raw_email, task, change_log and the rest keep every row.

-- `listEmailsInFolder` 按 folder 过滤（收件箱/已发送分页）；没有这个索引就是全表扫描。
-- 注意执行顺序：migrate.ts 先加 `raw_email.folder` 列，再执行本文件。
CREATE INDEX IF NOT EXISTS idx_raw_email_folder ON raw_email (folder, sent_at DESC);

-- 分类（C6）。名称唯一；「未分类」是计算态，不落库。
CREATE TABLE IF NOT EXISTS category (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  enter_todo INTEGER NOT NULL DEFAULT 0,
  broadcast  INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 规则：恰好挂在一个已存在分类上；条件树以 JSON 存储（结构由 shared 的
-- ruleTreeSchema 校验，本表只保证它是合法 JSON 文本）。
CREATE TABLE IF NOT EXISTS rule (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category_id TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  tree_json   TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  order_index INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rule_order ON rule (order_index, created_at);

-- 邮件↔分类多对多标签（C6）。一次重算 = 先删旧标签再加新标签，幂等。
-- `rule_id` 记第一个命中的规则；规则删除时标签保留（分类仍然成立）。
CREATE TABLE IF NOT EXISTS tag (
  id          TEXT PRIMARY KEY,
  email_id    TEXT NOT NULL REFERENCES raw_email(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
  -- No FK on purpose: tags are derived data recomputed in the background; a
  -- rule deleted mid-recompute must not surface as a raw SQLITE_CONSTRAINT.
  rule_id     TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (email_id, category_id)
);
CREATE INDEX IF NOT EXISTS idx_tag_category ON tag (category_id, email_id);
CREATE INDEX IF NOT EXISTS idx_tag_email    ON tag (email_id);

-- 服务端汇报的文件夹与未读数（C5）。幂等同步 = 覆盖整个账号的文件夹集合。
CREATE TABLE IF NOT EXISTS folder (
  account_id TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  path       TEXT NOT NULL,
  role       TEXT NOT NULL,
  unread     INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, path)
);

-- 本地草稿（C5）：整封待发送消息的 JSON 快照，停输/切换时覆盖同一行。
CREATE TABLE IF NOT EXISTS draft (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  message_json TEXT NOT NULL,
  saved_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_draft_account ON draft (account_id, saved_at DESC);

-- 离线发件队列（C5）：queued -> sending -> sent | failed -> (退避) -> queued。
-- `next_attempt_at` 是退避时刻；重启时 `sending` 行由 recoverOutbox() 拉回队列。
CREATE TABLE IF NOT EXISTS outbox (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  message_json    TEXT NOT NULL,
  status          TEXT NOT NULL CHECK (status IN ('queued', 'sending', 'failed', 'sent')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  sent_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox (status, next_attempt_at, created_at);

-- 初始化向导状态（C3）：单行表，id 恒为 1。
CREATE TABLE IF NOT EXISTS init_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  completed  INTEGER NOT NULL DEFAULT 0,
  skipped    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
