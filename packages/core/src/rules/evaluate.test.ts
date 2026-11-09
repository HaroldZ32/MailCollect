import { describe, expect, it } from "vitest";
import { RULE_FIELDS, RULE_FIELD_NAMES, RULE_OPERATOR_NAMES } from "@mailcollect/shared";
import type { FieldLeaf, RuleField, RuleOperator, RuleTree } from "@mailcollect/shared";
import {
  RuleEvaluationError,
  evaluateFieldLeaf,
  evaluateRuleTree,
  matchesWholeWord,
  parseAddress,
  type EvaluationContext,
  type RuleEmail,
} from "./evaluate.js";
import { makeRuleEmail, TEST_TIMEZONE } from "./__test-helpers__/fixtures.js";

const context: EvaluationContext = {
  userEmails: ["me@example.com"],
  timezone: TEST_TIMEZONE,
};

function leaf(field: RuleField, op: RuleOperator, value?: unknown, which?: "sent" | "received"): FieldLeaf {
  return {
    kind: "field",
    field,
    op,
    ...(value === undefined ? {} : { value }),
    ...(which === undefined ? {} : { which }),
  } as FieldLeaf;
}

const STRING_SAMPLES: Readonly<Record<string, string>> = {
  from: "zhang@example.com",
  to: "li@corp.example",
  cc: "c1@x.com",
  subject: "【重要】周五前提交 Ｑ３ 报告",
  body: "张三，请在周五下班前提交 Q3 报告，提到项目 X。",
  listId: "<announce.example.com>",
  precedence: "bulk",
  autoSubmitted: "auto-generated",
  attachmentName: "Ｒｅｐｏｒｔ.PDF",
  attachmentMime: "application/pdf",
  folder: "收件箱",
  account: "工作邮箱",
};

const NUMBER_SAMPLES: Readonly<Record<string, number>> = {
  "to.count": 2,
  "cc.count": 3,
  "recipient.count": 5,
  attachmentSize: 2048,
};

const email = makeRuleEmail();

/**
 * 整词操作符的 id：共享契约只认 captain 钉死的 `wholeWord`。
 */
const WORD_OPERATOR = (RULE_OPERATOR_NAMES as readonly string[]).find(
  (op): op is RuleOperator => op === "wholeWord",
);

