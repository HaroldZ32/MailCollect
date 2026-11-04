import { describe, expect, it } from "vitest";
import type { LlmConfig, RawEmail, UserProfile } from "@mailcollect/shared";
import type { LlmPort } from "../llm/port.js";
import { processEmail, processEmails } from "./extract.js";

const config: LlmConfig = {
  id: "test",
  label: "test",
  protocol: "openai-compatible",
  baseUrl: "http://127.0.0.1:1/v1",
  model: "test-model",
  apiKeyRef: null,
  temperature: 0,
  maxTokens: 256,
  timeoutMs: 1000,
  isDefault: true,
};

const profile: UserProfile = {
  id: "u1",
  displayName: "张三",
  aliases: ["San Zhang"],
  emails: ["me@corp.com"],
  timezone: "Asia/Shanghai",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

/** Fake port: always answers with "no tasks", so only the verdict path matters. */
const fakeLlm = (): LlmPort => ({
  config,
  structured: async (schema) => {
    const payload = { items: [], noTasks: true };
    return {
      value: schema.parse(payload),
      raw: JSON.stringify(payload),
      usage: null,
      repaired: false,
      latencyMs: 1,
    };
  },
  ping: async () => ({ ok: true, latencyMs: 1, detail: "ok" }),
});

const email = (id: string, uid: string, body: string, subject: string): RawEmail => ({
  id,
  accountId: "acc1",
  uid,
  messageId: `<${id}@corp.com>`,
  threadId: null,
  fromName: "李雷",
  fromEmail: "lilei@corp.com",
  to: ["me@corp.com"],
  cc: [],
  subject,
  sentAt: "2026-11-02T09:00:00+08:00",
  bodyText: body,
  hasAttachments: false,
  headers: {},
  createdAt: "2026-11-02T09:00:01+08:00",
});

const BODY = "各位同事，明天上午十点在三楼会议室开季度沟通会，请准时参加，谢谢。";

describe("processEmails — batch entry", () => {
  it("fires the body-hash broadcast signal that the single-email path cannot see", async () => {
    const emails = [
      email("e1", "1", BODY, "季度沟通会通知"),
      email("e2", "2", BODY, "季度沟通会通知（转发）"),
    ];

    const batch = await processEmails({ llm: fakeLlm(), profile }, emails);
    for (const item of emails) {
      const verdict = batch.verdicts.get(item.id);
      expect(verdict?.kind, `${item.id} 应判为群发`).toBe("broadcast");
      expect(verdict?.signals).toContain("body-hash");
    }

    // Same message through the single-email path: no sibling in view, no signal.
    const single = await processEmail({ llm: fakeLlm(), profile }, emails[0]!);
    expect(single.verdict.signals).not.toContain("body-hash");
  });

  it("does not fire body-hash for different bodies on the same day", async () => {
    const emails = [
      email("e1", "1", BODY, "季度沟通会通知"),
      email("e2", "2", "张三，请把上周的报销单在今天下班前发我，谢谢。", "报销单"),
    ];
    const batch = await processEmails({ llm: fakeLlm(), profile }, emails);
    expect(batch.verdicts.get("e1")?.signals ?? []).not.toContain("body-hash");
    expect(batch.verdicts.get("e2")?.signals ?? []).not.toContain("body-hash");
  });

  it("returns one verdict per email and marks nothing as skipped for usable bodies", async () => {
    const emails = [
      email("e1", "1", BODY, "A"),
      email("e2", "2", "另一封完全不同的正文，讲的是别的事情，也一样长一些以便通过清洗。", "B"),
      email("e3", "3", "第三封正文，内容同样不同，用于确认批量入口覆盖整批邮件。", "C"),
    ];
    const batch = await processEmails({ llm: fakeLlm(), profile }, emails);
    expect(batch.verdicts.size).toBe(3);
    expect(batch.skipped).toHaveLength(0);
    expect(Array.isArray(batch.tasks)).toBe(true);
  });
});
