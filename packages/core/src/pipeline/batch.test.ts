import { describe, expect, it } from "vitest";
import type { LlmPort } from "../llm/port.js";
import type { ClassificationGate, ClassifyPort } from "./types.js";
import { processEmail, processEmails } from "./extract.js";
import {
  classifyWith,
  extractionJson,
  makeEmail,
  makeLlmConfig,
  makeProfile,
  ScriptedLlm,
} from "./__test-helpers__/fixtures.js";

/**
 * 批量入口独有的一条确定性后处理（C6）：
 * 「同一天 + 同正文哈希」在分类完成之后按整批视野判定，不再是单封条件。
 */

const profile = makeProfile();

const TODO_GATE: Partial<ClassificationGate> = {
  enterTodo: true,
  categoryIds: ["cat-personal"],
};

const BODY = "系统通知：本周六 22:00 起停机维护两小时。";

const fakeLlm = (): LlmPort => ({
  config: makeLlmConfig(),
  structured: async (schema) => {
    const payload = { items: [], noTasks: true };
    return {
      value: schema.parse(payload),
      raw: JSON.stringify(payload),
      usage: null,
      repaired: false,
      latencyMs: 1,
    };
  },
  ping: async () => ({ ok: true, latencyMs: 1, detail: "ok" }),
});

function deps(llm: LlmPort, table: Record<string, Partial<ClassificationGate>>): {
  llm: LlmPort;
  profile: typeof profile;
  classify: ClassifyPort;
} {
  return { llm, profile, classify: classifyWith(table) };
}

function email(id: string, body: string, sentAt: string): ReturnType<typeof makeEmail> {
  return makeEmail({
    id,
    threadId: `thread-${id}`,
    fromEmail: "notice@corp.example.com",
    bodyText: body,
    sentAt,
  });
}

describe("processEmails — 同日同文后处理", () => {
  it("同一天两封正文相同（分类都准入）→ 后处理判群发，两封都只进提醒且不调用 LLM", async () => {
    const emails = [
      email("dup-1", BODY, "2026-11-04T09:00:00+08:00"),
      email("dup-2", BODY, "2026-11-04T15:00:00+08:00"),
    ];
    const llm = new ScriptedLlm(() => extractionJson([]));

    const outcome = await processEmails(
      deps(llm, { "dup-1": TODO_GATE, "dup-2": TODO_GATE }),
      emails,
    );

    expect(outcome.tasks).toHaveLength(0);
    expect(outcome.reminders).toHaveLength(2);
    for (const reminder of outcome.reminders) {
      expect(reminder.signals).toContain("deterministic:same-day-body-hash");
    }
    expect(outcome.skipped).toEqual([
      { emailId: "dup-1", reason: "broadcast" },
      { emailId: "dup-2", reason: "broadcast" },
    ]);
    expect(llm.requests).toHaveLength(0);
  });

  it("正文相同但不在同一天 → 不触发后处理，正常抽取", async () => {
    const emails = [
      email("day-1", BODY, "2026-11-04T09:00:00+08:00"),
      email("day-2", BODY, "2026-11-05T09:00:00+08:00"),
    ];
    const llm = new ScriptedLlm(() => extractionJson([]));

    const outcome = await processEmails(
      deps(llm, { "day-1": TODO_GATE, "day-2": TODO_GATE }),
      emails,
    );

    expect(outcome.reminders).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(0);
    expect(llm.requests).toHaveLength(2);
  });

  it("同一天但正文不同 → 不触发后处理，正常抽取", async () => {
    const emails = [
      email("diff-1", "维护通知甲。", "2026-11-04T09:00:00+08:00"),
      email("diff-2", "维护通知乙。", "2026-11-04T15:00:00+08:00"),
    ];
    const llm = new ScriptedLlm(() => extractionJson([]));

    const outcome = await processEmails(
      deps(llm, { "diff-1": TODO_GATE, "diff-2": TODO_GATE }),
      emails,
    );

    expect(outcome.reminders).toHaveLength(0);
    expect(outcome.skipped).toHaveLength(0);
    expect(llm.requests).toHaveLength(2);
  });

  it("单封 processEmail 看不到同日同伴，不触发后处理（已知边界）", async () => {
    const llm = new ScriptedLlm(() => extractionJson([]));

    const result = await processEmail(deps(llm, { "single-dup": TODO_GATE }), email("single-dup", BODY, "2026-11-04T09:00:00+08:00"));

    expect(result.reminders).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(llm.requests).toHaveLength(1);
  });

  it("批量入口逐封返回闸门去向，且分类只发生一次/封", async () => {
    const emails = [
      email("e1", "第一封不同正文，讲事项甲。", "2026-11-04T09:00:00+08:00"),
      email("e2", "第二封不同正文，讲事项乙。", "2026-11-04T10:00:00+08:00"),
    ];
    const seen: string[] = [];
    const classify: ClassifyPort = (item) => {
      seen.push(item.id);
      return classifyWith({ "e1": TODO_GATE })(item);
    };

    const outcome = await processEmails({ llm: fakeLlm(), profile, classify }, emails);

    expect(seen).toEqual(["e1", "e2"]);
    expect(outcome.skipped).toEqual([{ emailId: "e2", reason: "uncategorized" }]);
  });
});
