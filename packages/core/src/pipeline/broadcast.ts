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
  /**
   * 同一用户时区「同一天」内、与这封正文哈希相同的其它邮件数量（0 = 唯一）。
   * 由调用方基于整批邮件算好后传入；单封判定时没有这个信息，保持 0。
   */
  duplicateBodyCount?: number;
}

/** 单封邮件之外的附加上下文（批量调用者才拿得到）。 */
export interface BroadcastContext {
  duplicateBodyCount?: number;
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
 * 强信号（列表头 / 自动回复 / 大批量 / no-reply / 同日重复正文）→ broadcast；
 * 否则「用户被写在 To 且收件人基数 ≤ 3」→ personal；其余 uncertain。
 *
 * 收件人基数 = To + Cc（R4 明写「To/Cc 基数」）。只数 To 会漏掉
 * 「To 只有我、Cc 两百人」这种典型群发。
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
  // R4 的「To/Cc 基数」：两者都算人。
  const recipientCount = to.length + cc.length;
  const userInTo = userEmails.length > 0 && userEmails.some((email) => to.includes(email));
  const userInCc = userEmails.length > 0 && userEmails.some((email) => cc.includes(email));

  if (recipientCount >= 10) {
    add("recipients:>=10");
    strong = true;
  }

  const fromLocalPart = (normalizeAddress(input.fromEmail).split("@")[0] ?? "").toLowerCase();
  if (fromLocalPart !== "" && NO_REPLY_RE.test(fromLocalPart)) {
    add("from:no-reply");
    strong = true;
  }

  // 同一天多条正文完全相同 → 典型群发/自动通知（R4 的「去重正文哈希」）。
  if ((input.duplicateBodyCount ?? 0) >= 1) {
    add("body-hash");
    strong = true;
  }

  // 用户是否被直接写在 To 里：personal 的必要条件，也是 uncertain 时的加权依据。
  if (userInTo) add("user:in-to");
  else if (userInCc) add("user:in-cc");
  else if (userEmails.length === 0) add("user:no-emails");
  else add("user:not-in-to");

  if (strong) return { kind: "broadcast", signals };

  if (userInTo && recipientCount <= 3) {
    add("recipients:<=3");
    return { kind: "personal", signals };
  }

  if (recipientCount > 3) add("recipients:>3");
  return { kind: "uncertain", signals };
}

/** 便捷入口：直接从一封已入库的邮件 + 用户档案判定。 */
export function classifyBroadcast(
  email: RawEmail,
  profile: UserProfile,
  context: BroadcastContext = {},
): BroadcastVerdict {
  return judgeBroadcast({
    headers: email.headers,
    fromEmail: email.fromEmail,
    to: email.to,
    cc: email.cc,
    userEmails: profile.emails,
    ...(context.duplicateBodyCount === undefined
      ? {}
      : { duplicateBodyCount: context.duplicateBodyCount }),
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
