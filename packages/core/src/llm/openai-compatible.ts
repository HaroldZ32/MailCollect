import { createOpenAI } from "@ai-sdk/openai";
import { APICallError, generateText } from "ai";
import type { LlmConfig } from "@mailcollect/shared";
import { REPAIR_INSTRUCTION } from "@mailcollect/shared";
import type { ZodType } from "zod";
import {
  LlmError,
  type LlmPort,
  type LlmResult,
  type LlmUsage,
  type StructuredRequest,
} from "./port.js";

/**
 * 测试注入点：默认使用全局 fetch；单测用它伪造 OpenAI 兼容响应，
 * 从而覆盖真实的 SDK 请求/解析路径而不发网络请求、不花钱。
 */
export interface OpenAiCompatibleOptions {
  fetch?: typeof globalThis.fetch;
  /** 额外请求头（one-api / LiteLLM 网关常要求自定义鉴权头）。 */
  headers?: Record<string, string>;
}

/** 契约默认的修复重试次数（首次失败后最多再修 2 次）。 */
const DEFAULT_MAX_REPAIRS = 2;
/** 塞回给模型的坏输出上限，避免把上下文撑爆。 */
const REPAIR_ECHO_LIMIT = 1500;

/**
 * OpenAI 兼容适配器。
 *
 * 为什么走 chat completions 而不是 responses / json_schema：
 * DeepSeek、Kimi、通义、Claude 官方兼容层、Ollama、one-api、LiteLLM
 * 都实现了 `/chat/completions`，几乎没有人实现 OpenAI 的 `/responses`
 * 或 strict json_schema。结构化约束因此由本层用 Zod 校验完成，
 * 模型只被要求「输出 JSON」。
 */
export function createOpenAiCompatiblePort(
  config: LlmConfig,
  apiKey: string | null,
  options: OpenAiCompatibleOptions = {},
): LlmPort {
  if (!config.baseUrl.trim()) {
    throw new LlmError("bad_response", "LLM baseUrl 未配置", false);
  }
  if (!config.model.trim()) {
    throw new LlmError("bad_response", "LLM model 未配置", false);
  }

  const provider = createOpenAI({
    baseURL: config.baseUrl.replace(/\/+$/, ""),
    // Ollama / 本地网关不校验 key，但 SDK 要求非空字符串。
    apiKey: apiKey ?? "not-needed",
    ...(options.headers ? { headers: options.headers } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  const model = provider.chat(config.model);
  const timeoutMs = config.timeoutMs > 0 ? config.timeoutMs : 60_000;

  async function callModel(
    system: string,
    prompt: string,
    callerSignal: AbortSignal | undefined,
  ): Promise<{ text: string; usage: LlmUsage | null }> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
    const result = await generateText({
      model,
      system,
      prompt,
      temperature: config.temperature,
      ...(config.maxTokens > 0 ? { maxOutputTokens: config.maxTokens } : {}),
      // 传输层重试交给调用方，本端口只做「修复重试」，行为可预测。
      maxRetries: 0,
      abortSignal: signal,
    });
    return {
      text: result.text,
      usage: {
        promptTokens: result.usage.inputTokens ?? 0,
        completionTokens: result.usage.outputTokens ?? 0,
      },
    };
  }

  return {
    config,

    async structured<T>(schema: ZodType<T>, req: StructuredRequest): Promise<LlmResult<T>> {
      const maxRepairs = Math.max(0, req.maxRepairs ?? DEFAULT_MAX_REPAIRS);
      const startedAt = Date.now();
      const attempts = maxRepairs + 1;
      let prompt = req.user;
      let usage: LlmUsage | null = null;
      let raw = "";
      let lastError: LlmError | null = null;

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (req.signal?.aborted) {
          throw new LlmError("timeout", "调用方已取消", false);
        }

        let text: string;
        try {
          const call = await callModel(req.system, prompt, req.signal);
          text = call.text;
          usage = addUsage(usage, call.usage);
        } catch (error) {
          // 传输层错误不做修复重试：同一请求重发没有修复价值。
          throw toLlmError(error, req.signal, timeoutMs);
        }
        raw = text;

        if (text.trim() === "") {
          // DeepSeek json 模式会返回空白且 finish_reason=stop。
          // 绝不当成 noTasks —— 那是「模型说没有待办」，这是「什么都没说」。
          lastError = new LlmError(
            "blank_response",
            `模型返回空白响应（第 ${attempt + 1}/${attempts} 次尝试）`,
            true,
          );
        } else {
          const parsed = parseWithSchema(schema, text);
          if (parsed.ok) {
            return {
              value: parsed.value,
              raw,
              usage,
              repaired: attempt > 0,
              latencyMs: Date.now() - startedAt,
            };
          }
          lastError = new LlmError("schema_violation", parsed.message, true);
        }

        if (attempt < attempts - 1) {
          prompt = buildRepairPrompt(req.user, text, lastError);
        }
      }

      throw lastError ?? new LlmError("bad_response", "结构化调用失败（无具体错误）", false);
    },

    async ping(): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
      const startedAt = Date.now();
      try {
        const result = await generateText({
          model,
          prompt: "只回复 OK",
          maxOutputTokens: 8,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(Math.min(timeoutMs, 15_000)),
        });
        return {
          ok: true,
          latencyMs: Date.now() - startedAt,
          detail: `模型 ${config.model} 响应：${result.text.slice(0, 60) || "(空)"}`,
        };
      } catch (error) {
        const mapped = toLlmError(error, undefined, timeoutMs);
        return {
          ok: false,
          latencyMs: Date.now() - startedAt,
          detail: `[${mapped.code}] ${mapped.message}`,
        };
      }
    },
  };
}

