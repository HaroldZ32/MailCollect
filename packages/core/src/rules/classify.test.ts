import { describe, expect, it } from "vitest";
import type { Category, Rule, RuleTree } from "@mailcollect/shared";
import {
  applyClassification,
  classifyAndStore,
  classifyEmail,
  reclassifyEmails,
  type ClassificationRepository,
  type ClassificationTag,
} from "./classify.js";
import type { SemanticEvaluator } from "./semantic.js";
import { makeCategory, makeRule, makeRuleEmail, TEST_TIMEZONE } from "./__test-helpers__/fixtures.js";

const email = makeRuleEmail();
const baseOptions = { userEmails: ["me@example.com"], timezone: TEST_TIMEZONE };

const subjectContains = (text: string): RuleTree => ({
  kind: "field",
  field: "subject",
  op: "contains",
  value: text,
});

class FakeRepository implements ClassificationRepository {
  rules: readonly Rule[];
  categories: readonly Category[];
  readonly tags = new Map<string, ClassificationTag[]>();

  constructor(rules: readonly Rule[], categories: readonly Category[]) {
    this.rules = rules;
    this.categories = categories;
  }

  async listRules(): Promise<readonly Rule[]> {
    return this.rules;
  }

  async listCategories(): Promise<readonly Category[]> {
    return this.categories;
  }

  async removeTagsForEmail(emailId: string): Promise<void> {
    this.tags.delete(emailId);
  }

  async addTag(tag: ClassificationTag): Promise<void> {
    const list = this.tags.get(tag.emailId) ?? [];
    list.push(tag);
    this.tags.set(tag.emailId, list);
  }

  categoryIds(emailId: string): string[] {
    return (this.tags.get(emailId) ?? []).map((tag) => tag.categoryId);
  }
}

describe("多标签分类（AC-21）", () => {
  it("命中多条规则全部打标、不短路；enterTodo/broadcast 各自取 OR", async () => {
    const categories = [
      makeCategory("cat-todo", "待办", true, false),
      makeCategory("cat-broadcast", "群发", false, true),
    ];
    const rules = [
      makeRule("r-1", "cat-todo", subjectContains("报告"), { order: 0 }),
      makeRule("r-2", "cat-broadcast", { kind: "field", field: "listId", op: "exists" }, { order: 1 }),
    ];
    const result = await classifyEmail(email, rules, categories, baseOptions);

    expect(result.matches.map((match) => match.ruleId)).toEqual(["r-1", "r-2"]);
    expect(result.categoryIds).toEqual(["cat-todo", "cat-broadcast"]);
    expect(result.tags).toHaveLength(2);
    expect(result.enterTodo).toBe(true);
    expect(result.broadcast).toBe(true);
    expect(result.uncategorized).toBe(false);
  });

  it("同一分类被多条规则命中只留一个标签（保留首个命中的规则）", async () => {
    const categories = [makeCategory("cat-1", "一", true, false)];
    const rules = [
      makeRule("r-late", "cat-1", subjectContains("报告"), { order: 5 }),
      makeRule("r-early", "cat-1", subjectContains("报告"), { order: 1 }),
    ];
    const result = await classifyEmail(email, rules, categories, baseOptions);
    expect(result.matches.map((match) => match.ruleId)).toEqual(["r-early", "r-late"]);
    expect(result.tags).toHaveLength(1);
    expect(result.tags[0]?.ruleId).toBe("r-early");
  });

  it("停用的规则不参与求值", async () => {
    const categories = [makeCategory("cat-1", "一", true, false)];
    const rule = makeRule("r-1", "cat-1", subjectContains("报告"), { enabled: false });
    const result = await classifyEmail(email, [rule], categories, baseOptions);
    expect(result.uncategorized).toBe(true);
  });

  it("无命中 → 未分类（计算态，不产生标签）", async () => {
    const result = await classifyEmail(
      email,
      [makeRule("r-1", "cat-1", subjectContains("不存在的词"))],
      [makeCategory("cat-1", "一", true, false)],
      baseOptions,
    );
    expect(result.tags).toEqual([]);
    expect(result.categoryIds).toEqual([]);
    expect(result.uncategorized).toBe(true);
    expect(result.uncategorizedName).toBe("未分类");
    expect(result.enterTodo).toBe(false);
    expect(result.broadcast).toBe(false);
  });

  it("规则指向不存在的分类 → 记录错误并跳过，其余规则继续", async () => {
    const result = await classifyEmail(
      email,
      [
        makeRule("r-missing", "cat-missing", subjectContains("报告"), { order: 0 }),
        makeRule("r-ok", "cat-1", subjectContains("报告"), { order: 1 }),
      ],
      [makeCategory("cat-1", "一", true, false)],
      baseOptions,
    );
    expect(result.categoryIds).toEqual(["cat-1"]);
    expect(result.errors[0]?.code).toBe("target_category_missing");
    expect(result.errors[0]?.ruleId).toBe("r-missing");
  });

  it("非法条件树 → 记录类型化错误，不中断其它规则", async () => {
    const invalid = {
      kind: "field",
      field: "subject",
      op: "before",
      value: "2026-11-09",
    } as RuleTree;
    const unknownKind = { kind: "mystery" } as unknown as RuleTree;
    const result = await classifyEmail(
      email,
      [
        makeRule("r-bad", "cat-1", invalid, { order: 0 }),
        makeRule("r-weird", "cat-1", unknownKind, { order: 1 }),
        makeRule("r-ok", "cat-1", subjectContains("报告"), { order: 2 }),
      ],
      [makeCategory("cat-1", "一", true, false)],
      baseOptions,
    );
    expect(result.categoryIds).toEqual(["cat-1"]);
    expect(result.errors.filter((error) => error.code === "invalid_rule_tree")).toHaveLength(2);
  });

  it("语义叶子存在但未提供求值器 → 记录错误、叶子按 false、仍然完成分类", async () => {
    const result = await classifyEmail(
      email,
      [
        makeRule("r-semantic", "cat-1", { kind: "semantic", expr: "正文在催进度" }, { order: 0 }),
        makeRule("r-field", "cat-1", subjectContains("报告"), { order: 1 }),
      ],
      [makeCategory("cat-1", "一", true, false)],
      baseOptions,
    );
    expect(result.categoryIds).toEqual(["cat-1"]);
    expect(result.errors.some((error) => error.code === "semantic_unavailable")).toBe(true);
  });

  it("语义求值器自身抛错 → 降级为 false，不打断分类", async () => {
    const throwing = {
      evaluateAll: async () => {
        throw new Error("缓存后端不可用");
      },
    } as unknown as SemanticEvaluator;
    const result = await classifyEmail(
      email,
      [
        makeRule("r-semantic", "cat-1", { kind: "semantic", expr: "正文在催进度" }, { order: 0 }),
        makeRule("r-field", "cat-2", subjectContains("报告"), { order: 1 }),
      ],
      [makeCategory("cat-1", "一", true, false), makeCategory("cat-2", "二", false, true)],
      { ...baseOptions, semantic: throwing },
    );
    expect(result.categoryIds).toEqual(["cat-2"]);
    expect(result.errors.some((error) => error.code === "semantic_failure")).toBe(true);
  });
});

