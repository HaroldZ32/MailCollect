import { describe, expect, it } from "vitest";
import type { GraphFetch, GraphResponse } from "./graph.js";
import { GraphMailSource } from "./graph.js";
import { makeAccount } from "./test-support.js";
import { MailError } from "./types.js";

const DELTA_LINK_1 = "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=one";
const DELTA_LINK_2 = "https://graph.microsoft.com/v1.0/me/messages/delta?$deltatoken=two";
const NEXT_LINK = "https://graph.microsoft.com/v1.0/me/messages/delta?$skiptoken=next";

function graphMessage(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    internetMessageId: `<${id}@example.com>`,
    conversationId: `conv-${id}`,
    subject: `subject ${id}`,
    receivedDateTime: "2026-11-04T01:00:00Z",
    sentDateTime: "2026-11-04T00:59:00Z",
    hasAttachments: false,
    body: { contentType: "text", content: `body ${id}` },
    from: { emailAddress: { name: "Alice", address: "alice@example.com" } },
    toRecipients: [{ emailAddress: { address: "user@example.com" } }],
    ccRecipients: [],
    internetMessageHeaders: [],
    ...overrides,
  };
}

function response(body: unknown, status = 200): GraphResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => body,
  };
}

interface Harness {
  readonly source: GraphMailSource;
  readonly urls: string[];
  readonly headers: Array<Record<string, string>>;
}

function buildSource(responder: (url: string) => GraphResponse, token = "test-access-token"): Harness {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetchStub: GraphFetch = async (input, init) => {
    urls.push(input);
    headers.push({ ...init.headers });
    return responder(input);
  };
  const source = new GraphMailSource(
    makeAccount(
      "graph",
      { clientId: "11111111-1111-1111-1111-111111111111", cachePath: "/tmp/mailcollect-test-token.json" },
      "graph-shared-secret",
    ),
    {
      auth: { getAccessToken: async () => token, login: async () => undefined },
      fetch: fetchStub,
    },
  );
  return { source, urls, headers };
}

