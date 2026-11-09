import { z } from "zod";

/**
 * 规则条件树（v1.1 冻结点提案，captain 批准后生效）—— FROZEN CONTRACT。
 *
 * 需求来源：`.mpd/cellwork/<cell>/requirements.md` C6 / AC-18 / AC-22。
 *
 * 设计要点（不要「简化」掉）：
 * - 一条规则 = 一个条件树 + 恰好一个目标分类（分类由 `Rule.categoryId` 承载，
 *   树本身不持有分类）。
 * - 树节点三类：字段叶子（代码精确判定，零模型调用）、语义叶子（模型判定，
 *   必需能力）、逻辑节点 `and` / `or` / `not`。括号由树结构表达，不单独存节点。
 * - 嵌套深度只数逻辑节点（AND/OR/NOT 的层数），叶子记 0；上限 {@link RULE_MAX_DEPTH}。
 * - 浮点/整数的 `value` 一律是 JSON 值；日期是字符串（ISO 8601 或 `YYYY-MM-DD`），
 *   由求值方按用户 IANA 时区解析。
 * - 空值语义：字段缺失 → 字段叶子 false；因此 `not(缺失字段条件)` 为 true。
 *
 * 本文件不依赖 `domain.ts` / `api.ts`，避免循环依赖；`domain.ts` 只以
 * `import type` 引用 {@link RuleTree}。
 */

/** 条件树最大逻辑嵌套深度（AND/OR/NOT 的层数；叶子节点不计）。 */
export const RULE_MAX_DEPTH = 8;

/* ------------------------------- 字段词表 -------------------------------- */

/**
 * 字段词表（C6）。`to.count` / `cc.count` / `recipient.count` / `iAmInTo` /
 * `from.isNoReply` 沿用 R4 的命名，供「群发/通知」种子规则复刻旧判定。
 * `recipient.count` = To + Cc 总数，直接对应 R4 的「To/Cc 基数」。
 */
export const RULE_FIELD_NAMES = [
  "from",
  "to",
  "cc",
  "subject",
  "body",
  "date",
  "listId",
  "precedence",
  "autoSubmitted",
  "hasAttachments",
  "attachmentName",
  "attachmentMime",
  "attachmentSize",
  "isRead",
  "folder",
  "account",
  "to.count",
  "cc.count",
  "recipient.count",
  "iAmInTo",
  "from.isNoReply",
] as const;

export type RuleField = (typeof RULE_FIELD_NAMES)[number];

export const ruleFieldSchema = z.enum(RULE_FIELD_NAMES);

/* ------------------------------- 操作符枚举 ------------------------------ */

export const RULE_OPERATOR_NAMES = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "wholeWord",
  "startsWith",
  "endsWith",
  "in",
  "exists",
  "notExists",
  "before",
  "after",
  "between",
  "gt",
  "lt",
  "gte",
  "lte",
  "isTrue",
  "isFalse",
] as const;

export type RuleOperator = (typeof RULE_OPERATOR_NAMES)[number];

export const ruleOperatorSchema = z.enum(RULE_OPERATOR_NAMES);

/**
 * 归一化与匹配语义（引擎/UI 预览必须一致）：
 *
 * - 所有字符串比较先做 **Unicode NFKC、lowercase、空白压缩**（连续空白压成单个空格）；
 *   邮箱地址按小写比较；CJK 没有词边界，按子串匹配。
 * - `contains`：纯子串包含，不做词边界判断（"Li" 会命中 "Lion"）。
 * - `wholeWord`：整词匹配，复刻 v1 `identity.ts` 的 `nameAppears`/`wordAppears`：
 *   · ASCII 候选（`[\x00-\x7f]`，如 "Li"/"San Zhang"）⇒ token 边界匹配：两侧
 *     不得是 `[a-z0-9_]`，因此 "Li" 不命中 "Lion"，但命中 "ask Li now"；
 *   · 含非 ASCII 字符（CJK 等）的候选 ⇒ 去掉全部空白后做子串匹配，因此
 *     「张三」命中「张三丰」（v1 R3 的 compact 行为）。
 * - 日期按用户 IANA 时区解析（字段叶子；`date.which` 选择发送/接收时刻）。
 * - 字段缺失时字段叶子一律 false；因此 `not(缺失字段条件)` 为 true。
 */