function addUsage(total: LlmUsage | null, next: LlmUsage): LlmUsage {
  if (!total) return next;
  return {
    promptTokens: total.promptTokens + next.promptTokens,
    completionTokens: total.completionTokens + next.completionTokens,
  };
}

function buildRepairPrompt(user: string, badOutput: string, error: LlmError): string {
  const echo = badOutput.trim() === "" ? "(空响应)" : truncate(badOutput, REPAIR_ECHO_LIMIT);
  return [
    user,
    "",
    REPAIR_INSTRUCTION,
    `失败原因：${error.code} ${error.message}`,
    "上一次输出：",
    echo,
  ].join("\n");
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…(已截断)`;
}

type ParseOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

/** 从模型文本里取 JSON 并交给调用方提供的 Zod schema —— 绝不信任模型输出。 */
function parseWithSchema<T>(schema: ZodType<T>, text: string): ParseOutcome<T> {
  const json = extractJson(text);
  if (!json.ok) return { ok: false, message: json.message };
  const checked = schema.safeParse(json.value);
  if (!checked.success) {
    const issues = checked.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return { ok: false, message: `输出不符合 schema（${issues}）` };
  }
  return { ok: true, value: checked.data };
}

function extractJson(text: string): { ok: true; value: unknown } | { ok: false; message: string } {
  let body = text.trim();
  // 有些模型仍然包 markdown 代码块，先剥掉。
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(body);
  if (fenced?.[1]) body = fenced[1].trim();

  try {
    return { ok: true, value: JSON.parse(body) };
  } catch {
    // 再容错一次：取第一个 { 到最后一个 } 之间的片段。
    const first = body.indexOf("{");
    const last = body.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return { ok: true, value: JSON.parse(body.slice(first, last + 1)) };
      } catch {
        /* 落到下面的错误 */
      }
    }
    return { ok: false, message: "响应不是合法 JSON" };
  }
}

function toLlmError(error: unknown, callerSignal: AbortSignal | undefined, timeoutMs: number): LlmError {
  if (error instanceof LlmError) return error;

  if (APICallError.isInstance(error)) {
    const status = error.statusCode ?? 0;
    const detail = truncate(error.responseBody?.trim() || error.message, 300);
    if (status === 401 || status === 403) {
      return new LlmError("auth", `鉴权失败（HTTP ${status}）：${detail}`, false, error);
    }
    if (status === 429) {
      return new LlmError("rate_limited", "触发限流（HTTP 429）", true, error);
    }
    if (status === 408 || status === 504) {
      return new LlmError("timeout", `网关超时（HTTP ${status}）`, true, error);
    }
    if (status >= 500) {
      return new LlmError("network", `上游错误（HTTP ${status}）：${detail}`, true, error);
    }
    return new LlmError("bad_response", `请求被拒绝（HTTP ${status}）：${detail}`, false, error);
  }

  if (isAbortLike(error)) {
    if (callerSignal?.aborted) {
      return new LlmError("timeout", "调用方已取消", false, error);
    }
    return new LlmError("timeout", `请求超时（${timeoutMs}ms）`, true, error);
  }

  if (error instanceof TypeError) {
    return new LlmError("network", `网络请求失败：${truncate(error.message, 200)}`, true, error);
  }

  const message = error instanceof Error ? error.message : String(error);
  return new LlmError("bad_response", truncate(message, 300), false, error);
}

function isAbortLike(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error.name === "TimeoutError";
}
