import { describe, expect, it, vi } from "vitest";
import type { DeviceCodeNotice, GraphAuth } from "./graph.js";
import { createMailSource } from "./index.js";

/**
 * Regression guard for the shadowing bug the verifier found:
 * `GraphMailSource.login()` always hands its own wrapper to the auth layer, so a
 * callback supplied only to `createMailSource(account, { onDeviceCode })` never
 * fires. The server therefore MUST pass the callback to `login()` itself — this
 * test pins the only path that actually works.
 */

const account = {
  id: "acc-graph",
  provider: "graph" as const,
  email: "me@outlook.com",
  config: { clientId: "fake-client", tenant: "common", cachePath: "/tmp/none.json" },
  secret: "",
};

const notice: DeviceCodeNotice = {
  userCode: "ABCD-EFGH",
  verificationUri: "https://microsoft.com/devicelogin",
  message: "输入验证码",
  expiresInSeconds: 900,
};

const fakeAuth = (): GraphAuth =>
  ({
    getAccessToken: async () => "token",
    lastDeviceCodeNotice: null,
    login: async (onDeviceCode?: (n: DeviceCodeNotice) => void) => {
      onDeviceCode?.(notice);
      return { ok: true, detail: "ok" };
    },
  }) as unknown as GraphAuth;

describe("graph login callback plumbing", () => {
  it("forwards the callback passed to login(), which is the only channel that fires", async () => {
    const source = createMailSource(account, { auth: fakeAuth() });
    expect(typeof source.login).toBe("function");

    const seen = vi.fn();
    // verify() may fail without a live Graph endpoint; the callback assertion
    // does not depend on the final result.
    await source.login?.(seen).catch(() => undefined);

    expect(seen).toHaveBeenCalledTimes(1);
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ userCode: "ABCD-EFGH" }));
  });

  it("exposes no login() for mailbox adapters that cannot do it", () => {
    const imap = createMailSource({
      id: "acc-imap",
      provider: "imap",
      email: "me@corp.com",
      config: { host: "imap.corp.com" },
      secret: "pw",
    });
    expect(imap.login).toBeUndefined();
  });
});
