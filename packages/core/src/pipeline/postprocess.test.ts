import { describe, expect, it } from "vitest";
import {
  SAME_DAY_BODY_SIGNAL,
  bodyFingerprint,
  countSameDayDuplicateBodies,
  isSameDayDuplicate,
} from "./postprocess.js";
import { makeEmail } from "./__test-helpers__/fixtures.js";

describe("分类后的确定性后处理：同日同文", () => {
  it("正文指纹做 NFKC + 小写 + 去零宽 + 压缩空白；纯空白返回 null", () => {
    expect(bodyFingerprint("ＡＢＣ  \u200b  d")).toBe(bodyFingerprint("abc d"));
    expect(bodyFingerprint("   ")).toBeNull();
    expect(bodyFingerprint(null)).toBeNull();
    expect(bodyFingerprint(undefined)).toBeNull();
  });

  it("同日同文 → 每封的同伴计数为 1；不同日/不同文 → 0", () => {
    const emails = [
      makeEmail({ id: "a", bodyText: "相同的 正文", sentAt: "2026-11-04T09:00:00+08:00" }),
      makeEmail({ id: "b", bodyText: "相同的 正文", sentAt: "2026-11-04T10:00:00+08:00" }),
      makeEmail({ id: "c", bodyText: "不同的正文", sentAt: "2026-11-04T11:00:00+08:00" }),
      makeEmail({ id: "d", bodyText: "相同的 正文", sentAt: "2026-11-05T09:00:00+08:00" }),
    ];

    const counts = countSameDayDuplicateBodies(emails, "Asia/Shanghai");

    expect(counts.get("a")).toBe(1);
    expect(counts.get("b")).toBe(1);
    expect(counts.get("c")).toBe(0);
    expect(counts.get("d")).toBe(0);
  });

  it("按用户时区划天：上海跨天但 UTC 同天的两封，只在 UTC 下算同一条", () => {
    const emails = [
      makeEmail({ id: "x", bodyText: "同一正文", sentAt: "2026-11-04T23:30:00+08:00" }),
      makeEmail({ id: "y", bodyText: "同一正文", sentAt: "2026-11-05T00:30:00+08:00" }),
    ];

    expect(countSameDayDuplicateBodies(emails, "Asia/Shanghai").get("x")).toBe(0);
    expect(countSameDayDuplicateBodies(emails, "UTC").get("x")).toBe(1);
  });

  it("空正文不参与计数（不把空邮件当成同一条）", () => {
    const emails = [
      makeEmail({ id: "e1", bodyText: "" }),
      makeEmail({ id: "e2", bodyText: "" }),
    ];

    expect(countSameDayDuplicateBodies(emails, "Asia/Shanghai").size).toBe(0);
  });

  it("isSameDayDuplicate 与信号常量", () => {
    expect(isSameDayDuplicate(0)).toBe(false);
    expect(isSameDayDuplicate(1)).toBe(true);
    expect(isSameDayDuplicate(undefined)).toBe(false);
    expect(SAME_DAY_BODY_SIGNAL).toBe("deterministic:same-day-body-hash");
  });
});
