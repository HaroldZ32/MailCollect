import {
  RULE_FIELDS,
  RULE_OPERATOR_NAMES,
  type DateBasis,
  type FieldLeaf,
  type RuleOperator,
  type RuleTree,
  type SemanticLeaf,
} from "@mailcollect/shared";

/**
 * 字段叶子求值（C6 / AC-19）。
 *
 * 约定（与需求逐条对应）：
 * - 归一化：Unicode NFKC + 小写 + 空白压缩（连续空白含换行/制表符 → 单个空格并 trim）；
 *   邮箱地址先取尖括号里的小写地址；CJK 走子串匹配（不依赖词边界）。
 * - 空值：字段缺失/空串 → 该字段叶子 `false`（含 `notEquals` / `notContains`）；
 *   因此 `not(缺失字段条件)` 自然为 `true`。
 * - 日期：`value` 为 ISO 8601 或 `YYYY-MM-DD`，无时区信息时按用户 IANA 时区解释。
 *   日粒度的语义固定为：`before` 严格早于该日 00:00，`after` 严格晚于该日
 *   23:59:59.999，`between` 为闭区间（上界若只给日期则取当日结束）。
 * - `from` 的候选值 = 地址 + 域名 + 显示名；`to` / `cc` = 每个收件人的地址 + 显示名。
 *   多候选时：`equals/contains/startsWith/endsWith/in` 任一命中即真，
 *   `notEquals/notContains` 全部不命中才真。
 * - `attachmentSize` 对任一附件成立即真；`to.count` / `cc.count` / `recipient.count`
 *   统计非空地址数。
 */

export interface RuleAttachment {
  filename: string;
  mimeType: string;
  size: number;
}

/** 规则求值需要的邮件投影（不依赖 store 行结构，便于适配与测试）。 */
export interface RuleEmail {
  id: string;
  accountId: string;
  fromName: string | null;
  fromEmail: string;
  to: readonly string[];
  cc: readonly string[];
  subject: string;
  bodyText: string;
  /** ISO 8601（Date 头）。 */
  sentAt: string;
  /** 可选：接收时间；`which: "received"` 时使用。缺失即视为字段缺失。 */
  receivedAt?: string | null;
  headers: Readonly<Record<string, string>>;
  /** 可选：是否带附件（与 `attachments` 二选一或同时给出）。 */
  hasAttachments?: boolean;
  attachments?: readonly RuleAttachment[];
  isRead?: boolean | null;
  folder?: string | null;
  /** 可选：账号展示名/地址；缺省回退为 `accountId`。 */
  account?: string | null;
}

export type SemanticResolver = (leaf: SemanticLeaf) => boolean | Promise<boolean>;

/**
 * 求值期类型化错误：未经 AST 校验的非法叶子（未知字段/操作符/节点种类）
 * 必须报错，不能静默判 false。分类器会捕获它并记为一条规则级错误。
 */
export type RuleEvaluationErrorCode =
  | "unknown_field"
  | "unknown_operator"
  | "unsupported_operator"
  | "unknown_node_kind";

export class RuleEvaluationError extends Error {
  override readonly name = "RuleEvaluationError";

  constructor(
    readonly code: RuleEvaluationErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface EvaluationContext {
  /** 用户全部邮箱地址，用于 `iAmInTo`。 */
  readonly userEmails: readonly string[];
  /** 用户 IANA 时区；缺省 UTC。 */
  readonly timezone?: string;
  /** 语义叶子解析器；缺省时语义叶子判 false（调用方应先批量求值）。 */
  readonly semantic?: SemanticResolver;
}

/** R4 的 no-reply 判定（本地部分），保持与旧代码一致。 */
const NO_REPLY_RE = /no-?reply|do-not-reply|notification|bounce/i;

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_WITH_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;
const LOCAL_DATE_TIME_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/** 时区在该瞬间的偏移（毫秒）；无法识别的时区回退 UTC。 */
function timeZoneOffsetMs(instant: number, timeZone: string): number {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = getFormatter(timeZone);
  } catch {
    formatter = getFormatter("UTC");
  }
  const wholeSecond = Math.floor(instant / 1000) * 1000;
  const parts = formatter.formatToParts(new Date(wholeSecond));
  const valueOf = (type: string): number => {
    const part = parts.find((entry) => entry.type === type);
    return part ? Number(part.value) : 0;
  };
  const asUtc = Date.UTC(
    valueOf("year"),
    valueOf("month") - 1,
    valueOf("day"),
    valueOf("hour") % 24,
    valueOf("minute"),
    valueOf("second"),
  );
  return asUtc - wholeSecond;
}

/** 某 IANA 时区的本地时间 → UTC 瞬间。 */
export function zonedInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  millisecond: number,
  timeZone: string,
): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second, millisecond);
  let instant = naive;
  // 偏移本身依赖瞬间；两次迭代足以收敛，夏令时切换的歧义时间取先出现的那次偏移。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const offset = timeZoneOffsetMs(instant, timeZone);
    const next = naive - offset;
    if (next === instant) break;
    instant = next;
  }
  return instant;
}

