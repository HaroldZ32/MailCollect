import {
  SEED_BROADCAST_RULE,
  SEED_CATEGORY_BROADCAST_ID,
  SEED_CATEGORY_BROADCAST_NAME,
  SEED_CATEGORY_PERSONAL_ID,
  SEED_CATEGORY_PERSONAL_NAME,
  SEED_RULE_BROADCAST_ID,
  SEED_RULE_PERSONAL_ID,
  buildSeedRules,
  hasSeedIdentity,
} from "@mailcollect/shared";
import type { Category, Rule, RuleTree, SeedIdentity, SeedRule } from "@mailcollect/shared";
import { collectSemanticExpressions, parseRuleTreeOrThrow, walkRuleTree } from "./ast.js";

/**
 * 两条种子规则（C6 / AC-25 的引擎侧）。
 *
 * 事实源是 `@mailcollect/shared` 的 `buildSeedRules(identity)` /
 * `SEED_BROADCAST_RULE`：
 * - 「点名给我」只在有真实姓名/别名/邮箱时生成（用 `wholeWord` 展开，复刻 R3）；
 * - 「群发/通知」是纯字段树、零模型调用、不依赖档案。
 *
 * 本文件把它们转换成可落库的领域实体（`Category` / `Rule`），并保证：
 * - 树通过 AST 校验（深度、操作符、值形状）；
 * - 无档案时绝不落一条 inert 的「点名给我」；
 * - id 稳定，重复调用得到同一集合（幂等由调用方「只播种一次」保证）。
 */

export {
  SEED_CATEGORY_BROADCAST_ID,
  SEED_CATEGORY_BROADCAST_NAME,
  SEED_CATEGORY_PERSONAL_ID,
  SEED_CATEGORY_PERSONAL_NAME,
  SEED_RULE_BROADCAST_ID,
  SEED_RULE_PERSONAL_ID,
};

export interface SeedEntities {
  /** 顺序与规则一致；id 稳定，供迁移幂等 upsert。 */
  readonly categories: readonly Category[];
  readonly rules: readonly Rule[];
}

/**
 * 共享契约已删除占位符常量；保留字面量只做防御性检查 —— 任何残留 `{{me}}`
 * 的模板都不允许落库成为生效规则。
 */
const LEGACY_IDENTITY_TOKEN = "{{me}}";

/** 树里是否还残留身份占位符（→ 这条种子不能落库为生效规则）。 */
function usesIdentityToken(tree: RuleTree): boolean {
  let found = false;
  walkRuleTree(tree, (node) => {
    if (node.kind !== "field") return;
    if (node.value === LEGACY_IDENTITY_TOKEN) found = true;
  });
  return found;
}

/**
 * 把 shared 的种子规则转成领域实体（含 AST 校验）。
 *
 * - 有真实身份：两条规则（「点名给我」用姓名/别名/邮箱前缀展开占位）。
 * - 无身份：只播种「群发/通知」（纯字段、零模型调用）；**不生成** inert 的点名规则。
 */
export function buildSeedEntities(identity?: SeedIdentity | null): SeedEntities {
  const seeds: readonly SeedRule[] = hasSeedIdentity(identity)
    ? buildSeedRules(identity)
    : [SEED_BROADCAST_RULE];
  const categories: Category[] = [];
  const rules: Rule[] = [];

  for (const seed of seeds) {
    if (usesIdentityToken(seed.tree)) continue; // 双保险：永不把占位模板当生效规则。
    // 校验后落库；非法种子是编程错误，直接抛类型化错误而不是写入半成品。
    const tree = parseRuleTreeOrThrow(seed.tree);
    categories.push({
      id: seed.category.id,
      name: seed.category.name,
      enterTodo: seed.category.enterTodo,
      broadcast: seed.category.broadcast,
    });
    rules.push({
      id: seed.id,
      name: seed.name,
      categoryId: seed.category.id,
      tree,
      enabled: seed.enabled,
      order: seed.order,
    });
  }

  return { categories, rules };
}

/** 种子里的语义表达式（用于断言「群发/通知」零模型调用；两条种子都应为空）。 */
export function seedSemanticExpressions(identity?: SeedIdentity | null): string[] {
  return buildSeedEntities(identity).rules.flatMap((rule) => collectSemanticExpressions(rule.tree));
}
