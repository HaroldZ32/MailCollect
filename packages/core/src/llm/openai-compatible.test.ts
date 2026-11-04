import { describe, expect, it } from "vitest";
import { z } from "zod";
import { REPAIR_INSTRUCTION } from "@mailcollect/shared";
import { createOpenAiCompatiblePort } from "./openai-compatible.js";
import { LlmError } from "./port.js";
import { makeLlmConfig } from "../pipeline/__test-helpers__/fixtures.js";

const schema = z.object({
  items: z.array(z.object({ title: z.string() })),
  noTasks: z.boolean().default(false),
});

interface RecordedCall {
  url: string;
  body: { model: string; messages: Array<{ role: string; content: string }>; max_tokens?: number };
}

/** 伪造 OpenAI 兼容端点：覆盖真实 SDK 的请求/解析路径，不触网。 */
function fakeEndpoint(respond: (call: RecordedCall, callIndex: number) => Response): {
  fetchImpl: typeof globalThis.fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as RecordedCall["body"];
    const call: RecordedCall = { url: String(input), body };
    calls.push(call);
    return respond(call, calls.length - 1);
  }) as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

function chatCompletion(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-test",
      created: 1_760_000_000,
      model: "mock-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function apiError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "invalid_request_error" } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const okJson = JSON.stringify({ items: [{ title: "提交 Q3 报告" }], noTasks: false });

describe("createOpenAiCompatiblePort", () => {
  it("把合法 JSON 交给传入的 Zod schema 校验并返回结构化结果", async () => {
    const { fetchImpl, calls } = fakeEndpoint(() => chatCompletion(okJson));
    const port = createOpenAiCompatiblePort(makeLlmConfig(), "sk-test", { fetch: fetchImpl });

    const result = await port.structured(schema, { system: "系统", user: "用户" });

    expect(result.value.items[0]?.title).toBe("提交 Q3 报告");
    expect(result.repaired).toBe(false);
    expect(result.raw).toBe(okJson);
    expect(result.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(calls[0]?.body.model).toBe("mock-model");
  });

  it("空字符串响应必须抛 blank_response，绝不返回 noTasks", async () => {
    const { fetchImpl, calls } = fakeEndpoint(() => chatCompletion(""));
    const port = createOpenAiCompatiblePort(makeLlmConfig(), "sk-test", { fetch: fetchImpl });

    const failure = port.structured(schema, { system: "系统", user: "用户" });
    await expect(failure).rejects.toBeInstanceOf(LlmError);
    await expect(failure).rejects.toMatchObject({ code: "blank_response", retryable: true });
    // 默认 maxRepairs=2 → 首次 + 2 次修复
    expect(calls).toHaveLength(3);
  });

  it("纯空白响应同样按 blank_response 处理（DeepSeek json 模式的坑）", async () => {
    const { fetchImpl } = fakeEndpoint(() => chatCompletion("  \n\t "));
    const port = createOpenAiCompatiblePort(makeLlmConfig(), "sk-test", { fetch: fetchImpl });
    await expect(port.structured(schema, { system: "系统", user: "用户" })).rejects.toMatchObject({
      code: "blank_response",
    });
  });

  it("空白后重试成功时标记 repaired 并追加 REPAIR_INSTRUCTION", async () => {
    const { fetchImpl, calls } = fakeEndpoint((_call, index) =>
      chatCompletion(index === 0 ? "" : okJson),
    );
    const port = createOpenAiCompatiblePort(makeLlmConfig(), "sk-test", { fetch: fetchImpl });

    const result = await port.structured(schema, { system: "系统", user: "原始用户提示" });

    expect(result.repaired).toBe(true);
    expect(calls).toHaveLength(2);
    const secondPrompt = calls[1]?.body.messages.map((message) => message.content).join("\n") ?? "";
    expect(secondPrompt).toContain(REPAIR_INSTRUCTION);
    expect(secondPrompt).toContain("原始用户提示");
  });

  it("schema 不合法时修复重试，第二次合法则成功", async () => {
    const { fetchImpl, calls } = fakeEndpoint((_call, index) =>
      chatCompletion(index === 0 ? JSON.stringify({ items: [{ title: 42 }] }) : okJson),
    );
    const port = createOpenAiCompatiblePort(makeLlmConfig(), "sk-test", { fetch: fetchImpl });

    const result = await port.structured(schema, { system: "系统", user: "用户" });

    expect(result.repaired).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.messages.at(-1)?.content).toContain(REPAIR_INSTRUCTION);
  });

  it("重试耗尽后抛 schema_violation（maxRepairs 默认 2）", async () => {
    const { fetchImpl, calls } = fakeEndpoint(() => chatCompletion("not json at all"));
    const port = createOpenAiCompatiblePort(makeLlmConfig(), "sk-test", { fetch: fetchImpl });

    await expect(port.structured(schema, { system: "系统", user: "用户" })).rejects.toMatchObject({
      code: "schema_violation",
      retryable: true,
    });
    expect(calls).toHaveLength(3);
  });

  it("maxRepairs=0 时只尝试一次", async () => {
    const { fetchImpl, calls } = fakeEndpoint(() => chatCompletion(""));
    const port = createOpenAiCompatiblePort(makeLlmConfig(), "sk-test", { fetch: fetchImpl });
    await expect(
      port.structured(schema, { system: "系统", user: "用户", maxRepairs: 0 }),
    ).rejects.toMatchObject({ code: "blank_response" });
    expect(calls).toHaveLength(1);
  });

  it("能剥掉 markdown 代码块后解析", async () => {
    const { fetchImpl } = fakeEndpoint(() =>
      chatCompletion("```json\n" + okJson + "\n```"),
    );
    const port = createOpenAiCompatiblePort(makeLlmConfig(), "sk-test", { fetch: fetchImpl });
    const result = await port.structured(schema, { system: "系统", user: "用户" });
    expect(result.value.items[0]?.title).toBe("提交 Q3 报告");
  });

  it("把 401 映射成 auth（不可重试）", async () => {
    const { fetchImpl } = fakeEndpoint(() => apiError(401, "invalid api key"));
    const port = createOpenAiCompatiblePort(makeLlmConfig(), "sk-test", { fetch: fetchImpl });
    await expect(port.structured(schema, { system: "系统", user: "用户" })).rejects.toMatchObject({
      code: "auth",
      retryable: false,
    });
  });

  it("把 429 映射成 rate_limited（可重试）", async () => {
    const { fetchImpl } = fakeEndpoint(() => apiError(429, "rate limited"));
    const port = createOpenAiCompatiblePort(makeLlmConfig(), "sk-test", { fetch: fetchImpl });
    await expect(port.structured(schema, { system: "系统", user: "用户" })).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
  });

  it("ping 成功时返回 ok 与延迟", async () => {
    const { fetchImpl } = fakeEndpoint(() => chatCompletion("OK"));
    const port = createOpenAiCompatiblePort(makeLlmConfig(), "sk-test", { fetch: fetchImpl });
    const result = await port.ping();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("mock-model");
  });

  it("缺少 baseUrl 时构造即失败", () => {
    expect(() => createOpenAiCompatiblePort(makeLlmConfig({ baseUrl: "" }), null)).toThrow(LlmError);
  });
});
