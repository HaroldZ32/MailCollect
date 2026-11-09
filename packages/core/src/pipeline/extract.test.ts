import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import type { LlmPort, LlmResult, StructuredRequest } from "../llm/port.js";
import { LlmError } from "../llm/port.js";
import type { ClassificationGate } from "./types.js";
import { extractTasks, processEmail, type ExtractedTask } from "./extract.js";
import {
  classification,
  classifyWith,
  extractionItem,
  extractionJson,
  makeEmail,
  makeLlmConfig,
  makeProfile,
  ScriptedLlm,
} from "./__test-helpers__/fixtures.js";

const profile = makeProfile();

const TODO_GATE: Partial<ClassificationGate> = {
  enterTodo: true,
  categoryIds: ["cat-personal"],
};
const BROADCAST_GATE: Partial<ClassificationGate> = {
  broadcast: true,
  categoryIds: ["cat-broadcast"],
};

function deps(llm: LlmPort, table: Record<string, Partial<ClassificationGate>> = {}) {
  return { llm, profile, classify: classifyWith(table) };
}

function allTodo(...ids: string[]): Record<string, Partial<ClassificationGate>> {
  return Object.fromEntries(ids.map((id) => [id, TODO_GATE]));
}

function onlyTask(tasks: readonly ExtractedTask[]): ExtractedTask {
  expect(tasks).toHaveLength(1);
  const task = tasks[0];
  if (!task) throw new Error("expected exactly one task");
  return task;
}

