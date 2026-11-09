import { describe, expect, it } from "vitest";
import type { MailSourceAccount } from "./account.js";
import {
  autodiscoverEndpoints,
  autodiscoverForAccount,
  buildAutodiscoverRequestXml,
  discoverAutodiscover,
  parseXmlDocument,
  xmlAttr,
  xmlFirst,
  xmlText,
} from "./autodiscover.js";
import type { AutodiscoverFetch, AutodiscoverInit, AutodiscoverResponse } from "./autodiscover.js";
import { makeAccount } from "./test-support.js";
import { MailError } from "./types.js";

const SECRET = "s3cret-autodiscover-pass";

interface RecordedRequest {
  readonly url: string;
  readonly init: AutodiscoverInit;
}

function ok(body: string): AutodiscoverResponse {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => body,
  };
}

function failed(status: number, body = "", headers: Record<string, string> = {}): AutodiscoverResponse {
  return {
    ok: false,
    status,
    statusText: "",
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

function fakeFetch(handler: (request: RecordedRequest) => AutodiscoverResponse | Promise<AutodiscoverResponse>): {
  readonly fetch: AutodiscoverFetch;
  readonly requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  return {
    fetch: async (url, init) => {
      const request = { url, init };
      requests.push(request);
      return handler(request);
    },
    requests,
  };
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`缺少第 ${index} 项`);
  return item;
}

/** 断言 Promise 以 `MailError` 拒绝，并把错误交给检查函数。 */
async function expectMailError(promise: Promise<unknown>, check: (err: MailError) => void): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(MailError);
    if (!(err instanceof MailError)) throw err;
    check(err);
    return;
  }
  throw new Error("期望 Promise 被拒绝，但它成功了");
}

function autodiscoverXml(protocol: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Autodiscover xmlns="http://schemas.microsoft.com/exchange/autodiscover/responseschema/2006">',
    '<Response xmlns="http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a">',
    protocol,
    "</Response>",
    "</Autodiscover>",
  ].join("");
}

function exchProtocol(ewsUrl: string, server = "mail.example.com"): string {
  return [
    "<Account><AccountType>email</AccountType><Action>settings</Action>",
    `<Protocol><Type>EXCH</Type><Server>${server}</Server><ServerVersion>15.1.2507.6</ServerVersion><EwsUrl>${ewsUrl}</EwsUrl></Protocol>`,
    "</Account>",
  ].join("");
}

const EXCH_RESPONSE = autodiscoverXml(exchProtocol("https://mail.example.com/EWS/Exchange.asmx"));
const O365_RESPONSE = autodiscoverXml(
  exchProtocol("https://outlook.office365.com/EWS/Exchange.asmx", "outlook.office365.com"),
);
const REDIRECT_RESPONSE = autodiscoverXml(
  "<Redirect>https://autodiscover.contoso.example.net/autodiscover/autodiscover.xml</Redirect>",
);

function account(config: Record<string, string> = {}, secret = SECRET): MailSourceAccount {
  return makeAccount("ews", config, secret);
}

describe("XML 解析", () => {
  it("解析命名空间、属性、实体与 CDATA", () => {
    const xml = parseXmlDocument(
      '<?xml version="1.0"?><!-- c --><soap:Envelope xmlns:soap="http://x"><t:Body BodyType="HTML">&lt;p&gt;Hi &amp;amp; bye&lt;/p&gt;<![CDATA[<raw>]]></t:Body></soap:Envelope>',
    );
    expect(xml.name).toBe("Envelope");
    const body = xmlFirst(xml, "Body");
    expect(body).not.toBeNull();
    if (body !== null) {
      expect(xmlAttr(body, "BodyType")).toBe("HTML");
      expect(body.text).toBe("<p>Hi &amp; bye</p><raw>");
    }
  });

  it("支持自闭合标签与数值实体", () => {
    const xml = parseXmlDocument('<root><empty/><text>&#20320;&#x597d;</text></root>');
    expect(xmlFirst(xml, "empty")).not.toBeNull();
    expect(xmlText(xml, "text")).toBe("你好");
  });

  it("畸形 XML 抛类型化 protocol 错误", () => {
    expect(() => parseXmlDocument("<root><a></root>")).toThrowError(MailError);
    expect(() => parseXmlDocument("<root>")).toThrowError(MailError);
    expect(() => parseXmlDocument("not xml at all")).toThrowError(MailError);
  });
});

