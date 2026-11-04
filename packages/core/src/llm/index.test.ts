import { describe, expect, it } from "vitest";
import { createLlmPort } from "./index.js";
import { LlmError } from "./port.js";
import { makeLlmConfig } from "../pipeline/__test-helpers__/fixtures.js";

describe("createLlmPort 工厂（冻结签名）", () => {
  it("openai-compatible 返回端口并保留配置", () => {
    const config = makeLlmConfig();
    const port = createLlmPort(config, "sk-test");
    expect(port.config).toBe(config);
    expect(typeof port.structured).toBe("function");
    expect(typeof port.ping).toBe("function");
  });

  it("anthropic-messages 显式报错，不静默走错协议", () => {
    expect(() =>
      createLlmPort(makeLlmConfig({ protocol: "anthropic-messages" }), null),
    ).toThrow(LlmError);
  });
});