export const RULE_OPERATOR_LABELS: Readonly<Record<RuleOperator, string>> = {
  equals: "等于",
  notEquals: "不等于",
  contains: "包含",
  notContains: "不包含",
  wholeWord: "整词匹配",
  startsWith: "前缀是",
  endsWith: "后缀是",
  in: "属于列表",
  exists: "存在",
  notExists: "不存在",
  before: "早于",
  after: "晚于",
  between: "介于",
  gt: "大于",
  lt: "小于",
  gte: "大于等于",
  lte: "小于等于",
  isTrue: "是",
  isFalse: "否",
};

export type RuleFieldKind = "string" | "number" | "date" | "boolean";

/** 字段元数据：UI 用它决定操作符下拉与值输入控件，服务端/引擎用 `ops` 校验。 */
export interface RuleFieldSpec {
  /** 中文标签。 */
  readonly label: string;
  readonly kind: RuleFieldKind;
  readonly ops: readonly RuleOperator[];
}

const STRING_OPS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "wholeWord",
  "startsWith",
  "endsWith",
  "in",
  "exists",
  "notExists",
] as const;

const DATE_OPS = ["before", "after", "between", "exists", "notExists"] as const;
const NUMBER_OPS = ["gt", "lt", "gte", "lte", "exists", "notExists"] as const;
const BOOLEAN_OPS = ["isTrue", "isFalse", "exists", "notExists"] as const;

export const RULE_FIELDS: Readonly<Record<RuleField, RuleFieldSpec>> = {
  from: { label: "发件人（地址/域名/显示名）", kind: "string", ops: STRING_OPS },
  to: { label: "收件人", kind: "string", ops: STRING_OPS },
  cc: { label: "抄送", kind: "string", ops: STRING_OPS },
  subject: { label: "主题", kind: "string", ops: STRING_OPS },
  body: { label: "正文", kind: "string", ops: STRING_OPS },
  date: { label: "日期（发送/接收）", kind: "date", ops: DATE_OPS },
  listId: { label: "List-Id", kind: "string", ops: STRING_OPS },
  precedence: { label: "Precedence", kind: "string", ops: STRING_OPS },
  autoSubmitted: { label: "Auto-Submitted", kind: "string", ops: STRING_OPS },
  hasAttachments: { label: "有无附件", kind: "boolean", ops: BOOLEAN_OPS },
  attachmentName: { label: "附件文件名", kind: "string", ops: STRING_OPS },
  attachmentMime: { label: "附件 MIME 类型", kind: "string", ops: STRING_OPS },
  attachmentSize: { label: "附件大小（字节）", kind: "number", ops: NUMBER_OPS },
  isRead: { label: "已读/未读", kind: "boolean", ops: BOOLEAN_OPS },
  folder: { label: "所在文件夹", kind: "string", ops: STRING_OPS },
  account: { label: "所属账号", kind: "string", ops: STRING_OPS },
  "to.count": { label: "To 人数", kind: "number", ops: NUMBER_OPS },
  "cc.count": { label: "Cc 人数", kind: "number", ops: NUMBER_OPS },
  "recipient.count": { label: "To + Cc 人数", kind: "number", ops: NUMBER_OPS },
  iAmInTo: { label: "我在 To 里", kind: "boolean", ops: BOOLEAN_OPS },
  "from.isNoReply": { label: "发件人是 no-reply", kind: "boolean", ops: BOOLEAN_OPS },
};

/**
 * 需要精确定义的字段求值约定（引擎实现与 AC-19 测试共用）：
 * - `recipient.count` = To + Cc 去重后的地址数（R4 的「To/Cc 基数」）。
 * - `iAmInTo` = 用户任一邮箱出现在规范化后的 To 列表里。
 * - `from.isNoReply` = 发件地址 local part 命中 `/no-?reply|do-not-reply|notification|bounce/i`
 *   （R4 原正则；只看 local part，不看域名）。
 * - `date` 的 `which` 缺省为 `sent`（Date 头），`received` 用入库时间；比较按用户 IANA 时区。
 * - `attachmentSize` 单位是字节；`attachmentName`/`attachmentMime` 对任一附件成立即为 true。
 */

/* -------------------------------- 值形状 --------------------------------- */

