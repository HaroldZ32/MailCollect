import { describe, expect, it } from "vitest";
import { resolveTaskTime } from "./time.js";

const REFERENCE = "2026-11-04T09:00:00+08:00"; // 周三 09:00 上海
const SHANGHAI = "Asia/Shanghai";

describe("resolveTaskTime", () => {
  it("「周五下班前」解析到周五 18:00（IANA 时区）", () => {
    const time = resolveTaskTime({
      phrase: "周五下班前",
      kind: "deadline",
      referenceDate: REFERENCE,
      timezone: SHANGHAI,
    });
    expect(time.dueAt).toBe("2026-11-06T10:00:00.000Z"); // 18:00 +08:00
    expect(time.timezone).toBe(SHANGHAI);
    expect(time.confidence).toBe(0.65);
    expect(time.windowStart).toBeNull();
  });

  it("「下周一至周三」解析成整段区间（含首尾整天）", () => {
    const time = resolveTaskTime({
      phrase: "下周一至周三",
      kind: "window",
      referenceDate: REFERENCE,
      timezone: SHANGHAI,
    });
    expect(time.dueAt).toBeNull();
    expect(time.windowStart).toBe("2026-11-08T16:00:00.000Z"); // 11-09 00:00 +08:00
    expect(time.windowEnd).toBe("2026-11-11T15:59:59.999Z"); // 11-11 23:59:59.999 +08:00
    expect(time.confidence).toBe(0.75);
  });

  it("自带钟点的短语完全交给 chrono", () => {
    const time = resolveTaskTime({
      phrase: "11月10日 18:00",
      kind: "deadline",
      referenceDate: REFERENCE,
      timezone: SHANGHAI,
    });
    expect(time.dueAt).toBe("2026-11-10T10:00:00.000Z");
    expect(time.confidence).toBe(0.9);
  });

  it("无钟点的截止日落到当天 23:59:59.999（本地时区）", () => {
    const time = resolveTaskTime({
      phrase: "本周五前提交",
      kind: "deadline",
      referenceDate: REFERENCE,
      timezone: SHANGHAI,
    });
    expect(time.dueAt).toBe("2026-11-06T15:59:59.999Z");
  });

  it("DST 当天按目标时区的真实偏移解析（纽约 3 月 8 日已进入 EDT）", () => {
    const daylight = resolveTaskTime({
      phrase: "3月8日 9:00",
      kind: "deadline",
      referenceDate: "2026-03-05T12:00:00Z",
      timezone: "America/New_York",
    });
    // 09:00 EDT = 13:00Z；若忽略 IANA 时区会错成 14:00Z 或 01:00Z。
    expect(daylight.dueAt).toBe("2026-03-08T13:00:00.000Z");

    const endOfDay = resolveTaskTime({
      phrase: "3月8日",
      kind: "deadline",
      referenceDate: "2026-03-05T12:00:00Z",
      timezone: "America/New_York",
    });
    expect(endOfDay.dueAt).toBe("2026-03-09T03:59:59.999Z"); // 23:59:59.999 EDT
  });

  it("同一短语在不同 IANA 时区得到不同瞬间", () => {
    const shanghai = resolveTaskTime({
      phrase: "3月8日 9:00",
      kind: "deadline",
      referenceDate: "2026-03-05T12:00:00Z",
      timezone: "Asia/Shanghai",
    });
    expect(shanghai.dueAt).toBe("2026-03-08T01:00:00.000Z");
  });

  it("英文短语回退到英文解析器", () => {
    const time = resolveTaskTime({
      phrase: "Friday EOD",
      kind: "deadline",
      referenceDate: "2026-11-04T09:00:00+08:00",
      timezone: "America/New_York",
    });
    expect(time.dueAt).toBe("2026-11-06T23:00:00.000Z"); // 18:00 EST
    expect(time.confidence).toBe(0.65);
  });

  it("没有时间短语时返回空结果", () => {
    const time = resolveTaskTime({
      phrase: null,
      kind: "action",
      referenceDate: REFERENCE,
      timezone: SHANGHAI,
    });
    expect(time).toEqual({
      phrase: null,
      dueAt: null,
      windowStart: null,
      windowEnd: null,
      timezone: SHANGHAI,
      confidence: 0,
    });
  });

  it("无法解析的短语保留 phrase 但不编造日期", () => {
    const time = resolveTaskTime({
      phrase: "尽快",
      kind: "deadline",
      referenceDate: REFERENCE,
      timezone: SHANGHAI,
    });
    expect(time.phrase).toBe("尽快");
    expect(time.dueAt).toBeNull();
    expect(time.confidence).toBe(0);
  });

  it("无效的 IANA 时区直接报错，不静默退回本地时区", () => {
    expect(() =>
      resolveTaskTime({
        phrase: "周五",
        kind: "deadline",
        referenceDate: REFERENCE,
        timezone: "Mars/Olympus",
      }),
    ).toThrow(/无效的 IANA 时区/);
  });
});