describe("GraphMailSource", () => {
  it("首次同步用 delta 开窗，游标保存 deltaLink", async () => {
    const harness = buildSource(() =>
      response({ value: [graphMessage("m1")], "@odata.deltaLink": DELTA_LINK_1 }),
    );

    const result = await harness.source.fetch();

    expect(result.emails).toHaveLength(1);
    expect(result.emails[0]?.uid).toBe("m1");
    expect(result.emails[0]?.bodyText).toBe("body m1");
    expect(result.cursor?.value).toBe(DELTA_LINK_1);
    expect(result.hasMore).toBe(false);
    expect(harness.urls[0]).toContain("/me/messages/delta");
    expect(harness.urls[0]).toContain("$top=50");
    expect(harness.headers[0]?.Authorization).toBe("Bearer test-access-token");
  });

  it("增量同步直接请求游标 URL，并推进到新的 deltaLink", async () => {
    const harness = buildSource(() =>
      response({ value: [graphMessage("m2")], "@odata.deltaLink": DELTA_LINK_2 }),
    );

    const result = await harness.source.fetch({
      since: { accountId: "acc-1", value: DELTA_LINK_1, updatedAt: "2026-11-03T00:00:00.000Z" },
    });

    expect(harness.urls[0]).toBe(DELTA_LINK_1);
    expect(result.cursor?.value).toBe(DELTA_LINK_2);
    expect(result.emails.map((email) => email.uid)).toEqual(["m2"]);
  });

  it("@odata.nextLink 表示枚举未完成：游标存 nextLink 且 hasMore=true", async () => {
    const harness = buildSource(() =>
      response({ value: [graphMessage("m3")], "@odata.nextLink": NEXT_LINK }),
    );

    const result = await harness.source.fetch();

    expect(result.cursor?.value).toBe(NEXT_LINK);
    expect(result.hasMore).toBe(true);
  });

  it("只保留白名单头，其余头（含自定义头）全部丢弃", async () => {
    const harness = buildSource(() =>
      response({
        value: [
          graphMessage("m4", {
            internetMessageHeaders: [
              { name: "List-Id", value: "<news.example.com>" },
              { name: "List-Unsubscribe", value: "<mailto:unsub@example.com>" },
              { name: "Precedence", value: "bulk" },
              { name: "Return-Path", value: "<bounce@example.com>" },
              { name: "X-Custom-Tracking", value: "drop-me" },
              { name: "MIME-Version", value: "1.0" },
            ],
          }),
        ],
        "@odata.deltaLink": DELTA_LINK_1,
      }),
    );

    const result = await harness.source.fetch();
    const headers = result.emails[0]?.headers ?? {};

    expect(headers).toEqual({
      "list-id": "<news.example.com>",
      "list-unsubscribe": "<mailto:unsub@example.com>",
      precedence: "bulk",
      "return-path": "<bounce@example.com>",
    });
    expect("x-custom-tracking" in headers).toBe(false);
    expect("mime-version" in headers).toBe(false);
  });

  it("HTML 正文转成纯文本，标签不进入 bodyText", async () => {
    const harness = buildSource(() =>
      response({
        value: [
          graphMessage("m5", {
            body: { contentType: "html", content: "<p>周一<strong>提交</strong>报告</p><p>谢谢</p>" },
          }),
        ],
        "@odata.deltaLink": DELTA_LINK_1,
      }),
    );

    const result = await harness.source.fetch();
    const bodyText = result.emails[0]?.bodyText ?? "";

    expect(bodyText).toContain("提交");
    expect(bodyText).not.toContain("<");
    expect(bodyText).toContain("\n");
  });

  it("@removed 条目被跳过，不影响同页其它邮件", async () => {
    const harness = buildSource(() =>
      response({
        value: [{ "@removed": { reason: "deleted" } }, graphMessage("m6")],
        "@odata.deltaLink": DELTA_LINK_1,
      }),
    );

    const result = await harness.source.fetch();

    expect(result.emails.map((email) => email.uid)).toEqual(["m6"]);
  });

  it("HTTP 401 映射为 auth，429 映射为可重试的 rate_limited", async () => {
    const unauthorized = buildSource(() => response({ error: {} }, 401));
    const authFailure = await unauthorized.source.fetch().then(
      () => null,
      (err: unknown) => err,
    );
    expect(authFailure).toBeInstanceOf(MailError);
    if (authFailure instanceof MailError) {
      expect(authFailure.code).toBe("auth");
      expect(authFailure.retryable).toBe(false);
    }

    const throttled = buildSource(() => response({ error: {} }, 429));
    const rateFailure = await throttled.source.fetch().then(
      () => null,
      (err: unknown) => err,
    );
    expect(rateFailure).toBeInstanceOf(MailError);
    if (rateFailure instanceof MailError) {
      expect(rateFailure.code).toBe("rate_limited");
      expect(rateFailure.retryable).toBe(true);
    }
  });

  it("返回值与错误信息都不包含 access token", async () => {
    const token = "super-secret-access-token";
    const harness = buildSource(() => response({ value: [graphMessage("m7")], "@odata.deltaLink": DELTA_LINK_1 }), token);
    const result = await harness.source.fetch();
    expect(JSON.stringify(result)).not.toContain(token);

    const failing = buildSource(() => response({ error: {} }, 500), token);
    const failure = await failing.source.fetch().catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(MailError);
    if (failure instanceof MailError) expect(failure.message).not.toContain(token);
  });

  it("verify() 用一次最小请求验证令牌与权限", async () => {
    const harness = buildSource(() => response({ value: [] }));

    await expect(harness.source.verify()).resolves.toEqual({
      ok: true,
      detail: "Graph 已连接：user@example.com",
    });
    expect(harness.urls[0]).toContain("/me/messages?$top=1");
  });

  it("login() 先执行设备码登录，再用 verify() 验证身份", async () => {
    let loginCalls = 0;
    let tokenCalls = 0;
    const source = new GraphMailSource(
      makeAccount("graph", {
        clientId: "11111111-1111-1111-1111-111111111111",
        cachePath: "/tmp/mailcollect-test-token.json",
      }),
      {
        auth: {
          getAccessToken: async () => {
            tokenCalls += 1;
            return "token";
          },
          login: async () => {
            loginCalls += 1;
          },
        },
        fetch: async () => response({ value: [] }),
      },
    );

    await expect(source.login()).resolves.toEqual({ ok: true, detail: "Graph 已连接：user@example.com" });
    expect(loginCalls).toBe(1);
    expect(tokenCalls).toBe(1);
  });

  it("拒绝把 Bearer 令牌发往非配置端点的游标 URL", async () => {
    const harness = buildSource(() => response({ value: [], "@odata.deltaLink": DELTA_LINK_1 }));

    const failure = await harness.source
      .fetch({
        since: {
          accountId: "acc-1",
          value: "https://evil.example.com/steal",
          updatedAt: "2026-11-03T00:00:00.000Z",
        },
      })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(failure).toBeInstanceOf(MailError);
    if (failure instanceof MailError) expect(failure.code).toBe("protocol");
    // 关键断言：非法游标在发请求之前就被拒绝
    expect(harness.urls).toHaveLength(0);
  });

  it("缺少 cachePath 时构造即失败（不允许写死全局令牌路径）", () => {
    expect(
      () => new GraphMailSource(makeAccount("graph", { clientId: "11111111-1111-1111-1111-111111111111" })),
    ).toThrowError(MailError);
  });
});