/** `date` 字段比较的是发送日期还是接收日期；默认 `sent`（Date 头）。 */
export const DATE_BASIS_NAMES = ["sent", "received"] as const;
export type DateBasis = (typeof DATE_BASIS_NAMES)[number];

export const ruleValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.object({ from: z.string(), to: z.string() }),
]);

export type RuleValue = z.infer<typeof ruleValueSchema>;

/** 值的语法类别；与操作符一一对应，见 {@link RULE_VALUE_KIND}。 */
type RuleValueKind = "none" | "string" | "number" | "date" | "stringList" | "dateRange";

const RULE_VALUE_KIND: Readonly<Record<RuleOperator, RuleValueKind>> = {
  equals: "string",
  notEquals: "string",
  contains: "string",
  notContains: "string",
  wholeWord: "string",
  startsWith: "string",
  endsWith: "string",
  in: "stringList",
  exists: "none",
  notExists: "none",
  before: "date",
  after: "date",
  between: "dateRange",
  gt: "number",
  lt: "number",
  gte: "number",
  lte: "number",
  isTrue: "none",
  isFalse: "none",
};

/* -------------------------------- 节点类型 ------------------------------- */

export interface FieldLeaf {
  readonly kind: "field";
  readonly field: RuleField;
  readonly op: RuleOperator;
  /** 操作符要求的字面值；`exists` / `notExists` / `isTrue` / `isFalse` 不带值。 */
  readonly value?: RuleValue;
  /** 仅 `date` 字段使用；缺省按 `sent`（Date 头）解释。 */
  readonly which?: DateBasis;
}

/** 语义叶子的模型输出（LlmPort 的结构化布尔）。 */
export interface SemanticLeaf {
  readonly kind: "semantic";
  /** 自然语言谓词，例如「正文在催进度」「提到项目 X」。 */
  readonly expr: string;
}

export interface AndNode {
  readonly kind: "and";
  readonly children: readonly RuleNode[];
}

export interface OrNode {
  readonly kind: "or";
  readonly children: readonly RuleNode[];
}

export interface NotNode {
  readonly kind: "not";
  readonly child: RuleNode;
}

export type LogicalNode = AndNode | OrNode | NotNode;
export type RuleNode = FieldLeaf | SemanticLeaf | LogicalNode;

/** 条件树根 = 任意节点。`domain.ts` 的 `Rule.tree` 用这个类型。 */
export type RuleTree = RuleNode;

/* ------------------------------- Zod schema ------------------------------ */

const dateBasisSchema = z.enum(DATE_BASIS_NAMES);

const fieldLeafSchema = z.object({
  kind: z.literal("field"),
  field: ruleFieldSchema,
  op: ruleOperatorSchema,
  value: ruleValueSchema.optional(),
  which: dateBasisSchema.optional(),
});

const semanticLeafSchema = z.object({
  kind: z.literal("semantic"),
  expr: z.string(),
});

/**
 * 节点结构 schema（递归）。它只保证「形状」；操作符/值/深度/空分组的语义检查
 * 在 {@link ruleTreeSchema}（顶层入口）里统一完成。
 *
 * 注意：递归 schema 在 parse 时才求值，所以这里引用自身的常量是安全的。
 */
export const ruleNodeSchema: z.ZodType<RuleNode> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    fieldLeafSchema,
    semanticLeafSchema,
    z.object({ kind: z.literal("and"), children: z.array(ruleNodeSchema) }),
    z.object({ kind: z.literal("or"), children: z.array(ruleNodeSchema) }),
    z.object({ kind: z.literal("not"), child: ruleNodeSchema }),
  ]),
);

/* --------------------------- 校验 / 解析 / 序列化 ------------------------- */

export type RuleIssueCode =
  | "invalid_shape"
  | "operator_not_allowed"
  | "value_missing"
  | "value_type_mismatch"
  | "depth_exceeded"
  | "empty_group"
  | "empty_semantic_expression";

export interface RuleValidationIssue {
  /** 从树根起的点分路径，例如 `children.0.value`；根节点为空串。 */
  readonly path: string;
  readonly code: RuleIssueCode;
  readonly message: string;
}

export type RuleValidationResult =
  | { readonly ok: true; readonly tree: RuleTree }
  | { readonly ok: false; readonly issues: readonly RuleValidationIssue[] };

