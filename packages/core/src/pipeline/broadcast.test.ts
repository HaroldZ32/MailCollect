import { describe, expect, it } from "vitest";
import type { BroadcastInput } from "./broadcast.js";
import { classifyBroadcast, hashBody, judgeBroadcast } from "./broadcast.js";
import { makeEmail, makeProfile } from "./__test-helpers__/fixtures.js";

const profile = makeProfile();

function judge(overrides: Partial<BroadcastInput> = {}) {
  return judgeBroadcast({
    headers: {},
    fromEmail: "boss@corp.cn",
    to: ["zhangsan@example.com"],
    cc: [],
    userEmails: profile.emails,
    ...overrides,
  });
}

describe("judgeBroadcast 强信号 → broadcast", () => {
  it("List-Id", () => {
    const verdict = judge({ headers: { "List-Id": "<devs.lists.example.com>" } });
    expect(verdict.kind).toBe("broadcast");
    expect(verdict.signals).toContain("header:list-id");
  });

  it("List-Unsubscribe", () => {
    const verdict = judge({ headers: { "List-Unsubscribe": "<mailto:unsub@example.com>" } });
    expect(verdict.kind).toBe("broadcast");
    expect(verdict.signals).toContain("header:list-unsubscribe");
  });

  it("List-Post", () => {
    const verdict = judge({ headers: { "List-Post": "<mailto:list@example.com>" } });
    expect(verdict.kind).toBe("broadcast");
    expect(verdict.signals).toContain("header:list-post");
  });

  it("头部名大小写不敏感", () => {
    const verdict = judge({ headers: { "LIST-ID": "<x.lists.example.com>" } });
    expect(verdict.kind).toBe("broadcast");
  });

  it("Auto-Submitted 且值不为 no", () => {
    const verdict = judge({ headers: { "Auto-Submitted": "auto-generated" } });
    expect(verdict.kind).toBe("broadcast");
    expect(verdict.signals).toContain("header:auto-submitted");
  });

  it("Auto-Submitted: no 不算群发", () => {
    const verdict = judge({ headers: { "Auto-Submitted": "no" } });
    expect(verdict.kind).toBe("personal");
    expect(verdict.signals).not.toContain("header:auto-submitted");
  });

  it("Precedence: bulk（弱信号也计入 signals）", () => {
    const verdict = judge({ headers: { Precedence: "bulk" } });
    expect(verdict.kind).toBe("broadcast");
    expect(verdict.signals).toContain("header:precedence");
  });

  it("Precedence: list", () => {
    expect(judge({ headers: { Precedence: "list" } }).kind).toBe("broadcast");
  });

  it("To 数量 >= 10", () => {
    const to = Array.from({ length: 10 }, (_, index) => `user${index}@example.com`);
    const verdict = judge({ to });
    expect(verdict.kind).toBe("broadcast");
    expect(verdict.signals).toContain("to-count:>=10");
  });

  it.each([
    "noreply@shop.example.com",
    "no-reply@shop.example.com",
    "do-not-reply@shop.example.com",
    "notifications@example.com",
    "bounce+42@example.com",
  ])("no-reply 类发件人：%s", (fromEmail) => {
    const verdict = judge({ fromEmail });
    expect(verdict.kind).toBe("broadcast");
    expect(verdict.signals).toContain("from:no-reply");
  });
});

describe("judgeBroadcast 无强信号", () => {
  it("用户在 To 且 To 人数 <= 3 → personal", () => {
    const verdict = judge({ to: ["zhangsan@example.com", "lisi@example.com"] });
    expect(verdict.kind).toBe("personal");
    expect(verdict.signals).toContain("user:in-to");
    expect(verdict.signals).toContain("to-count:<=3");
  });

  it("用户只在 Cc（不在 To）→ uncertain 并记录加权信号", () => {
    const verdict = judge({
      to: ["lisi@example.com", "wangwu@example.com"],
      cc: ["zhangsan@example.com"],
    });
    expect(verdict.kind).toBe("uncertain");
    expect(verdict.signals).toContain("user:in-cc");
  });

  it("用户在 To 但 To 人数 4-9 → uncertain", () => {
    const to = ["zhangsan@example.com", "a@x.com", "b@x.com", "c@x.com", "d@x.com"];
    const verdict = judge({ to });
    expect(verdict.kind).toBe("uncertain");
    expect(verdict.signals).toContain("to-count:>3");
  });

  it("To 为空 → uncertain（不能证明是个人邮件）", () => {
    const verdict = judge({ to: [] });
    expect(verdict.kind).toBe("uncertain");
    expect(verdict.signals).toContain("user:not-in-to");
  });

  it("用户档案没配邮箱 → uncertain 并记录原因", () => {
    const verdict = judge({ userEmails: [] });
    expect(verdict.kind).toBe("uncertain");
    expect(verdict.signals).toContain("user:no-emails");
  });

  it("地址带显示名与不同大小写也能匹配", () => {
    const verdict = judge({ to: ["张三 <ZHANGSAN@Example.com>"] });
    expect(verdict.kind).toBe("personal");
  });
});

describe("classifyBroadcast", () => {
  it("从 RawEmail 头部直接判定", () => {
    const email = makeEmail({
      headers: { "List-Id": "<devs.lists.example.com>" },
      to: ["devs@lists.example.com"],
    });
    const verdict = classifyBroadcast(email, profile);
    expect(verdict.kind).toBe("broadcast");
    expect(verdict.signals).toContain("header:list-id");
  });
});

describe("hashBody", () => {
  it("空白/大小写不同的同一正文得到同一指纹", () => {
    expect(hashBody({ text: "Hello   World\n" })).toBe(hashBody({ text: " hello world " }));
  });

  it("不同正文得到不同指纹", () => {
    expect(hashBody({ text: "正文 A" })).not.toBe(hashBody({ text: "正文 B" }));
  });

  it("纯空白返回 null", () => {
    expect(hashBody({ text: "   \n\t" })).toBeNull();
    expect(hashBody({})).toBeNull();
  });

  it("纯文本为空时回退到 HTML", () => {
    expect(hashBody({ text: " ", html: "<p>相同正文</p>" })).toBe(
      hashBody({ html: "<p>相同正文</p>" }),
    );
  });

  it("同一天多条相同正文可用指纹判重", () => {
    const first = makeEmail({ id: "a", bodyText: "系统维护通知：本周五 22:00。" });
    const second = makeEmail({ id: "b", bodyText: "系统维护通知：本周五   22:00。" });
    expect(hashBody({ text: first.bodyText })).toBe(hashBody({ text: second.bodyText }));
  });
});