describe("Autodiscover 请求", () => {
  it("端点顺序与请求 XML 符合 Outlook 标准", () => {
    expect(autodiscoverEndpoints("user@corp.example.com")).toEqual([
      "https://autodiscover.corp.example.com/autodiscover/autodiscover.xml",
      "https://corp.example.com/autodiscover/autodiscover.xml",
    ]);
    const xml = buildAutodiscoverRequestXml('a&b@example.com');
    expect(xml).toContain("<EMailAddress>a&amp;b@example.com</EMailAddress>");
    expect(xml).toContain("http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006");
    expect(xml).toContain("responseschema/2006a");
    expect(() => autodiscoverEndpoints("not-an-email")).toThrowError(MailError);
  });

  it("探测请求带 Basic 认证（密码只出现在头里）", async () => {
    const fake = fakeFetch(() => ok(EXCH_RESPONSE));
    await discoverAutodiscover({ email: "user@example.com", secret: SECRET }, { fetch: fake.fetch });

    const request = at(fake.requests, 0);
    expect(request.init.method).toBe("POST");
    expect(request.init.headers.Authorization).toBe(
      `Basic ${Buffer.from(`user@example.com:${SECRET}`).toString("base64")}`,
    );
    expect(request.init.body).toContain("user@example.com");
  });

  it("未提供 secret 时不发 Authorization 头", async () => {
    const fake = fakeFetch(() => ok(EXCH_RESPONSE));
    await discoverAutodiscover({ email: "user@example.com" }, { fetch: fake.fetch });

    expect(at(fake.requests, 0).init.headers.Authorization).toBeUndefined();
  });
});

describe("Autodiscover 结果", () => {
  it("本地 Exchange：解析出 EWS URL/服务器/版本", async () => {
    const fake = fakeFetch(() => ok(EXCH_RESPONSE));

    const result = await discoverAutodiscover({ email: "user@example.com", secret: SECRET }, { fetch: fake.fetch });

    expect(result.kind).toBe("ews");
    expect(result.ewsUrl).toBe("https://mail.example.com/EWS/Exchange.asmx");
    expect(result.server).toBe("mail.example.com");
    expect(result.serverVersion).toBe("15.1.2507.6");
    expect(result.detail).toContain("EWS 端点");
  });

  it("Office 365：提示改用 Graph 且不返回 EWS URL", async () => {
    const fake = fakeFetch(() => ok(O365_RESPONSE));

    const result = await discoverAutodiscover({ email: "user@example.com", secret: SECRET }, { fetch: fake.fetch });

    expect(result.kind).toBe("graph");
    expect(result.ewsUrl).toBeNull();
    expect(result.detail).toContain("Graph");
  });

  it("跟随 Redirect（最多 2 跳）", async () => {
    const fake = fakeFetch((request) =>
      request.url === "https://autodiscover.example.com/autodiscover/autodiscover.xml"
        ? ok(REDIRECT_RESPONSE)
        : ok(EXCH_RESPONSE),
    );

    const result = await discoverAutodiscover({ email: "user@example.com", secret: SECRET }, { fetch: fake.fetch });

    expect(result.kind).toBe("ews");
    expect(fake.requests).toHaveLength(2);
    expect(at(fake.requests, 1).url).toBe("https://autodiscover.contoso.example.net/autodiscover/autodiscover.xml");
  });

  it("Redirect 到未允许的主机被拒绝（不把 Basic 凭据发出去）", async () => {
    const fake = fakeFetch(() =>
      ok(autodiscoverXml("<Redirect>https://evil.example.net/autodiscover/autodiscover.xml</Redirect>")),
    );

    await expectMailError(
      discoverAutodiscover(
        { email: "user@example.com", secret: SECRET },
        { endpoints: ["https://autodiscover.example.com/autodiscover/autodiscover.xml"], fetch: fake.fetch },
      ),
      (err) => {
        expect(err.code).toBe("protocol");
        expect(err.message).toContain("未允许的主机");
        expect(err.message).toContain("手工填写 EWS URL");
        expect(err.message).not.toContain(SECRET);
      },
    );
    // 只请求了原端点，没有跟随到 evil.example.net
    expect(fake.requests).toHaveLength(1);
    expect(at(fake.requests, 0).url).toBe("https://autodiscover.example.com/autodiscover/autodiscover.xml");
  });

  it("第一个端点网络失败时回退到第二个端点", async () => {
    const fake = fakeFetch((request) => {
      if (request.url.startsWith("https://autodiscover.")) {
        throw Object.assign(new Error("getaddrinfo ENOTFOUND autodiscover.example.com"), {
          code: "ENOTFOUND",
        });
      }
      return ok(EXCH_RESPONSE);
    });

    const result = await discoverAutodiscover({ email: "user@example.com", secret: SECRET }, { fetch: fake.fetch });

    expect(result.kind).toBe("ews");
    expect(fake.requests).toHaveLength(2);
  });
});