/** 解析（unknown JSON → 树）的结果，与校验共用形状。 */
export type RuleParseResult = RuleValidationResult;

export type RuleSerializeResult =
  | { readonly ok: true; readonly json: string; readonly tree: RuleTree }
  | { readonly ok: false; readonly issues: readonly RuleValidationIssue[] };

export type RuleParser = (input: unknown) => RuleParseResult;
export type RuleValidator = (input: unknown) => RuleValidationResult;
export type RuleSerializer = (tree: RuleTree) => RuleSerializeResult;

/** 内部 invariant 兜底：穷尽联合后不应到达。 */
function assertNever(value: never): never {
  throw new Error(`未处理的规则节点：${JSON.stringify(value)}`);
}

const ISSUE_CODE_SET: ReadonlySet<string> = new Set<RuleIssueCode>([
  "invalid_shape",
  "operator_not_allowed",
  "value_missing",
  "value_type_mismatch",
  "depth_exceeded",
  "empty_group",
  "empty_semantic_expression",
]);

function isIssueCode(value: string): value is RuleIssueCode {
  return ISSUE_CODE_SET.has(value);
}

interface RawIssue {
  readonly code: RuleIssueCode;
  readonly message: string;
  readonly path: ReadonlyArray<string | number>;
}

function formatPath(path: ReadonlyArray<string | number>): string {
  return path.map((segment) => String(segment)).join(".");
}

function issueCodeFromMessage(message: string): RuleIssueCode {
  const prefix = message.includes(":") ? message.slice(0, message.indexOf(":")) : "";
  return isIssueCode(prefix) ? prefix : "invalid_shape";
}

function issueMessageFromMessage(message: string): string {
  const prefix = message.includes(":") ? message.slice(0, message.indexOf(":")) : "";
  return isIssueCode(prefix) ? message.slice(prefix.length + 1).trim() : message;
}

/** 逻辑嵌套深度：AND/OR/NOT 计 1，叶子计 0。 */
export function ruleDepth(tree: RuleTree): number {
  switch (tree.kind) {
    case "field":
    case "semantic":
      return 0;
    case "not":
      return 1 + ruleDepth(tree.child);
    case "and":
    case "or":
      return tree.children.reduce((max, child) => Math.max(max, ruleDepth(child)), 0) + 1;
    default:
      return assertNever(tree);
  }
}

function inspectFieldLeaf(leaf: FieldLeaf, path: Array<string | number>): RawIssue[] {
  const issues: RawIssue[] = [];
  const spec = RULE_FIELDS[leaf.field];
  if (!spec.ops.includes(leaf.op)) {
    issues.push({
      code: "operator_not_allowed",
      message: `字段 ${leaf.field} 不支持操作符 ${leaf.op}`,
      path: [...path, "op"],
    });
    return issues;
  }
  if (leaf.which !== undefined && leaf.field !== "date") {
    issues.push({
      code: "invalid_shape",
      message: "which 只能用于 date 字段",
      path: [...path, "which"],
    });
  }

  const expected = RULE_VALUE_KIND[leaf.op];
  if (expected === "none") {
    if (leaf.value !== undefined) {
      issues.push({
        code: "value_type_mismatch",
        message: `操作符 ${leaf.op} 不接受值`,
        path: [...path, "value"],
      });
    }
    return issues;
  }
  if (leaf.value === undefined) {
    issues.push({
      code: "value_missing",
      message: `操作符 ${leaf.op} 需要一个值`,
      path: [...path, "value"],
    });
    return issues;
  }

  const value = leaf.value;
  const mismatch = (message: string): void => {
    issues.push({ code: "value_type_mismatch", message, path: [...path, "value"] });
  };

  switch (expected) {
    case "string":
      if (typeof value !== "string" || value.trim() === "") {
        mismatch(`操作符 ${leaf.op} 需要非空字符串`);
      }
      break;
    case "date":
      if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
        mismatch(`操作符 ${leaf.op} 需要 ISO 日期字符串`);
      }
      break;
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) {
        mismatch(`操作符 ${leaf.op} 需要数字`);
      }
      break;
    case "stringList":
      if (!Array.isArray(value) || value.length === 0 || value.some((item) => item.trim() === "")) {
        mismatch(`操作符 ${leaf.op} 需要非空字符串列表`);
      }
      break;
    case "dateRange": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        mismatch(`操作符 ${leaf.op} 需要 { from, to } 两个 ISO 日期`);
        break;
      }
      if (Number.isNaN(Date.parse(value.from)) || Number.isNaN(Date.parse(value.to))) {
        mismatch(`操作符 ${leaf.op} 需要 { from, to } 两个 ISO 日期`);
      }
      break;
    }
    default:
      return assertNever(expected);
  }
  return issues;
}