/**
 * 解析规则里的日期字面值。返回 epoch ms 或 null。
 * 带 Z/偏移的 ISO 直接用；`YYYY-MM-DD` / 无时区本地时间按 IANA 时区解释。
 */
export function parseDateInTimezone(value: string, timeZone: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  if (DATE_ONLY_RE.test(trimmed)) {
    const [year, month, day] = trimmed.split("-").map(Number);
    if (year === undefined || month === undefined || day === undefined) return null;
    return zonedInstant(year, month, day, 0, 0, 0, 0, timeZone);
  }

  if (ISO_WITH_ZONE_RE.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const local = LOCAL_DATE_TIME_RE.exec(trimmed);
  if (local) {
    const year = Number(local[1]);
    const month = Number(local[2]);
    const day = Number(local[3]);
    const hour = Number(local[4]);
    const minute = Number(local[5]);
    const second = local[6] === undefined ? 0 : Number(local[6]);
    const fraction = local[7] ?? "";
    const millisecond = fraction === "" ? 0 : Number(fraction.padEnd(3, "0"));
    return zonedInstant(year, month, day, hour, minute, second, millisecond, timeZone);
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/** 日期字面值为「日」粒度时，取该日结束（闭区间上界）。 */
function endOfDayInTimezone(value: string, timeZone: string): number | null {
  const trimmed = value.trim();
  if (!DATE_ONLY_RE.test(trimmed)) return parseDateInTimezone(trimmed, timeZone);
  const [year, month, day] = trimmed.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  return zonedInstant(year, month, day, 23, 59, 59, 999, timeZone);
}

/**
 * 引擎统一的字符串归一化（与共享契约「归一化与匹配语义」逐字一致）：
 * NFKC + 小写 + 空白压缩（连续空白含换行/制表符 → 单个空格）+ 两端 trim。
 *
 * 所有字符串操作符（equals/contains/startsWith/endsWith/in）与 `matchesWholeWord`
 * 都必须走这一条路，保证同一对文本在不同操作符下结论一致、UI 预览与引擎一致。
 */
export function normalizeRuleText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export interface ParsedAddress {
  /** 小写地址；原始值不是地址时保留小写原文。 */
  readonly address: string;
  /** 显示名（原样，保留大小写）。 */
  readonly display: string;
  /** 小写域名；无 `@` 时为空串。 */
  readonly domain: string;
}

/** `"张三 <A@B.com>"` → `{ address:"a@b.com", display:"张三", domain:"b.com" }`。 */
export function parseAddress(raw: string): ParsedAddress {
  const trimmed = raw.trim();
  const angled = /<([^<>]+)>/.exec(trimmed);
  const display = angled ? trimmed.slice(0, angled.index).trim() : "";
  const address = (angled?.[1] ?? trimmed).trim().toLowerCase();
  const at = address.lastIndexOf("@");
  const domain = at >= 0 ? address.slice(at + 1) : "";
  return { address, display, domain };
}

/** 兼容旧 R4 语义：取尖括号里的小写地址。 */
export function normalizeAddress(raw: string): string {
  return parseAddress(raw).address;
}

/** R4 的 `from.isNoReply`：本地部分命中 no-reply 类词。 */
export function isNoReplySender(fromEmail: string): boolean {
  const localPart = (normalizeAddress(fromEmail).split("@")[0] ?? "").toLowerCase();
  return localPart !== "" && NO_REPLY_RE.test(localPart);
}

/**
 * 「整词/令牌」操作符名单。
 *
 * 共享契约只认 `wholeWord`（captain 钉死的 id）；它的语义见
 * {@link matchesWholeWord}。名单之外的未知操作符会得到 `unsupported_operator`
 * 类型化错误，绝不静默 false。
 */
const WHOLE_WORD_OPERATORS: readonly string[] = ["wholeWord"];

function isWholeWordOperator(op: string): boolean {
  return WHOLE_WORD_OPERATORS.includes(op);
}

function isKnownOperator(value: string): value is RuleOperator {
  return (RULE_OPERATOR_NAMES as readonly string[]).includes(value);
}

const ASCII_ONLY_RE = /^[\x00-\x7f]+$/;

/**
 * v1 R3 的姓名/令牌匹配语义（复刻 AC-25 的种子等价）：
 * - ASCII 文本要求词边界（"Li" 不命中 "Lion"，但命中 "ask Li now"）；
 * - 含非 ASCII 字符（CJK 等）按去空白子串匹配（中文没有词边界概念，
 *   "张三" 命中 "张三丰"）；
 * - 两者都先做 NFKC + 小写，空白压缩为单个空格。
 */
export function matchesWholeWord(haystack: string, needle: string): boolean {
  // normalizeRuleText 已包含 NFKC + 小写 + 空白压缩 + trim；这里不再重复压缩，
  // 否则「双重压缩」会让含换行的 CJK 文本与子串语义悄悄分叉。
  const text = normalizeRuleText(haystack);
  const word = normalizeRuleText(needle);
  if (word === "") return false;

  if (!ASCII_ONLY_RE.test(word)) {
    return text.replace(/\s+/g, "").includes(word.replace(/\s+/g, ""));
  }

  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9_])${escaped}(?![a-z0-9_])`).test(text);
}

interface ExtractedField {
  readonly present: boolean;
  readonly strings?: readonly string[];
  readonly numbers?: readonly number[];
  readonly date?: number;
  readonly bool?: boolean;
}

const ABSENT: ExtractedField = { present: false };

function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | null {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.trim().toLowerCase() !== wanted) continue;
    const text = String(value).trim();
    return text === "" ? null : text;
  }
  return null;
}

function stringField(values: readonly string[]): ExtractedField {
  const kept = values.map((value) => value.trim()).filter((value) => value !== "");
  if (kept.length === 0) return ABSENT;
  return { present: true, strings: kept };
}

function dateField(raw: string | null | undefined, timeZone: string): ExtractedField {
  if (raw === null || raw === undefined) return ABSENT;
  const instant = parseDateInTimezone(raw, timeZone);
  if (instant === null) return ABSENT;
  return { present: true, date: instant };
}

function extractField(field: FieldLeaf, email: RuleEmail, context: EvaluationContext): ExtractedField {
  const timeZone = context.timezone ?? "UTC";

  switch (field.field) {
    case "from": {
      const parsed = parseAddress(email.fromEmail);
      const display = (email.fromName ?? parsed.display).trim();
      return stringField([parsed.address, parsed.domain, display]);
    }
    case "to":
      return stringField(
        email.to.flatMap((raw) => {
          const parsed = parseAddress(raw);
          return [parsed.address, parsed.display];
        }),
      );
    case "cc":
      return stringField(
        email.cc.flatMap((raw) => {
          const parsed = parseAddress(raw);
          return [parsed.address, parsed.display];
        }),
      );
    case "subject":
      return stringField([email.subject]);
    case "body":
      return stringField([email.bodyText]);
    case "date": {
      const which: DateBasis = field.which ?? "sent";
      return dateField(which === "received" ? email.receivedAt : email.sentAt, timeZone);
    }
    case "listId": {
      const value = headerValue(email.headers, "list-id");
      return value === null ? ABSENT : stringField([value]);
    }
    case "precedence": {
      const value = headerValue(email.headers, "precedence");
      return value === null ? ABSENT : stringField([value]);
    }
    case "autoSubmitted": {
      const value = headerValue(email.headers, "auto-submitted");
      return value === null ? ABSENT : stringField([value]);
    }
    case "hasAttachments": {
      const attachments = email.attachments;
      if (attachments === undefined && email.hasAttachments === undefined) return ABSENT;
      const value = email.hasAttachments ?? (attachments !== undefined && attachments.length > 0);
      return { present: true, bool: value };
    }
    case "attachmentName":
      return stringField((email.attachments ?? []).map((attachment) => attachment.filename));
    case "attachmentMime":
      return stringField((email.attachments ?? []).map((attachment) => attachment.mimeType));
    case "attachmentSize": {
      const sizes = (email.attachments ?? []).map((attachment) => attachment.size);
      if (sizes.length === 0) return ABSENT;
      return { present: true, numbers: sizes };
    }
    case "isRead": {
      if (typeof email.isRead !== "boolean") return ABSENT;
      return { present: true, bool: email.isRead };
    }
    case "folder": {
      if (email.folder === null || email.folder === undefined) return ABSENT;
      return stringField([email.folder]);
    }
    case "account": {
      const value = email.account ?? email.accountId;
      return stringField([value]);
    }
    case "to.count": {
      const count = email.to.map(normalizeAddress).filter((address) => address !== "").length;
      return { present: true, numbers: [count] };
    }
    case "cc.count": {
      const count = email.cc.map(normalizeAddress).filter((address) => address !== "").length;
      return { present: true, numbers: [count] };
    }
    case "recipient.count": {
      const to = email.to.map(normalizeAddress).filter((address) => address !== "").length;
      const cc = email.cc.map(normalizeAddress).filter((address) => address !== "").length;
      return { present: true, numbers: [to + cc] };
    }
    case "iAmInTo": {
      const user = new Set(
        context.userEmails.map(normalizeAddress).filter((address) => address !== ""),
      );
      const inTo = email.to.some((raw) => {
        const address = normalizeAddress(raw);
        return address !== "" && user.has(address);
      });
      return { present: true, bool: inTo };
    }
    case "from.isNoReply": {
      const address = normalizeAddress(email.fromEmail);
      if (address === "") return ABSENT;
      return { present: true, bool: isNoReplySender(address) };
    }
    default:
      throw new RuleEvaluationError("unknown_field", `未知规则字段：${String(field.field)}`);
  }
}

function anyString(
  field: ExtractedField,
  predicate: (candidate: string) => boolean,
): boolean {
  return (field.strings ?? []).some(predicate);
}

function equalsValue(field: ExtractedField, value: string): boolean {
  const needle = normalizeRuleText(value);
  return anyString(field, (candidate) => normalizeRuleText(candidate) === needle);
}

function containsValue(field: ExtractedField, value: string): boolean {
  const needle = normalizeRuleText(value);
  if (needle === "") return false;
  return anyString(field, (candidate) => normalizeRuleText(candidate).includes(needle));
}

function startsWithValue(field: ExtractedField, value: string): boolean {
  const needle = normalizeRuleText(value);
  if (needle === "") return false;
  return anyString(field, (candidate) => normalizeRuleText(candidate).startsWith(needle));
}

function endsWithValue(field: ExtractedField, value: string): boolean {
  const needle = normalizeRuleText(value);
  if (needle === "") return false;
  return anyString(field, (candidate) => normalizeRuleText(candidate).endsWith(needle));
}

/** 字符串操作符；非法值（理论上已被 AST 拦下）判 false。 */
function applyStringOperator(field: ExtractedField, op: RuleOperator, value: unknown): boolean {
  if (op === "in") {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return false;
    const needles = new Set(
      value.map((item) => normalizeRuleText(String(item))).filter((item) => item !== ""),
    );
    return anyString(field, (candidate) => needles.has(normalizeRuleText(candidate)));
  }
  if (typeof value !== "string") return false;

  switch (op) {
    case "equals":
      return equalsValue(field, value);
    case "notEquals":
      return !equalsValue(field, value);
    case "contains":
      return containsValue(field, value);
    case "notContains":
      return !containsValue(field, value);
    case "startsWith":
      return startsWithValue(field, value);
    case "endsWith":
      return endsWithValue(field, value);
    default:
      if (isWholeWordOperator(op)) {
        return anyString(field, (candidate) => matchesWholeWord(candidate, value));
      }
      throw new RuleEvaluationError("unsupported_operator", `字符串字段不支持操作符 ${op}`);
  }
}

function applyNumberOperator(field: ExtractedField, op: RuleOperator, value: unknown): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const numbers = field.numbers ?? [];
  switch (op) {
    case "gt":
      return numbers.some((number) => number > value);
    case "lt":
      return numbers.some((number) => number < value);
    case "gte":
      return numbers.some((number) => number >= value);
    case "lte":
      return numbers.some((number) => number <= value);
    default:
      throw new RuleEvaluationError("unsupported_operator", `数值字段不支持操作符 ${op}`);
  }
}

function applyDateOperator(
  field: ExtractedField,
  op: RuleOperator,
  value: unknown,
  timeZone: string,
): boolean {
  if (field.date === undefined) return false;
  const instant = field.date;

  if (op === "between") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const range = value as { from?: unknown; to?: unknown };
    if (typeof range.from !== "string" || typeof range.to !== "string") return false;
    const lower = parseDateInTimezone(range.from, timeZone);
    const upper = endOfDayInTimezone(range.to, timeZone);
    if (lower === null || upper === null) return false;
    return instant >= lower && instant <= upper;
  }

  if (typeof value !== "string") return false;
  if (op === "before") {
    const boundary = parseDateInTimezone(value, timeZone);
    return boundary !== null && instant < boundary;
  }
  if (op === "after") {
    // 日粒度：「晚于该日」= 该日结束之后，避免当日邮件被误判为“晚于当天”。
    const boundary = endOfDayInTimezone(value, timeZone);
    return boundary !== null && instant > boundary;
  }
  throw new RuleEvaluationError("unsupported_operator", `日期字段不支持操作符 ${op}`);
}

function applyBooleanOperator(field: ExtractedField, op: RuleOperator): boolean {
  if (typeof field.bool !== "boolean") return false;
  if (op === "isTrue") return field.bool;
  if (op === "isFalse") return !field.bool;
  throw new RuleEvaluationError("unsupported_operator", `布尔字段不支持操作符 ${op}`);
}

/** 单个字段叶子的求值；未知字段/操作符抛 {@link RuleEvaluationError}（不静默 false）。 */
export function evaluateFieldLeaf(
  leaf: FieldLeaf,
  email: RuleEmail,
  context: EvaluationContext,
): boolean {
  if (!Object.hasOwn(RULE_FIELDS, leaf.field)) {
    throw new RuleEvaluationError("unknown_field", `未知规则字段：${String(leaf.field)}`);
  }
  const spec = RULE_FIELDS[leaf.field];
  if (!isKnownOperator(leaf.op)) {
    throw new RuleEvaluationError("unknown_operator", `未知规则操作符：${String(leaf.op)}`);
  }
  if (!spec.ops.includes(leaf.op)) {
    throw new RuleEvaluationError(
      "unsupported_operator",
      `字段 ${leaf.field} 不支持操作符 ${leaf.op}`,
    );
  }

  const field = extractField(leaf, email, context);
  if (leaf.op === "exists") return field.present;
  if (leaf.op === "notExists") return !field.present;
  if (!field.present) return false;

  const timeZone = context.timezone ?? "UTC";
  switch (leaf.field) {
    case "hasAttachments":
    case "isRead":
    case "iAmInTo":
    case "from.isNoReply":
      // 布尔操作符（isTrue/isFalse）不需要值。
      return applyBooleanOperator(field, leaf.op);
    case "date":
      if (leaf.value === undefined) return false;
      return applyDateOperator(field, leaf.op, leaf.value, timeZone);
    case "to.count":
    case "cc.count":
    case "recipient.count":
    case "attachmentSize":
      if (leaf.value === undefined) return false;
      return applyNumberOperator(field, leaf.op, leaf.value);
    default:
      if (leaf.value === undefined) return false;
      return applyStringOperator(field, leaf.op, leaf.value);
  }
}

/** 条件树求值；语义叶子经由 `context.semantic` 解析，未提供则判 false。 */
export async function evaluateRuleTree(
  tree: RuleTree,
  email: RuleEmail,
  context: EvaluationContext,
): Promise<boolean> {
  switch (tree.kind) {
    case "field":
      return evaluateFieldLeaf(tree, email, context);
    case "semantic": {
      if (!context.semantic) return false;
      try {
        return Boolean(await context.semantic(tree));
      } catch {
        return false;
      }
    }
    case "not":
      return !(await evaluateRuleTree(tree.child, email, context));
    case "and": {
      for (const child of tree.children) {
        if (!(await evaluateRuleTree(child, email, context))) return false;
      }
      return true;
    }
    case "or": {
      for (const child of tree.children) {
        if (await evaluateRuleTree(child, email, context)) return true;
      }
      return false;
    }
    default: {
      const unknown = tree as { kind?: unknown };
      throw new RuleEvaluationError(
        "unknown_node_kind",
        `未知规则节点种类：${String(unknown.kind)}`,
      );
    }
  }
}
