import { describe, expect, it } from "vitest";
import type { DeviceCodeNotice, GraphFetch, GraphResponse } from "./graph.js";
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

interface CapturedRequest {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
  readonly headers: Record<string, string>;
}

interface Harness {
  readonly source: GraphMailSource;
  readonly urls: string[];
  readonly headers: Array<Record<string, string>>;
  readonly requests: CapturedRequest[];
  /** 每次取令牌时申请的追加 scope；GET 路径是 undefined。 */
  readonly scopeRequests: Array<readonly string[] | undefined>;
}

function buildSource(responder: (url: string) => GraphResponse, token = "test-access-token"): Harness {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const requests: CapturedRequest[] = [];
  const scopeRequests: Array<readonly string[] | undefined> = [];
  const fetchStub: GraphFetch = async (input, init) => {
    urls.push(input);
    headers.push({ ...init.headers });
    requests.push({
      url: input,
      method: init.method ?? "GET",
      body: init.body ?? null,
      headers: { ...init.headers },
    });
    return responder(input);
  };
  const source = new GraphMailSource(
    makeAccount(
      "graph",
      { clientId: "11111111-1111-1111-1111-111111111111", cachePath: "/tmp/mailcollect-test-token.json" },
      "graph-shared-secret",
    ),
    {
      auth: {
        getAccessToken: async (extraScopes) => {
          scopeRequests.push(extraScopes);
          return token;
        },
        login: async () => undefined,
      },
      fetch: fetchStub,
    },
  );
  return { source, urls, headers, requests, scopeRequests };
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

  it("login() 把设备码提示同时送到参数回调与 lastDeviceCodeNotice", async () => {
    const notice: DeviceCodeNotice = {
      userCode: "ABCD-EFGH",
      verificationUri: "https://microsoft.com/devicelogin",
      message: "请访问 https://microsoft.com/devicelogin 并输入代码 ABCD-EFGH",
      expiresInSeconds: 900,
    };
    const received: DeviceCodeNotice[] = [];
    const source = new GraphMailSource(
      makeAccount("graph", {
        clientId: "11111111-1111-1111-1111-111111111111",
        cachePath: "/tmp/mailcollect-test-token.json",
      }),
      {
        auth: {
          getAccessToken: async () => "token",
          login: async (onDeviceCode) => {
            onDeviceCode?.(notice);
          },
        },
        fetch: async () => response({ value: [] }),
      },
    );

    // 登录前没有任何提示
    expect(source.lastDeviceCodeNotice).toBeNull();

    await expect(source.login((item) => received.push(item))).resolves.toEqual({
      ok: true,
      detail: "Graph 已连接：user@example.com",
    });

    expect(received).toEqual([notice]);
    expect(source.lastDeviceCodeNotice).toEqual(notice);
  });

  it("lastDeviceCodeNotice 会透出 auth 实现的同名 getter", () => {
    const notice: DeviceCodeNotice = {
      userCode: "WXYZ-1234",
      verificationUri: "https://microsoft.com/devicelogin",
      message: "请访问 https://microsoft.com/devicelogin 并输入代码 WXYZ-1234",
      expiresInSeconds: 900,
    };
    const source = new GraphMailSource(
      makeAccount("graph", {
        clientId: "11111111-1111-1111-1111-111111111111",
        cachePath: "/tmp/mailcollect-test-token.json",
      }),
      {
        auth: {
          getAccessToken: async () => "token",
          login: async () => undefined,
          lastDeviceCodeNotice: notice,
        },
      },
    );

    expect(source.lastDeviceCodeNotice).toEqual(notice);
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

  /* -------------------------- v1.1 能力端口 -------------------------- */

  it("缺 clientId 抛类型化 not_configured，不崩溃、文案不回显 secret", () => {
    const account = makeAccount("graph", { cachePath: "/tmp/mailcollect-test-token.json" }, "graph-shared-secret");
    let thrown: unknown = null;
    try {
      new GraphMailSource(account);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(MailError);
    if (thrown instanceof MailError) {
      expect(thrown.code).toBe("not_configured");
      expect(thrown.message).toContain("clientId");
      expect(thrown.message).not.toContain(account.secret);
    }
  });

  it("clientId 只来自账号 config：环境变量不算数", () => {
    const previous = process.env.GRAPH_CLIENT_ID;
    process.env.GRAPH_CLIENT_ID = "env-only-client-id";
    try {
      expect(() => new GraphMailSource(makeAccount("graph", { cachePath: "/tmp/x.json" }))).toThrowError(MailError);
    } finally {
      if (previous === undefined) delete process.env.GRAPH_CLIENT_ID;
      else process.env.GRAPH_CLIENT_ID = previous;
    }
  });

  it("tenant 留空按 common 处理：构造不失败", async () => {
    const source = new GraphMailSource(
      makeAccount("graph", {
        clientId: "11111111-1111-1111-1111-111111111111",
        cachePath: "/tmp/mailcollect-test-token.json",
        tenant: "   ",
      }),
    );
    await expect(source.close()).resolves.toBeUndefined();
  });

  it("设备码登录失败返回 ok:false 类型化 detail（不抛、不挂起）", async () => {
    const source = new GraphMailSource(
      makeAccount("graph", {
        clientId: "11111111-1111-1111-1111-111111111111",
        cachePath: "/tmp/mailcollect-test-token.json",
      }),
      {
        auth: {
          getAccessToken: async () => "token",
          login: async () => {
            throw new MailError("auth", "设备码登录未完成或已超时", false);
          },
        },
        fetch: async () => response({ value: [] }),
      },
    );

    await expect(source.login()).resolves.toEqual({ ok: false, detail: "auth: 设备码登录未完成或已超时" });
  });

  it("listFolders 按 well-known 映射角色，并补齐列表里缺失的 Archive", async () => {
    const harness = buildSource((url) => {
      if (url.includes("/me/mailFolders?")) {
        return response({
          value: [
            { id: "f-inbox", displayName: "收件箱", wellKnownName: "inbox", unreadItemCount: 3 },
            { id: "f-sent", displayName: "已发送邮件", wellKnownName: "sentitems", unreadItemCount: 0 },
            { id: "f-drafts", displayName: "草稿", wellKnownName: "drafts", unreadItemCount: 0 },
            { id: "f-trash", displayName: "已删除邮件", wellKnownName: "deleteditems", unreadItemCount: 1 },
            { id: "f-custom", displayName: "项目/2026", wellKnownName: null, unreadItemCount: 0 },
          ],
        });
      }
      if (url.includes("/me/mailFolders/archive?")) {
        return response({ id: "f-archive", displayName: "Archive", wellKnownName: "archive", unreadItemCount: 0 });
      }
      return response({ error: {} }, 404);
    });

    const folders = await harness.source.listFolders();
    const byRole = new Map(folders.map((folder) => [folder.role, folder]));

    expect(byRole.get("inbox")?.id).toBe("f-inbox");
    expect(byRole.get("inbox")?.unreadCount).toBe(3);
    expect(byRole.get("sent")?.id).toBe("f-sent");
    expect(byRole.get("drafts")?.id).toBe("f-drafts");
    expect(byRole.get("trash")?.id).toBe("f-trash");
    expect(byRole.get("archive")?.id).toBe("f-archive");
    expect(byRole.get("other")?.name).toBe("项目/2026");
    expect(harness.urls[0]).toContain("/me/mailFolders?$top=100");
    expect(harness.urls[1]).toContain("/me/mailFolders/archive?");
    expect(harness.headers[0]?.Authorization).toBe("Bearer test-access-token");
  });

  it("fetch({folderId}) 在指定文件夹内做 delta 增量", async () => {
    const harness = buildSource(() =>
      response({ value: [graphMessage("m10")], "@odata.deltaLink": DELTA_LINK_1 }),
    );

    const result = await harness.source.fetch({ folderId: "inbox" });

    expect(harness.urls[0]).toContain("/me/mailFolders/inbox/messages/delta");
    expect(harness.urls[0]).toContain("$top=50");
    expect(result.emails.map((email) => email.uid)).toEqual(["m10"]);
  });

  it("getMessage 返回正文、已读标记与附件元数据（HTML 转纯文本）", async () => {
    const harness = buildSource((url) => {
      if (url.includes("/attachments?")) {
        return response({
          value: [
            { id: "att1", name: "report.pdf", contentType: "application/pdf", size: 1234, isInline: false },
            { id: "att2", name: "logo.png", contentType: "image/png", size: 56, isInline: true },
          ],
        });
      }
      return response(
        graphMessage("m11", {
          parentFolderId: "f-inbox",
          isRead: true,
          hasAttachments: true,
          body: { contentType: "html", content: "<p>hello<strong>world</strong></p>" },
        }),
      );
    });

    const body = await harness.source.getMessage({ id: "m11" });

    expect(body.id).toBe("m11");
    expect(body.folderId).toBe("f-inbox");
    expect(body.isRead).toBe(true);
    expect(body.text).toContain("hello");
    expect(body.text).not.toContain("<");
    expect(body.html).toContain("<p>hello");
    expect(body.attachments.map((item) => [item.id, item.filename, item.size, item.inline])).toEqual([
      ["att1", "report.pdf", 1234, false],
      ["att2", "logo.png", 56, true],
    ]);
    expect(harness.urls[0]).toContain("/me/messages/m11?$select=");
    expect(harness.urls[1]).toContain("/me/messages/m11/attachments?$select=");
  });

  it("getMessage 在 hasAttachments=false 时不请求附件列表", async () => {
    const harness = buildSource(() => response(graphMessage("m12")));

    const body = await harness.source.getMessage({ id: "m12" });

    expect(body.attachments).toEqual([]);
    expect(harness.urls).toHaveLength(1);
  });

  it("getAttachment 把 base64 解码成原始字节", async () => {
    const harness = buildSource(() =>
      response({
        id: "att1",
        name: "a.txt",
        contentType: "text/plain",
        size: 5,
        isInline: false,
        contentBytes: Buffer.from("hello").toString("base64"),
      }),
    );

    const data = await harness.source.getAttachment({ id: "m11" }, "att1");

    expect([...data.content]).toEqual([104, 101, 108, 108, 111]);
    expect(data.info.filename).toBe("a.txt");
    expect(data.info.mimeType).toBe("text/plain");
    expect(harness.urls[0]).toContain("/me/messages/m11/attachments/att1?$select=");
  });

  it("getAttachment 对 itemAttachment（没有 contentBytes）返回类型化 unsupported", async () => {
    const harness = buildSource(() =>
      response({ id: "att2", name: "mail.eml", contentType: "message/rfc822", size: 10, isInline: false }),
    );

    const failure = await harness.source.getAttachment({ id: "m11" }, "att2").then(
      () => null,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(MailError);
    if (failure instanceof MailError) expect(failure.code).toBe("unsupported");
  });

  it("setFlags 用 PATCH 只改给出的旗标，并申请 Mail.ReadWrite", async () => {
    const harness = buildSource(() => response({ id: "m1" }));

    await harness.source.setFlags({ id: "m1" }, { read: true });

    expect(harness.requests[0]?.method).toBe("PATCH");
    expect(harness.requests[0]?.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(harness.requests[0]?.body ?? "{}")).toEqual({ isRead: true });
    expect(harness.scopeRequests[0]).toContain("https://graph.microsoft.com/Mail.ReadWrite");
  });

  it("move 返回移动后的新定位（Graph 会换 id）", async () => {
    const harness = buildSource(() => response({ id: "m1-new", parentFolderId: "f-archive" }));

    const moved = await harness.source.move({ id: "m1" }, "f-archive");

    expect(moved).toEqual({ id: "m1-new", folderId: "f-archive" });
    expect(harness.urls[0]).toContain("/me/messages/m1/move");
    expect(JSON.parse(harness.requests[0]?.body ?? "{}")).toEqual({ destinationId: "f-archive" });
  });

  it("delete 默认移入回收站，permanent 才真正 DELETE", async () => {
    const moves = buildSource(() => response({ id: "m2", parentFolderId: "deleteditems" }));
    await moves.source.delete({ id: "m2" });

    expect(moves.requests[0]?.url).toContain("/me/messages/m2/move");
    expect(JSON.parse(moves.requests[0]?.body ?? "{}")).toEqual({ destinationId: "deleteditems" });

    const permanent = buildSource(() => response({}, 204));
    await permanent.source.delete({ id: "m2" }, { permanent: true });

    expect(permanent.requests[0]?.method).toBe("DELETE");
    expect(permanent.requests[0]?.url).toContain("/me/messages/m2");
  });

  it("search 合成 $search KQL，命中带 id 与所在文件夹", async () => {
    const harness = buildSource(() => response({ value: [{ id: "m20", parentFolderId: "f-inbox" }] }));

    const hits = await harness.source.search({ subject: "周报", from: "alice@example.com", unreadOnly: true, limit: 10 });

    expect(hits).toEqual([{ id: "m20", folderId: "f-inbox" }]);
    const decoded = decodeURIComponent(harness.urls[0] ?? "");
    expect(decoded).toContain("/me/messages?");
    expect(decoded).toContain("$top=10");
    expect(decoded).toContain('subject:"周报"');
    expect(decoded).toContain('from:"alice@example.com"');
    expect(decoded).toContain("$filter=isRead eq false");
  });

  it("search 带 folderId 时限定到该文件夹集合", async () => {
    const harness = buildSource(() => response({ value: [{ id: "m21", parentFolderId: "f-sent" }] }));

    const hits = await harness.source.search({ folderId: "f-sent", body: "发票" });

    expect(hits).toEqual([{ id: "m21", folderId: "f-sent" }]);
    expect(decodeURIComponent(harness.urls[0] ?? "")).toContain("/me/mailFolders/f-sent/messages?");
  });

  it("search 被服务器拒绝时返回类型化 unsupported，不静默返回空数组", async () => {
    const harness = buildSource(() => response({ error: { code: "ErrorInvalidRequest" } }, 400));

    const failure = await harness.source.search({ subject: "x" }).then(
      () => null,
      (err: unknown) => err,
    );

    expect(failure).toBeInstanceOf(MailError);
    if (failure instanceof MailError) {
      expect(failure.code).toBe("unsupported");
      expect(failure.message).toContain("搜索");
    }
  });

  it("sendViaGraph POST /me/sendMail，申请 Mail.Send，MIME 以 base64 发送", async () => {
    const harness = buildSource(() => response(null, 202));
    const mime = "From: user@example.com\r\nTo: bob@example.com\r\nSubject: hi\r\n\r\nbody";

    const result = await harness.source.sendViaGraph({
      mime: new TextEncoder().encode(mime),
      to: ["bob@example.com"],
      cc: [],
      bcc: [],
      from: "user@example.com",
    });

    expect(result).toMatchObject({ ok: true, transport: "graph", savedToSent: "server" });
    expect(harness.urls[0]).toBe("https://graph.microsoft.com/v1.0/me/sendMail");
    expect(harness.requests[0]?.method).toBe("POST");
    expect(harness.requests[0]?.headers["Content-Type"]).toBe("text/plain");
    expect(harness.requests[0]?.headers["Content-Transfer-Encoding"]).toBe("base64");
    expect(Buffer.from(harness.requests[0]?.body ?? "", "base64").toString("utf8")).toBe(mime);
    expect(harness.scopeRequests[0]).toContain("https://graph.microsoft.com/Mail.Send");
    // 令牌只出现在 Authorization 头，不进入 URL。
    expect(harness.urls[0]).not.toContain("test-access-token");
  });

  it("sendViaGraph 缺 Mail.Send（HTTP 403）返回 auth，提示重新授权且未送达", async () => {
    const harness = buildSource(() => response({ error: {} }, 403));

    const result = await harness.source.sendViaGraph({
      mime: new Uint8Array(),
      to: ["bob@example.com"],
      cc: [],
      bcc: [],
      from: "user@example.com",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.transport).toBe("graph");
      expect(result.savedToSent).toBe("none");
      expect(result.error.code).toBe("auth");
      expect(result.detail).toContain("Mail.Send");
    }
  });

  it("sendViaGraph 静默取令牌缺 scope 时不发请求，返回类型化 auth", async () => {
    const urls: string[] = [];
    const scopeRequests: Array<readonly string[] | undefined> = [];
    const source = new GraphMailSource(
      makeAccount("graph", {
        clientId: "11111111-1111-1111-1111-111111111111",
        cachePath: "/tmp/mailcollect-test-token.json",
      }),
      {
        auth: {
          getAccessToken: async (extraScopes) => {
            scopeRequests.push(extraScopes);
            if (extraScopes !== undefined && extraScopes.length > 0) {
              throw new MailError("auth", "缺少发信权限，需要重新授权", false);
            }
            return "token";
          },
          login: async () => undefined,
        },
        fetch: async (input) => {
          urls.push(input);
          return response(null, 202);
        },
      },
    );

    const result = await source.sendViaGraph({
      mime: new Uint8Array(),
      to: ["bob@example.com"],
      cc: [],
      bcc: [],
      from: "user@example.com",
    });

    expect(scopeRequests[0]).toContain("https://graph.microsoft.com/Mail.Send");
    expect(urls).toHaveLength(0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("auth");
  });
});

describe("GraphMailSource receivedAt 语义", () => {
  it("fetch 用 receivedDateTime 作接收时间，sentAt 取 sentDateTime（两者分开）", async () => {
    const harness = buildSource(() =>
      response({ value: [graphMessage("m40")], "@odata.deltaLink": DELTA_LINK_1 }),
    );

    const result = await harness.source.fetch();

    // fixture：receivedDateTime=01:00Z，sentDateTime=00:59Z
    expect(result.receivedAtByUid?.get("m40")?.toISOString()).toBe("2026-11-04T01:00:00.000Z");
    expect(result.emails[0]?.sentAt).toBe("2026-11-04T00:59:00.000Z");
  });

  it("getMessage 的 MessageBody 带 receivedAt，sentAt 取 sentDateTime", async () => {
    const harness = buildSource(() => response(graphMessage("m41")));

    const body = await harness.source.getMessage({ id: "m41" });

    expect(body.receivedAt?.toISOString()).toBe("2026-11-04T01:00:00.000Z");
    expect(body.sentAt).toBe("2026-11-04T00:59:00.000Z");
  });

  it("receiveDateTime 缺失时不填 receivedAt（不造数）", async () => {
    const harness = buildSource(() =>
      response({
        value: [graphMessage("m42", { receivedDateTime: null })],
        "@odata.deltaLink": DELTA_LINK_1,
      }),
    );

    const result = await harness.source.fetch();

    expect(result.receivedAtByUid).toBeUndefined();
  });
});