describe("Autodiscover 失败路径", () => {
  const ONE_ENDPOINT = { endpoints: ["https://autodiscover.example.com/autodiscover/autodiscover.xml"] };

  it("Error 节点给可读错误并提示手工填写", async () => {
    const fake = fakeFetch(() => ok(autodiscoverXml('<Error ErrorCode="600" Message="Invalid Request" />')));

    await expectMailError(
      discoverAutodiscover({ email: "user@example.com", secret: SECRET }, { ...ONE_ENDPOINT, fetch: fake.fetch }),
      (err) => {
        expect(err.code).toBe("protocol");
        expect(err.message).toContain("Invalid Request");
        expect(err.message).toContain("手工填写 EWS URL");
      },
    );
  });

  it("响应缺少 EwsUrl 时提示手工填写", async () => {
    const fake = fakeFetch(() => ok(autodiscoverXml("<Account><Protocol><Type>EXCH</Type></Protocol></Account>")));

    await expectMailError(
      discoverAutodiscover({ email: "user@example.com" }, { ...ONE_ENDPOINT, fetch: fake.fetch }),
      (err) => {
        expect(err.code).toBe("protocol");
        expect(err.message).toContain("手工填写");
      },
    );
  });

  it("http:// 的 EWS URL 被拒绝", async () => {
    const fake = fakeFetch(() => ok(autodiscoverXml(exchProtocol("http://mail.example.com/EWS/Exchange.asmx"))));

    await expectMailError(
      discoverAutodiscover({ email: "user@example.com" }, { ...ONE_ENDPOINT, fetch: fake.fetch }),
      (err) => expect(err.code).toBe("protocol"),
    );
  });

  it("XML 里的 EWS URL 内嵌凭据：拒绝，且错误文案不含密码", async () => {
    const password = "s3cret-xml-pass";
    const fake = fakeFetch(() =>
      ok(autodiscoverXml(exchProtocol(`https://bob:${password}@mail.example.com/EWS/Exchange.asmx`))),
    );

    await expectMailError(
      discoverAutodiscover({ email: "user@example.com" }, { ...ONE_ENDPOINT, fetch: fake.fetch }),
      (err) => {
        expect(err.code).toBe("protocol");
        expect(err.message).toContain("不得包含用户名或密码");
        expect(err.message).not.toContain(password);
        expect(err.message).not.toContain("bob");
      },
    );
  });

  it("Redirect 地址内嵌凭据：拒绝且不跟随", async () => {
    const password = "s3cret-redirect-pass";
    const fake = fakeFetch(() =>
      ok(autodiscoverXml(`<Redirect>https://bob:${password}@autodiscover.example.net/autodiscover/autodiscover.xml</Redirect>`)),
    );

    await expectMailError(
      discoverAutodiscover(
        { email: "user@example.com", secret: SECRET },
        { endpoints: ["https://autodiscover.example.com/autodiscover/autodiscover.xml"], fetch: fake.fetch },
      ),
      (err) => {
        expect(err.code).toBe("protocol");
        expect(err.message).toContain("不得包含用户名或密码");
        expect(err.message).not.toContain(password);
        expect(err.message).not.toContain("bob");
      },
    );
    // 没有跟随到带凭据的地址
    expect(fake.requests).toHaveLength(1);
  });

  it("HTTP 401 映射为 auth；所有端点失败时补上手工填写提示", async () => {
    const fake = fakeFetch(() => failed(401));

    await expectMailError(
      discoverAutodiscover({ email: "user@example.com", secret: SECRET }, { fetch: fake.fetch }),
      (err) => {
        expect(err.code).toBe("auth");
        expect(err.message).toContain("HTTP 401");
        expect(err.message).toContain("手工填写 EWS URL");
        expect(err.message).not.toContain(SECRET);
      },
    );
  });

  it("畸形 XML 与全端点 404 都收敛成可读错误", async () => {
    const malformed = fakeFetch(() => ok("<html><body>login</body></html>"));
    const notFound = fakeFetch(() => failed(404));

    await expectMailError(
      discoverAutodiscover({ email: "user@example.com" }, { fetch: malformed.fetch }),
      (err) => expect(err.code).toBe("protocol"),
    );
    await expectMailError(
      discoverAutodiscover({ email: "user@example.com" }, { fetch: notFound.fetch }),
      (err) => {
        expect(err.code).toBe("protocol");
        expect(err.message).toContain("手工填写 EWS URL");
      },
    );
  });

  it("超时映射为 network 并提示手工填写", async () => {
    const hanging: AutodiscoverFetch = (_url, init) =>
      new Promise<AutodiscoverResponse>((_resolve, reject) => {
        const signal = init.signal;
        if (signal === undefined) {
          reject(new Error("测试缺少 signal"));
          return;
        }
        const onAbort = (): void => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      });

    await expectMailError(
      discoverAutodiscover(
        { email: "user@example.com" },
        { fetch: hanging, timeoutMs: 20, endpoints: ["https://autodiscover.example.com/autodiscover/autodiscover.xml"] },
      ),
      (err) => {
        expect(err.code).toBe("network");
        expect(err.message).toContain("超时");
        expect(err.message).toContain("手工填写 EWS URL");
      },
    );
  });
});

