import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import type { LlmPort, LlmResult, StructuredRequest } from "../llm/port.js";
import { LlmError } from "../llm/port.js";
import {
  extractTasks,
  processEmail,
  type ExtractedTask,
} from "./extract.js";
import {
  extractionItem,
  extractionJson,
  makeEmail,
  makeLlmConfig,
  makeProfile,
  ScriptedLlm,
} from "./__test-helpers__/fixtures.js";

const profile = makeProfile();
const deps = (llm: LlmPort) => ({ llm, profile });

function onlyTask(tasks: readonly ExtractedTask[]): ExtractedTask {
  expect(tasks).toHaveLength(1);
  const task = tasks[0];
  if (!task) throw new Error("expected exactly one task");
  return task;
}

describe("端到端样本 1：点名任务", () => {
  it("owner=me、broadcast=personal、证据逐字命中", async () => {
    const email = makeEmail({
      id: "mail-personal",
      threadId: "thread-personal",
      subject: "Q3 报告",
      bodyText: "张三，请周五下班前把 Q3 报告发给我。\n\n谢谢\n-- \n李四",
    });
    const llm = new ScriptedLlm(() =>
      extractionJson([
        extractionItem({
          title: "提交 Q3 报告",
          owner: "me",
          kind: "deadline",
          timePhrase: "周五下班前",
          evidenceQuote: "张三，请周五下班前把 Q3 报告发给我。",
          confidence: 0.9,
        }),
      ]),
    );

    const outcome = await extractTasks([email], deps(llm));
    const task = onlyTask(outcome.tasks);

    expect(task.owner).toBe("me");
    expect(task.broadcast.kind).toBe("personal");
    expect(task.kind).toBe("deadline");
    expect(task.time?.dueAt).toBe("2026-11-06T10:00:00.000Z");
    expect(task.evidenceVerified).toBe(true);
    expect(task.identityMentioned).toBe(true);
    expect(task.sourceEmailId).toBe("mail-personal");
    expect(outcome.verdicts.get("mail-personal")?.kind).toBe("personal");
    // 群发结论在调用 LLM 之前完成，并作为字段传给模型。
    expect(llm.requests[0]?.user).toContain("群发判定（代码层结论，不要重新判断）: personal");
  });
});

describe("端到端样本 2：群发通知", () => {
  it("代码层判 broadcast（List-Id/List-Unsubscribe），模型给 everyone", async () => {
    const email = makeEmail({
      id: "mail-list",
      threadId: "thread-list",
      fromName: "研发周报",
      fromEmail: "digest@lists.example.com",
      to: ["devs@lists.example.com"],
      subject: "本周系统维护通知",
      bodyText: "全体成员：本周五 22:00 起系统维护，预计两小时。",
      headers: {
        "List-Id": "<devs.lists.example.com>",
        "List-Unsubscribe": "<mailto:unsubscribe@lists.example.com>",
      },
    });
    const llm = new ScriptedLlm(() =>
      extractionJson([
        extractionItem({
          title: "关注本周五系统维护窗口",
          owner: "everyone",
          ownerName: null,
          kind: "deadline",
          timePhrase: "本周五 22:00",
          evidenceQuote: "全体成员：本周五 22:00 起系统维护，预计两小时。",
          confidence: 0.75,
        }),
      ]),
    );

    const outcome = await extractTasks([email], deps(llm));
    const task = onlyTask(outcome.tasks);

    expect(task.broadcast.kind).toBe("broadcast");
    expect(task.broadcast.signals).toEqual(
      expect.arrayContaining(["header:list-id", "header:list-unsubscribe"]),
    );
    expect(task.owner).toBe("everyone");
    expect(task.time?.dueAt).toBe("2026-11-06T14:00:00.000Z"); // 22:00 +08:00
    expect(llm.requests[0]?.user).toContain("群发判定（代码层结论，不要重新判断）: broadcast");
  });
});

describe("端到端样本 3：纯广告", () => {
  it("无强信号叠加也不判 personal；noTasks 是「没有待办」而不是解析失败", async () => {
    const email = makeEmail({
      id: "mail-ad",
      threadId: "thread-ad",
      fromName: "好物商城",
      fromEmail: "noreply@shop.example.com",
      to: Array.from({ length: 12 }, (_, index) => `user${index}@example.com`),
      cc: [],
      subject: "双十一大促，全场五折",
      bodyText: "全场五折，仅此三天！退订请点链接。",
      headers: { Precedence: "bulk" },
    });
    const llm = new ScriptedLlm(() => extractionJson([], true));

    const outcome = await extractTasks([email], deps(llm));

    expect(outcome.tasks).toHaveLength(0);
    expect(outcome.calls).toBe(1);
    const verdict = outcome.verdicts.get("mail-ad");
    expect(verdict?.kind).toBe("broadcast");
    expect(verdict?.signals).toEqual(
      expect.arrayContaining([
        "header:precedence",
        "to-count:>=10",
        "from:no-reply",
        "user:not-in-to",
      ]),
    );
    expect(llm.requests[0]?.user).toContain(": broadcast");
  });
});

