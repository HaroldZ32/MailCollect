import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import clsx from "clsx";
import type {
  AndNode,
  DateBasis,
  FieldLeaf,
  NotNode,
  OrNode,
  RuleField,
  RuleNode,
  RuleOperator,
  RuleTree,
  RuleValue,
  SemanticLeaf,
} from "@mailcollect/shared";
import { Icon } from "./Icon";

/**
 * 规则条件树编辑器（C6 / AC-28）。
 *
 * 树形状与 `packages/shared/src/rules.ts` 的 FROZEN CONTRACT 一致：
 * - `field` 字段叶子（代码判定）；`semantic` 语义叶子（模型判定）；
 * - `and` / `or` / `not` 逻辑节点 —— **括号由树结构表达**，分组即一层括号；
 * - 逻辑嵌套深度 = AND/OR/NOT 的层数（叶子计 0），上限 {@link MAX_DEPTH}。
 *
 * 架构不变量（AGENT.md §7）：`ui → shared (types only)`。因此本文件只从 shared
 * 引入类型；字段词表 / 操作符标签 / 深度上限在这里**镜像** shared 的常量。
 * `Record<RuleField, …>` 的完整性由 tsc 保证：shared 增删字段时这里会编译失败，
 * 不会静默漂移。
 */

export const MAX_DEPTH = 8;

/* ------------------------------- 字段词表镜像 ------------------------------ */

export const FIELD_LABELS: Readonly<Record<RuleField, string>> = {
  from: "发件人（地址/域名/显示名）",
  to: "收件人",
  cc: "抄送",
  subject: "主题",
  body: "正文",
  date: "日期（发送/接收）",
  listId: "List-Id",
  precedence: "Precedence",
  autoSubmitted: "Auto-Submitted",
  hasAttachments: "有无附件",
  attachmentName: "附件文件名",
  attachmentMime: "附件 MIME 类型",
  attachmentSize: "附件大小（字节）",
  isRead: "已读/未读",
  folder: "所在文件夹",
  account: "所属账号",
  "to.count": "To 人数",
  "cc.count": "Cc 人数",
  "recipient.count": "To + Cc 人数",
  iAmInTo: "我在 To 里",
  "from.isNoReply": "发件人是 no-reply",
};

export const OPERATOR_LABELS: Readonly<Record<RuleOperator, string>> = {
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
] as const satisfies readonly RuleOperator[];

const DATE_OPS = ["before", "after", "between", "exists", "notExists"] as const satisfies readonly RuleOperator[];
const NUMBER_OPS = ["gt", "lt", "gte", "lte", "exists", "notExists"] as const satisfies readonly RuleOperator[];
const BOOLEAN_OPS = ["isTrue", "isFalse", "exists", "notExists"] as const satisfies readonly RuleOperator[];

export const FIELD_OPERATORS: Readonly<Record<RuleField, readonly RuleOperator[]>> = {
  from: STRING_OPS,
  to: STRING_OPS,
  cc: STRING_OPS,
  subject: STRING_OPS,
  body: STRING_OPS,
  date: DATE_OPS,
  listId: STRING_OPS,
  precedence: STRING_OPS,
  autoSubmitted: STRING_OPS,
  hasAttachments: BOOLEAN_OPS,
  attachmentName: STRING_OPS,
  attachmentMime: STRING_OPS,
  attachmentSize: NUMBER_OPS,
  isRead: BOOLEAN_OPS,
  folder: STRING_OPS,
  account: STRING_OPS,
  "to.count": NUMBER_OPS,
  "cc.count": NUMBER_OPS,
  "recipient.count": NUMBER_OPS,
  iAmInTo: BOOLEAN_OPS,
  "from.isNoReply": BOOLEAN_OPS,
};

type ValueKind = "none" | "string" | "number" | "date" | "stringList" | "dateRange";

