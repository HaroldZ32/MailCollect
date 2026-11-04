/**
 * 邮件头的白名单。
 *
 * `RawEmail.headers` 是「pipeline 允许推理的头」这一契约（见 shared/src/domain.ts），
 * 而群发判定只依赖 RFC 2369 / RFC 2919 / RFC 3834 相关的这几个头，因此三个适配器
 * 都在这里统一裁剪：白名单之外的头既不落库也不进模型。
 */
export const ALLOWED_HEADERS = [
  "list-id",
  "list-unsubscribe",
  "list-post",
  "precedence",
  "auto-submitted",
  "return-path",
  "message-id",
  "in-reply-to",
  "references",
] as const;

const ALLOWED_HEADER_SET: ReadonlySet<string> = new Set(ALLOWED_HEADERS);

/** 把一条头值压成单行：折叠头（FWS）先展开再收尾。 */
function normalizeHeaderValue(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** 只保留白名单头；键统一小写，值折叠为单行，空值丢弃。 */
export function pickHeaders(source: Iterable<readonly [string, string]>): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, value] of source) {
    const key = name.toLowerCase();
    if (!ALLOWED_HEADER_SET.has(key)) continue;
    const text = normalizeHeaderValue(value);
    if (text.length === 0) continue;
    picked[key] = text;
  }
  return picked;
}

/** 把 mailparser 的头值（string | string[] | Date | 结构化对象）压成字符串；不认识的类型返回 null。 */
export function stringifyHeaderValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === "string") parts.push(item);
    }
    return parts.length > 0 ? parts.join(", ") : null;
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return null;
}

/** 从 mailparser 的 Headers（小写键的 Map）中裁剪出白名单头。 */
export function pickMailparserHeaders(headers: ReadonlyMap<string, unknown>): Record<string, string> {
  const pairs: Array<readonly [string, string]> = [];
  for (const key of ALLOWED_HEADERS) {
    const text = stringifyHeaderValue(headers.get(key));
    if (text !== null) pairs.push([key, text]);
  }
  return pickHeaders(pairs);
}