describe("字段词表 × 操作符（AC-19）", () => {
  const cases: Array<{ label: string; field: RuleField; leaf: FieldLeaf; expected: boolean }> = [];

  for (const field of RULE_FIELD_NAMES) {
    if (field in STRING_SAMPLES) {
      const sample = STRING_SAMPLES[field] ?? "";
      const ops: RuleOperator[] = ["equals", "notEquals", "contains", "notContains", "startsWith", "endsWith", "in", "exists", "notExists"];
      for (const op of ops) {
        const value = op === "in" ? [sample] : op === "exists" || op === "notExists" ? undefined : sample;
        const expected =
          op === "equals" || op === "contains" || op === "startsWith" || op === "endsWith" || op === "in" || op === "exists"
            ? true
            : false;
        cases.push({ label: `${field} ${op}`, field, leaf: leaf(field, op, value), expected });
      }
      if (WORD_OPERATOR) {
        cases.push({
          label: `${field} ${WORD_OPERATOR}`,
          field,
          leaf: leaf(field, WORD_OPERATOR, sample),
          expected: true,
        });
      }
      continue;
    }

    if (field in NUMBER_SAMPLES) {
      const sample = NUMBER_SAMPLES[field] ?? 0;
      const numberOps: Array<{ op: RuleOperator; value?: unknown; expected: boolean }> = [
        { op: "gt", value: sample - 1, expected: true },
        { op: "lt", value: sample + 1, expected: true },
        { op: "gte", value: sample, expected: true },
        { op: "lte", value: sample, expected: true },
        { op: "exists", expected: true },
        { op: "notExists", expected: false },
      ];
      for (const entry of numberOps) {
        cases.push({
          label: `${field} ${entry.op}`,
          field,
          leaf: leaf(field, entry.op, entry.value),
          expected: entry.expected,
        });
      }
      continue;
    }

    if (field === "date") {
      const dateOps: Array<{ op: RuleOperator; value?: unknown; expected: boolean }> = [
        { op: "before", value: "2026-11-10", expected: true },
        { op: "after", value: "2026-11-08", expected: true },
        { op: "between", value: { from: "2026-11-08", to: "2026-11-09" }, expected: true },
        { op: "exists", expected: true },
        { op: "notExists", expected: false },
      ];
      for (const entry of dateOps) {
        cases.push({
          label: `${field} ${entry.op}`,
          field,
          leaf: leaf(field, entry.op, entry.value),
          expected: entry.expected,
        });
      }
      continue;
    }

    const booleanCase: Record<string, { email: RuleEmail; expected: boolean }> = {
      hasAttachments: { email, expected: true },
      isRead: { email, expected: false },
      iAmInTo: { email, expected: true },
      "from.isNoReply": {
        email: makeRuleEmail({ fromName: null, fromEmail: "no-reply@corp.example" }),
        expected: true,
      },
    };
    const spec = booleanCase[field];
    if (!spec) throw new Error(`测试缺少字段 ${field} 的样例`);
    const booleanOps: Array<{ op: RuleOperator; expected: boolean }> = [
      { op: "isTrue", expected: spec.expected },
      { op: "isFalse", expected: !spec.expected },
      { op: "exists", expected: true },
      { op: "notExists", expected: false },
    ];
    for (const entry of booleanOps) {
      cases.push({
        label: `${field} ${entry.op}`,
        field,
        leaf: leaf(field, entry.op),
        expected: entry.expected,
      });
    }
  }

  it.each(cases)("$label → $expected", ({ field, leaf: node, expected }) => {
    const target =
      field === "from.isNoReply"
        ? makeRuleEmail({ fromName: null, fromEmail: "no-reply@corp.example" })
        : email;
    // 字段声明的允许操作符必须覆盖矩阵使用的操作符。
    expect(RULE_FIELDS[field].ops).toContain(node.op);
    expect(evaluateFieldLeaf(node, target, context)).toBe(expected);
  });
});