/** 与 shared 的 `RULE_VALUE_KIND` 一一对应：操作符决定值输入控件。 */
const OPERATOR_VALUE_KIND: Readonly<Record<RuleOperator, ValueKind>> = {
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

/* -------------------------------- 校验镜像 -------------------------------- */

export type RuleIssueCode =
  | "invalid_shape"
  | "operator_not_allowed"
  | "value_missing"
  | "value_type_mismatch"
  | "depth_exceeded"
  | "empty_group"
  | "empty_semantic_expression";

export interface RuleTreeIssue {
  /** 与 shared 相同的点分路径：根为空串，例如 `children.0.value`。 */
  readonly path: string;
  readonly code: RuleIssueCode;
  readonly message: string;
}

const ISSUE_MESSAGES: Readonly<Record<RuleIssueCode, string>> = {
  invalid_shape: "节点形状不合法",
  operator_not_allowed: "该字段不支持这个操作符",
  value_missing: "这个操作符需要一个值",
  value_type_mismatch: "值的类型或内容不合法",
  depth_exceeded: `嵌套深度超过上限 ${MAX_DEPTH}`,
  empty_group: "分组至少要有一个子条件",
  empty_semantic_expression: "语义条件至少需要 2 个字",
};

function isLogical(node: RuleNode): node is AndNode | OrNode | NotNode {
  return node.kind === "and" || node.kind === "or" || node.kind === "not";
}

/** 逻辑嵌套深度：AND/OR/NOT 计 1，叶子计 0。 */
export function treeDepth(node: RuleNode): number {
  switch (node.kind) {
    case "field":
    case "semantic":
      return 0;
    case "not":
      return 1 + treeDepth(node.child);
    case "and":
    case "or":
      return node.children.reduce((max, child) => Math.max(max, treeDepth(child)), 0) + 1;
  }
}

function joinPath(prefix: string, segment: string): string {
  return prefix === "" ? segment : `${prefix}.${segment}`;
}

/** 镜像 shared `inspectRuleTree`：深度超限/空分组只报当前节点、不再向下走。 */
export function validateTreeLocally(tree: RuleTree): readonly RuleTreeIssue[] {
  const issues: RuleTreeIssue[] = [];

  const push = (path: string, code: RuleIssueCode): void => {
    issues.push({ path, code, message: ISSUE_MESSAGES[code] });
  };

  const walk = (node: RuleNode, path: string, logicalDepth: number): void => {
    switch (node.kind) {
      case "field": {
        const spec = FIELD_OPERATORS[node.field];
        if (!spec.includes(node.op)) {
          push(joinPath(path, "op"), "operator_not_allowed");
          return;
        }
        if (node.which !== undefined && node.field !== "date") {
          push(joinPath(path, "which"), "invalid_shape");
        }
        const expected = OPERATOR_VALUE_KIND[node.op];
        if (expected === "none") {
          if (node.value !== undefined) push(joinPath(path, "value"), "value_type_mismatch");
          return;
        }
        if (node.value === undefined) {
          push(joinPath(path, "value"), "value_missing");
          return;
        }
        const value = node.value;
        switch (expected) {
          case "string":
            if (typeof value !== "string" || value.trim() === "") {
              push(joinPath(path, "value"), "value_type_mismatch");
            }
            return;
          case "date":
            if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
              push(joinPath(path, "value"), "value_type_mismatch");
            }
            return;
          case "number":
            if (typeof value !== "number" || !Number.isFinite(value)) {
              push(joinPath(path, "value"), "value_type_mismatch");
            }
            return;
          case "stringList":
            if (
              !Array.isArray(value) ||
              value.length === 0 ||
              value.some((item) => typeof item !== "string" || item.trim() === "")
            ) {
              push(joinPath(path, "value"), "value_type_mismatch");
            }
            return;
          case "dateRange": {
            if (typeof value !== "object" || value === null || Array.isArray(value)) {
              push(joinPath(path, "value"), "value_type_mismatch");
              return;
            }
            if (Number.isNaN(Date.parse(value.from)) || Number.isNaN(Date.parse(value.to))) {
              push(joinPath(path, "value"), "value_type_mismatch");
            }
            return;
          }
        }
        return;
      }
      case "semantic":
        if (node.expr.trim().length < 2) push(joinPath(path, "expr"), "empty_semantic_expression");
        return;
      case "not": {
        const depth = logicalDepth + 1;
        if (depth > MAX_DEPTH) {
          push(joinPath(path, "kind"), "depth_exceeded");
          return;
        }
        walk(node.child, joinPath(path, "child"), depth);
        return;
      }
      case "and":
      case "or": {
        const depth = logicalDepth + 1;
        if (node.children.length === 0) {
          push(joinPath(path, "children"), "empty_group");
          return;
        }
        if (depth > MAX_DEPTH) {
          push(joinPath(path, "kind"), "depth_exceeded");
          return;
        }
        node.children.forEach((child, index) => {
          walk(child, joinPath(path, `children.${index}`), depth);
        });
        return;
      }
    }
  };

  walk(tree, "", 0);
  return issues;
}

/**
 * 服务端 400 的文案形如 `条件树不合法（children.0.value:value_type_mismatch）`。
 * 只在整体格式完全匹配时还原成路径/代码，其余情况原样展示（不做猜测性解析）。
 */
