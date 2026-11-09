import {
  UNCATEGORIZED_ID,
  UNCATEGORIZED_NAME,
  validateRuleTree,
} from "@mailcollect/shared";
import type { Category, Rule, RuleTree } from "@mailcollect/shared";
import { collectSemanticExpressions, normalizeSemanticExpression } from "./ast.js";
import { RuleEvaluationError, evaluateRuleTree, type RuleEmail } from "./evaluate.js";
import type { SemanticEvaluator, SemanticFailure } from "./semantic.js";

/**
 * 多标签分类（C6 / AC-21）。
 *
 * 一次分类 = 对一封邮件求值全部「启用」规则：
 * - 命中即打标，**不短路**；顺序只决定求值/展示顺序；
 * - 同一分类被多条命中的规则指向时只留一个标签（首个命中的规则）；
 * - 无命中 → 「未分类」（计算态，不落标签）；
 * - `enterTodo` / `broadcast` 各自对所有命中分类取 OR。
 *
 * 幂等重算：{@link applyClassification} 先移除该邮件全部旧标签再加新标签，
 * 因此停用/删除规则后同一次重算就会让旧标签消失。
 */

export type MaybePromise<T> = T | Promise<T>;

export interface ClassificationOptions {
  /** 用户全部邮箱，供 `iAmInTo` 使用。 */
  readonly userEmails: readonly string[];
  readonly timezone?: string;
  /** 语义叶子求值器；纯字段规则集可以不传（0 次模型调用）。 */
  readonly semantic?: SemanticEvaluator | null;
  readonly now?: () => Date;
}

export interface RuleMatch {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly categoryId: string;
}

export interface ClassificationTag {
  readonly emailId: string;
  readonly categoryId: string;
  /** 产生标签的规则；同分类多规则时是顺序最靠前的那个。 */
  readonly ruleId: string;
  readonly createdAt: string;
}

export type ClassificationErrorCode =
  | "target_category_missing"
  | "invalid_rule_tree"
  | "evaluation_error"
  | "semantic_unavailable"
  | "semantic_failure";

export interface ClassificationError {
  readonly code: ClassificationErrorCode;
  readonly message: string;
  readonly ruleId?: string;
  readonly expr?: string;
}

export interface ClassificationSemanticStats {
  /** 语义叶子出现次数（同一表达式跨规则重复计数）。 */
  readonly requested: number;
  /** 去重后的唯一表达式数。 */
  readonly unique: number;
  readonly calls: number;
  readonly cacheHits: number;
  readonly failures: readonly SemanticFailure[];
}

export interface ClassificationResult {
  readonly emailId: string;
  /** 命中的规则（按 order 顺序，允许同分类多条）。 */
  readonly matches: readonly RuleMatch[];
  /** 去重后的标签（每个分类最多一个，首个命中的规则保留）。 */
  readonly tags: readonly ClassificationTag[];
  readonly categoryIds: readonly string[];
  readonly enterTodo: boolean;
  readonly broadcast: boolean;
  /** 无任何规则命中；不是可持久化分类。 */
  readonly uncategorized: boolean;
  readonly uncategorizedId: typeof UNCATEGORIZED_ID;
  readonly uncategorizedName: typeof UNCATEGORIZED_NAME;
  readonly semantic: ClassificationSemanticStats;
  readonly errors: readonly ClassificationError[];
}

interface UsableRule {
  readonly rule: Rule;
  readonly tree: RuleTree;
}

function sortRules(rules: readonly Rule[]): Rule[] {
  return rules
    .map((rule, index) => ({ rule, index }))
    .filter((entry) => entry.rule.enabled)
    .sort((left, right) => {
      const byOrder = left.rule.order - right.rule.order;
      return byOrder !== 0 ? byOrder : left.index - right.index;
    })
    .map((entry) => entry.rule);
}

/**
 * 对一封邮件求值全部启用规则，返回命中集合与门控开关；不写任何存储。
 * 模型失败被收敛成 `errors` 与 false 叶子，不抛错（同步不中断）。
 */
