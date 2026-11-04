import { describe, expect, it } from "vitest";
import {
  compactText,
  describeIdentityMentions,
  findIdentityHits,
  mentionsUser,
  normalizeText,
} from "./identity.js";
import { makeProfile } from "./__test-helpers__/fixtures.js";

const profile = makeProfile();

describe("identity 归一化", () => {
  it("NFKC 归一全角字符并压缩空白", () => {
    expect(normalizeText("ＳＡＮ　　ＺＨＡＮＧ")).toBe("SAN ZHANG");
    expect(compactText("张 三")).toBe("张三");
  });
});

describe("findIdentityHits", () => {
  it("命中姓名", () => {
    const hits = findIdentityHits("请张三处理这份报告", profile);
    expect(hits).toContainEqual({ kind: "display-name", matched: "张三" });
  });

  it("别名带空格也能命中", () => {
    const hits = findIdentityHits("请张 三处理", profile);
    expect(hits.some((hit) => hit.kind === "alias" && hit.matched === "张 三")).toBe(true);
  });

  it("全角 + 大小写不同的英文别名也能命中", () => {
    const hits = findIdentityHits("Assign to ＳＡＮ　ＺＨＡＮＧ please", profile);
    expect(hits.some((hit) => hit.matched === "San Zhang")).toBe(true);
  });

  it("命中完整邮箱", () => {
    const hits = findIdentityHits("收件人是 zhangsan@example.com", profile);
    expect(hits.some((hit) => hit.kind === "email")).toBe(true);
  });

  it("命中邮箱前缀", () => {
    const hits = findIdentityHits("zhangsan 负责这个", profile);
    expect(hits.some((hit) => hit.kind === "email-local" && hit.matched === "zhangsan")).toBe(
      true,
    );
  });

  it("ASCII 短名要求词边界（Li 不命中 Lion）", () => {
    const asciiProfile = makeProfile({ displayName: "Li", aliases: [] });
    expect(mentionsUser("Lion is here", asciiProfile)).toBe(false);
    expect(mentionsUser("ask Li now", asciiProfile)).toBe(true);
  });

  it("没有出现任何身份信息时返回空", () => {
    expect(findIdentityHits("今天天气不错", profile)).toEqual([]);
  });

  it("describeIdentityMentions 给出可读摘要", () => {
    const summary = describeIdentityMentions("张三，请周五前提交", profile);
    expect(summary).toContain("张三");
    expect(summary).toContain("姓名");
    expect(describeIdentityMentions("今天天气不错", profile)).toContain("未出现");
  });
});
