import { describe, expect, it } from "vitest";
import {
  SEED_CATEGORY_BROADCAST_ID,
  SEED_CATEGORY_PERSONAL_ID,
  SEED_RULE_BROADCAST_ID,
  SEED_RULE_PERSONAL_ID,
} from "@mailcollect/shared";
import { collectSemanticExpressions } from "./ast.js";
import { classifyEmail } from "./classify.js";
import { SemanticEvaluator } from "./semantic.js";
import { buildSeedEntities, seedSemanticExpressions } from "./seeds.js";
import { makeLlm, makeRuleEmail, TEST_TIMEZONE } from "./__test-helpers__/fixtures.js";

/** 共享契约已删除该常量；保留字面量用于断言模板绝不落库。 */
const LEGACY_IDENTITY_TOKEN = "{{me}}";

describe("种子规则（C6 / AC-25 引擎侧）", () => {
  const identity = { names: ["张三"], emails: ["zhangsan@example.com"] };

  it("有真实身份时生成两条规则与两个分类，id/顺序稳定", () => {
    const seeds = buildSeedEntities(identity);
    expect(seeds.categories).toHaveLength(2);
    expect(seeds.rules).toHaveLength(2);

    const personal = seeds.categories.find((category) => category.id === SEED_CATEGORY_PERSONAL_ID);
    const broadcast = seeds.categories.find((category) => category.id === SEED_CATEGORY_BROADCAST_ID);
    expect(personal).toMatchObject({ name: "点名给我", enterTodo: true, broadcast: false });
    expect(broadcast).toMatchObject({ name: "群发/通知", enterTodo: false, broadcast: true });

    expect(seeds.rules.map((rule) => rule.id)).toEqual([SEED_RULE_PERSONAL_ID, SEED_RULE_BROADCAST_ID]);
    expect(seeds.rules.map((rule) => rule.order)).toEqual([0, 1]);
    expect(seeds.rules.every((rule) => rule.enabled)).toBe(true);
  });

  it("重复构建结果一致（播种幂等的输入保证）", () => {
    expect(buildSeedEntities(identity)).toEqual(buildSeedEntities(identity));
  });

  it("无档案时只播种「群发/通知」，绝不把 {{me}} 模板当生效规则", async () => {
    const seeds = buildSeedEntities();
    expect(seeds.rules.map((rule) => rule.id)).toEqual([SEED_RULE_BROADCAST_ID]);
    expect(seeds.categories.map((category) => category.id)).toEqual([SEED_CATEGORY_BROADCAST_ID]);
    expect(JSON.stringify(seeds)).not.toContain(LEGACY_IDENTITY_TOKEN);
    expect(seeds.rules.some((rule) => rule.id === SEED_RULE_PERSONAL_ID)).toBe(false);

    const emptyIdentity = buildSeedEntities({ names: [], emails: [] });
    expect(emptyIdentity).toEqual(seeds);
    // 只有单字符姓名时 v1 的「>=2 字符」规则会忽略它 → 同样只播群发。
    const tooShort = buildSeedEntities({ names: ["X"], emails: [] });
    expect(tooShort.rules.map((rule) => rule.id)).toEqual([SEED_RULE_BROADCAST_ID]);
  });

  it("群发种子是纯字段树，零语义叶子、零模型调用", async () => {
    const seeds = buildSeedEntities(identity);
    const broadcastRule = seeds.rules.find((rule) => rule.id === SEED_RULE_BROADCAST_ID);
    expect(broadcastRule).toBeDefined();
    if (!broadcastRule) return;
    expect(collectSemanticExpressions(broadcastRule.tree)).toEqual([]);
    expect(seedSemanticExpressions()).toEqual([]);

    const llm = makeLlm(() => true);
    const evaluator = new SemanticEvaluator({ llm: llm.port });
    const email = makeRuleEmail({ headers: { "List-Id": "<announce.example.com>" } });
    const result = await classifyEmail(
      email,
      [broadcastRule],
      seeds.categories,
      { userEmails: ["me@example.com"], timezone: TEST_TIMEZONE, semantic: evaluator },
    );
    expect(result.categoryIds).toEqual([SEED_CATEGORY_BROADCAST_ID]);
    expect(result.broadcast).toBe(true);
    expect(llm.calls).toHaveLength(0);
  });

  it("有档案时「点名给我」展开姓名/邮箱/前缀，命中正文提及", async () => {
    const seeds = buildSeedEntities(identity);
    const personalRule = seeds.rules.find((rule) => rule.id === SEED_RULE_PERSONAL_ID);
    expect(personalRule).toBeDefined();
    if (!personalRule) return;

    const serialized = JSON.stringify(personalRule.tree);
    expect(serialized).not.toContain(LEGACY_IDENTITY_TOKEN);
    expect(serialized).toContain("张三");
    expect(serialized).toContain("zhangsan@example.com");
    expect(serialized).toContain("zhangsan");
    // 姓名用整词操作符（ASCII 词边界；CJK 子串），复刻 v1 R3 / AC-25。
    expect(serialized).toContain("wholeWord");

    const email = makeRuleEmail({
      fromName: null,
      fromEmail: "boss@corp.example",
      bodyText: "请 zhangsan 明天处理一下",
    });
    const result = await classifyEmail(email, [personalRule], seeds.categories, {
      userEmails: ["zhangsan@example.com"],
      timezone: TEST_TIMEZONE,
    });
    expect(result.categoryIds).toEqual([SEED_CATEGORY_PERSONAL_ID]);
    expect(result.enterTodo).toBe(true);
  });

  it("无档案时不生成点名规则，因而不会误命中也无法被指派", async () => {
    const seeds = buildSeedEntities();
    const personalRule = seeds.rules.find((rule) => rule.id === SEED_RULE_PERSONAL_ID);
    expect(personalRule).toBeUndefined();

    const result = await classifyEmail(makeRuleEmail(), seeds.rules, seeds.categories, {
      userEmails: [],
      timezone: TEST_TIMEZONE,
    });
    expect(result.categoryIds).not.toContain(SEED_CATEGORY_PERSONAL_ID);
  });
});