describe("端到端样本 4：含硬截止", () => {
  it("timePhrase 交给 chrono 解析成 dueAt，模型不做日期运算", async () => {
    const email = makeEmail({
      id: "mail-deadline",
      threadId: "thread-deadline",
      subject: "报销单提交",
      bodyText: "请在 11月10日 18:00 前提交报销单。",
    });
    const llm = new ScriptedLlm(() =>
      extractionJson([
        extractionItem({
          title: "提交报销单",
          owner: "me",
          kind: "deadline",
          timePhrase: "11月10日 18:00",
          evidenceQuote: "请在 11月10日 18:00 前提交报销单。",
          confidence: 0.92,
        }),
      ]),
    );

    const outcome = await extractTasks([email], deps(llm));
    const task = onlyTask(outcome.tasks);

    expect(task.owner).toBe("me");
    expect(task.broadcast.kind).toBe("personal");
    expect(task.kind).toBe("deadline");
    expect(task.time).toMatchObject({
      phrase: "11月10日 18:00",
      dueAt: "2026-11-10T10:00:00.000Z",
      windowStart: null,
      windowEnd: null,
      timezone: "Asia/Shanghai",
      confidence: 0.9,
    });
    expect(llm.requests[0]?.user).toContain("群发判定（代码层结论，不要重新判断）: personal");
  });
});

describe("端到端样本 5：含时段", () => {
  it("「下周一至周三」解析成 window 区间", async () => {
    const email = makeEmail({
      id: "mail-window",
      threadId: "thread-window",
      subject: "值班安排",
      bodyText: "张三，下周一至周三由你负责值班。",
    });
    const llm = new ScriptedLlm(() =>
      extractionJson([
        extractionItem({
          title: "负责值班",
          owner: "me",
          kind: "window",
          timePhrase: "下周一至周三",
          evidenceQuote: "张三，下周一至周三由你负责值班。",
          confidence: 0.8,
        }),
      ]),
    );

    const outcome = await extractTasks([email], deps(llm));
    const task = onlyTask(outcome.tasks);

    expect(task.owner).toBe("me");
    expect(task.broadcast.kind).toBe("personal");
    expect(task.kind).toBe("window");
    expect(task.time?.windowStart).toBe("2026-11-08T16:00:00.000Z");
    expect(task.time?.windowEnd).toBe("2026-11-11T15:59:59.999Z");
    expect(task.time?.dueAt).toBeNull();
  });
});

describe("线程级切块", () => {
  it("不同线程分两次请求，prompt 不互相污染", async () => {
    const emailA = makeEmail({
      id: "mail-a",
      threadId: "thread-a",
      subject: "报告A",
      bodyText: "请处理 A 事项。",
    });
    const emailB = makeEmail({
      id: "mail-b",
      threadId: "thread-b",
      subject: "报告B",
      bodyText: "请处理 B 事项。",
    });
    const llm = new ScriptedLlm((request) => {
      const isA = request.user.includes("报告A");
      return extractionJson([
        extractionItem({
          title: isA ? "处理 A" : "处理 B",
          owner: "me",
          evidenceQuote: isA ? "请处理 A 事项。" : "请处理 B 事项。",
        }),
      ]);
    });

    const outcome = await extractTasks([emailA, emailB], deps(llm));

    expect(outcome.calls).toBe(2);
    expect(outcome.tasks).toHaveLength(2);
    const [first, second] = llm.requests;
    expect(first?.user).toContain("报告A");
    expect(first?.user).not.toContain("报告B");
    expect(second?.user).toContain("报告B");
    expect(second?.user).not.toContain("报告A");
  });

  it("同一线程的多封邮件合在一次请求里", async () => {
    const first = makeEmail({
      id: "mail-t1",
      threadId: "shared-thread",
      subject: "事项一",
      sentAt: "2026-11-04T09:00:00+08:00",
      bodyText: "请处理事项一。",
    });
    const second = makeEmail({
      id: "mail-t2",
      threadId: "shared-thread",
      subject: "事项二",
      sentAt: "2026-11-04T10:00:00+08:00",
      bodyText: "请处理事项二。",
    });
    const llm = new ScriptedLlm(() => extractionJson([]));

    const outcome = await extractTasks([first, second], deps(llm));

    expect(outcome.calls).toBe(1);
    expect(llm.requests[0]?.user).toContain("事项一");
    expect(llm.requests[0]?.user).toContain("事项二");
  });

  it("超过字符预算时线程内切块，且切块后仍不跨线程", async () => {
    const longBody = "这里是一段很长的正文内容。".repeat(20);
    const threadA = [0, 1].map((index) =>
      makeEmail({
        id: `a-${index}`,
        threadId: "thread-A",
        subject: `A 线程第 ${index} 封`,
        sentAt: ["2026-11-04T09:00:00+08:00", "2026-11-04T10:00:00+08:00"][index],
        bodyText: longBody,
      }),
    );
    const threadB = makeEmail({
      id: "b-0",
      threadId: "thread-B",
      subject: "B 线程唯一一封",
      bodyText: longBody,
    });
    const llm = new ScriptedLlm(() => extractionJson([]));

    const outcome = await extractTasks([...threadA, threadB], deps(llm), {
      maxCharsPerChunk: 300,
    });

    expect(outcome.calls).toBeGreaterThanOrEqual(3);
    for (const request of llm.requests) {
      const hasA = request.user.includes("线程: thread-A");
      const hasB = request.user.includes("线程: thread-B");
      expect(hasA !== hasB).toBe(true);
      // 同一请求里只能出现一个线程的邮件。
      if (hasA) expect(request.user).not.toContain("B 线程唯一一封");
      if (hasB) expect(request.user).not.toContain("A 线程第");
    }
  });
});

