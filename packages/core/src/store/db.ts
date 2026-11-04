import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type SqlValue = string | number | bigint | null | Uint8Array;

export interface DbStatement {
  run(...params: SqlValue[]): { changes: number; lastInsertRowid: number | bigint };
  get<T = unknown>(...params: SqlValue[]): T | undefined;
  all<T = unknown>(...params: SqlValue[]): T[];
}

export interface Db {
  readonly driver: "node:sqlite";
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  close(): void;
}

/** node:sqlite refuses booleans; the whole app speaks in 0/1. */
export const bit = (value: boolean | number | null | undefined): number => (value ? 1 : 0);

type SqliteModule = {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): {
      run(...p: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
      get(...p: unknown[]): unknown;
      all(...p: unknown[]): unknown[];
    };
    close(): void;
  };
};

/**
 * Opens the local SQLite file through Node's built-in `node:sqlite`.
 *
 * Deliberately NO native module (no better-sqlite3): that is what lets the very
 * same code run inside Electron's Node and in a plain `node` server without any
 * ABI rebuild. Node >= 24 ships it; Electron 45 bundles Node 24.
 */
export async function openDatabase(file: string): Promise<Db> {
  mkdirSync(dirname(file), { recursive: true });

  let mod: SqliteModule;
  try {
    mod = (await import("node:sqlite")) as unknown as SqliteModule;
  } catch (cause) {
    throw new Error(
      "node:sqlite is unavailable. MailCollect needs Node >= 24 (Electron 45 bundles Node 24).",
      { cause },
    );
  }

  const db = new mod.DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  return {
    driver: "node:sqlite",
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const stmt = db.prepare(sql);
      return {
        run: (...p) => {
          const result = stmt.run(...p);
          return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
        },
        get: <T,>(...p: SqlValue[]) => stmt.get(...p) as T | undefined,
        all: <T,>(...p: SqlValue[]) => stmt.all(...p) as T[],
      };
    },
    close: () => db.close(),
  };
}
