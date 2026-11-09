import type {
  Category,
  LlmConfig,
  Rule,
  RuleTree,
} from "@mailcollect/shared";
import type { ZodType } from "zod";
import type { LlmPort, StructuredRequest } from "../../llm/port.js";
import type { RuleEmail } from "../evaluate.js";

export const TEST_TIMEZONE = "Asia/Shanghai";

export function makeLlmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id: "llm-fake",
    label: "fake",
    protocol: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    model: "fake-model",
    apiKeyRef: null,
    temperature: 0,
    maxTokens: 512,
    timeoutMs: 1000,
    isDefault: true,
    ...overrides,
  };
}

export interface FakeLlm {
  readonly port: LlmPort;
  readonly calls: StructuredRequest[];
}

/** 假 LlmPort：记录每次请求，按 handler 返回 `{ match }`。 */
export function makeLlm(
  handler: (request: StructuredRequest) => boolean | Promise<boolean>,
  config: Partial<LlmConfig> = {},
): FakeLlm {
  const calls: StructuredRequest[] = [];
  const resolvedConfig = makeLlmConfig(config);
  const port: LlmPort = {
    config: resolvedConfig,
    async structured<T>(schema: ZodType<T>, request: StructuredRequest) {
      calls.push(request);
      const match = await handler(request);
      const raw = JSON.stringify({ match });
      const value = schema.parse({ match });
      return { value, raw, usage: null, repaired: false, latencyMs: 1 };
    },
    async ping() {
      return { ok: true, latencyMs: 1, detail: "fake" };
    },
  };
  return { port, calls };
}

export function makeRuleEmail(overrides: Partial<RuleEmail> = {}): RuleEmail {
  return {
    id: "email-1",
    accountId: "account-1",
    fromName: "张三",
    fromEmail: "Zhang@Example.com",
    to: ["李四 <li@corp.example>", "me@example.com"],
    cc: ["c1@x.com", "c2@x.com", "c3@x.com"],
    subject: "【重要】周五前提交 Ｑ３ 报告",
    bodyText: "张三，请在周五下班前提交 Q3 报告，提到项目 X。",
    sentAt: "2026-11-09T00:30:00+08:00",
    receivedAt: "2026-11-09T08:00:00+08:00",
    headers: {
      "List-Id": "<announce.example.com>",
      Precedence: "bulk",
      "Auto-Submitted": "auto-generated",
    },
    hasAttachments: true,
    attachments: [{ filename: "Ｒｅｐｏｒｔ.PDF", mimeType: "application/pdf", size: 2048 }],
    isRead: false,
    folder: "收件箱",
    account: "工作邮箱",
    ...overrides,
  };
}

export function makeCategory(
  id: string,
  name: string,
  enterTodo: boolean,
  broadcast: boolean,
): Category {
  return { id, name, enterTodo, broadcast };
}

export function makeRule(
  id: string,
  categoryId: string,
  tree: RuleTree,
  overrides: Partial<Omit<Rule, "id" | "categoryId" | "tree">> = {},
): Rule {
  return {
    id,
    name: overrides.name ?? id,
    categoryId,
    tree,
    enabled: overrides.enabled ?? true,
    order: overrides.order ?? 0,
  };
}

export const FIELD = (field: string, op: string, value?: unknown, which?: "sent" | "received"): RuleTree =>
  ({
    kind: "field",
    field,
    op,
    ...(value === undefined ? {} : { value }),
    ...(which === undefined ? {} : { which }),
  }) as RuleTree;
