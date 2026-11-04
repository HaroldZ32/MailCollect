import type { LlmConfig, LlmProtocol } from "@mailcollect/shared";
import type { ZodType } from "zod";

export type LlmErrorCode =
  | "auth"
  | "rate_limited"
  | "timeout"
  | "network"
  | "blank_response"
  | "bad_response"
  | "schema_violation";

export class LlmError extends Error {
  override readonly name = "LlmError";
  constructor(
    readonly code: LlmErrorCode,
    message: string,
    readonly retryable: boolean = false,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}

export interface StructuredRequest {
  system: string;
  user: string;
  /** Extra repair attempts after the first validation failure. Default 2. */
  maxRepairs?: number;
  signal?: AbortSignal;
}

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface LlmResult<T> {
  value: T;
  /** The raw text the model produced (last attempt). Kept for debugging. */
  raw: string;
  usage: LlmUsage | null;
  repaired: boolean;
  latencyMs: number;
}

/**
 * The single seam every LLM call goes through. FROZEN CONTRACT.
 *
 * Implementations must:
 *  - validate with the provided Zod schema (never trust the model),
 *  - treat an EMPTY body as `blank_response` (DeepSeek json mode quirk),
 *  - retry at most `maxRepairs` times with REPAIR_INSTRUCTION appended,
 *  - throw LlmError, never return a partially valid object.
 */
export interface LlmPort {
  readonly config: LlmConfig;
  structured<T>(schema: ZodType<T>, req: StructuredRequest): Promise<LlmResult<T>>;
  ping(): Promise<{ ok: boolean; latencyMs: number; detail: string }>;
}

export type LlmPortFactory = (config: LlmConfig, apiKey: string | null) => LlmPort;

/** Protocol → default base URL, used by the settings UI for quick fill. */
export const DEFAULT_BASE_URLS: Record<LlmProtocol, string> = {
  "openai-compatible": "https://api.deepseek.com/v1",
  "anthropic-messages": "https://api.anthropic.com/v1",
};

export const PROVIDER_PRESETS: ReadonlyArray<{
  id: string;
  label: string;
  protocol: LlmProtocol;
  baseUrl: string;
  models: string[];
}> = [
  {
    id: "deepseek",
    label: "DeepSeek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "moonshot",
    label: "Kimi / Moonshot",
    protocol: "openai-compatible",
    baseUrl: "https://api.moonshot.cn/v1",
    models: ["kimi-k2-turbo-preview", "moonshot-v1-32k"],
  },
  {
    id: "dashscope",
    label: "通义千问 / DashScope",
    protocol: "openai-compatible",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-plus", "qwen-max"],
  },
  {
    id: "openai",
    label: "OpenAI",
    protocol: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-5-mini", "gpt-5"],
  },
  {
    id: "anthropic-compat",
    label: "Claude（OpenAI 兼容层）",
    protocol: "openai-compatible",
    baseUrl: "https://api.anthropic.com/v1",
    models: ["claude-sonnet-4-5", "claude-haiku-4-5"],
  },
  {
    id: "ollama",
    label: "本地 Ollama",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    models: ["qwen3:8b", "llama3.1:8b"],
  },
  {
    id: "gateway",
    label: "自定义网关（one-api / LiteLLM）",
    protocol: "openai-compatible",
    baseUrl: "http://127.0.0.1:3000/v1",
    models: [],
  },
];