function inspectRuleTree(tree: RuleTree): RawIssue[] {
  const issues: RawIssue[] = [];

  const walk = (node: RuleNode, path: Array<string | number>, logicalDepth: number): void => {
    switch (node.kind) {
      case "field":
        issues.push(...inspectFieldLeaf(node, path));
        return;
      case "semantic":
        if (node.expr.trim().length < 2) {
          issues.push({
            code: "empty_semantic_expression",
            message: "语义叶子需要一句自然语言条件",
            path: [...path, "expr"],
          });
        }
        return;
      case "not": {
        const depth = logicalDepth + 1;
        if (depth > RULE_MAX_DEPTH) {
          issues.push({
            code: "depth_exceeded",
            message: `条件树嵌套深度 ${depth} 超过上限 ${RULE_MAX_DEPTH}`,
            path: [...path, "kind"],
          });
          return;
        }
        walk(node.child, [...path, "child"], depth);
        return;
      }
      case "and":
      case "or": {
        const depth = logicalDepth + 1;
        if (node.children.length === 0) {
          issues.push({
            code: "empty_group",
            message: `${node.kind.toUpperCase()} 分组至少需要一个子条件`,
            path: [...path, "children"],
          });
          return;
        }
        if (depth > RULE_MAX_DEPTH) {
          issues.push({
            code: "depth_exceeded",
            message: `条件树嵌套深度 ${depth} 超过上限 ${RULE_MAX_DEPTH}`,
            path: [...path, "kind"],
          });
          return;
        }
        node.children.forEach((child, index) => walk(child, [...path, "children", index], depth));
        return;
      }
      default:
        return assertNever(node);
    }
  };

  walk(tree, [], 0);
  return issues;
}

/**
 * 规则条件树 schema —— 所有落库/入参校验的唯一入口。
 * 结构由递归 discriminated union 保证；语义检查（操作符、值、深度、空分组）
 * 由 superRefine 挂上，失败信息以 `code: message` 形式写入，便于
 * {@link validateRuleTree} 还原类型化 issue。
 */
export const ruleTreeSchema: z.ZodType<RuleTree> = ruleNodeSchema.superRefine((tree, ctx) => {
  for (const issue of inspectRuleTree(tree)) {
    ctx.addIssue({
      code: "custom",
      message: `${issue.code}: ${issue.message}`,
      path: [...issue.path],
    });
  }
});

function toValidationIssue(issue: { path: PropertyKey[]; message: string }): RuleValidationIssue {
  return {
    path: formatPath(issue.path.map((segment) => String(segment))),
    code: issueCodeFromMessage(issue.message),
    message: issueMessageFromMessage(issue.message),
  };
}

/** 校验未知输入；永不抛错，非法输入返回类型化 issue 列表。 */
export function validateRuleTree(input: unknown): RuleValidationResult {
  const parsed = ruleTreeSchema.safeParse(input);
  if (parsed.success) return { ok: true, tree: parsed.data };
  return { ok: false, issues: parsed.error.issues.map(toValidationIssue) };
}

/** 解析 = 校验（wire 形态就是 JSON 树；括号在树结构里）。 */
export function parseRuleTree(input: unknown): RuleParseResult {
  return validateRuleTree(input);
}

/** 序列化为稳定的 JSON 文本；先校验，非法树不序列化。 */
export function serializeRuleTree(tree: RuleTree): RuleSerializeResult {
  const validated = validateRuleTree(tree);
  if (!validated.ok) return validated;
  return { ok: true, json: JSON.stringify(validated.tree), tree: validated.tree };
}

/* -------------------------------- 种子规则 -------------------------------- */