describe("证据与失败路径", () => {
  it("证据无法逐字命中时保留条目但标记 evidenceVerified=false", async () => {
    const email = makeEmail({ id: "mail-evidence", bodyText: "请把报告发我。" });
    const llm = new ScriptedLlm(() =>
      extractionJson([
        extractionItem({
          title: "提交报告",
          owner: "me",
          evidenceQuote: "这句话完全不在正文里",
        }),
      ]),
    );

    const outcome = await extractTasks([email], deps(llm));

    const task = onlyTask(outcome.tasks);
    expect(task.evidenceVerified).toBe(false);
    expect(task.sourceEmailId).toBe("mail-evidence");
  });

  it("空白响应抛 blank_response，绝不吞成空任务列表", async () => {
    const email = makeEmail();
    const llm: LlmPort = {
      config: makeLlmConfig(),
      async structured<T>(
        _schema: ZodType<T>,
        _request: StructuredRequest,
      ): Promise<LlmResult<T>> {
        throw new LlmError("blank_response", "模型返回空白响应", true);
      },
      async ping() {
        return { ok: true, latencyMs: 1, detail: "stub" };
      },
    };

    await expect(extractTasks([email], deps(llm))).rejects.toMatchObject({
      code: "blank_response",
      retryable: true,
    });
  });

  it("空邮件（无正文无主题）被跳过且不调用 LLM", async () => {
    const email = makeEmail({ id: "mail-empty", bodyText: "", subject: "" });
    const llm = new ScriptedLlm(() => extractionJson([]));

    const outcome = await extractTasks([email], deps(llm));

    expect(outcome.calls).toBe(0);
    expect(outcome.tasks).toHaveLength(0);
    expect(outcome.skipped).toEqual([{ emailId: "mail-empty", reason: "empty_message" }]);
  });
});

describe("processEmail（服务端集成契约）", () => {
  it("返回 verdict 与字段齐全的 Task，owner != me 也保留", async () => {
    const email = makeEmail({
      id: "mail-process",
      threadId: "thread-process",
      bodyText: "请王五在周五前提交采购单。",
    });
    const llm = new ScriptedLlm(() =>
      extractionJson([
        extractionItem({
          title: "提交采购单",
          owner: "other",
          ownerName: "王五",
          kind: "deadline",
          timePhrase: "周五前",
          evidenceQuote: "请王五在周五前提交采购单。",
          confidence: 0.7,
        }),
      ]),
    );

    const result = await processEmail(deps(llm), email);

    expect(result.verdict.kind).toBe("personal");
    expect(result.tasks).toHaveLength(1);
    const task = result.tasks[0];
    if (!task) throw new Error("expected one task");

    expect(task.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(task.userId).toBe(profile.id);
    expect(task.title).toBe("提交采购单");
    expect(task.owner).toBe("other");
    expect(task.ownerName).toBe("王五");
    expect(task.kind).toBe("deadline");
    expect(task.status).toBe("candidate");
    expect(task.origin).toBe("personal");
    expect(task.sourceEmailId).toBe("mail-process");
    expect(task.threadId).toBe("thread-process");
    expect(task.time?.timezone).toBe("Asia/Shanghai");
    expect(task.time?.dueAt).toBe("2026-11-06T15:59:59.999Z");
    expect(task.createdAt).toBe(task.updatedAt);
    expect(Number.isNaN(Date.parse(task.createdAt))).toBe(false);
  });

  it("群发邮件返回 origin=broadcast 的候选任务", async () => {
    const email = makeEmail({
      id: "mail-broadcast-process",
      to: ["devs@lists.example.com"],
      headers: { "List-Id": "<devs.lists.example.com>" },
      bodyText: "全体成员：本周五系统维护。",
    });
    const llm = new ScriptedLlm(() =>
      extractionJson([
        extractionItem({
          title: "关注系统维护",
          owner: "everyone",
          evidenceQuote: "全体成员：本周五系统维护。",
        }),
      ]),
    );

    const result = await processEmail(deps(llm), email);

    expect(result.verdict.kind).toBe("broadcast");
    expect(result.tasks[0]?.origin).toBe("broadcast");
    expect(result.tasks[0]?.owner).toBe("everyone");
  });
});
