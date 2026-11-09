import { describe, expect, it } from "vitest";
import type { MailSourceAccount } from "./account.js";
import { GraphMailSource } from "./graph.js";
import { ImapMailSource } from "./imap.js";
// Graph 的传输层参数类型必须能从包入口导入（T44：消除「类型只在实现文件里」的豁口）。
import type { DeviceCodeNotice, GraphFetchOptions, GraphRequestInit } from "./index.js";
// 发信 API 必须能从包入口拿到（T46：send/ 不得只能走内部路径）。
import {
  buildMime,
  createMailSource,
  dispatchSend,
  mirrorSentMessage,
  resolveSendChannel,
  SmtpClient,
  smtpConfigForAccount,
} from "./index.js";
import type { DispatchSendInput, SendOutcome } from "./index.js";
import { Pop3MailSource } from "./pop3.js";
import { makeAccount } from "./test-support.js";
import type { MailSource } from "./types.js";
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

  it("DeviceCodeNotice 仍可从包入口导入（导出名不变）", () => {
    const notice: DeviceCodeNotice = {
      userCode: "ABCD-EFGH",
      verificationUri: "https://microsoft.com/devicelogin",
      message: "请访问 https://microsoft.com/devicelogin 并输入代码 ABCD-EFGH",
      expiresInSeconds: 900,
    };
    expect(notice.verificationUri).toBe("https://microsoft.com/devicelogin");
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

  it("只有 Graph 适配器暴露 login()", () => {
    const imap = createMailSource(makeAccount("imap", { host: "imap.example.com" }));
    const pop3 = createMailSource(makeAccount("pop3", { host: "pop3.example.com" }));
    const graph = createMailSource(
      makeAccount("graph", {
        clientId: "11111111-1111-1111-1111-111111111111",
        cachePath: "/tmp/mailcollect-test-token.json",
      }),
    );

    expect(imap.login).toBeUndefined();
    expect(pop3.login).toBeUndefined();
    expect(typeof graph.login).toBe("function");
  });

  it("createMailSource 把 Graph 的 options 透传给适配器", async () => {
    let loginCalls = 0;
    const source = createMailSource(
      makeAccount("graph", {
        clientId: "11111111-1111-1111-1111-111111111111",
        cachePath: "/tmp/mailcollect-test-token.json",
      }),
      {
        auth: {
          getAccessToken: async () => "token",
          login: async () => {
            loginCalls += 1;
          },
        },
        fetch: async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ value: [] }) }),
      },
    );

    expect(typeof source.login).toBe("function");
    if (typeof source.login === "function") {
      await expect(source.login()).resolves.toEqual({ ok: true, detail: "Graph 已连接：user@example.com" });
    }
    expect(loginCalls).toBe(1);
  });

  it("适配器的 provider 字段与账号一致", () => {
    expect(createMailSource(makeAccount("imap", { host: "imap.example.com" })).provider).toBe("imap");
    expect(createMailSource(makeAccount("pop3", { host: "pop3.example.com" })).provider).toBe("pop3");
  });

  it("发信 API 从包入口可用：函数/类在运行时拿得到，类型面也完整", () => {
    expect(typeof buildMime).toBe("function");
    expect(typeof dispatchSend).toBe("function");
    expect(typeof resolveSendChannel).toBe("function");
    expect(typeof smtpConfigForAccount).toBe("function");
    expect(typeof mirrorSentMessage).toBe("function");
    expect(typeof SmtpClient).toBe("function");

    // 类型面：DispatchSendInput → Promise<SendOutcome> 能直接从包入口写出来。
    const acceptsDispatch = (input: DispatchSendInput): Promise<SendOutcome> => dispatchSend(input);
    expect(typeof acceptsDispatch).toBe("function");
  });

  it("fetch({ folderId }) 可从 MailSource 类型面调用，且 Graph 真的按该文件夹做 delta", async () => {
    const urls: string[] = [];
    // 关键：变量类型是 MailSource（不是 GraphMailSource）——没有 folderId 的公共契约这里就编不过。
    const source: MailSource = createMailSource(
      makeAccount("graph", {
        clientId: "11111111-1111-1111-1111-111111111111",
        cachePath: "/tmp/mailcollect-test-token.json",
      }),
      {
        auth: { getAccessToken: async () => "token", login: async () => undefined },
        fetch: async (input: string, init: GraphRequestInit) => {
          urls.push(input);
          void init;
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({
              value: [],
              "@odata.deltaLink": "https://graph.microsoft.com/v1.0/me/mailFolders/f-archive/messages/delta?$deltatoken=x",
            }),
          };
        },
      },
    );
    // Graph 专属选项类型也能从包入口拿到，并且与拓宽后的 FetchOptions 兼容。
    const options: GraphFetchOptions = { folderId: "f-archive" };

    const result = await source.fetch(options);

    expect(urls[0]).toContain("/me/mailFolders/f-archive/messages/delta");
    expect(result.emails).toEqual([]);
    expect(result.cursor).not.toBeNull();
  });
});
