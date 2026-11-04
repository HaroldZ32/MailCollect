import type { LlmConfig } from "@mailcollect/shared";
import { LlmError, type LlmPort } from "./port.js";
import { createOpenAiCompatiblePort } from "./openai-compatible.js";

export * from "./port.js";
export {
  createOpenAiCompatiblePort,
  type OpenAiCompatibleOptions,
} from "./openai-compatible.js";

/**
 * 唯一的供应商工厂（冻结签名）。
 *
 * `anthropic-messages` 暂时没有原生适配器：需求要求接的是 Claude 官方的
 * OpenAI 兼容层，走 `openai-compatible` 即可。这里显式报错而不是静默回退，
 * 免得用户在设置里选了原生协议却拿到一条走错协议的请求。
 */
export function createLlmPort(config: LlmConfig, apiKey: string | null): LlmPort {
  switch (config.protocol) {
    case "openai-compatible":
      return createOpenAiCompatiblePort(config, apiKey);
    case "anthropic-messages":
      throw new LlmError(
        "bad_response",
        "anthropic-messages 原生协议尚未实现；请选择「Claude（OpenAI 兼容层）」并把 baseURL 指向兼容端点",
        false,
      );
    default: {
      const exhaustive: never = config.protocol;
      throw new LlmError("bad_response", `未知的 LLM 协议：${String(exhaustive)}`, false);
    }
  }
}
