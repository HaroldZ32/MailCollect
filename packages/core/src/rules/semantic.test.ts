import { describe, expect, it } from "vitest";
import type { RuleTree } from "@mailcollect/shared";
import { LlmError } from "../llm/port.js";
import { classifyEmail } from "./classify.js";
import {
  InMemorySemanticCache,
  SemanticEvaluator,
  semanticCacheKey,
} from "./semantic.js";
import { makeCategory, makeLlm, makeRule, makeRuleEmail, TEST_TIMEZONE } from "./__test-helpers__/fixtures.js";

const email = makeRuleEmail();
const options = (semantic: SemanticEvaluator | null) => ({
  userEmails: ["me@example.com"],
  timezone: TEST_TIMEZONE,
  semantic,
});

const semanticTree = (expr: string): RuleTree => ({ kind: "semantic", expr });

describe("语义叶子成本上限（AC-20）", () => {
  it("纯字段规则 0 次模型调用", async () => {
    const llm = makeLlm(() => true);
    const evaluator = new SemanticEvaluator({ llm: llm.port });
    const rule = makeRule("r-field", "cat-1", {
      kind: "field",
      field: "subject",
      op: "contains",
      value: "报告",
    });
    const result = await classifyEmail(email, [rule], [makeCategory("cat-1", "分类", true, false)], options(evaluator));
    expect(result.semantic.calls).toBe(0);
    expect(result.semantic.requested).toBe(0);
    expect(llm.calls).toHaveLength(0);
  });

  it("同一邮件跨规则去重：S 个唯一语义叶子最多 S 次调用", async () => {
    const llm = makeLlm(() => true);
    const evaluator = new SemanticEvaluator({ llm: llm.port });
    const first = makeRule("r-1", "cat-1", semanticTree("正文在催进度"));
    const second = makeRule("r-2", "cat-2", {
      kind: "and",
      children: [semanticTree("正文在催进度"), semanticTree("提到项目 X")],
    });

    const result = await classifyEmail(
      email,
      [first, second],
      [makeCategory("cat-1", "一", true, false), makeCategory("cat-2", "二", false, true)],
      options(evaluator),
    );

    expect(result.semantic.requested).toBe(3);
    expect(result.semantic.unique).toBe(2);
    expect(result.semantic.calls).toBe(2);
    expect(llm.calls).toHaveLength(2);
    expect(result.categoryIds).toEqual(["cat-1", "cat-2"]);
  });

  it("同轮/跨轮共享缓存：第二次分类 0 次调用", async () => {
    const llm = makeLlm(() => true);
    const evaluator = new SemanticEvaluator({ llm: llm.port });
    const rule = makeRule("r-1", "cat-1", semanticTree("正文在催进度"));
    const categories = [makeCategory("cat-1", "一", true, false)];

    const first = await classifyEmail(email, [rule], categories, options(evaluator));
    expect(first.semantic.calls).toBe(1);
    const second = await classifyEmail(email, [rule], categories, options(evaluator));
    expect(second.semantic.calls).toBe(0);
    expect(second.semantic.cacheHits).toBe(1);
    expect(llm.calls).toHaveLength(1);
  });

  it("provider/model 变化使缓存失效（共享同一缓存实例）", async () => {
    const cache = new InMemorySemanticCache();
    const llmA = makeLlm(() => true, { model: "model-a" });
    const llmB = makeLlm(() => true, { model: "model-b", baseUrl: "https://other.example.com/v1" });
    const rule = makeRule("r-1", "cat-1", semanticTree("正文在催进度"));
    const categories = [makeCategory("cat-1", "一", true, false)];

    const evaluatorA = new SemanticEvaluator({ llm: llmA.port, cache });
    const evaluatorB = new SemanticEvaluator({ llm: llmB.port, cache });

    await classifyEmail(email, [rule], categories, options(evaluatorA));
    await classifyEmail(email, [rule], categories, options(evaluatorB));
    await classifyEmail(email, [rule], categories, options(evaluatorA));

    expect(llmA.calls).toHaveLength(1);
    expect(llmB.calls).toHaveLength(1);
  });

  it("提示词版本变化使缓存失效", async () => {
    const cache = new InMemorySemanticCache();
    const llm = makeLlm(() => true);
    const rule = makeRule("r-1", "cat-1", semanticTree("正文在催进度"));
    const categories = [makeCategory("cat-1", "一", true, false)];

    const v1 = new SemanticEvaluator({ llm: llm.port, cache, promptVersion: "v1" });
    const v2 = new SemanticEvaluator({ llm: llm.port, cache, promptVersion: "v2" });
    await classifyEmail(email, [rule], categories, options(v1));
    await classifyEmail(email, [rule], categories, options(v2));
    expect(llm.calls).toHaveLength(2);
  });

  it("缓存键包含邮件 id + 表达式 + 版本 + provider + model", () => {
    const base = {
      emailId: "e1",
      expr: "催进度",
      promptVersion: "v1",
      provider: "p",
      model: "m",
    };
    const key = semanticCacheKey(base);
    expect(semanticCacheKey({ ...base, emailId: "e2" })).not.toBe(key);
    expect(semanticCacheKey({ ...base, expr: "另一个" })).not.toBe(key);
    expect(semanticCacheKey({ ...base, promptVersion: "v2" })).not.toBe(key);
    expect(semanticCacheKey({ ...base, provider: "q" })).not.toBe(key);
    expect(semanticCacheKey({ ...base, model: "n" })).not.toBe(key);
    expect(semanticCacheKey({ ...base, expr: " 催进度 " })).toBe(key);
  });
});

describe("语义叶子失败降级（AC-20）", () => {
  it("模型失败 → 叶子 false + 可读错误 + 不抛错；下一轮重试成功", async () => {
    let attempt = 0;
    const llm = makeLlm(() => {
      attempt += 1;
      if (attempt === 1) throw new LlmError("timeout", "模型请求超时", true);
      return true;
    });
    const evaluator = new SemanticEvaluator({ llm: llm.port });
    const rule = makeRule("r-1", "cat-1", semanticTree("正文在催进度"));
    const categories = [makeCategory("cat-1", "一", true, false)];

    const failed = await classifyEmail(email, [rule], categories, options(evaluator));
    expect(failed.categoryIds).toEqual([]);
    expect(failed.semantic.failures).toHaveLength(1);
    expect(failed.semantic.failures[0]?.code).toBe("timeout");
    expect(failed.errors.some((error) => error.code === "semantic_failure")).toBe(true);
    expect(failed.errors.every((error) => !error.message.includes(email.bodyText))).toBe(true);

    const retried = await classifyEmail(email, [rule], categories, options(evaluator));
    expect(retried.categoryIds).toEqual(["cat-1"]);
    expect(retried.semantic.failures).toHaveLength(0);
    expect(llm.calls).toHaveLength(2);
  });

  it("模型判 false 时不命中规则", async () => {
    const llm = makeLlm(() => false);
    const evaluator = new SemanticEvaluator({ llm: llm.port });
    const rule = makeRule("r-1", "cat-1", semanticTree("正文在催进度"));
    const result = await classifyEmail(
      email,
      [rule],
      [makeCategory("cat-1", "一", true, false)],
      options(evaluator),
    );
    expect(result.categoryIds).toEqual([]);
    expect(result.uncategorized).toBe(true);
  });
});