export function issuesFromServerMessage(message: string): readonly RuleTreeIssue[] | null {
  const open = message.indexOf("（");
  const close = message.lastIndexOf("）");
  if (open < 0 || close !== message.length - 1) return null;
  const body = message.slice(open + 1, close);
  if (body === "") return null;
  const result: RuleTreeIssue[] = [];
  for (const part of body.split(",")) {
    const item = part.trim();
    const colon = item.indexOf(":");
    if (colon <= 0) return null;
    const path = item.slice(0, colon);
    const code = item.slice(colon + 1);
    if (!(code in ISSUE_MESSAGES)) return null;
    result.push({ path, code: code as RuleIssueCode, message: ISSUE_MESSAGES[code as RuleIssueCode] });
  }
  return result;
}

/* -------------------------------- 文本化 -------------------------------- */

function formatValue(value: RuleValue | undefined): string {
  if (value === undefined) return "";
  if (typeof value === "string") return `「${value}」`;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) return value.map((item) => `「${item}」`).join("、");
  return `「${value.from}」至「${value.to}」`;
}

/** 把树渲染成带括号的表达式，例如 `(主题 包含「账单」 且 非(正文 整词匹配「张三」))`。 */
export function formatTreeFormula(node: RuleNode): string {
  switch (node.kind) {
    case "field": {
      const value = formatValue(node.value);
      return `${FIELD_LABELS[node.field]} ${OPERATOR_LABELS[node.op]}${value === "" ? "" : ` ${value}`}`;
    }
    case "semantic":
      return `语义「${node.expr.trim() === "" ? "待填写" : node.expr.trim()}」`;
    case "not":
      return `非(${formatTreeFormula(node.child)})`;
    case "and":
      return `(${node.children.map(formatTreeFormula).join(" 且 ")})`;
    case "or":
      return `(${node.children.map(formatTreeFormula).join(" 或 ")})`;
  }
}

const SUMMARY_LIMIT = 120;

/** 规则列表里的单行条件摘要。 */
export function summarizeTree(node: RuleNode): string {
  const formula = formatTreeFormula(node);
  return formula.length > SUMMARY_LIMIT ? `${formula.slice(0, SUMMARY_LIMIT)}…` : formula;
}

/* -------------------------------- 默认节点 -------------------------------- */

export function createFieldLeaf(): FieldLeaf {
  return { kind: "field", field: "subject", op: "contains", value: "" };
}

export function createSemanticLeaf(): SemanticLeaf {
  return { kind: "semantic", expr: "" };
}

/** 新规则的条件树：一个待填写的字段条件（空值由校验标出，保存前必须填）。 */
export function createDefaultTree(): RuleTree {
  return createFieldLeaf();
}

function defaultGroup(kind: "and" | "or"): RuleNode {
  return { kind, children: [createFieldLeaf()] };
}

function defaultNot(): RuleNode {
  return { kind: "not", child: createFieldLeaf() };
}

/* ------------------------------- 组件样式 ------------------------------- */

const S: Readonly<Record<string, CSSProperties>> = {
  editor: { display: "flex", flexDirection: "column", gap: 10, minWidth: 0 },
  toolbar: { display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" },
  preview: {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "8px 11px",
    borderRadius: "var(--radius-sm)",
    background: "rgba(255, 255, 255, 0.6)",
    border: "1px solid rgba(47, 124, 246, 0.1)",
    minWidth: 0,
  },
  formula: {
    fontFamily: "var(--font-mono)",
    fontSize: 11.5,
    lineHeight: 1.6,
    color: "var(--text-secondary)",
    overflowWrap: "anywhere",
  },
  canvas: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: 11,
    borderRadius: "var(--radius-md)",
    background: "var(--surface-sunken)",
    border: "1px solid rgba(47, 124, 246, 0.1)",
    minWidth: 0,
  },
  group: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    padding: "9px 10px 10px",
    borderRadius: 12,
    background: "rgba(255, 255, 255, 0.55)",
    border: "1px solid rgba(15, 37, 64, 0.08)",
    minWidth: 0,
  },
  groupHead: { display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", minWidth: 0 },
  bracket: {
    fontFamily: "var(--font-mono)",
    fontSize: 17,
    lineHeight: 1,
    color: "var(--text-tertiary)",
    userSelect: "none",
  },
  children: {
    display: "flex",
    flexDirection: "column",
    gap: 7,
    marginLeft: 3,
    paddingLeft: 11,
    borderLeft: "1px dashed rgba(15, 37, 64, 0.16)",
    minWidth: 0,
  },
  leaf: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 },
  leafGrow: { flex: "1 1 150px", minWidth: 120 },
  addRow: { display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" },
  hint: { fontSize: 10.5, lineHeight: 1.5, color: "var(--text-tertiary)", flexBasis: "100%" },
  issue: {
    flexBasis: "100%",
    display: "flex",
    alignItems: "center",
    gap: 5,
    fontSize: 10.5,
    lineHeight: 1.5,
    color: "#b0454c",
  },
  issueBox: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    padding: "8px 11px",
    borderRadius: "var(--radius-sm)",
    background: "var(--danger-soft)",
    color: "#b0454c",
    fontSize: 11,
    lineHeight: 1.6,
  },
};

