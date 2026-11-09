import { createHash } from "node:crypto";
import type { RawEmail } from "@mailcollect/shared";
import { cleanBody } from "./strip.js";

/**
 * 分类之后的确定性后处理（C6 最后一条 / C7 准入）。
 *
 * v1 R4 把「同一天 + 同正文哈希」当作**单封邮件**的群发强信号；v1.1 起它不再是
 * 任何规则的条件（规则树只有单封视野，表达不了跨邮件集合），而是在分类完成之后
 * 按整批邮件做确定性后处理：同一用户时区「同一天」内正文指纹相同的邮件，
 * 一律按群发处理（只进提醒卡片，不送 LLM 抽取）。
 *
 * 本文件只保留这一条确定性逻辑；R4 的其它信号（List-*、Precedence、
 * Auto-Submitted、no-reply、To/Cc 基数）已由「群发/通知」种子规则承接。
 */

/** 确定性后处理的信号名（写进群发提醒，便于审计「不是规则命中的」）。 */
export const SAME_DAY_BODY_SIGNAL = "deterministic:same-day-body-hash";

/**
 * 正文指纹：NFKC + 小写 + 去零宽字符 + 压缩空白 + sha256。
 * 纯空白（或缺失）返回 null —— 空正文不应被当成「同一条」。
 */
export function bodyFingerprint(text: string | null | undefined): string | null {
  if (text === null || text === undefined || text.trim() === "") return null;
  const normalized = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized === "") return null;
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * 同一用户时区「同一天」内、正文指纹相同的**其它**邮件数量（0 = 唯一）。
 *
 * 调用方在分类之后用这张表做确定性后处理；单封调用没有整批视野，
 * 因此单封入口永远看不到这个信号（与 v1 的已知边界一致）。
 */
export function countSameDayDuplicateBodies(
  emails: readonly RawEmail[],
  timezone: string,
): Map<string, number> {
  const dayFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const buckets = new Map<string, RawEmail[]>();
  for (const email of emails) {
    const sentAt = new Date(email.sentAt);
    if (Number.isNaN(sentAt.getTime())) continue;
    // 先剥引文/签名再指纹：同一封转发件不该因为引用历史不同而漏判。
    const fingerprint = bodyFingerprint(cleanBody(email.bodyText ?? ""));
    if (fingerprint === null) continue;
    const key = `${dayFormatter.format(sentAt)}|${fingerprint}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(email);
    else buckets.set(key, [email]);
  }
  const counts = new Map<string, number>();
  for (const bucket of buckets.values()) {
    for (const email of bucket) counts.set(email.id, bucket.length - 1);
  }
  return counts;
}

/** 该邮件是否被确定性后处理判为群发（同日同文有同伴）。 */
export function isSameDayDuplicate(count: number | undefined): boolean {
  return (count ?? 0) >= 1;
}
