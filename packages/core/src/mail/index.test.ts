import { describe, expect, it } from "vitest";
import type { MailSourceAccount } from "./account.js";
import { GraphMailSource } from "./graph.js";
import { ImapMailSource } from "./imap.js";
import { createMailSource } from "./index.js";
import { Pop3MailSource } from "./pop3.js";
import { makeAccount } from "./test-support.js";
import { MailError } from "./types.js";

describe("createMailSource", () => {
  it("按 provider 选择适配器", () => {
    expect(createMailSource(makeAccount("imap", { host: "imap.example.com" }))).toBeInstanceOf(ImapMailSource);
    expect(createMailSource(makeAccount("pop3", { host: "pop3.example.com" }))).toBeInstanceOf(Pop3MailSource);
    expect(
      createMailSource(
        makeAccount("graph", {
          clientId: "11111111-1111-1111-1111-111111111111",
          cachePath: "/tmp/mailcollect-test-token.json",
        }),
      ),
    ).toBeInstanceOf(GraphMailSource);
  });

  it("未知 provider 抛 not_supported", () => {
    // provider 在类型上是联合类型；运行时来自持久化配置，因此保留显式兜底分支。
    const account: MailSourceAccount = {
      ...makeAccount("imap", { host: "imap.example.com" }),
      provider: "unknown" as MailSourceAccount["provider"],
    };
    expect(() => createMailSource(account)).toThrowError(MailError);
    try {
      createMailSource(account);
    } catch (err) {
      expect(err).toBeInstanceOf(MailError);
      if (err instanceof MailError) expect(err.code).toBe("not_supported");
    }
  });

  it("适配器的 provider 字段与账号一致", () => {
    expect(createMailSource(makeAccount("imap", { host: "imap.example.com" })).provider).toBe("imap");
    expect(createMailSource(makeAccount("pop3", { host: "pop3.example.com" })).provider).toBe("pop3");
  });
});