describe("autodiscoverForAccount", () => {
  it("已手工填写 ewsUrl 时不再发请求", async () => {
    let called = 0;
    const fetchFn: AutodiscoverFetch = async () => {
      called += 1;
      return ok(EXCH_RESPONSE);
    };

    const result = await autodiscoverForAccount(
      account({ ewsUrl: "https://mail.corp.example.com/EWS/Exchange.asmx" }),
      { fetch: fetchFn },
    );

    expect(result.kind).toBe("ews");
    expect(result.ewsUrl).toBe("https://mail.corp.example.com/EWS/Exchange.asmx");
    expect(called).toBe(0);
  });

  it("手工填写的 O365 地址提示改用 Graph", async () => {
    const result = await autodiscoverForAccount(account({ ewsUrl: "https://outlook.office365.com/EWS/Exchange.asmx" }));
    expect(result.kind).toBe("graph");
    expect(result.ewsUrl).toBeNull();
  });

  it("手工填写的 http:// 地址拒绝", async () => {
    await expectMailError(
      autodiscoverForAccount(account({ ewsUrl: "http://mail.corp.example.com/EWS/Exchange.asmx" })),
      (err) => expect(err.code).toBe("not_configured"),
    );
  });

  it("手工填写的 URL 内嵌凭据：拒绝且错误文案不含密码", async () => {
    const password = "s3cret-manual-pass";

    await expectMailError(
      autodiscoverForAccount(account({ ewsUrl: `https://bob:${password}@mail.corp.example.com/EWS/Exchange.asmx` })),
      (err) => {
        expect(err.code).toBe("not_configured");
        expect(err.message).toContain("不得包含用户名或密码");
        expect(err.message).not.toContain(password);
        expect(err.message).not.toContain("bob");
      },
    );
  });

  it("没有 userinfo 的 URL 仍原样通过（不误伤）", async () => {
    const result = await autodiscoverForAccount(
      account({ ewsUrl: "https://mail.corp.example.com/EWS/Exchange.asmx" }),
      { fetch: async () => ok(EXCH_RESPONSE) },
    );

    expect(result.ewsUrl).toBe("https://mail.corp.example.com/EWS/Exchange.asmx");
  });
});
