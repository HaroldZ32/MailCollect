import {
  RULE_MAX_DEPTH,
  parseRuleTree,
  ruleDepth,
  ruleTreeSchema,
  serializeRuleTree,
  validateRuleTree,
} from "@mailcollect/shared";
import type {
  RuleIssueCode,
  RuleNode,
  RuleTree,
  RuleValidationIssue,
  RuleValidationResult,
  SemanticLeaf,
} from "@mailcollect/shared";

/**
 * 规则条件树的 AST 门面（AC-18）。
 *
 * 唯一事实源是 `@mailcollect/shared` 的冻结点（`rules.ts`）：
 * - 括号由树结构表达，wire 形态就是 JSON 树；
 * - 深度只数 AND/OR/NOT 层，上限 {@link RULE_MAX_DEPTH}；
 * - 非法叶子返回类型化 issue，不抛异常。
 *
 * 本文件只做三件事：把 shared 的 parse/validate/serialize 暴露为 core 的稳定入口、
 * 提供「必须成功」的抛错版本（{@link RuleTreeError}），以及供语义求值用的叶子收集。
 */

export {
  RULE_MAX_DEPTH,
  parseRuleTree,
  ruleDepth,
  ruleTreeSchema,
  serializeRuleTree,
  validateRuleTree,
};
export type {
  RuleIssueCode,
  RuleNode,
  RuleTree,
  RuleValidationIssue,
  RuleValidationResult,
  SemanticLeaf,
};

/** 类型化解析错误：调用方需要「不吞掉」非法规则时使用。 */
export class RuleTreeError extends Error {
  override readonly name = "RuleTreeError";

  constructor(readonly issues: readonly RuleValidationIssue[]) {
    super(
      issues.length === 0
        ? "规则条件树非法"
        : `规则条件树非法：${issues
            .map((issue) => `${issue.path === "" ? "<root>" : issue.path}: ${issue.code} ${issue.message}`)
            .join("; ")}`,
    );
  }
}

/** 解析并校验；非法输入抛 {@link RuleTreeError}，绝不返回半成品。 */
export function parseRuleTreeOrThrow(input: unknown): RuleTree {
  const result: RuleValidationResult = parseRuleTree(input);
  if (!result.ok) throw new RuleTreeError(result.issues);
  return result.tree;
}

/** 序列化为稳定 JSON；非法树抛 {@link RuleTreeError}。 */
export function serializeRuleTreeOrThrow(tree: RuleTree): string {
  const result = serializeRuleTree(tree);
  if (!result.ok) throw new RuleTreeError(result.issues);
  return result.json;
}

/**
 * 深度优先遍历；`path` 与校验 issue 的路径同形（`children.0.child`）。
 * 遍历顺序即求值顺序（AND/OR 子节点从左到右）。
 */
export function walkRuleTree(
  tree: RuleTree,
  visit: (node: RuleNode, path: readonly (string | number)[], logicalDepth: number) => void,
): void {
  const walk = (node: RuleNode, path: Array<string | number>, logicalDepth: number): void => {
    visit(node, path, logicalDepth);
    switch (node.kind) {
      case "field":
      case "semantic":
        return;
      case "not":
        walk(node.child, [...path, "child"], logicalDepth + 1);
        return;
      case "and":
      case "or":
        node.children.forEach((child, index) =>
          walk(child, [...path, "children", index], logicalDepth + 1),
        );
        return;
    }
  };
  walk(tree, [], 0);
}

/**
 * 收集树里的语义叶子表达式，按首次出现顺序去重。
 * 分类器用它做「一封邮件一轮只调一次模型」的去重依据（AC-20）。
 */
export function collectSemanticExpressions(tree: RuleTree): string[] {
  const seen = new Set<string>();
  const expressions: string[] = [];
  walkRuleTree(tree, (node) => {
    if (node.kind !== "semantic") return;
    const expr = normalizeSemanticExpression(node.expr);
    if (expr === "" || seen.has(expr)) return;
    seen.add(expr);
    expressions.push(expr);
  });
  return expressions;
}

/** 树里是否含语义叶子（纯字段规则应为 false，决定是否调用模型）。 */
export function hasSemanticLeaf(tree: RuleTree): boolean {
  let found = false;
  walkRuleTree(tree, (node) => {
    if (node.kind === "semantic") found = true;
  });
  return found;
}

/** 语义表达式比较用的归一形态：NFKC + 压缩空白（空白差异不应多花一次模型调用）。 */
export function normalizeSemanticExpression(expr: string): string {
  return expr.normalize("NFKC").replace(/\s+/g, " ").trim();
}

/** 便捷判断：这个 issue code 是否属于叶子级错误（而非结构错误）。 */
export function isLeafIssue(code: RuleIssueCode): boolean {
  return (
    code === "operator_not_allowed" ||
    code === "value_missing" ||
    code === "value_type_mismatch" ||
    code === "empty_semantic_expression"
  );
}

export type { SemanticLeaf as SemanticLeafNode };