describe("归一化与空值（AC-19）", () => {
  it("NFKC 全角 + ASCII 大小写不敏感", () => {
    expect(evaluateFieldLeaf(leaf("subject", "contains", "q3"), email, context)).toBe(true);
    expect(evaluateFieldLeaf(leaf("subject", "contains", "Ｑ３"), email, context)).toBe(true);
    expect(evaluateFieldLeaf(leaf("from", "equals", "ZHANG@EXAMPLE.COM"), email, context)).toBe(true);
  });

  it("邮箱地址比较前统一小写并去掉显示名", () => {
    expect(parseAddress("张三 <A@B.Com>")).toEqual({
      address: "a@b.com",
      display: "张三",
      domain: "b.com",
    });
    expect(evaluateFieldLeaf(leaf("to", "equals", "LI@CORP.EXAMPLE"), email, context)).toBe(true);
    expect(
      evaluateFieldLeaf(leaf("iAmInTo", "isTrue"), email, {
        userEmails: ["ME@EXAMPLE.COM"],
        timezone: TEST_TIMEZONE,
      }),
    ).toBe(true);
  });

  it("空白压缩对 haystack 与 needle 同时生效（多空格/换行/制表符）", () => {
    const spaced = makeRuleEmail({ subject: "A  B", bodyText: "line one\nline two" });
    expect(evaluateFieldLeaf(leaf("subject", "contains", "a b"), spaced, context)).toBe(true);
    expect(evaluateFieldLeaf(leaf("subject", "equals", "a b"), spaced, context)).toBe(true);
    expect(evaluateFieldLeaf(leaf("subject", "in", ["a b"]), spaced, context)).toBe(true);
    expect(evaluateFieldLeaf(leaf("body", "contains", "line one line two"), spaced, context)).toBe(
      true,
    );

    const tabbed = makeRuleEmail({ subject: "A\tB" });
    expect(evaluateFieldLeaf(leaf("subject", "contains", "a b"), tabbed, context)).toBe(true);
    expect(evaluateFieldLeaf(leaf("subject", "startsWith", "a"), tabbed, context)).toBe(true);
    expect(evaluateFieldLeaf(leaf("subject", "endsWith", "b"), tabbed, context)).toBe(true);
  });

  it("CJK 子串匹配不依赖词边界", () => {
    expect(evaluateFieldLeaf(leaf("body", "contains", "项目 X"), email, context)).toBe(true);
    expect(evaluateFieldLeaf(leaf("body", "contains", "项目X"), email, context)).toBe(false);
  });

  it("字段缺失时所有字段叶子判 false（含否定操作符）", () => {
    const empty = makeRuleEmail({
      subject: "",
      bodyText: "",
      fromName: null,
      headers: {},
      attachments: undefined,
      hasAttachments: undefined,
      isRead: undefined,
      folder: null,
    });
    for (const node of [
      leaf("subject", "equals", "x"),
      leaf("subject", "notEquals", "x"),
      leaf("subject", "notContains", "x"),
      leaf("body", "exists"),
      leaf("listId", "exists"),
      leaf("hasAttachments", "isFalse"),
    ]) {
      expect(evaluateFieldLeaf(node, empty, context), `${node.field} ${node.op}`).toBe(false);
    }
    // 存在性操作符按定义：缺失 → exists false、notExists true。
    expect(evaluateFieldLeaf(leaf("isRead", "notExists"), empty, context)).toBe(true);
  });

  it("NOT(缺失字段条件) 判 true", async () => {
    const empty = makeRuleEmail({ subject: "", bodyText: "" });
    const tree: RuleTree = { kind: "not", child: leaf("subject", "contains", "报告") };
    await expect(evaluateRuleTree(tree, empty, context)).resolves.toBe(true);
  });

  it("多候选字段：否定操作符要求全部不命中", () => {
    expect(evaluateFieldLeaf(leaf("from", "notEquals", "someone@else.com"), email, context)).toBe(true);
    expect(evaluateFieldLeaf(leaf("from", "notEquals", "example.com"), email, context)).toBe(false);
    expect(evaluateFieldLeaf(leaf("to", "contains", "li@corp.example"), email, context)).toBe(true);
  });

  it("附件大小对任一附件成立即真", () => {
    const multi = makeRuleEmail({
      attachments: [
        { filename: "a.txt", mimeType: "text/plain", size: 10 },
        { filename: "b.pdf", mimeType: "application/pdf", size: 5000 },
      ],
    });
    expect(evaluateFieldLeaf(leaf("attachmentSize", "gt", 1000), multi, context)).toBe(true);
    expect(evaluateFieldLeaf(leaf("attachmentSize", "lt", 100), multi, context)).toBe(true);
  });

  it("收件人计数忽略空地址", () => {
    const withEmpty = makeRuleEmail({ to: ["", "A <a@b.com>"], cc: [] });
    expect(evaluateFieldLeaf(leaf("to.count", "gte", 1), withEmpty, context)).toBe(true);
    expect(evaluateFieldLeaf(leaf("recipient.count", "gte", 1), withEmpty, context)).toBe(true);
  });
});

