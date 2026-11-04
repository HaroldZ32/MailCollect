import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Local secret protection.
 *
 * The key lives next to the database with mode 0600. That is equivalent to the
 * database's own protection on a single-user machine, and it keeps secrets out
 * of git, out of logs and out of API responses. OS keychain integration is a
 * deliberate follow-up, not a v1 claim.
 */
export function loadOrCreateKey(dataDir: string): Buffer {
  const file = join(dataDir, "secret.key");
  if (existsSync(file)) {
    const raw = readFileSync(file, "utf8").trim();
    const key = Buffer.from(raw, "base64");
    if (key.length !== 32) throw new Error(`secret.key is corrupt (${key.length} bytes)`);
    return key;
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(file, `${key.toString("base64")}\n`, { mode: 0o600 });
  return key;
}

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    "v1",
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(key: Buffer, payload: string): string {
  // An account created without a secret (Graph device-code accounts have none to
  // paste) is stored as NULL; an all-empty payload must read back as "" rather
  // than throwing, or every account listing would fail.
  if (payload.length === 0) return "";
  const [version, ivB64, tagB64, dataB64 = ""] = payload.split(":");
  if (version !== "v1" || !ivB64 || !tagB64) {
    throw new Error("unsupported secret payload");
  }
  if (dataB64.length === 0) return "";
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