const COMPACT_INPUT: CSSProperties = {
  height: 32,
  padding: "0 9px",
  borderRadius: 10,
  fontSize: 12,
};

const COMPACT_TEXTAREA: CSSProperties = {
  ...COMPACT_INPUT,
  height: "auto",
  minHeight: 34,
  padding: "7px 9px",
  lineHeight: 1.5,
  resize: "vertical",
};

/* -------------------------------- 主组件 -------------------------------- */

export interface RuleTreeEditorProps {
  readonly tree: RuleTree;
  readonly onChange: (next: RuleTree) => void;
  /** 本地/服务端校验问题；按路径就近显示在节点上。 */
  readonly issues?: readonly RuleTreeIssue[];
  readonly disabled?: boolean;
}

export function RuleTreeEditor({ tree, onChange, issues = [], disabled = false }: RuleTreeEditorProps) {
  const depth = treeDepth(tree);
  const overLimit = depth > MAX_DEPTH;

  return (
    <div style={S.editor} data-testid="rule-tree-editor">
      <div style={S.toolbar}>
        <span style={{ fontSize: 13, fontWeight: 700 }}>条件树</span>
        <span className="section-note" style={{ flex: "1 1 220px", minWidth: 0 }}>
          叶子 = 字段条件或语义条件；「与 / 或 / 非」分组就是一层括号
        </span>
        <span
          className={clsx("chip", overLimit ? "chip--danger" : depth > 0 ? "chip--accent" : "")}
          title={`逻辑嵌套深度（AND/OR/NOT 层数）上限 ${MAX_DEPTH}`}
          data-testid="tree-depth"
        >
          深度 {depth} / {MAX_DEPTH}
        </span>
      </div>

      <div style={S.preview}>
        <span className="field-label">表达式预览</span>
        <code style={S.formula} data-testid="tree-formula">
          {formatTreeFormula(tree)}
        </code>
      </div>

      <div style={S.canvas}>
        <NodeEditor
          node={tree}
          path=""
          depth={isLogical(tree) ? 1 : 0}
          isRoot
          disabled={disabled}
          issues={issues}
          onChange={onChange}
          onRemove={null}
        />
        {isLogical(tree) ? null : (
          <div style={S.addRow} data-testid="root-wrap">
            <span className="section-note">组合这一条：</span>
            <button
              type="button"
              className="btn btn--sm btn--quiet"
              disabled={disabled}
              onClick={() => onChange({ kind: "and", children: [tree] })}
            >
              包成「与」括号
            </button>
            <button
              type="button"
              className="btn btn--sm btn--quiet"
              disabled={disabled}
              onClick={() => onChange({ kind: "or", children: [tree] })}
            >
              包成「或」括号
            </button>
            <button
              type="button"
              className="btn btn--sm btn--quiet"
              disabled={disabled}
              onClick={() => onChange({ kind: "not", child: tree })}
            >
              包成「非」
            </button>
          </div>
        )}
      </div>

      {issues.length > 0 ? (
        <div style={S.issueBox} role="alert" data-testid="tree-issues">
          <strong>条件树有 {issues.length} 个问题，修正后才能保存：</strong>
          {issues.map((issue, index) => (
            <span key={`${issue.path}-${issue.code}-${index}`}>· {issue.message}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------- 节点递归 ------------------------------- */

interface NodeEditorProps {
  readonly node: RuleNode;
  readonly path: string;
  /** 该节点自身的逻辑深度：叶子 0，逻辑节点 = 父逻辑深度 + 1。 */
  readonly depth: number;
  readonly isRoot: boolean;
  readonly disabled: boolean;
  readonly issues: readonly RuleTreeIssue[];
  readonly onChange: (next: RuleNode) => void;
  readonly onRemove: (() => void) | null;
}

function NodeEditor(props: NodeEditorProps): ReactNode {
  const { node } = props;
  switch (node.kind) {
    case "field":
      return <FieldLeafEditor {...props} leaf={node} />;
    case "semantic":
      return <SemanticLeafEditor {...props} leaf={node} />;
    case "and":
    case "or":
      return <GroupNodeEditor {...props} node={node} />;
    case "not":
      return <NotNodeEditor {...props} node={node} />;
  }
}

function IssueLines({ issues }: { readonly issues: readonly RuleTreeIssue[] }): ReactNode {
  if (issues.length === 0) return null;
  return (
    <>
      {issues.map((issue, index) => (
        <span key={`${issue.code}-${index}`} style={S.issue} role="note">
          <Icon name="alert" size={11} />
          {issue.message}
        </span>
      ))}
    </>
  );
}

function RemoveButton({
  onRemove,
  disabled,
  label,
}: {
  readonly onRemove: () => void;
  readonly disabled: boolean;
  readonly label: string;
}): ReactNode {
  return (
    <button
      type="button"
      className="btn btn--icon btn--sm btn--quiet"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onRemove}
    >
      <Icon name="close" size={13} />
    </button>
  );
}

function issueAt(issues: readonly RuleTreeIssue[], path: string): readonly RuleTreeIssue[] {
  return issues.filter((issue) => issue.path === path);
}

/* --------------------------------- 分组 --------------------------------- */

interface GroupNodeEditorProps extends NodeEditorProps {
  readonly node: AndNode | OrNode;
}

function GroupNodeEditor({
  node,
  path,
  depth,
  isRoot,
  disabled,
  issues,
  onChange,
  onRemove,
}: GroupNodeEditorProps): ReactNode {
  const canNest = depth + 1 <= MAX_DEPTH;
  const childrenPath = joinPath(path, "children");
  const kindPath = joinPath(path, "kind");
  const emptyIssue = issueAt(issues, childrenPath);
  const depthIssue = issueAt(issues, kindPath);

  const setChildren = (children: readonly RuleNode[]): void => {
    onChange({ kind: node.kind, children });
  };

  const append = (child: RuleNode): void => {
    setChildren([...node.children, child]);
  };

  const nestTip = canNest
    ? "添加一个嵌套分组"
    : `已达最大嵌套深度 ${MAX_DEPTH}（与/或/非 的层数），不能再嵌套分组`;

  return (
    <div style={S.group} data-tree-path={path} data-tree-kind={node.kind}>
      <div style={S.groupHead}>
        <span style={S.bracket} aria-hidden="true">
          (
        </span>
        <span className="chip chip--iris">{node.kind === "and" ? "括号 · 与" : "括号 · 或"}</span>
        <div className="segmented" role="group" aria-label="分组逻辑">
          <button
            type="button"
            className={clsx(node.kind === "and" && "is-active")}
            onClick={() => onChange({ kind: "and", children: node.children })}
            disabled={disabled || node.kind === "and"}
            aria-pressed={node.kind === "and"}
          >
            与
          </button>
          <button
            type="button"
            className={clsx(node.kind === "or" && "is-active")}
            onClick={() => onChange({ kind: "or", children: node.children })}
            disabled={disabled || node.kind === "or"}
            aria-pressed={node.kind === "or"}
          >
            或
          </button>
          <button
            type="button"
            title={canNest ? "把这个分组整体取反：非(…)" : `取反会多一层嵌套，超过上限 ${MAX_DEPTH}`}
            disabled={disabled || !canNest}
            onClick={() => onChange({ kind: "not", child: node })}
          >
            非
          </button>
        </div>
        <span className="section-note">深度 {depth}/{MAX_DEPTH}</span>
        <span style={{ flex: 1 }} />
        {isRoot ? null : (
          <RemoveButton
            disabled={disabled}
            label="删除这个分组"
            onRemove={() => {
              onRemove?.();
            }}
          />
        )}
      </div>

      <div style={S.children}>
        {node.children.map((child, index) => {
          const childPath = joinPath(path, `children.${index}`);
          const childLogical = isLogical(child);
          return (
            <NodeEditor
              key={`${index}-${child.kind}`}
              node={child}
              path={childPath}
              depth={childLogical ? depth + 1 : 0}
              isRoot={false}
              disabled={disabled}
              issues={issues}
              onChange={(next) => {
                setChildren(node.children.map((current, i) => (i === index ? next : current)));
              }}
              onRemove={() => {
                setChildren(node.children.filter((_, i) => i !== index));
              }}
            />
          );
        })}
        {node.children.length === 0 ? (
          <span style={{ ...S.hint, color: "var(--danger)" }} role="note">
            这个分组还没有子条件，至少添加一个。
          </span>
        ) : null}
      </div>

      <IssueLines issues={[...emptyIssue, ...depthIssue]} />

      <div style={S.addRow}>
        <span className="section-note">添加：</span>
        <button
          type="button"
          className="btn btn--sm btn--quiet"
          disabled={disabled}
          onClick={() => append(createFieldLeaf())}
        >
          <Icon name="plus" size={12} /> 字段条件
        </button>
        <button
          type="button"
          className="btn btn--sm btn--quiet"
          disabled={disabled}
          onClick={() => append(createSemanticLeaf())}
        >
          <Icon name="plus" size={12} /> 语义条件
        </button>
        <button
          type="button"
          className="btn btn--sm btn--quiet"
          title={nestTip}
          disabled={disabled || !canNest}
          onClick={() => append(defaultGroup("and"))}
        >
          <Icon name="plus" size={12} /> 与分组
        </button>
        <button
          type="button"
          className="btn btn--sm btn--quiet"
          title={nestTip}
          disabled={disabled || !canNest}
          onClick={() => append(defaultGroup("or"))}
        >
          <Icon name="plus" size={12} /> 或分组
        </button>
        <button
          type="button"
          className="btn btn--sm btn--quiet"
          title={nestTip}
          disabled={disabled || !canNest}
          onClick={() => append(defaultNot())}
        >
          <Icon name="plus" size={12} /> 否定
        </button>
      </div>
      {!canNest ? (
        <span style={S.hint} role="note">
          已达最大嵌套深度 {MAX_DEPTH}：可以继续添加叶子条件，但不能再加分组。
        </span>
      ) : null}
    </div>
  );
}

/* --------------------------------- 非 ---------------------------------- */

interface NotNodeEditorProps extends NodeEditorProps {
  readonly node: NotNode;
}

function NotNodeEditor({ node, path, depth, isRoot, disabled, issues, onChange, onRemove }: NotNodeEditorProps): ReactNode {
  const childPath = joinPath(path, "child");
  const kindPath = joinPath(path, "kind");
  const child = node.child;
  const childLogical = isLogical(child);

  return (
    <div style={S.group} data-tree-path={path} data-tree-kind="not">
      <div style={S.groupHead}>
        <span style={S.bracket} aria-hidden="true">
          (
        </span>
        <span className="chip chip--warning">括号 · 非</span>
        <div className="segmented" role="group" aria-label="分组逻辑">
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ kind: "and", children: [child] })}
          >
            与
          </button>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onChange({ kind: "or", children: [child] })}
          >
            或
          </button>
          <button type="button" className="is-active" aria-pressed="true" disabled>
            非
          </button>
        </div>
        <span className="section-note">深度 {depth}/{MAX_DEPTH}</span>
        <span style={{ flex: 1 }} />
        {isRoot ? null : (
          <RemoveButton
            disabled={disabled}
            label="删除这个「非」分组"
            onRemove={() => {
              onRemove?.();
            }}
          />
        )}
      </div>

      <div style={S.children}>
        <NodeEditor
          node={child}
          path={childPath}
          depth={childLogical ? depth + 1 : 0}
          isRoot={false}
          disabled={disabled}
          issues={issues}
          onChange={(next) => onChange({ kind: "not", child: next })}
          onRemove={() => onChange(createFieldLeaf())}
        />
      </div>

      <IssueLines issues={issueAt(issues, kindPath)} />
      <span style={S.hint}>
        「非」只否定一个条件；要否定多个条件，先在父分组里用「与 / 或」分组再把它取反。
      </span>
    </div>
  );
}

/* ------------------------------ 字段叶子 ------------------------------- */

interface FieldLeafEditorProps extends NodeEditorProps {
  readonly leaf: FieldLeaf;
}

function FieldLeafEditor({ leaf, path, isRoot, disabled, issues, onChange, onRemove }: FieldLeafEditorProps): ReactNode {
  const opPath = joinPath(path, "op");
  const valuePath = joinPath(path, "value");
  const fieldId = `${path === "" ? "root" : path}-field`;
  const opId = `${path === "" ? "root" : path}-op`;

  const ops = FIELD_OPERATORS[leaf.field];
  const valueKind = OPERATOR_VALUE_KIND[leaf.op];

  const setField = (field: RuleField): void => {
    const nextOps = FIELD_OPERATORS[field];
    const op = nextOps.includes(leaf.op) ? leaf.op : (nextOps[0] ?? "exists");
    const keepValue = nextOps.includes(leaf.op);
    const which = field === "date" ? leaf.which ?? "sent" : undefined;
    onChange({
      kind: "field",
      field,
      op,
      ...(keepValue && leaf.value !== undefined ? { value: leaf.value } : {}),
      ...(which === undefined ? {} : { which }),
    });
  };

  const setOperator = (op: RuleOperator): void => {
    const previousKind = OPERATOR_VALUE_KIND[leaf.op];
    const nextKind = OPERATOR_VALUE_KIND[op];
    const defaultValue = previousKind === nextKind ? leaf.value : defaultForKind(nextKind);
    onChange({
      kind: "field",
      field: leaf.field,
      op,
      ...(leaf.which === undefined ? {} : { which: leaf.which }),
      ...(defaultValue === undefined ? {} : { value: defaultValue }),
    });
  };

  const setValue = (value: RuleValue | undefined): void => {
    const { value: _previous, ...rest } = leaf;
    onChange(value === undefined ? rest : { ...rest, value });
  };

  return (
    <div style={S.leaf} data-tree-path={path} data-tree-kind="field">
      <span className="chip">条件</span>

      <label htmlFor={fieldId} className="visually-hidden">
        字段
      </label>
      <select
        id={fieldId}
        className="select"
        aria-label="字段"
        style={{ ...COMPACT_INPUT, flex: "1 1 150px", minWidth: 120 }}
        value={leaf.field}
        disabled={disabled}
        onChange={(event) => {
          setField(event.target.value as RuleField);
        }}
      >
        {Object.entries(FIELD_LABELS).map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>

      <label htmlFor={opId} className="visually-hidden">
        操作符
      </label>
      <select
        id={opId}
        className="select"
        aria-label="操作符"
        style={{ ...COMPACT_INPUT, flex: "0 1 116px", minWidth: 100 }}
        value={leaf.op}
        disabled={disabled}
        onChange={(event) => {
          setOperator(event.target.value as RuleOperator);
        }}
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {OPERATOR_LABELS[op]}
          </option>
        ))}
      </select>

      <ValueEditor
        operator={leaf.op}
        value={leaf.value}
        valueKind={valueKind}
        disabled={disabled}
        onChange={setValue}
      />

      {leaf.field === "date" ? (
        <select
          className="select"
          aria-label="日期口径"
          style={{ ...COMPACT_INPUT, flex: "0 0 108px" }}
          value={leaf.which ?? "sent"}
          disabled={disabled}
          onChange={(event) => {
            const which = event.target.value as DateBasis;
            onChange({ ...leaf, which });
          }}
        >
          <option value="sent">发送日期</option>
          <option value="received">接收日期</option>
        </select>
      ) : null}

      {/* 右侧控件作为一个不可拆分的整体换行：避免窄屏下只把「删除」挤到下一行。 */}
      <span
        style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}
      >
        <div className="segmented" role="group" aria-label="叶子类型">
          <button type="button" className="is-active" aria-pressed="true" disabled>
            字段
          </button>
          <button
            type="button"
            disabled={disabled}
            title="换成由模型判定的语义条件"
            onClick={() => onChange(createSemanticLeaf())}
          >
            语义
          </button>
        </div>
        {isRoot ? null : (
          <RemoveButton
            disabled={disabled}
            label="删除这个条件"
            onRemove={() => {
              onRemove?.();
            }}
          />
        )}
      </span>

      <IssueLines issues={[...issueAt(issues, opPath), ...issueAt(issues, valuePath)]} />
      {leaf.op === "wholeWord" ? (
        <span style={S.hint}>整词匹配：Li 不命中 Lion；中文去空白后按子串（「张三」命中「张三丰」）。</span>
      ) : null}
      {valueKind === "stringList" ? <span style={S.hint}>多个值用逗号或换行分隔。</span> : null}
    </div>
  );
}

/* ------------------------------ 语义叶子 ------------------------------- */

interface SemanticLeafEditorProps extends NodeEditorProps {
  readonly leaf: SemanticLeaf;
}

function SemanticLeafEditor({ leaf, path, isRoot, disabled, issues, onChange, onRemove }: SemanticLeafEditorProps): ReactNode {
  const exprPath = joinPath(path, "expr");

  return (
    <div style={S.leaf} data-tree-path={path} data-tree-kind="semantic">
      <span className="chip chip--iris">语义</span>
      <label htmlFor={`${path === "" ? "root" : path}-expr`} className="visually-hidden">
        语义条件
      </label>
      <textarea
        id={`${path === "" ? "root" : path}-expr`}
        className="textarea"
        style={{ ...COMPACT_TEXTAREA, flex: "1 1 240px", minWidth: 170 }}
        value={leaf.expr}
        disabled={disabled}
        placeholder="用一句话描述，例如：正文在催我本周提交报告"
        onChange={(event) => onChange({ kind: "semantic", expr: event.target.value })}
      />

      <span
        style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, flexShrink: 0 }}
      >
        <div className="segmented" role="group" aria-label="叶子类型">
          <button type="button" disabled={disabled} onClick={() => onChange(createFieldLeaf())}>
            字段
          </button>
          <button type="button" className="is-active" aria-pressed="true" disabled>
            语义
          </button>
        </div>
        {isRoot ? null : (
          <RemoveButton
            disabled={disabled}
            label="删除这个语义条件"
            onRemove={() => {
              onRemove?.();
            }}
          />
        )}
      </span>

      <IssueLines issues={issueAt(issues, exprPath)} />
      <span style={S.hint}>语义条件由模型判断真假（会调用你配置的 LLM）；至少写 2 个字。</span>
    </div>
  );
}