describe("日期按 IANA 时区（AC-19）", () => {
  it("同一瞬间在不同时区落入不同日期（日粒度边界）", () => {
    // 2026-11-09T00:30+08:00 == 2026-11-08T16:30Z
    const shanghai = leaf("date", "before", "2026-11-09");
    expect(evaluateFieldLeaf(shanghai, email, { userEmails: [], timezone: "Asia/Shanghai" })).toBe(false);
    expect(evaluateFieldLeaf(shanghai, email, { userEmails: [], timezone: "UTC" })).toBe(true);
  });

  it("between 的日粒度上界包含当日 23:59:59.999", () => {
    const late = makeRuleEmail({ sentAt: "2026-11-09T23:30:00+08:00" });
    expect(
      evaluateFieldLeaf(
        leaf("date", "between", { from: "2026-11-09", to: "2026-11-09" }),
        late,
        context,
      ),
    ).toBe(true);
  });

  it("which=received 使用接收时间；缺失即字段缺失", () => {
    expect(evaluateFieldLeaf(leaf("date", "before", "2026-11-10", "received"), email, context)).toBe(true);
    expect(
      evaluateFieldLeaf(leaf("date", "before", "2026-11-10", "received"), email, {
        ...context,
        timezone: TEST_TIMEZONE,
      }),
    ).toBe(true);
    const noReceived = makeRuleEmail({ receivedAt: null });
    expect(evaluateFieldLeaf(leaf("date", "exists", undefined, "received"), noReceived, context)).toBe(false);
  });
});

describe("条件树求值", () => {
  it("AND 全真才真，OR 任一真即真，NOT 取反", async () => {
    const andTree: RuleTree = {
      kind: "and",
      children: [leaf("subject", "contains", "报告"), leaf("body", "contains", "项目")],
    };
    const falseAnd: RuleTree = {
      kind: "and",
      children: [leaf("subject", "contains", "报告"), leaf("body", "contains", "不存在")],
    };
    const orTree: RuleTree = {
      kind: "or",
      children: [leaf("body", "contains", "不存在"), leaf("subject", "contains", "报告")],
    };
    const notTree: RuleTree = { kind: "not", child: leaf("subject", "contains", "不存在") };

    await expect(evaluateRuleTree(andTree, email, context)).resolves.toBe(true);
    await expect(evaluateRuleTree(falseAnd, email, context)).resolves.toBe(false);
    await expect(evaluateRuleTree(orTree, email, context)).resolves.toBe(true);
    await expect(evaluateRuleTree(notTree, email, context)).resolves.toBe(true);
  });

  it("括号语义由树结构决定", async () => {
    const truthy = leaf("subject", "contains", "报告");
    const falsy = leaf("subject", "contains", "不存在");
    const a = (x: FieldLeaf): RuleTree => x;
    // (T OR F) AND F = false vs T OR (F AND F) = true
    const left: RuleTree = {
      kind: "and",
      children: [{ kind: "or", children: [a(truthy), a(falsy)] }, a(falsy)],
    };
    const right: RuleTree = {
      kind: "or",
      children: [a(truthy), { kind: "and", children: [a(falsy), a(falsy)] }],
    };
    await expect(evaluateRuleTree(left, email, context)).resolves.toBe(false);
    await expect(evaluateRuleTree(right, email, context)).resolves.toBe(true);
  });

  it("未提供语义解析器时语义叶子判 false", async () => {
    const tree: RuleTree = { kind: "semantic", expr: "正文在催进度" };
    await expect(evaluateRuleTree(tree, email, context)).resolves.toBe(false);
  });
});

