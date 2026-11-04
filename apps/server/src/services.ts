import type { ServerEvent } from "@mailcollect/shared";

/**
 * The capabilities the HTTP layer needs but does not implement itself.
 * main.ts wires the real mail / LLM / pipeline implementations in, which keeps
 * this file free of provider-specific imports and makes it unit-testable.
 */
export interface ServerServices {
  verifyAccount(accountId: string): Promise<{ ok: boolean; detail: string }>;
  /**
   * Interactive login (Microsoft Graph device code). Returns immediately; the
   * device code and the outcome arrive as SSE events.
   */
  loginAccount(accountId: string, emit: (event: ServerEvent) => void): Promise<void>;
  syncAccount(
    accountId: string,
    options: { full: boolean },
    emit: (event: ServerEvent) => void,
  ): Promise<void>;
  extract(emit: (event: ServerEvent) => void): Promise<{ done: number; total: number }>;
  testLlm(input: {
    protocol: "openai-compatible" | "anthropic-messages";
    baseUrl: string;
    model: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; latencyMs: number; detail: string }>;
  /** Called once at boot; implementations may start polling or IDLE watchers. */
  startBackground(): void;
  stopBackground(): Promise<void>;
}
