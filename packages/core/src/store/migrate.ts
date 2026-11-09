import { readFileSync } from "node:fs";
import type { Db } from "./db.js";

/**
 * v1 -> v1.1 migration.
 *
 * Rules this file exists to honour (requirements C2 / AC-26):
 * - data is never dropped: the v1 tables are created by the frozen `schema.sql`
 *   and only new tables/columns are added on top of them;
 * - the whole migration is repeatable: every table is `CREATE ... IF NOT EXISTS`,
 *   column additions are guarded by `PRAGMA table_info`, and the "was this a v1
 *   database?" decision is answered by the persisted `schema_version` marker —
 *   not by row counts, which cannot tell "fresh install in progress" from
 *   "existing v1 install";
 * - the schema version is recorded last, so an interrupted migration is retried
 *   on the next boot instead of being mistaken for a finished one.
 */
const SCHEMA_VERSION = "1.1";

interface ColumnSpec {
  readonly table: "raw_email" | "account";
  readonly column: string;
  readonly ddl: string;
}

/** Columns SQLite cannot add idempotently (`ALTER TABLE` has no IF NOT EXISTS). */
const ADDED_COLUMNS: readonly ColumnSpec[] = [
  { table: "raw_email", column: "folder", ddl: "TEXT NOT NULL DEFAULT 'INBOX'" },
  { table: "raw_email", column: "is_read", ddl: "INTEGER NOT NULL DEFAULT 0" },
  // 服务端定位：移动会换 id（IMAP uid 是文件夹作用域的），旧 uid 不能盲用。
  // NULL = 从未记录（v1 旧行）→ 调用方可回落到 uid+文件夹；JSON = 权威 ref 或
  // {"kind":"unresolved"}（服务器已移动但新定位不可知，必须重同步）。
  { table: "raw_email", column: "provider_ref_json", ddl: "TEXT" },
  // 服务器接收时间（IMAP internalDate / Graph receivedDateTime / EWS DateTimeReceived）
  // 与附件元数据（name/mime/size，不含字节）。NULL = 未知（旧行或协议不提供）
  // → 对应的规则叶子按 C6「字段缺失判 false」，绝不编造。
  { table: "raw_email", column: "received_at", ddl: "TEXT" },
  { table: "raw_email", column: "attachments_json", ddl: "TEXT" },
  // SMTP / EWS password, AES-256-GCM ciphertext — the same treatment as the
  // inbound mailbox secret (C2).
  { table: "account", column: "smtp_secret_cipher", ddl: "TEXT" },
];

export interface MigrationResult {
  /** True when this database was a v1 store and has just been upgraded. */
  readonly legacy: boolean;
  /** True when the v1.1 schema was already in place before this call. */
  readonly alreadyCurrent: boolean;
}

const readSql = (name: string): string => readFileSync(new URL(name, import.meta.url), "utf8");

function readMeta(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get<{ value: string }>(key);
  return row?.value ?? null;
}

function hasColumn(db: Db, table: string, column: string): boolean {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all<{ name: string }>()
    .some((row) => row.name === column);
}

/** Any application row at all: a v1 database that has been used. */
function hasApplicationData(db: Db): boolean {
  const row = db
    .prepare(
      `SELECT (
         (SELECT COUNT(*) FROM user_profile) +
         (SELECT COUNT(*) FROM account) +
         (SELECT COUNT(*) FROM raw_email) +
         (SELECT COUNT(*) FROM task)
       ) AS n`,
    )
    .get<{ n: number }>();
  return Number(row?.n ?? 0) > 0;
}

/**
 * Applies `schema.sql`, the v1.1 column additions and `schema-v11.sql`.
 * Safe to call on every boot and on a half-migrated database.
 */
export function migrateSchema(db: Db): MigrationResult {
  // The v1 tables must exist before anything can be inspected or altered.
  db.exec(readSql("./schema.sql"));

  const versionBefore = readMeta(db, "schema_version");
  const legacy = versionBefore === null && hasApplicationData(db);

  for (const spec of ADDED_COLUMNS) {
    if (hasColumn(db, spec.table, spec.column)) continue;
    db.exec(`ALTER TABLE ${spec.table} ADD COLUMN ${spec.column} ${spec.ddl}`);
  }

  // After the column additions: this file indexes `raw_email.folder`.
  db.exec(readSql("./schema-v11.sql"));

  const clause = "ON CONFLICT(key) DO UPDATE SET value = excluded.value";
  db.prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?) ${clause}`).run(
    SCHEMA_VERSION,
  );
  if (legacy) {
    db.prepare(`INSERT INTO meta (key, value) VALUES ('upgraded_from', 'v1') ${clause}`).run();
  }

  return { legacy, alreadyCurrent: versionBefore === SCHEMA_VERSION };
}
