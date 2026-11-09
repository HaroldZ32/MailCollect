import { dirname } from "node:path";
import { loadOrCreateKey } from "./crypto.js";
import { openDatabase } from "./db.js";
import { Store } from "./store.js";

export * from "./db.js";
export * from "./crypto.js";
export * from "./errors.js";
export * from "./mappers.js";
export * from "./cursor.js";
export * from "./migrate.js";
export * from "./repos.js";
export * from "./store.js";

/**
 * Opens (and migrates) the local store. The AES key and the SQLite file live in
 * the same directory — that is deliberate for a single-user desktop app; see
 * crypto.ts for the reasoning.
 */
export async function openStore(dbFile: string, deviceId: string): Promise<Store> {
  const db = await openDatabase(dbFile);
  const key = loadOrCreateKey(dirname(dbFile));
  const store = new Store({ db, key, userId: "local-user", deviceId });
  store.migrate();
  return store;
}