export interface SeedCategory {
  /** 稳定 id：同一个用户重复播种必须得到同一行，便于迁移幂等。 */
  readonly id: string;
  readonly name: string;
  readonly enterTodo: boolean;
  readonly broadcast: boolean;
}

export interface SeedRule {
  /** 稳定 id。 */
  readonly id: string;
  readonly name: string;
  readonly category: SeedCategory;
  readonly tree: RuleTree;
  readonly enabled: boolean;
  readonly order: number;
}

export const SEED_CATEGORY_PERSONAL_ID = "seed-category-personal";
export const SEED_CATEGORY_BROADCAST_ID = "seed-category-broadcast";
export const SEED_RULE_PERSONAL_ID = "seed-rule-personal";
export const SEED_RULE_BROADCAST_ID = "seed-rule-broadcast";
export const SEED_CATEGORY_PERSONAL_NAME = "点名给我";
export const SEED_CATEGORY_BROADCAST_NAME = "群发/通知";

/**
 * 「群发/通知」种子条件（纯字段，零模型调用），复刻 R4 的强信号：
 * List-Id、Precedence(bulk|list|junk)、Auto-Submitted(≠no)、from no-reply、
 * To+Cc 基数 ≥10。
 *
 * 与 v1 R4 的偏差（AC-25 语料需要显式排除/按 v1.1 语义断言的三类用例）：
 * 1. R4 还认 `List-Unsubscribe` / `List-Post` 两个列表头；v1.1 字段词表（C6）
 *    只列了 `list-id`。若某封邮件的唯一列表信号是这两个头，v1 判 broadcast、
 *    v1.1 种子不判 —— 该用例必须带 `List-Id` 或排除出等价语料。
 * 2. R4 代码只把 `Precedence: bulk|list` 当强信号；C6 明写 `bulk|list|junk`。
 *    仅 `Precedence: junk` 的用例在 v1 下不判 broadcast、在 v1.1 种子下判
 *    broadcast —— 断言「与 v1 完全一致」的语料必须排除该用例（断言 v1.1 语义则保留）。
 * 3. R4 的「同日同文哈希去重」按 C6 改为分类后的**确定性后处理**，不是规则条件；
 *    AC-25 的等价断言必须在后处理之后比较，不能要求种子规则本身复现它。
 * 4. R4 的「我是否在 To」只影响 personal/uncertain 判定，不是群发强信号，
 *    因此不进入本种子；`iAmInTo` 仍在字段词表里供用户自建规则使用。
 */
const SEED_BROADCAST_TREE: RuleTree = {
  kind: "or",
  children: [
    { kind: "field", field: "listId", op: "exists" },
    { kind: "field", field: "precedence", op: "in", value: ["bulk", "list", "junk"] },
    {
      kind: "and",
      children: [
        { kind: "field", field: "autoSubmitted", op: "exists" },
        {
          kind: "not",
          child: { kind: "field", field: "autoSubmitted", op: "equals", value: "no" },
        },
      ],
    },
    { kind: "field", field: "from.isNoReply", op: "isTrue" },
    { kind: "field", field: "recipient.count", op: "gte", value: 10 },
  ],
};

/**
 * 「群发/通知」种子规则：纯字段、零模型调用、不依赖档案，可直接持久化。
 * 与「点名给我」不同，它不携带任何占位符。
 */
export const SEED_BROADCAST_RULE: SeedRule = {
  id: SEED_RULE_BROADCAST_ID,
  name: "群发/通知",
  category: {
    id: SEED_CATEGORY_BROADCAST_ID,
    name: SEED_CATEGORY_BROADCAST_NAME,
    enterTodo: false,
    broadcast: true,
  },
  tree: SEED_BROADCAST_TREE,
  enabled: true,
  order: 1,
};

/**
 * 旧 profile（或向导档案）里参与「点名给我」匹配的身份信息。
 * 对齐 v1 R3：匹配的是**正文**里出现的姓名/别名/邮箱/邮箱前缀。
 */
export interface SeedIdentity {
  /** 显示名 + 别名，例如 ["张三", "San Zhang"]。 */
  readonly names: readonly string[];
  /** 用户全部邮箱地址；本地部分（≥3 字符）也会参与匹配（v1 行为）。 */
  readonly emails: readonly string[];
}