/* ------------------------------- 值编辑器 ------------------------------- */

function defaultForKind(kind: ValueKind): RuleValue | undefined {
  switch (kind) {
    case "none":
      return undefined;
    case "string":
    case "date":
      return "";
    case "stringList":
      return [];
    case "dateRange":
      return { from: "", to: "" };
    case "number":
      return undefined;
  }
}

interface ValueEditorProps {
  readonly operator: RuleOperator;
  readonly value: RuleValue | undefined;
  readonly valueKind: ValueKind;
  readonly disabled: boolean;
  readonly onChange: (value: RuleValue | undefined) => void;
}

function ValueEditor({ operator, value, valueKind, disabled, onChange }: ValueEditorProps): ReactNode {
  const label = `值（${OPERATOR_LABELS[operator]}）`;

  switch (valueKind) {
    case "none":
      return <span className="section-note">无需值</span>;
    case "string":
      return (
        <input
          className="input"
          style={{ ...COMPACT_INPUT, flex: "1 1 150px", minWidth: 110 }}
          aria-label={label}
          placeholder="值"
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "date":
      return (
        <input
          type="date"
          className="input"
          style={{ ...COMPACT_INPUT, flex: "0 1 148px" }}
          aria-label={label}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      );
    case "number":
      return (
        <input
          type="number"
          className="input"
          style={{ ...COMPACT_INPUT, flex: "0 1 110px" }}
          aria-label={label}
          placeholder="数字"
          value={typeof value === "number" ? String(value) : ""}
          disabled={disabled}
          onChange={(event) => {
            const raw = event.target.value;
            onChange(raw === "" ? undefined : Number(raw));
          }}
        />
      );
    case "stringList":
      return <ListValueEditor value={value} disabled={disabled} onChange={onChange} label={label} />;
    case "dateRange": {
      const range =
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? value
          : { from: "", to: "" };
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "1 1 260px", minWidth: 210 }}>
          <input
            type="date"
            className="input"
            style={{ ...COMPACT_INPUT, flex: "1 1 120px", minWidth: 100 }}
            aria-label="起始日期"
            value={range.from}
            disabled={disabled}
            onChange={(event) => onChange({ from: event.target.value, to: range.to })}
          />
          <span className="section-note">至</span>
          <input
            type="date"
            className="input"
            style={{ ...COMPACT_INPUT, flex: "1 1 120px", minWidth: 100 }}
            aria-label="结束日期"
            value={range.to}
            disabled={disabled}
            onChange={(event) => onChange({ from: range.from, to: event.target.value })}
          />
        </span>
      );
    }
  }
}

/**
 * `in` 的字符串列表：输入过程中保留原文（否则用户输入逗号就会被“吃掉”），
 * 每次编辑同时提交解析后的数组；外部替换（切换节点）时再回灌。
 */
function ListValueEditor({
  value,
  disabled,
  onChange,
  label,
}: {
  readonly value: RuleValue | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: RuleValue | undefined) => void;
  readonly label: string;
}): ReactNode {
  const toText = (current: RuleValue | undefined): string => {
    if (!Array.isArray(current)) return "";
    return current.join("，");
  };
  const [draft, setDraft] = useState(() => toText(value));
  const committed = useRef<RuleValue | undefined>(value);

  useEffect(() => {
    if (value !== committed.current) {
      committed.current = value;
      setDraft(toText(value));
    }
  }, [value]);

  return (
    <input
      className="input"
      style={{ ...COMPACT_INPUT, flex: "1 1 190px", minWidth: 140 }}
      aria-label={label}
      placeholder="值1，值2"
      value={draft}
      disabled={disabled}
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const items = text
          .split(/[,，、\n]/)
          .map((item) => item.trim())
          .filter((item) => item !== "");
        committed.current = items;
        onChange(items);
      }}
    />
  );
}
