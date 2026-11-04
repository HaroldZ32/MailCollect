import { describe, expect, it, vi } from "vitest";
import type { DeviceCodeNotice } from "@mailcollect/core/mail";
import type { ServerEvent } from "@mailcollect/shared";
import { runDeviceLogin, type LoginCapableSource } from "./login-flow.js";

const notice: DeviceCodeNotice = {
  userCode: "ABCD-EFGH",
  verificationUri: "https://microsoft.com/devicelogin",
  message: "输入验证码",
  expiresInSeconds: 900,
};

const collector = (): { events: ServerEvent[]; emit: (e: ServerEvent) => void } => {
  const events: ServerEvent[] = [];
  return { events, emit: (e) => events.push(e) };
};

describe("runDeviceLogin", () => {
  it("passes the callback into login() and forwards a real code to SSE", async () => {
    let captured: ((notice: DeviceCodeNotice) => void) | null = null;
    const source: LoginCapableSource = {
      login: async (cb) => {
        captured = cb ?? null;
        cb?.(notice);
        return { ok: true, detail: "已连接" };
      },
      close: vi.fn(async () => undefined),
    };

    const { events, emit } = collector();
    await runDeviceLogin(source, "acc1", emit);

    // This is the assertion the old test lacked: the callback must reach login().
    expect(captured).not.toBeNull();
    expect(events[0]).toMatchObject({
      type: "device-code",
      data: { accountId: "acc1", userCode: "ABCD-EFGH", verificationUri: notice.verificationUri },
    });
    expect(events[1]).toMatchObject({ type: "device-login", data: { accountId: "acc1", ok: true } });
    expect(source.close).toHaveBeenCalledTimes(1);
  });

  it("drops a notice that carries no code (MSAL can fire before issuing one)", async () => {
    const source: LoginCapableSource = {
      login: async (cb) => {
        cb?.(undefined as unknown as DeviceCodeNotice);
        cb?.({ ...notice, userCode: "" });
        return { ok: false, detail: "invalid_grant" };
      },
      close: async () => undefined,
    };

    const { events, emit } = collector();
    await runDeviceLogin(source, "acc1", emit);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "device-login",
      data: { accountId: "acc1", ok: false, detail: "invalid_grant" },
    });
  });

  it("reports a clear failure for adapters without interactive login", async () => {
    const close = vi.fn(async () => undefined);
    const source: LoginCapableSource = { close };
    const { events, emit } = collector();
    await runDeviceLogin(source, "acc1", emit);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "device-login", data: { ok: false } });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("always closes the source, even when login throws", async () => {
    const close = vi.fn(async () => undefined);
    const source: LoginCapableSource = {
      login: async () => {
        throw new Error("boom");
      },
      close,
    };
    await expect(runDeviceLogin(source, "acc1", () => undefined)).rejects.toThrow("boom");
    expect(close).toHaveBeenCalledTimes(1);
  });
});
