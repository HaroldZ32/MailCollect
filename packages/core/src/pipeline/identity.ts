import type { UserProfile } from "@mailcollect/shared";

/** 用户身份在正文里以什么形式出现。 */
export type IdentityHitKind = "display-name" | "alias" | "email" | "email-local";

export interface IdentityHit {
  kind: IdentityHitKind;
  /** 命中的原始写法（用于给 LLM 和用户看）。 */
  matched: string;
}

const KIND_LABELS: Readonly<Record<IdentityHitKind, string>> = {
  "display-name": "姓名",
  alias: "别名",
  email: "邮箱",
  "email-local": "邮箱前缀",
};

/**
 * 姓名/别名的确定性匹配。
 *
 * 规则：NFKC（中文全角→半角、兼容字符归一）+ 小写 + 去掉所有空白。
 * 这样 "张 三"、"张三"、"ＳＡＮ　ＺＨＡＮＧ" 都能互相命中。
 * 已知边界：两字中文姓名是纯子串匹配（"张三" 会命中 "张三丰"），
 * 这是为召回率做的取舍，报告的「未验证/风险」里已记录。
 */
export function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** 去掉全部空白并小写的比较形态。 */
export function compactText(value: string): string {
  return normalizeText(value).replace(/[\s\u3000]+/g, "").toLowerCase();
}

export function findIdentityHits(text: string, profile: UserProfile): IdentityHit[] {
  const hits: IdentityHit[] = [];
  const seen = new Set<string>();
  const push = (kind: IdentityHitKind, matched: string): void => {
    const key = `${kind}:${compactText(matched)}`;
    if (seen.has(key)) return;
    seen.add(key);
    hits.push({ kind, matched });
  };

  const compactHaystack = compactText(text);
  // ASCII 名字需要词边界，但去掉空白后边界会丢（"ask Li now" → "asklinow"），
  // 所以保留单空格的归一形态另外算一份。
  const spacedHaystack = normalizeText(text).toLowerCase();
  const lowerHaystack = spacedHaystack;

  for (const email of profile.emails) {
    const needle = email.trim().toLowerCase();
    if (needle && lowerHaystack.includes(needle)) push("email", email.trim());
  }

  const names: Array<[IdentityHitKind, string]> = [
    ["display-name", profile.displayName],
    ...profile.aliases.map((alias): [IdentityHitKind, string] => ["alias", alias]),
  ];
  for (const [kind, name] of names) {
    if (nameAppears(spacedHaystack, compactHaystack, name)) push(kind, name.trim());
  }

  for (const email of profile.emails) {
    const localPart = (email.split("@")[0] ?? "").trim();
    if (localPart.length >= 3 && wordAppears(spacedHaystack, localPart.toLowerCase())) {
      push("email-local", localPart);
    }
  }

  return hits;
}

export function mentionsUser(text: string, profile: UserProfile): boolean {
  return findIdentityHits(text, profile).length > 0;
}

/** 给 prompt 用的一句话摘要。 */
export function describeIdentityMentions(text: string, profile: UserProfile): string {
  const hits = findIdentityHits(text, profile);
  if (hits.length === 0) return "确定性匹配：正文未出现用户姓名/别名/邮箱";
  const parts = hits.map((hit) => `「${hit.matched}」(${KIND_LABELS[hit.kind]})`);
  return `确定性匹配：正文出现 ${parts.join("、")}`;
}

/**
 * ASCII 名字要求词边界（"Li" 不该命中 "Lion"）；
 * 含非 ASCII 字符的名字（中文等）按子串匹配，因为中文句子没有词边界。
 */
function nameAppears(spacedHaystack: string, compactHaystack: string, name: string): boolean {
  const raw = normalizeText(name).toLowerCase();
  const compacted = compactText(name);
  if (compacted.length < 2) return false;
  if (/^[\x20-\x7e]+$/.test(compacted)) return wordAppears(spacedHaystack, raw);
  return compactHaystack.includes(compacted);
}

function wordAppears(compactHaystack: string, needle: string): boolean {
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`).test(compactHaystack);
}