describe("分类闸门（C7）：邮件级准入", () => {
  it("enterTodo 且非 broadcast → 进入抽取；时间确定性解析，prompt 无 R3/R4 残留", async () => {
    const email = makeEmail({
      id: "mail-personal",
      threadId: "thread-personal",
      subject: "Q3 报告",
      bodyText: "张三，请周五下班前把 Q3 报告发给我。",
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

    const outcome = await extractTasks([email], deps(llm, { "mail-personal": TODO_GATE }));
    const task = onlyTask(outcome.tasks);

    expect(outcome.calls).toBe(1);
    expect(outcome.reminders).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(0);
    expect(task.owner).toBe("me");
    expect(task.kind).toBe("deadline");
    expect(task.time?.dueAt).toBe("2026-11-06T10:00:00.000Z");
    expect(task.evidenceVerified).toBe(true);
    expect(task.sourceEmailId).toBe("mail-personal");
    // 已删除的 R3 姓名匹配 / R4 群发判定不得再出现在模型上下文里。
    expect(llm.requests[0]?.user).not.toContain("群发判定");
    expect(llm.requests[0]?.user).not.toContain("确定性匹配");
  });

  it("broadcast 分类 → 不调用 LLM，只进提醒卡片并记 rule 信号", async () => {
    const email = makeEmail({
      id: "mail-list",
      headers: { "List-Id": "<devs.lists.example.com>" },
      bodyText: "全体成员：本周五 22:00 起系统维护。",
    });
    const llm = new ScriptedLlm(() => extractionJson([]));

    const outcome = await extractTasks([email], deps(llm, {
      "mail-list": {
        ...BROADCAST_GATE,
        matches: [
          { ruleId: "seed-rule-broadcast", ruleName: "群发/通知", categoryId: "cat-broadcast" },
        ],
      },
    }));

    expect(outcome.calls).toBe(0);
    expect(outcome.tasks).toHaveLength(0);
    expect(outcome.reminders).toEqual([
      {
        emailId: "mail-list",
        categoryIds: ["cat-broadcast"],
        signals: ["rule:seed-rule-broadcast"],
      },
    ]);
    expect(outcome.skipped).toEqual([{ emailId: "mail-list", reason: "broadcast" }]);
  });

  it("同时命中 enterTodo 与 broadcast 时以 broadcast 为准（不抽取）", async () => {
    const email = makeEmail({ id: "mail-both" });
    const llm = new ScriptedLlm(() => extractionJson([]));

    const outcome = await extractTasks([email], deps(llm, {
      "mail-both": { enterTodo: true, broadcast: true, categoryIds: ["cat-both"] },
    }));

    expect(outcome.calls).toBe(0);
    expect(outcome.reminders.map((item) => item.emailId)).toEqual(["mail-both"]);
    expect(outcome.skipped).toEqual([{ emailId: "mail-both", reason: "broadcast" }]);
  });

  it("命中分类但 enterTodo=false → 不抽取、不提醒", async () => {
    const email = makeEmail({ id: "mail-info" });
    const llm = new ScriptedLlm(() => extractionJson([]));

    const outcome = await extractTasks([email], deps(llm, {
      "mail-info": { enterTodo: false, broadcast: false, categoryIds: ["cat-info"] },
    }));

    expect(outcome.calls).toBe(0);
    expect(outcome.reminders).toHaveLength(0);
    expect(outcome.skipped).toEqual([{ emailId: "mail-info", reason: "not_enter_todo" }]);
  });

  it("无命中（未分类）→ 不抽取、不标群发", async () => {
    const email = makeEmail({ id: "mail-uncategorized" });
    const llm = new ScriptedLlm(() => extractionJson([]));

    const outcome = await extractTasks([email], deps(llm));

    expect(outcome.calls).toBe(0);
    expect(outcome.tasks).toHaveLength(0);
    expect(outcome.reminders).toHaveLength(0);
    expect(outcome.skipped).toEqual([{ emailId: "mail-uncategorized", reason: "uncategorized" }]);
  });

  it("每封邮件只分类一次，并且分类发生在 LLM 抽取之前", async () => {
    const emails = [
      makeEmail({ id: "mail-a", threadId: "thread-a" }),
      makeEmail({ id: "mail-b", threadId: "thread-b" }),
    ];
    const llm = new ScriptedLlm(() => extractionJson([]));
    const seen: string[] = [];
    const classify = (email: { id: string }): ClassificationGate => {
      seen.push(email.id);
      return classification(email.id, { uncategorized: true });
    };

    await extractTasks(emails, { llm, profile, classify });

    expect(seen).toEqual(["mail-a", "mail-b"]);
    expect(llm.requests).toHaveLength(0);
  });
});

describe("线程与切块：只渲染准入邮件", () => {
  it("同一线程的多封准入邮件合在一次请求里，群发兄弟不出现在 prompt", async () => {
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
    const broadcast = makeEmail({
      id: "mail-t3-broadcast",
      threadId: "shared-thread",
      subject: "线程里的群发通知",
      sentAt: "2026-11-04T11:00:00+08:00",
      bodyText: "全体通知：周五维护。",
    });
    const llm = new ScriptedLlm(() => extractionJson([]));

    const outcome = await extractTasks(
      [first, second, broadcast],
      deps(llm, { ...allTodo("mail-t1", "mail-t2"), "mail-t3-broadcast": BROADCAST_GATE }),
    );

    expect(outcome.calls).toBe(1);
    expect(llm.requests[0]?.user).toContain("事项一");
    expect(llm.requests[0]?.user).toContain("事项二");
    expect(llm.requests[0]?.user).not.toContain("mail-t3-broadcast");
    expect(outcome.reminders.map((item) => item.emailId)).toEqual(["mail-t3-broadcast"]);
  });

  it("超过字符预算时线程内切块，且切块后仍不跨线程", async () => {
    const longBody = "这里是一段很长的正文内容。".repeat(20);
    // 每封正文必须不同：同日同文会被分类后的确定性后处理判成群发（本测试只关心切块）。
    const threadA = [0, 1].map((index) =>
      makeEmail({
        id: `a-${index}`,
        threadId: "thread-A",
        subject: `A 线程第 ${index} 封`,
        sentAt: ["2026-11-04T09:00:00+08:00", "2026-11-04T10:00:00+08:00"][index],
        bodyText: `${longBody}线程 A 第 ${index} 段。`,
      }),
    );
    const threadB = makeEmail({
      id: "b-0",
      threadId: "thread-B",
      subject: "B 线程唯一一封",
      bodyText: `${longBody}线程 B 唯一的一段。`,
    });
    const llm = new ScriptedLlm(() => extractionJson([]));

    const outcome = await extractTasks(
      [...threadA, threadB],
      deps(llm, allTodo("a-0", "a-1", "b-0")),
      { maxCharsPerChunk: 300 },
    );

    expect(outcome.calls).toBeGreaterThanOrEqual(3);
    for (const request of llm.requests) {
      const hasA = request.user.includes("线程: thread-A");
      const hasB = request.user.includes("线程: thread-B");
      expect(hasA !== hasB).toBe(true);
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

    const outcome = await extractTasks([email], deps(llm, { "mail-evidence": TODO_GATE }));

    const task = onlyTask(outcome.tasks);
    expect(task.evidenceVerified).toBe(false);
    expect(task.sourceEmailId).toBe("mail-evidence");
  });

  it("空白响应抛 blank_response，绝不吞成空任务列表", async () => {
    const email = makeEmail({ id: "mail-blank" });
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

    await expect(extractTasks([email], deps(llm, { "mail-blank": TODO_GATE }))).rejects.toMatchObject({
      code: "blank_response",
      retryable: true,
    });
  });

  it("准入后正文与主题都为空 → 跳过且不调用 LLM", async () => {
    const email = makeEmail({ id: "mail-empty", bodyText: "", subject: "" });
    const llm = new ScriptedLlm(() => extractionJson([]));

    const outcome = await extractTasks([email], deps(llm, { "mail-empty": TODO_GATE }));

    expect(outcome.calls).toBe(0);
    expect(outcome.tasks).toHaveLength(0);
    expect(outcome.skipped).toEqual([{ emailId: "mail-empty", reason: "empty_message" }]);
  });
});

describe("processEmail（服务端集成契约）", () => {
  it("返回字段齐全的 Task；owner != me 只影响任务状态，不影响准入", async () => {
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

    const result = await processEmail(deps(llm, { "mail-process": TODO_GATE }), email);

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

  it("群发分类：无任务、只返回提醒卡片", async () => {
    const email = makeEmail({
      id: "mail-broadcast-process",
      headers: { "List-Id": "<devs.lists.example.com>" },
      bodyText: "全体成员：本周五系统维护。",
    });
    const llm = new ScriptedLlm(() => extractionJson([]));

    const result = await processEmail(deps(llm, { "mail-broadcast-process": BROADCAST_GATE }), email);

    expect(result.tasks).toHaveLength(0);
    expect(result.reminders.map((item) => item.emailId)).toEqual(["mail-broadcast-process"]);
    expect(result.skipped).toEqual([{ emailId: "mail-broadcast-process", reason: "broadcast" }]);
  });

  it("点名任务（owner=me 且非群发）→ status=confirmed", async () => {
    const email = makeEmail({ id: "mail-confirm", bodyText: "张三，请提交周报。" });
    const llm = new ScriptedLlm(() =>
      extractionJson([
        extractionItem({ title: "提交周报", owner: "me", evidenceQuote: "张三，请提交周报。" }),
      ]),
    );

    const result = await processEmail(deps(llm, { "mail-confirm": TODO_GATE }), email);

    expect(result.tasks[0]?.owner).toBe("me");
    expect(result.tasks[0]?.status).toBe("confirmed");
    expect(result.tasks[0]?.origin).toBe("personal");
  });
});
