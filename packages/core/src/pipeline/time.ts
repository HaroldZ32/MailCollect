import * as chrono from "chrono-node";
import type { TaskKind, TaskTime } from "@mailcollect/shared";

/**
 * 时间解析：模型只给原文时间短语，日期运算全部在这里确定性完成。
 * 锚点是邮件 Date 头（referenceDate），时区是用户档案里的 IANA 时区；
 * 夏令时交给 Intl / tzdata，绝不手算 UTC 偏移。
 */
export interface ResolveTimeInput {
  phrase: string | null | undefined;
  kind: TaskKind;
  referenceDate: Date | string;
  timezone: string;
}

/**
 * 「下班前 / 上班前」这类短语里没有钟点，chrono 会落到当天 12:00。
 * 这里只补一个业务约定的钟点；仍然通过 Intl 换算到 UTC，不手算偏移。
 */
const CLOCK_HINTS: ReadonlyArray<{ pattern: RegExp; hour: number; minute: number }> = [
  { pattern: /下班前|下班之前|收工前|before (the )?end of (the )?(work ?day|day)/i, hour: 18, minute: 0 },
  { pattern: /上班前|上班之前/i, hour: 9, minute: 0 },
  { pattern: /中午前|午饭前/i, hour: 12, minute: 0 },
  { pattern: /\b(eod|cob|end of day|close of business)\b/i, hour: 18, minute: 0 },
];

/** 短语里是否自带钟点（有钟点就完全听 chrono 的）。 */
const EXPLICIT_CLOCK = /(\d{1,2}\s*[:：]\s*\d{2})|(\d{1,2}\s*[点时](\s*\d{1,2}\s*分)?)|(\b(am|pm)\b)/i;

const MINUTE_MS = 60_000;

export function resolveTaskTime(input: ResolveTimeInput): TaskTime {
  const timezone = assertTimezone(input.timezone);
  const phrase = input.phrase?.trim() ?? "";
  const blank: TaskTime = {
    phrase: phrase === "" ? null : phrase,
    dueAt: null,
    windowStart: null,
    windowEnd: null,
    timezone,
    confidence: 0,
  };
  if (phrase === "") return blank;

  const referenceDate = input.referenceDate instanceof Date
    ? input.referenceDate
    : new Date(input.referenceDate);
  if (Number.isNaN(referenceDate.getTime())) return blank;

  const parsed = parseInZone(phrase, referenceDate, timezone);
  const first = parsed[0];
  if (!first) return blank;

  const explicitClock = EXPLICIT_CLOCK.test(phrase);
  const offsetMinutes = offsetMinutesAt(referenceDate, timezone);
  const start = toZonedInstant(first.start, offsetMinutes, timezone);

  // chrono 自己识别显式区间（"下周一至周三" / "Mon to Wed"）。
  if (first.end) {
    const rawEnd = toZonedInstant(first.end, offsetMinutes, timezone);
    const windowStart = explicitClock ? start : startOfDayLocal(start, timezone);
    const windowEnd = explicitClock ? rawEnd : endOfDayLocal(rawEnd, timezone);
    return {
      phrase,
      dueAt: null,
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      timezone,
      confidence: explicitClock ? 0.85 : 0.75,
    };
  }

  const hint = CLOCK_HINTS.find((candidate) => candidate.pattern.test(phrase));
  let due = start;
  let confidence = 0.7;
  if (explicitClock) {
    confidence = 0.9;
  } else if (input.kind === "deadline") {
    due = hint ? atLocalClock(start, timezone, hint.hour, hint.minute) : endOfDayLocal(start, timezone);
    confidence = hint ? 0.65 : 0.7;
  }

  return {
    phrase,
    dueAt: due.toISOString(),
    windowStart: null,
    windowEnd: null,
    timezone,
    confidence,
  };
}

/**
 * 中文优先，回退英文（chrono 的顶层 `parse` 默认只有英文解析器）。
 *
 * 这里必须传**数字分钟偏移**：chrono 2.x 收到 "Asia/Shanghai" 这类 IANA
 * 名字时 `toTimezoneOffset` 返回 null，会静默退回服务器本地时区。
 * 本机恰好是 Asia/Shanghai，所以只测中文/本地时区看不出这个 bug。
 */
