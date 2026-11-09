import { describe, expect, it } from "vitest";
import type { RawEmail, RuleTree } from "@mailcollect/shared";
import { evaluateRuleTree, type EvaluationContext } from "./evaluate.js";
import { projectRuleEmail } from "./projection.js";

/**
 * 投影 + 引擎的联合回归（T60）：规则词表承诺的 `date.which="received"` 与
 * `attachmentName` / `attachmentMime` / `attachmentSize` 必须能在真实元数据上命中，
 * 不能是死条件；元数据缺失时仍按 C6「字段缺失 → 叶子 false」。
 */

const email = (over: Partial<RawEmail> = {}): RawEmail => ({
  id: over.id ?? "email-1",
  accountId: "account-1",
  uid: "uid-1",
  messageId: "<m1@corp.example>",
  threadId: null,
  fromName: "李雷",
  fromEmail: "lilei@corp.example",
  to: ["me@corp.example"],
  cc: [],
  subject: "请查收季度报告",
  // 发送时间故意放在窗口外：命中必须来自 receivedAt。
  sentAt: "2026-10-01T01:00:00.000Z",
  bodyText: "附件是季度报告。",
  hasAttachments: over.hasAttachments ?? true,
  headers: {},
  createdAt: "2026-11-03T08:00:01.000Z",
});

const context: EvaluationContext = {
  userEmails: ["me@corp.example"],
  timezone: "Asia/Shanghai",
};

const attachmentRule: RuleTree = {
  kind: "and",
  children: [
    { kind: "field", field: "attachmentName", op: "contains", value: "季度报告" },
    { kind: "field", field: "attachmentMime", op: "equals", value: "application/pdf" },
    { kind: "field", field: "attachmentSize", op: "gte", value: 1024 },
    {
      kind: "field",
      field: "date",
      op: "between",
      which: "received",
      value: { from: "2026-11-03T00:00:00.000Z", to: "2026-11-04T00:00:00.000Z" },
    },
  ],
};

const attachment = { filename: "季度报告.pdf", mimeType: "application/pdf", size: 2048 };

describe("rule projection — received date and attachment metadata (T60)", () => {
  it("hits when attachment metadata and received time are present", async () => {
    const projected = projectRuleEmail(
      email(),
      { folder: "INBOX", isRead: false },
      { receivedAt: "2026-11-03T08:00:00.000Z", attachments: [attachment] },
    );
    await expect(evaluateRuleTree(attachmentRule, projected, context)).resolves.toBe(true);
  });

  it("evaluates date.which=received against receivedAt, not sentAt", async () => {
    // sentAt（10-01）在窗口外、receivedAt（11-03）在窗口内 → 命中只可能来自 received。
    const inside = projectRuleEmail(
      email(),
      { folder: "INBOX", isRead: false },
      { receivedAt: "2026-11-03T08:00:00.000Z", attachments: [attachment] },
    );
    await expect(evaluateRuleTree(attachmentRule, inside, context)).resolves.toBe(true);

    // 反过来：receivedAt 在窗口外、sentAt 在窗口内（改成 11-03）→ 不得命中。
    const outside = projectRuleEmail(
      { ...email(), sentAt: "2026-11-03T08:00:00.000Z" },
      { folder: "INBOX", isRead: false },
      { receivedAt: "2026-10-01T01:00:00.000Z", attachments: [attachment] },
    );
    await expect(evaluateRuleTree(attachmentRule, outside, context)).resolves.toBe(false);
  });

  it("is false when the mail has no attachments (C6 missing-field semantics)", async () => {
    const projected = projectRuleEmail(
      email({ hasAttachments: false }),
      null,
      { receivedAt: "2026-11-03T08:00:00.000Z", attachments: [] },
    );
    await expect(evaluateRuleTree(attachmentRule, projected, context)).resolves.toBe(false);
    // 只要求附件名的叶子同样为 false。
    await expect(
      evaluateRuleTree(
        { kind: "field", field: "attachmentName", op: "exists" },
        projected,
        context,
      ),
    ).resolves.toBe(false);
    // 但 hasAttachments 叶子在无附件时是可判定的 false（有数据，不是缺失）。
    await expect(
      evaluateRuleTree(
        { kind: "field", field: "hasAttachments", op: "isFalse" },
        projected,
        context,
      ),
    ).resolves.toBe(true);
  });

  it("stays false when metadata was never enriched (unknown ≠ empty)", async () => {
    const projected = projectRuleEmail(email({ hasAttachments: false }), null, null);
    await expect(evaluateRuleTree(attachmentRule, projected, context)).resolves.toBe(false);
    await expect(
      evaluateRuleTree(
        { kind: "field", field: "date", op: "exists", which: "received" },
        projected,
        context,
      ),
    ).resolves.toBe(false);
  });
});
