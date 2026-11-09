import { describe, expect, it } from "vitest";
import {
  RULE_MAX_DEPTH,
  RuleTreeError,
  collectSemanticExpressions,
  hasSemanticLeaf,
  parseRuleTree,
  parseRuleTreeOrThrow,
  ruleDepth,
  serializeRuleTree,
  serializeRuleTreeOrThrow,
  validateRuleTree,
} from "./ast.js";
import type { RuleTree } from "./ast.js";

const leaf = (field: string, op: string, value?: unknown): RuleTree =>
  ({
    kind: "field",
    field,
    op,
    ...(value === undefined ? {} : { value }),
  }) as RuleTree;

function nested(depth: number): RuleTree {
  let tree: RuleTree = leaf("subject", "exists");
  for (let index = 0; index < depth; index += 1) {
    tree = { kind: "not", child: tree };
  }
  return tree;
}

describe("AST 解析 / 校验 / 序列化（AC-18）", () => {
  it("序列化后解析回来完全一致（JSON 往返）", () => {
    const tree: RuleTree = {
      kind: "and",
      children: [
        leaf("from", "contains", "@example.com"),
        {
          kind: "or",
          children: [
            leaf("subject", "contains", "报告"),
            {
              kind: "not",
              child: leaf("date", "before", "2026-11-09"),
            },
          ],
        },
        { kind: "field", field: "to.count", op: "lte", value: 3 },
      ],
    };

    const serialized = serializeRuleTree(tree);
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;

    const parsed = parseRuleTree(JSON.parse(serialized.json));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.tree).toEqual(tree);
  });

  it("AND / OR / NOT 与括号以树结构表达，嵌套合法", () => {
    const tree: RuleTree = {
      kind: "or",
      children: [
        { kind: "and", children: [leaf("from", "contains", "a"), leaf("subject", "exists")] },
        { kind: "not", child: leaf("body", "contains", "退订") },
      ],
    };
    expect(ruleDepth(tree)).toBe(2);
    expect(validateRuleTree(tree).ok).toBe(true);
  });

  it(`深度 ${RULE_MAX_DEPTH} 允许、${RULE_MAX_DEPTH + 1} 拒绝`, () => {
    expect(validateRuleTree(nested(RULE_MAX_DEPTH)).ok).toBe(true);
    const tooDeep = validateRuleTree(nested(RULE_MAX_DEPTH + 1));
    expect(tooDeep.ok).toBe(false);
    if (tooDeep.ok) return;
    expect(tooDeep.issues.some((issue) => issue.code === "depth_exceeded")).toBe(true);
  });

  it.each([
    ["未知字段", { kind: "field", field: "nope", op: "exists" }, "invalid_shape"],
    [
      "字段不支持的操作符",
      { kind: "field", field: "subject", op: "before", value: "2026-11-09" },
      "operator_not_allowed",
    ],
    ["缺少值", { kind: "field", field: "subject", op: "contains" }, "value_missing"],
    [
      "值类型不匹配",
      { kind: "field", field: "to.count", op: "gt", value: "3" },
      "value_type_mismatch",
    ],
    ["空分组", { kind: "and", children: [] }, "empty_group"],
    ["空语义表达式", { kind: "semantic", expr: " " }, "empty_semantic_expression"],
  ])("%s 返回类型化错误而不是崩溃", (_label, input, expectedCode) => {
    const result = validateRuleTree(input);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code)).toContain(expectedCode);
    expect(result.issues.every((issue) => typeof issue.message === "string")).toBe(true);
  });

  it("完全非法的输入（null / 字符串）不会抛异常", () => {
    expect(() => validateRuleTree(null)).not.toThrow();
    expect(validateRuleTree("not-a-tree").ok).toBe(false);
    expect(validateRuleTree(42).ok).toBe(false);
  });

  it("parseRuleTreeOrThrow 抛出带 issue 的 RuleTreeError", () => {
    try {
      parseRuleTreeOrThrow({ kind: "and", children: [] });
      expect.unreachable("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(RuleTreeError);
      const typed = error as RuleTreeError;
      expect(typed.issues.map((issue) => issue.code)).toContain("empty_group");
      expect(typed.issues[0]?.path).toBe("children");
      expect(typed.message).toContain("empty_group");
    }
  });

  it("serializeRuleTreeOrThrow 对非法树抛错", () => {
    expect(() =>
      serializeRuleTreeOrThrow({ kind: "field", field: "subject", op: "contains" } as RuleTree),
    ).toThrow(RuleTreeError);
  });
});

describe("语义叶子收集（供一轮一次模型调用）", () => {
  const tree: RuleTree = {
    kind: "and",
    children: [
      { kind: "semantic", expr: "正文在催进度" },
      leaf("subject", "contains", "报告"),
      {
        kind: "or",
        children: [
          { kind: "semantic", expr: "正文在催进度" },
          { kind: "semantic", expr: "提到项目 X" },
        ],
      },
    ],
  };

  it("按首次出现顺序去重", () => {
    expect(collectSemanticExpressions(tree)).toEqual(["正文在催进度", "提到项目 X"]);
  });

  it("纯字段树没有语义叶子", () => {
    expect(collectSemanticExpressions(leaf("subject", "exists"))).toEqual([]);
    expect(hasSemanticLeaf(leaf("subject", "exists"))).toBe(false);
    expect(hasSemanticLeaf(tree)).toBe(true);
  });

  it("空白差异视为同一表达式", () => {
    const spaced: RuleTree = {
      kind: "or",
      children: [
        { kind: "semantic", expr: "提到  项目 X" },
        { kind: "semantic", expr: " 提到 项目  X " },
      ],
    };
    expect(collectSemanticExpressions(spaced)).toEqual(["提到 项目 X"]);
  });
});
