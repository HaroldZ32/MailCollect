import type { LlmConfig, RawEmail, UserProfile } from "@mailcollect/shared";
import type { ZodType } from "zod";
import type { LlmPort, LlmResult, StructuredRequest } from "../../llm/port.js";

/** 统一的测试用户：两个邮箱、两个姓名变体、上海时区。 */
export const TEST_PROFILE: UserProfile = {
  id: "user-zhangsan",
  displayName: "张三",
  aliases: ["张 三", "San Zhang"],
  emails: ["zhangsan@example.com", "zs@corp.cn"],
  timezone: "Asia/Shanghai",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

export function makeProfile(overrides: Partial<UserProfile> = {}): UserProfile {
  return { ...TEST_PROFILE, ...overrides };
}

export function makeEmail(overrides: Partial<RawEmail> = {}): RawEmail {
  return {
    id: "mail-1",
    accountId: "account-1",
    uid: "uid-1",
    messageId: "<mail-1@example.com>",
    threadId: "thread-1",
    fromName: "李四",
    fromEmail: "lisi@example.com",
    to: ["zhangsan@example.com"],
    cc: [],
    subject: "Q3 报告",
    sentAt: "2026-11-04T09:00:00+08:00",
    bodyText: "张三，请周五下班前把 Q3 报告发给我。\n\n谢谢\n-- \n李四",
    hasAttachments: false,
    headers: {},
    createdAt: "2026-11-04T09:00:00+08:00",
    ...overrides,
  };
}

export function makeLlmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    id: "llm-mock",
    label: "mock",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:9/v1",
    model: "mock-model",
    apiKeyRef: null,
    temperature: 0,
    maxTokens: 1024,
    timeoutMs: 5_000,
    isDefault: true,
    ...overrides,
  };
}

/** 一条合法的抽取项（tests 只覆盖它关心的字段）。 */
export function extractionItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "处理邮件里的待办",
    owner: "me",
    kind: "action",
    evidenceQuote: "请处理",
    confidence: 0.8,
    ...overrides,
  };
}

export function extractionJson(
  items: Array<Record<string, unknown>>,
  noTasks = false,
): string {
  return JSON.stringify({ items, noTasks });
}

type Script = string[] | ((request: StructuredRequest, callIndex: number) => string);

/**
 * 按脚本返回预置 JSON 的 LlmPort；记录每次请求，供断言 prompt 内容。
 * 用真实 schema 校验脚本数据，避免测试夹具本身不合契约。
 */
export class ScriptedLlm implements LlmPort {
  readonly config: LlmConfig;
  readonly requests: StructuredRequest[] = [];
  private readonly script: Script;

  constructor(script: Script, config: LlmConfig = makeLlmConfig()) {
    this.script = script;
    this.config = config;
  }

  async structured<T>(schema: ZodType<T>, request: StructuredRequest): Promise<LlmResult<T>> {
    const callIndex = this.requests.length;
    this.requests.push(request);
    const raw = typeof this.script === "function"
      ? this.script(request, callIndex)
      : this.script[callIndex] ?? this.script[this.script.length - 1] ?? "{}";
    const value = schema.parse(JSON.parse(raw));
    return {
      value,
      raw,
      usage: { promptTokens: 10, completionTokens: 5 },
      repaired: false,
      latencyMs: 1,
    };
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
    return { ok: true, latencyMs: 1, detail: "scripted" };
  }
}
