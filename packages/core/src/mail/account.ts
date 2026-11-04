import type { MailProvider, SyncCursor } from "@mailcollect/shared";

/**
 * 适配器构造入参。与 `MailSourceFactory` 的入参形状保持一致（FROZEN CONTRACT 见 types.ts）。
 *
 * 凭据只经 `secret` 传入：IMAP/POP3 是密码或应用专用密码，Graph 不使用。
 * 适配器不读环境变量、不读凭据文件，也不会把 `secret` 写回任何地方。
 */
export interface MailSourceAccount {
  readonly id: string;
  readonly provider: MailProvider;
  readonly email: string;
  readonly config: Readonly<Record<string, string>>;
  readonly secret: string;
}

/** 读取非敏感配置项；空白值按缺失处理，返回 null。 */
export function readConfig(account: MailSourceAccount, key: string): string | null {
  const value = account.config[key];
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 读取整数配置项并夹到 [min, max]；无法解析时返回 null（交给调用方取默认值）。 */
export function readConfigInt(account: MailSourceAccount, key: string, min: number, max: number): number | null {
  const raw = readConfig(account, key);
  if (raw === null) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return null;
  return Math.min(Math.max(parsed, min), max);
}

/** 读取布尔配置项；只有明确写出的 1/0、true/false 等才生效，其余走 fallback。 */
export function readConfigBool(account: MailSourceAccount, key: string, fallback: boolean): boolean {
  const raw = readConfig(account, key)?.toLowerCase() ?? null;
  switch (raw) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return fallback;
  }
}

/** 生成一次同步的游标；`value` 的格式由各适配器自己定义。 */
export function makeCursor(accountId: string, value: string): SyncCursor {
  return { accountId, value, updatedAt: new Date().toISOString() };
}
