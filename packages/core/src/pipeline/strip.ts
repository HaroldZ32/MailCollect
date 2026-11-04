/**
 * 引文与签名剥离。
 *
 * 只做文本层面的裁剪，不解析 MIME：输入是 mailparser 等适配器已经解码好的
 * text 或 html 正文。目标是让 LLM 只看到「本次新写的内容」，避免把上几轮的
 * 待办重复抽出来。
 */

const CHINESE_HEADER_LABELS = ["发件人", "发送时间", "日期", "时间", "收件人", "抄送", "主题"];
const ENGLISH_HEADER_LABELS = ["from", "sent", "date", "to", "cc", "subject"];

/** 常见「原始邮件」分隔线。 */
const SEPARATOR_PATTERNS: readonly RegExp[] = [
  /^\s*-{2,}\s*(original message|forwarded message|原始邮件|邮件原文|转发邮件|邮件原件)\s*-{2,}\s*$/i,
  /^\s*={3,}\s*(原始邮件|转发邮件)\s*={3,}\s*$/i,
  /^\s*_{10,}\s*$/,
  /^\s*-{5,}\s*$/,
];

/** 「On ... wrote:」与中文「在 ... 写道：」回复头。 */
const REPLY_HEADER_PATTERNS: readonly RegExp[] = [
  /^\s*On\b.{0,400}\bwrote:\s*$/i,
  /^\s*在.{0,400}写道[：:]\s*$/,
  /^\s*于.{0,200}写道[：:]\s*$/,
];

/** 「Sent from my iPhone」这类签名尾巴。 */
const DEVICE_SIGNATURE = /^\s*(sent from my (iphone|ipad|android|mobile)|发自我的(iphone|ipad|android|华为|小米|手机))\b/i;

export function looksLikeHtml(input: string): boolean {
  return /<\s*(blockquote|div|p|br|html|body|table)\b/i.test(input);
}

/** 删除 HTML 中的 <blockquote> 引用块（含嵌套），未闭合时删到结尾。 */
export function stripHtmlBlockquotes(html: string): string {
  let output = html;
  for (let round = 0; round < 8; round += 1) {
    const next = output.replace(/<blockquote\b[^>]*>[\s\S]*?<\/blockquote\s*>/gi, "\n");
    if (next === output) break;
    output = next;
  }
  // 被截断的 HTML：从第一个未闭合的 blockquote 起全部丢弃。
  const unclosed = output.search(/<blockquote\b/i);
  if (unclosed >= 0) output = output.slice(0, unclosed);
  return output;
}

/** HTML → 纯文本（无第三方依赖，够用即可）。 */
export function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<(script|style|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section)\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<[^>]+>/g, "");
  return normalizeBlankLines(decodeEntities(withoutNoise).trim());
}

/** 剥离引文：HTML blockquote、">" 引用、回复头、原始邮件分隔线、中文/英文头部块。 */
export function stripQuoted(input: string): string {
  let text = input;
  if (looksLikeHtml(text)) {
    text = htmlToText(stripHtmlBlockquotes(text));
  }
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const cutAt = findQuoteStart(lines);
  const kept = cutAt >= 0 ? lines.slice(0, cutAt) : lines;
  // 行内 "> xxx" 引用块（保留行内正常内容）。
  const unquoted = kept.filter((line) => !/^\s*>/.test(line));
  return normalizeBlankLines(unquoted.join("\n")).trim();
}

/** 剥离 "-- " 签名块（只在末尾像签名时才剪，避免误伤正文分隔线）。 */
export function stripSignature(input: string): string {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  let cutAt = -1;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "--" || DEVICE_SIGNATURE.test(line)) cutAt = index;
  }
  if (cutAt < 0) return input.trim();
  const before = lines.slice(0, cutAt).join("\n").trimEnd();
  const after = lines.slice(cutAt + 1).filter((line) => line.trim() !== "").length;
  // 签名通常很短；后面还有大段正文时说明 "--" 只是分隔线，不剪。
  return after <= 15 && before.trim() !== "" ? before : input.trim();
}

/** 流水线入口：剥离引文 + 签名。 */
export function cleanBody(input: string): string {
  return stripSignature(stripQuoted(input)).trim();
}

function findQuoteStart(lines: readonly string[]): number {
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (SEPARATOR_PATTERNS.some((pattern) => pattern.test(line))) return index;
    if (REPLY_HEADER_PATTERNS.some((pattern) => pattern.test(line))) return index;
  }
  return findHeaderBlockStart(lines);
}

/**
 * 中文（发件人/发送时间/收件人/主题）或英文（From/Sent/To/Subject）头部块：
 * 至少两个不同标签连续出现，才算被引用的历史邮件。
 */
function findHeaderBlockStart(lines: readonly string[]): number {
  const headerLines: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (headerLabelOf(line)) headerLines.push(index);
  }
  for (let cursor = 0; cursor + 1 < headerLines.length; cursor += 1) {
    const first = headerLines[cursor];
    const second = headerLines[cursor + 1];
    if (first === undefined || second === undefined) continue;
    if (second - first > 8) continue;
    const labels = new Set(
      [lines[first], lines[second]]
        .map((line) => headerLabelOf(line ?? ""))
        .filter((label): label is string => label !== null),
    );
    if (labels.size >= 2) return first;
  }
  return -1;
}

function headerLabelOf(line: string): string | null {
  const match = /^\s*([^\s:：]{1,8})\s*[:：]/.exec(line);
  if (!match) return null;
  const label = (match[1] ?? "").toLowerCase();
  return CHINESE_HEADER_LABELS.includes(label) || ENGLISH_HEADER_LABELS.includes(label) ? label : null;
}

function normalizeBlankLines(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "");
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  middot: "·",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    const lower = body.toLowerCase();
    if (lower.startsWith("#x")) return safeCodePoint(Number.parseInt(lower.slice(2), 16), whole);
    if (lower.startsWith("#")) return safeCodePoint(Number.parseInt(lower.slice(1), 10), whole);
    return NAMED_ENTITIES[lower] ?? whole;
  });
}

function safeCodePoint(code: number, fallback: string): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}