const PARSERS: ReadonlyArray<Pick<chrono.Chrono, "parse">> = [chrono.zh, chrono.en];

function parseInZone(
  phrase: string,
  referenceDate: Date,
  timezone: string,
): chrono.ParsedResult[] {
  const offsetMinutes = offsetMinutesAt(referenceDate, timezone);
  for (const parser of PARSERS) {
    const results = parser.parse(phrase, { instant: referenceDate, timezone: offsetMinutes }, {});
    if (results.length > 0) return results;
  }
  return [];
}

function assertTimezone(timezone: string): string {
  const zone = timezone?.trim() ?? "";
  if (zone === "") throw new Error("用户时区为空，无法确定性地解析时间");
  try {
    formatterFor(zone);
  } catch {
    throw new Error(`无效的 IANA 时区：${timezone}`);
  }
  return zone;
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const cached = FORMATTERS.get(timezone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  FORMATTERS.set(timezone, formatter);
  return formatter;
}

function zonedParts(date: Date, timezone: string): ZonedParts {
  const parts = formatterFor(timezone).formatToParts(date);
  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number.parseInt(found.value, 10) : Number.NaN;
  };
  return {
    year: read("year"),
    month: read("month"),
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  };
}

/** 某一瞬间在该时区的偏移量（毫秒），由 Intl/tzdata 给出。 */
function localOffsetMs(date: Date, timezone: string): number {
  const parts = zonedParts(date, timezone);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function offsetMinutesAt(date: Date, timezone: string): number {
  return Math.round(localOffsetMs(date, timezone) / MINUTE_MS);
}

/** 该时区的「墙上时间」→ UTC 瞬间（两次校正，跨 DST 也正确）。 */
function zonedToUtc(
  parts: Pick<ZonedParts, "year" | "month" | "day" | "hour" | "minute" | "second">,
  timezone: string,
  millisecond: number,
): Date {
  const guess = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
    millisecond,
  );
  const firstOffset = localOffsetMs(new Date(guess), timezone);
  const candidate = new Date(guess - firstOffset);
  const secondOffset = localOffsetMs(candidate, timezone);
  return secondOffset === firstOffset ? candidate : new Date(guess - secondOffset);
}

/**
 * chrono 在「固定偏移」下把墙钟编码成 UTC；读出墙钟字段后，
 * 用目标日期的真实偏移换回 UTC 瞬间（跨 DST 的那一天也正确）。
 * 短语自带显式时区（如 "3pm EST"）时 chrono 已给出绝对瞬间，直接采用。
 */
function toZonedInstant(
  components: chrono.ParsedComponents,
  offsetMinutes: number,
  timezone: string,
): Date {
  const explicitOffset = components.get("timezoneOffset");
  if (explicitOffset !== null) return components.date();
  const wall = new Date(components.date().getTime() + offsetMinutes * MINUTE_MS);
  return zonedToUtc(
    {
      year: wall.getUTCFullYear(),
      month: wall.getUTCMonth() + 1,
      day: wall.getUTCDate(),
      hour: wall.getUTCHours(),
      minute: wall.getUTCMinutes(),
      second: wall.getUTCSeconds(),
    },
    timezone,
    wall.getUTCMilliseconds(),
  );
}

function startOfDayLocal(date: Date, timezone: string): Date {
  const parts = zonedParts(date, timezone);
  return zonedToUtc({ ...parts, hour: 0, minute: 0, second: 0 }, timezone, 0);
}

function endOfDayLocal(date: Date, timezone: string): Date {
  const parts = zonedParts(date, timezone);
  return zonedToUtc({ ...parts, hour: 23, minute: 59, second: 59 }, timezone, 999);
}

function atLocalClock(date: Date, timezone: string, hour: number, minute: number): Date {
  const parts = zonedParts(date, timezone);
  return zonedToUtc({ ...parts, hour, minute, second: 0 }, timezone, 0);
}