export async function classifyEmail(
  email: RuleEmail,
  rules: readonly Rule[],
  categories: readonly Category[],
  options: ClassificationOptions,
): Promise<ClassificationResult> {
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const errors: ClassificationError[] = [];
  const usable: UsableRule[] = [];

  for (const rule of sortRules(rules)) {
    if (!categoryById.has(rule.categoryId)) {
      errors.push({
        code: "target_category_missing",
        ruleId: rule.id,
        message: `规则「${rule.name}」指向不存在的分类 ${rule.categoryId}`,
      });
      continue;
    }
    const validated = validateRuleTree(rule.tree);
    if (!validated.ok) {
      errors.push({
        code: "invalid_rule_tree",
        ruleId: rule.id,
        message: `规则「${rule.name}」条件树非法：${validated.issues
          .map((issue) => `${issue.path === "" ? "<root>" : issue.path}:${issue.code}`)
          .join(",")}`,
      });
      continue;
    }
    usable.push({ rule, tree: validated.tree });
  }

  // 语义叶子：先跨规则收集去重，再一次性求值（同轮共享；纯字段规则 0 次调用）。
  const occurrences = usable.flatMap((entry) => collectSemanticExpressions(entry.tree));
  const uniqueExpressions = [...new Set(occurrences)];
  let semanticValues = new Map<string, boolean>();
  let semanticStats: ClassificationSemanticStats = {
    requested: occurrences.length,
    unique: uniqueExpressions.length,
    calls: 0,
    cacheHits: 0,
    failures: [],
  };

  if (uniqueExpressions.length > 0) {
    if (options.semantic) {
      try {
        const round = await options.semantic.evaluateAll(email, uniqueExpressions);
        semanticValues = new Map(round.values);
        semanticStats = {
          requested: occurrences.length,
          unique: uniqueExpressions.length,
          calls: round.calls,
          cacheHits: round.cacheHits,
          failures: round.failures,
        };
        for (const failure of round.failures) {
          errors.push({
            code: "semantic_failure",
            expr: failure.expr,
            message: `语义叶子求值失败（${failure.code}）：${failure.message}`,
          });
        }
      } catch (error) {
        // 求值器自身的意外错误（例如缓存后端故障）也必须降级为 false，
        // 不能把同步/重算管线整体打断。
        const message = error instanceof Error ? error.message : String(error);
        errors.push({
          code: "semantic_failure",
          message: `语义叶子求值器异常：${message}`,
        });
      }
    } else {
      for (const expr of uniqueExpressions) {
        errors.push({
          code: "semantic_unavailable",
          expr,
          message: "规则包含语义叶子，但本次分类未提供 LLM 求值器；按 false 处理",
        });
      }
    }
  }

  const matches: RuleMatch[] = [];
  for (const { rule, tree } of usable) {
    let hit: boolean;
    try {
      hit = await evaluateRuleTree(tree, email, {
        userEmails: options.userEmails,
        ...(options.timezone === undefined ? {} : { timezone: options.timezone }),
        semantic: (leaf) => semanticValues.get(normalizeSemanticExpression(leaf.expr)) ?? false,
      });
    } catch (error) {
      const message =
        error instanceof RuleEvaluationError
          ? `[${error.code}] ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      errors.push({
        code: "evaluation_error",
        ruleId: rule.id,
        message: `规则「${rule.name}」求值失败：${message}`,
      });
      continue;
    }
    if (hit) matches.push({ ruleId: rule.id, ruleName: rule.name, categoryId: rule.categoryId });
  }

  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const seenCategories = new Set<string>();
  const tags: ClassificationTag[] = [];
  for (const match of matches) {
    if (seenCategories.has(match.categoryId)) continue;
    seenCategories.add(match.categoryId);
    tags.push({
      emailId: email.id,
      categoryId: match.categoryId,
      ruleId: match.ruleId,
      createdAt,
    });
  }

  let enterTodo = false;
  let broadcast = false;
  for (const tag of tags) {
    const category = categoryById.get(tag.categoryId);
    if (!category) continue;
    enterTodo = enterTodo || category.enterTodo;
    broadcast = broadcast || category.broadcast;
  }

  return {
    emailId: email.id,
    matches,
    tags,
    categoryIds: [...seenCategories],
    enterTodo,
    broadcast,
    uncategorized: matches.length === 0,
    uncategorizedId: UNCATEGORIZED_ID,
    uncategorizedName: UNCATEGORIZED_NAME,
    semantic: semanticStats,
    errors,
  };
}

/** 幂等重算所需的标签写入缝（store 适配器实现；同步/异步皆可）。 */
export interface ClassificationTagStore {
  removeTagsForEmail(emailId: string): MaybePromise<void>;
  addTag(tag: ClassificationTag): MaybePromise<void>;
}

/**
 * 幂等落标签：先按当前规则集移除旧标签，再加本次命中标签。
 * 重复调用结果相同；规则停用/删除后旧标签在本次调用中消失。
 */
export async function applyClassification(
  store: ClassificationTagStore,
  result: ClassificationResult,
): Promise<void> {
  await store.removeTagsForEmail(result.emailId);
  for (const tag of result.tags) await store.addTag(tag);
}

/** 分类 + 落标签所需的仓储缝（store 的规则/分类/标签仓储实现）。 */
export interface ClassificationRepository extends ClassificationTagStore {
  listRules(): MaybePromise<readonly Rule[]>;
  listCategories(): MaybePromise<readonly Category[]>;
}

/** 一封邮件：读规则集 → 分类 → 幂等写标签。 */
export async function classifyAndStore(
  email: RuleEmail,
  repository: ClassificationRepository,
  options: ClassificationOptions,
): Promise<ClassificationResult> {
  const rules = await repository.listRules();
  const categories = await repository.listCategories();
  const result = await classifyEmail(email, rules, categories, options);
  await applyClassification(repository, result);
  return result;
}

/** 规则集变化后重算一批邮件（调用方负责取邮件与进度上报）。 */
export async function reclassifyEmails(
  emails: readonly RuleEmail[],
  repository: ClassificationRepository,
  options: ClassificationOptions,
  onProgress?: (done: number, total: number, result: ClassificationResult) => MaybePromise<void>,
): Promise<{ results: ClassificationResult[]; errors: ClassificationError[] }> {
  const rules = await repository.listRules();
  const categories = await repository.listCategories();
  const results: ClassificationResult[] = [];
  const errors: ClassificationError[] = [];

  for (const email of emails) {
    const result = await classifyEmail(email, rules, categories, options);
    await applyClassification(repository, result);
    results.push(result);
    errors.push(...result.errors);
    if (onProgress) await onProgress(results.length, emails.length, result);
  }

  return { results, errors };
}