describe("整词操作符 wholeWord（AC-25 姓名等价）", () => {
  it("ASCII 词边界：Li 不命中 Lion，命中 ask Li now", () => {
    expect(WORD_OPERATOR).toBeDefined();
    if (!WORD_OPERATOR) return;

    const lion = makeRuleEmail({ bodyText: "Lion is here" });
    expect(evaluateFieldLeaf(leaf("body", WORD_OPERATOR, "Li"), lion, context)).toBe(false);

    const ask = makeRuleEmail({ bodyText: "please ask Li now" });
    expect(evaluateFieldLeaf(leaf("body", WORD_OPERATOR, "Li"), ask, context)).toBe(true);
    expect(evaluateFieldLeaf(leaf("body", WORD_OPERATOR, "li"), ask, context)).toBe(true);
  });

  it("CJK 无词边界：张三命中张三丰，仍是子串", () => {
    expect(WORD_OPERATOR).toBeDefined();
    if (!WORD_OPERATOR) return;

    const zhangsanfeng = makeRuleEmail({ bodyText: "张三丰负责这个项目" });
    expect(evaluateFieldLeaf(leaf("body", WORD_OPERATOR, "张三"), zhangsanfeng, context)).toBe(true);
    // 带空格的姓名先压缩空白再去空白子串：张 三 ⊂ 张三丰。
    expect(evaluateFieldLeaf(leaf("body", WORD_OPERATOR, "张 三"), zhangsanfeng, context)).toBe(
      true,
    );

    const lisi = makeRuleEmail({ bodyText: "李四负责这个项目" });
    expect(evaluateFieldLeaf(leaf("body", WORD_OPERATOR, "张三"), lisi, context)).toBe(false);
  });

  it("字符串字段词表都接受整词操作符", () => {
    expect(WORD_OPERATOR).toBeDefined();
    if (!WORD_OPERATOR) return;
    for (const field of RULE_FIELD_NAMES) {
      if (RULE_FIELDS[field].kind !== "string") continue;
      expect(RULE_FIELDS[field].ops, field).toContain(WORD_OPERATOR);
    }
  });
});

describe("整词边界匹配（AC-25 姓名等价）", () => {
  it("ASCII 要求词边界：Li 不命中 Lion，命中 ask Li now", () => {
    expect(matchesWholeWord("Lion is here", "Li")).toBe(false);
    expect(matchesWholeWord("ask Li now", "Li")).toBe(true);
    expect(matchesWholeWord("LI, please", "li")).toBe(true);
    expect(matchesWholeWord("ZhangSan", "Zhang")).toBe(false);
  });

  it("CJK 没有词边界概念：仍按子串匹配（张三命中张三丰）", () => {
    expect(matchesWholeWord("张三丰负责这个项目", "张三")).toBe(true);
    expect(matchesWholeWord("张 三 负责这个项目", "张三")).toBe(true);
    expect(matchesWholeWord("李四负责这个项目", "张三")).toBe(false);
  });

  it("NFKC / 大小写 / 空白归一", () => {
    expect(matchesWholeWord("ＳＡＮ　ＺＨＡＮＧ 是负责人", "san zhang")).toBe(true);
    expect(matchesWholeWord("San   Zhang 是负责人", "San Zhang")).toBe(true);
  });
});

describe("非法叶子/节点给出类型化错误（不崩溃、不静默 false）", () => {
  const invalidLeaf = (field: string, op: string): FieldLeaf =>
    ({ kind: "field", field, op }) as unknown as FieldLeaf;

  it("未知操作符抛 unknown_operator", () => {
    expect(() => evaluateFieldLeaf(invalidLeaf("subject", "bogus"), email, context)).toThrow(
      RuleEvaluationError,
    );
    try {
      evaluateFieldLeaf(invalidLeaf("subject", "bogus"), email, context);
    } catch (error) {
      expect((error as RuleEvaluationError).code).toBe("unknown_operator");
    }
  });

  it("字段不允许的操作符抛 unsupported_operator", () => {
    try {
      evaluateFieldLeaf(invalidLeaf("subject", "before"), email, context);
      expect.unreachable("应当抛错");
    } catch (error) {
      expect((error as RuleEvaluationError).code).toBe("unsupported_operator");
    }
  });

  it("未知字段抛 unknown_field", () => {
    try {
      evaluateFieldLeaf(invalidLeaf("nope", "exists"), email, context);
      expect.unreachable("应当抛错");
    } catch (error) {
      expect((error as RuleEvaluationError).code).toBe("unknown_field");
    }
  });

  it("未知节点种类抛 unknown_node_kind", async () => {
    const tree = { kind: "mystery" } as unknown as RuleTree;
    await expect(evaluateRuleTree(tree, email, context)).rejects.toMatchObject({
      name: "RuleEvaluationError",
      code: "unknown_node_kind",
    });
  });
});
