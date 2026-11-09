import type { SeedIdentity } from "@mailcollect/shared";
import type { ZodType } from "zod";
import { describe, expect, it } from "vitest";
import type { LlmPort, LlmResult, StructuredRequest } from "../llm/port.js";
import { classifyEmail } from "../rules/classify.js";
import { buildSeedEntities, seedSemanticExpressions } from "../rules/seeds.js";
import { extractTasks } from "./extract.js";
import { makeLlmConfig } from "./__test-helpers__/fixtures.js";
import { PARITY_CORPUS, PARITY_PROFILE } from "./__test-helpers__/seed-corpus.js";
import golden from "./__test-helpers__/seed-parity-golden.json" with { type: "json" };

/**
 * AC-25 种子等价回归。
 *
 * golden 是删除 R3/R4 **之前**用 v1 管线（`pipeline/extract.ts` +
 * `pipeline/broadcast.ts`）在固定语料上录制的，见 `__test-helpers__/record-v1-golden.ts`
 * 与 `__test-helpers__/seed-parity-golden.json`。本测试只允许使用两条种子规则
 * （`buildSeedEntities(profile)`）+ 分类后的确定性后处理，必须逐封复现：
 * - 待办集合：v1 产生 confirmed 待办 ⇒ v1.1 准入抽取；
 * - 群发集合：v1 判 broadcast（含同日同文）⇒ v1.1 只进提醒卡片。
 */

interface GoldenRow {
  verdict: string;
  signals: string[];
  todo: boolean;
  taskStatus: string | null;
}

const goldenRows = golden.perEmail as Record<string, GoldenRow | undefined>;

const identity: SeedIdentity = {
  names: [PARITY_PROFILE.displayName, ...PARITY_PROFILE.aliases],
  emails: PARITY_PROFILE.emails,
};

/**
 * 与录制 golden 时相同的假模型：为 prompt 里每封邮件返回一条 owner=me 的待办，
 * evidenceQuote 取该邮件正文第一行。这样「是否进入抽取」只由闸门决定，
 * 不受模型随机性影响。
 */
function corpusLlm(): LlmPort {
  return {
    config: makeLlmConfig(),
    async structured<T>(schema: ZodType<T>, request: StructuredRequest): Promise<LlmResult<T>> {
      const ids = [...request.user.matchAll(/^## 邮件 (.+)$/gm)].map((match) => match[1]!.trim());
      const items = ids.map((id) => {
        const marker = `## 邮件 ${id}`;
        const after = request.user.slice(request.user.indexOf(marker) + marker.length);
        const bodyStart = after.indexOf("正文:\n");
        const bodyText = after.slice(bodyStart + "正文:\n".length);
        const firstLine =
          bodyText
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line !== "") ?? "";
        return {
          title: `处理 ${id}`,
          detail: null,
          owner: "me",
          ownerName: null,
          kind: "action",
          timePhrase: null,
          evidenceQuote: firstLine.slice(0, 200),
          confidence: 0.9,
        };
      });
      const payload = { items, noTasks: items.length === 0 };
      return {
        value: schema.parse(payload),
        raw: JSON.stringify(payload),
        usage: null,
        repaired: false,
        latencyMs: 1,
      };
    },
    async ping() {
      return { ok: true, latencyMs: 1, detail: "corpus" };
    },
  };
}

describe("AC-25 种子等价：两条种子规则复现 v1 golden", () => {
  it("语料 ≥10 封且覆盖需求点名的全部用例", () => {
    expect(PARITY_CORPUS.length).toBeGreaterThanOrEqual(10);
    const ids = PARITY_CORPUS.map((email) => email.id);
    const required = [
      "m01-zh-name", // 中文点名
      "m02-en-alias", // 英文点名/别名
      "m03-email-local", // 邮箱前缀
      "m04-list-id", // List-Id
      "m05-precedence", // Precedence bulk
      "m06-no-reply", // no-reply 发件人
      "m07-pure-ad", // 纯广告
      "m08-deadline", // 截止时间
      "m09-window", // 时段
    ];
    for (const id of required) expect(ids, `语料缺少 ${id}`).toContain(id);
    expect(Object.keys(goldenRows)).toHaveLength(PARITY_CORPUS.length);
  });

  it("升级后仅凭两条种子规则 + 确定性后处理复现待办/群发集合", async () => {
    const seeds = buildSeedEntities(identity);
    expect(seeds.rules).toHaveLength(2);
    expect(seeds.categories).toHaveLength(2);
    expect(seeds.rules.map((rule) => rule.id)).toEqual([
      "seed-rule-personal",
      "seed-rule-broadcast",
    ]);
    // 两条种子都是纯字段条件：分类阶段 0 次模型调用。
    expect(seedSemanticExpressions(identity)).toEqual([]);

    const outcome = await extractTasks(PARITY_CORPUS, {
      profile: PARITY_PROFILE,
      llm: corpusLlm(),
      classify: (email) =>
        classifyEmail(email, seeds.rules, seeds.categories, {
          userEmails: PARITY_PROFILE.emails,
          timezone: PARITY_PROFILE.timezone,
        }),
    });

    const extracted = new Set(outcome.tasks.map((task) => task.sourceEmailId));
    const reminded = new Set(outcome.reminders.map((reminder) => reminder.emailId));

    for (const email of PARITY_CORPUS) {
      const expected = goldenRows[email.id];
      expect(expected, `${email.id} 缺少 v1 golden`).toBeDefined();
      if (!expected) continue;
      expect(
        reminded.has(email.id),
        `${email.id}：v1 判定 ${expected.verdict}，v1.1 群发集合不符`,
      ).toBe(expected.verdict === "broadcast");
      expect(
        extracted.has(email.id),
        `${email.id}：v1 待办期望 todo=${expected.todo}，v1.1 待办集合不符`,
      ).toBe(expected.todo);
    }

    // 两个集合互斥，且每封准入邮件恰好产生一条任务（假模型一封一条）。
    expect([...reminded].filter((id) => extracted.has(id))).toEqual([]);
    expect(outcome.calls).toBe(extracted.size);
  });
});