/** identity 必填但没有可匹配的身份词时抛出的类型化错误。 */
export class SeedIdentityError extends Error {
  constructor(message = "buildSeedPersonalRule 需要至少一个姓名/别名/邮箱") {
    super(message);
    this.name = "SeedIdentityError";
  }
}

interface IdentityTerm {
  readonly value: string;
  readonly op: "wholeWord" | "contains";
}

/** v1 identity.ts 的 compactText：NFKC + 去掉全部空白 + lowercase。 */
function compactIdentityText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\s\u3000]+/g, "")
    .toLowerCase();
}

/**
 * 「点名给我」的匹配词表（顺序：姓名/别名 → 邮箱 → 邮箱前缀）。对齐 v1 R3：
 * - 姓名/别名：`wholeWord`（ASCII 词边界；CJK 去空白子串）；去掉空白后少于
 *   2 个字符的名字 v1 不参与匹配，这里同样跳过；
 * - 完整邮箱：`contains`（v1 是 normalized 小写子串，无词边界）；
 * - 邮箱前缀：≥3 字符时 `wholeWord`（v1 的 wordAppears）。
 */
function identityTerms(identity: SeedIdentity): IdentityTerm[] {
  const seen = new Set<string>();
  const terms: IdentityTerm[] = [];
  const push = (raw: string, op: IdentityTerm["op"]): void => {
    const value = raw.trim();
    if (value === "") return;
    const key = `${op}:${value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    terms.push({ value, op });
  };

  for (const name of identity.names) {
    if (compactIdentityText(name).length < 2) continue;
    push(name, "wholeWord");
  }
  for (const email of identity.emails) {
    push(email, "contains");
    const localPart = (email.split("@")[0] ?? "").trim();
    if (localPart.length >= 3) push(localPart, "wholeWord");
  }
  return terms;
}

/**
 * 档案是否拥有可用于展开的身份词（至少一个姓名/别名/邮箱）。
 * 空档案（向导第①步跳过）不应产出「点名给我」，否则就是 inert 规则。
 */
export function hasSeedIdentity(
  identity: SeedIdentity | null | undefined,
): identity is SeedIdentity {
  return identity !== null && identity !== undefined && identityTerms(identity).length > 0;
}

/**
 * 生成「点名给我」种子规则（唯一可落库的个人种子；契约里不再出现占位符模板）。
 * identity 必填；没有任何可匹配词时抛 {@link SeedIdentityError}。
 */
export function buildSeedPersonalRule(identity: SeedIdentity): SeedRule {
  const terms = identityTerms(identity);
  if (terms.length === 0) throw new SeedIdentityError();
  const leaves: RuleNode[] = terms.map(({ value, op }) => ({
    kind: "field",
    field: "body",
    op,
    value,
  }));
  const first = leaves[0];
  const tree: RuleTree =
    leaves.length === 1 && first !== undefined ? first : { kind: "or", children: leaves };
  return {
    id: SEED_RULE_PERSONAL_ID,
    name: "点名给我",
    category: {
      id: SEED_CATEGORY_PERSONAL_ID,
      name: SEED_CATEGORY_PERSONAL_NAME,
      enterTodo: true,
      broadcast: false,
    },
    tree,
    enabled: true,
    order: 0,
  };
}

/**
 * 两条种子规则（`order` 0/1，点名给我在前）。identity 必填：
 * - 有可匹配身份词 → 两条；
 * - 档案为空 / 词全被 v1 的「>=2 字符」规则忽略 → 只返回群发种子，
 *   绝不返回 inert 的个人规则。
 *
 * 同一 identity 重复调用结果深比较相等（幂等）；返回的是独立副本，调用方可以
 * 安全地改写而不污染 {@link SEED_BROADCAST_RULE}。
 */
export function buildSeedRules(identity: SeedIdentity): SeedRule[] {
  const broadcast: SeedRule = {
    ...SEED_BROADCAST_RULE,
    category: { ...SEED_BROADCAST_RULE.category },
    tree: cloneRuleTree(SEED_BROADCAST_RULE.tree),
  };
  return hasSeedIdentity(identity)
    ? [buildSeedPersonalRule(identity), broadcast]
    : [broadcast];
}

/**
 * 「点名给我」种子的幂等重展开（写入契约的规则，store 执行）：
 *
 * 每次**保存用户档案**时评估本函数；只有「未被用户编辑、未被删除」的
 * 「点名给我」种子会被重展开成新身份词：
 * - 档案没有可用身份词 → 不动作（`no_identity`）；
 * - 用户删除过（墓碑）→ 永不重建（`deleted`）；
 * - 用户编辑过 → 保持用户版本（`edited`）；
 * - 行不存在 → 创建（`create`）；
 * - 行存在且与目标树结构相同 → 不动作（`unchanged`，幂等）；
 * - 否则 → 用目标树覆盖（身份词变化后的重展开，`update`）。
 *
 * store 负责持久化「编辑过」的判定：播种时记录 `serializeRuleTree(tree).json`
 * 的哈希，当前行哈希不同即视为用户编辑过；删除用墓碑记录。
 */
export interface SeedPersonalState {
  /** 当前持久化的「点名给我」条件树；行不存在时为 null。 */
  readonly tree: RuleTree | null;
  /** 用户是否编辑过（tree 与播种时写入的内容不同）。 */
  readonly edited: boolean;
  /** 用户是否删除过（墓碑；删除后永不重建）。 */
  readonly deleted: boolean;
}

export type SeedPersonalPlan =
  | {
      readonly kind: "skip";
      readonly reason: "no_identity" | "deleted" | "edited" | "unchanged";
    }
  | { readonly kind: "create" | "update"; readonly rule: SeedRule };

/** 按 {@link SeedPersonalState} 决定是否创建/重展开「点名给我」种子。 */
export function planSeedPersonalReconcile(
  identity: SeedIdentity | null | undefined,
  state: SeedPersonalState,
): SeedPersonalPlan {
  if (!hasSeedIdentity(identity)) return { kind: "skip", reason: "no_identity" };
  if (state.deleted) return { kind: "skip", reason: "deleted" };
  if (state.edited) return { kind: "skip", reason: "edited" };
  const rule = buildSeedPersonalRule(identity);
  if (state.tree === null) return { kind: "create", rule };
  if (sameRuleTree(state.tree, rule.tree)) return { kind: "skip", reason: "unchanged" };
  return { kind: "update", rule };
}

/** 条件树结构相等（忽略对象键顺序），用于判定种子是否仍未被编辑。 */
export function sameRuleTree(a: RuleTree, b: RuleTree): boolean {
  switch (a.kind) {
    case "field":
      return (
        b.kind === "field" &&
        a.field === b.field &&
        a.op === b.op &&
        a.which === b.which &&
        sameRuleValue(a.value, b.value)
      );
    case "semantic":
      return b.kind === "semantic" && a.expr === b.expr;
    case "not":
      return b.kind === "not" && sameRuleTree(a.child, b.child);
    case "and":
      return b.kind === "and" && sameRuleChildren(a.children, b.children);
    case "or":
      return b.kind === "or" && sameRuleChildren(a.children, b.children);
    default:
      return assertNever(a);
  }
}

function sameRuleChildren(a: readonly RuleNode[], b: readonly RuleNode[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((child, index) => {
    const other = b[index];
    return other !== undefined && sameRuleTree(child, other);
  });
}

function sameRuleValue(a: RuleValue | undefined, b: RuleValue | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    return a.length === b.length && a.every((item, index) => item === b[index]);
  }
  if (typeof a === "object" || typeof b === "object") {
    if (typeof a !== "object" || typeof b !== "object") return false;
    return a.from === b.from && a.to === b.to;
  }
  return false;
}

function cloneRuleValue(value: RuleValue | undefined): RuleValue | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return [...value];
  if (typeof value === "object") return { ...value };
  return value;
}

function cloneRuleTree(tree: RuleTree): RuleTree {
  switch (tree.kind) {
    case "field": {
      const value = cloneRuleValue(tree.value);
      return { ...tree, ...(value === undefined ? {} : { value }) };
    }
    case "semantic":
      return { ...tree };
    case "not":
      return { kind: "not", child: cloneRuleTree(tree.child) };
    case "and":
      return { kind: "and", children: tree.children.map(cloneRuleTree) };
    case "or":
      return { kind: "or", children: tree.children.map(cloneRuleTree) };
    default:
      return assertNever(tree);
  }
}
