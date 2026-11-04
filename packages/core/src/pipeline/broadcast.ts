import { createHash } from "node:crypto";
import type {
  BroadcastKind,
  BroadcastVerdict,
  RawEmail,
  UserProfile,
} from "@mailcollect/shared";

/**
 * 群发判定输入。全部来自邮件头部与地址簿（代码层信息），
 * 绝不依赖模型，也不依赖正文语义。
 */
export interface BroadcastInput {
  headers: Record<string, string>;
  fromEmail: string;
  to: readonly string[];
  cc: readonly string[];
  userEmails: readonly string[];
}

/** RFC 2369/2919 的 List-* 头部：出现任意一个就是邮件列表。 */
const LIST_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["list-id", "header:list-id"],
  ["list-unsubscribe", "header:list-unsubscribe"],
  ["list-post", "header:list-post"],
];

const NO_REPLY_RE = /no-?reply|do-not-reply|notification|bounce/i;

/**
 * 三态判定。规则顺序即优先级：
 * 强信号（列表头 / 自动回复 / 大批量 / no-reply）→ broadcast；
 * 否则「用户在 To 且 To 人数 ≤ 3」→ personal；其余 uncertain。
 */
export function judgeBroadcast(input: BroadcastInput): BroadcastVerdict {
  const headers = normalizeHeaders(input.headers);
  const signals: string[] = [];
  const add = (signal: string): void => {
    if (!signals.includes(signal)) signals.push(signal);
  };

  let strong = false;

  for (const [header, signal] of LIST_HEADERS) {
    if (headers.has(header)) {
      add(signal);
      strong = true;
    }
  }

  const autoSubmitted = headers.get("auto-submitted");
  if (autoSubmitted !== undefined && autoSubmitted.trim().toLowerCase() !== "no") {
    add("header:auto-submitted");
    strong = true;
  }

  const precedence = headers.get("precedence")?.trim().toLowerCase();
  if (precedence === "bulk" || precedence === "list") {
    // 弱信号，但 RFC 3834 之外仍是最常见的群发标记，按需求计入 broadcast。
    add("header:precedence");
    strong = true;
  }

  const to = input.to.map(normalizeAddress).filter((address) => address !== "");
  const cc = input.cc.map(normalizeAddress).filter((address) => address !== "");
  const userEmails = input.userEmails.map(normalizeAddress).filter((address) => address !== "");
  const toCount = to.length;
  const userInTo = userEmails.length > 0 && userEmails.some((email) => to.includes(email));
  const userInCc = userEmails.length > 0 && userEmails.some((email) => cc.includes(email));

  if (toCount >= 10) {
    add("to-count:>=10");
    strong = true;
  }

  const fromLocalPart = (normalizeAddress(input.fromEmail).split("@")[0] ?? "").toLowerCase();
  if (fromLocalPart !== "" && NO_REPLY_RE.test(fromLocalPart)) {
    add("from:no-reply");
    strong = true;
  }

  // 用户是否被直接写在 To 里：personal 的必要条件，也是 uncertain 时的加权依据。
  if (userInTo) add("user:in-to");
  else if (userInCc) add("user:in-cc");
  else if (userEmails.length === 0) add("user:no-emails");
  else add("user:not-in-to");

  if (strong) return { kind: "broadcast", signals };

  if (userInTo && toCount <= 3) {
    add("to-count:<=3");
    return { kind: "personal", signals };
  }

  if (toCount > 3) add("to-count:>3");
  return { kind: "uncertain", signals };
}

/** 便捷入口：直接从一封已入库的邮件 + 用户档案判定。 */
export function classifyBroadcast(email: RawEmail, profile: UserProfile): BroadcastVerdict {
  return judgeBroadcast({
    headers: email.headers,
    fromEmail: email.fromEmail,
    to: email.to,
    cc: email.cc,
    userEmails: profile.emails,
  });
}

/**
 * 正文指纹：供调用方对「同一天多条相同正文」做二次判定。
 * NFKC + 小写 + 压缩空白 + 去零宽字符；正文和 HTML 二选一（优先纯文本）。
 * 纯空白返回 null —— 空正文不应被当成「同一条」。
 */
export function hashBody(input: { text?: string | null; html?: string | null }): string | null {
  const source = input.text !== null && input.text !== undefined && input.text.trim() !== ""
    ? input.text
    : input.html;
  if (source === null || source === undefined) return null;
  const normalized = source
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized === "") return null;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function normalizeHeaders(headers: Record<string, string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    const normalized = key.trim().toLowerCase();
    if (normalized !== "" && !map.has(normalized)) map.set(normalized, String(value));
  }
  return map;
}

/** "张三 <a@b.com>" → "a@b.com"，并统一小写。 */
function normalizeAddress(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const angled = /<([^<>]+)>/.exec(trimmed);
  const address = (angled?.[1] ?? trimmed).trim().toLowerCase();
  return address;
}

/** 排序稳定输出用（供调用方打印/断言）。 */
export function isBroadcast(kind: BroadcastKind): boolean {
  return kind === "broadcast";
}