describe("幂等重算与标签移除（AC-21）", () => {
  const personal = makeCategory("cat-1", "一", true, false);
  const other = makeCategory("cat-2", "二", false, true);

  it("重复重算幂等：标签集合不变、不重复", async () => {
    const repo = new FakeRepository(
      [makeRule("r-1", "cat-1", subjectContains("报告")), makeRule("r-2", "cat-2", subjectContains("提交"))],
      [personal, other],
    );

    await classifyAndStore(email, repo, baseOptions);
    const first = repo.tags.get(email.id)?.map((tag) => tag.categoryId);
    await classifyAndStore(email, repo, baseOptions);
    const second = repo.tags.get(email.id)?.map((tag) => tag.categoryId);

    expect(first).toEqual(["cat-1", "cat-2"]);
    expect(second).toEqual(first);
    expect(repo.tags.get(email.id)).toHaveLength(2);
  });

  it("停用/删除规则后重算移除旧标签", async () => {
    const repo = new FakeRepository(
      [makeRule("r-1", "cat-1", subjectContains("报告")), makeRule("r-2", "cat-2", subjectContains("提交"))],
      [personal, other],
    );
    await classifyAndStore(email, repo, baseOptions);
    expect(repo.categoryIds(email.id)).toEqual(["cat-1", "cat-2"]);

    repo.rules = [makeRule("r-1", "cat-1", subjectContains("报告"))];
    await classifyAndStore(email, repo, baseOptions);
    expect(repo.categoryIds(email.id)).toEqual(["cat-1"]);
  });

  it("applyClassification 先移除旧标签再加新标签", async () => {
    const calls: string[] = [];
    const store = {
      async removeTagsForEmail(): Promise<void> {
        calls.push("remove");
      },
      async addTag(tag: ClassificationTag): Promise<void> {
        calls.push(`add:${tag.categoryId}`);
      },
    };
    const result = await classifyEmail(
      email,
      [makeRule("r-1", "cat-1", subjectContains("报告")), makeRule("r-2", "cat-2", { kind: "not", child: subjectContains("不存在") })],
      [personal, other],
      baseOptions,
    );
    await applyClassification(store, result);
    expect(calls).toEqual(["remove", "add:cat-1", "add:cat-2"]);
  });

  it("批量重算回报进度与错误", async () => {
    const repo = new FakeRepository([makeRule("r-1", "cat-1", subjectContains("报告"))], [personal]);
    const progress: number[] = [];
    const emails = [email, makeRuleEmail({ id: "email-2", subject: "无关" })];
    const result = await reclassifyEmails(emails, repo, baseOptions, (done) => {
      progress.push(done);
    });
    expect(progress).toEqual([1, 2]);
    expect(result.results).toHaveLength(2);
    expect(repo.categoryIds("email-1")).toEqual(["cat-1"]);
    expect(repo.categoryIds("email-2")).toEqual([]);
  });
});
