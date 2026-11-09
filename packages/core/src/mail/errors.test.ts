import { describe, expect, it } from "vitest";
import { redact, toMailError } from "./errors.js";

describe("redact：短 secret 也必须脱敏", () => {
  it("长度 1-3 的 secret 全量替换为 ***，不留明文", () => {
    expect(redact("pin=123 rejected", ["123"])).toBe("pin=*** rejected");
    expect(redact("pw=ab", ["ab"])).toBe("pw=***");
    expect(redact("x", ["x"])).toBe("***");
  });

  it("多个 secret（含长串）一起替换", () => {
    expect(redact("a1 and b2 and s3cret-token", ["a1", "b2", "s3cret-token"])).toBe("*** and *** and ***");
  });

  it("空串不参与替换，避免把文本拆碎", () => {
    expect(redact("abc", [""])).toBe("abc");
    expect(redact("abc", [""])).toBe(redact("abc", []));
  });
});

describe("toMailError：错误信息里不出现短密码", () => {
  it("3 位密码在映射后的可读文案里已被擦除", () => {
    const error = toMailError(new Error("authentication failed for pin 123"), ["123"]);

    expect(error.message).not.toContain("123");
    expect(error.message).toContain("***");
    expect(error.message).toContain("认证失败");
  });

  it("空 secret 不会破坏原始文案", () => {
    const error = toMailError(new Error("socket hang up"), [""]);
    expect(error.message).toContain("socket hang up");
  });
});
