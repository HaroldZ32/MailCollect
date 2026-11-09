import { describe, expect, it } from "vitest";
import type { MailSourceAccount } from "./account.js";
import { EwsMailSource, NtlmClient, md4, parseNtlmChallenge } from "./ews.js";
import type { EwsFetch, EwsRequestInit, EwsResponse } from "./ews.js";
import { createMailSource } from "./index.js";
import { makeAccount } from "./test-support.js";
import { MailError } from "./types.js";

/**
 * EWS 适配器的 fixture 测试：不连真实服务器。
 * 传输层注入 fake fetch，断言「发出的 SOAP 请求」与「解析出的 MailSource 结果」。
 */

const EWS_URL = "https://exchange.example.com/EWS/Exchange.asmx";
const SECRET = "s3cret-exchange-pass";

function ewsAccount(config: Record<string, string> = {}, secret = SECRET): MailSourceAccount {
  return makeAccount("ews", { ewsUrl: EWS_URL, authMode: "password", ...config }, secret);
}

interface RecordedRequest {
  readonly url: string;
  readonly init: EwsRequestInit;
}

function ok(body: string): EwsResponse {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => body,
  };
}

function failed(status: number, body: string, headers: Record<string, string> = {}): EwsResponse {
  return {
    ok: false,
    status,
    statusText: "",
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

function fakeFetch(handler: (request: RecordedRequest) => EwsResponse | Promise<EwsResponse>): {
  readonly fetch: EwsFetch;
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

function authorizationOf(request: RecordedRequest): string {
  const validAuthorization = request.init.headers.Authorization;
  if (validAuthorization === undefined) throw new Error("请求缺少 Authorization");
  return validAuthorization;
}

function soapEnvelope(body: string, header = '<t:ServerVersionInfo MajorVersion="15" MinorVersion="1" MajorBuildNumber="2507" Version="Exchange2016"/>'): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">',
    `<soap:Header>${header}</soap:Header>`,
    `<soap:Body>${body}</soap:Body>`,
    "</soap:Envelope>",
  ].join("");
}

function opResponse(operation: string, inner: string): string {
  return soapEnvelope(
    `<m:${operation}Response><m:ResponseMessages><m:${operation}ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>${inner}</m:${operation}ResponseMessage></m:ResponseMessages></m:${operation}Response>`,
  );
}

function errorResponse(operation: string, code: string, messageText = "服务器拒绝"): string {
  return soapEnvelope(
    `<m:${operation}Response><m:ResponseMessages><m:${operation}ResponseMessage ResponseClass="Error"><m:ResponseCode>${code}</m:ResponseCode><m:MessageText>${messageText}</m:MessageText></m:${operation}ResponseMessage></m:ResponseMessages></m:${operation}Response>`,
  );
}

function findItemResponse(items: readonly string[], includesLast = true): string {
  return opResponse(
    "FindItem",
    `<m:RootFolder TotalItemsInView="${items.length}" IncludesLastItemInRange="${includesLast}"><t:Items>${items.join("")}</t:Items></m:RootFolder>`,
  );
}

function findItemEntry(id: string, receivedAt = "2026-11-04T01:00:00Z"): string {
  return `<t:Message><t:ItemId Id="${id}" ChangeKey="ck"/><t:DateTimeReceived>${receivedAt}</t:DateTimeReceived></t:Message>`;
}

const MIME = [
  "Message-ID: <mime-1@example.com>",
  "From: Alice <alice@example.com>",
  "To: user@example.com",
  "Subject: Hello MIME",
  "Date: Tue, 04 Nov 2026 09:00:00 +0800",
  "MIME-Version: 1.0",
  'Content-Type: text/plain; charset="utf-8"',
  "",
  "Hello world.",
].join("\r\n");
const MIME_BASE64 = Buffer.from(MIME, "utf8").toString("base64");

function mimeItem(id = "item-1", receivedAt = "2026-11-04T01:00:00Z"): string {
  return `<t:Message><t:ItemId Id="${id}" ChangeKey="ck"/><t:DateTimeReceived>${receivedAt}</t:DateTimeReceived><t:MimeContent CharacterSet="UTF-8">${MIME_BASE64}</t:MimeContent></t:Message>`;
}

interface GetItemEntry {
  readonly id: string;
  readonly failed?: boolean;
  readonly receivedAt?: string;
}

/** 一条 GetItem 响应里混合成功/失败消息（EWS 每个 ItemId 对应一条 ResponseMessage）。 */
function getItemMixedMessages(entries: readonly GetItemEntry[]): string {
  const messages = entries
    .map((entry) =>
      entry.failed === true
        ? '<m:GetItemResponseMessage ResponseClass="Error"><m:ResponseCode>ErrorItemNotFound</m:ResponseCode><m:MessageText>gone</m:MessageText></m:GetItemResponseMessage>'
        : `<m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items>${mimeItem(entry.id, entry.receivedAt)}</m:Items></m:GetItemResponseMessage>`,
    )
    .join("");
  return soapEnvelope(`<m:GetItemResponse><m:ResponseMessages>${messages}</m:ResponseMessages></m:GetItemResponse>`);
}

const FULL_MESSAGE_ITEM = [
  '<t:Message><t:ItemId Id="item-1"/>',
  "<t:Subject>Report</t:Subject>",
  "<t:DateTimeSent>2026-11-04T01:30:00Z</t:DateTimeSent>",
  "<t:DateTimeReceived>2026-11-04T01:31:00Z</t:DateTimeReceived>",
  "<t:IsRead>false</t:IsRead>",
  "<t:HasAttachments>true</t:HasAttachments>",
  "<t:From><t:Mailbox><t:Name>Bob</t:Name><t:EmailAddress>bob@example.com</t:EmailAddress></t:Mailbox></t:From>",
  "<t:ToRecipients><t:Mailbox><t:EmailAddress>user@example.com</t:EmailAddress></t:Mailbox></t:ToRecipients>",
  "<t:CcRecipients><t:Mailbox><t:EmailAddress>cc@example.com</t:EmailAddress></t:Mailbox></t:CcRecipients>",
  '<t:Body BodyType="HTML">&lt;p&gt;Hi &amp;amp; bye&lt;/p&gt;</t:Body>',
  "<t:Attachments><t:FileAttachment><t:AttachmentId Id=\"att-1\"/><t:Name>a.txt</t:Name><t:ContentType>text/plain</t:ContentType><t:Size>5</t:Size><t:IsInline>false</t:IsInline></t:FileAttachment></t:Attachments>",
  "</t:Message>",
].join("");

describe("EwsMailSource 构造与注册", () => {
  it("缺少 ewsUrl 时抛类型化 not_configured（工厂同一路径）", () => {
    expect(() => createMailSource(makeAccount("ews", {}))).toThrowError(MailError);
    try {
      createMailSource(makeAccount("ews", {}));
    } catch (err) {
      expect(err).toBeInstanceOf(MailError);
      if (err instanceof MailError) expect(err.code).toBe("not_configured");
    }
  });

  it("工厂注册 ews 并透传注入的传输层", () => {
    const fake = fakeFetch(() => ok(opResponse("GetFolder", "")));
    const source = createMailSource(ewsAccount(), { ews: { fetch: fake.fetch } });
    expect(source).toBeInstanceOf(EwsMailSource);
    expect(source.provider).toBe("ews");
  });

  it("ewsUrl 内嵌凭据：构造时拒绝，错误串不含用户名/密码（与 Autodiscover 同一判定）", () => {
    const password = "s3cret-url-pass";
    const bad = ewsAccount({ ewsUrl: `https://bob:${password}@exchange.example.com/EWS/Exchange.asmx` });

    expect(() => new EwsMailSource(bad)).toThrowError(MailError);
    try {
      new EwsMailSource(bad);
    } catch (err) {
      expect(err).toBeInstanceOf(MailError);
      if (err instanceof MailError) {
        expect(err.code).toBe("not_configured");
        expect(err.message).toContain("不得包含用户名或密码");
        expect(err.message).not.toContain(password);
        expect(err.message).not.toContain("bob");
      }
    }
    // 工厂入口走同一路径
    expect(() => createMailSource(bad)).toThrowError(MailError);
  });

  it("没有 userinfo 的 https ewsUrl 不被误伤", () => {
    const source = new EwsMailSource(ewsAccount());
    expect(source.provider).toBe("ews");
    expect(source).toBeInstanceOf(EwsMailSource);
  });

  it("http:// 的 ewsUrl 与 oauth2 认证都在构造时报 not_configured", () => {
    expect(() => new EwsMailSource(ewsAccount({ ewsUrl: "http://exchange.example.com/EWS/Exchange.asmx" }))).toThrowError(
      MailError,
    );
    expect(() => new EwsMailSource(ewsAccount({ authMode: "oauth2" }))).toThrowError(MailError);
  });
});

describe("EwsMailSource 连接与认证", () => {
  it("verify 走 GetFolder(Inbox) 并带 Basic 认证与 SOAPAction", async () => {
    const fake = fakeFetch(() => ok(opResponse("GetFolder", "")));
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const result = await source.verify();

    expect(result.ok).toBe(true);
    expect(result.detail).toContain("Exchange2016");
    const request = at(fake.requests, 0);
    expect(request.url).toBe(EWS_URL);
    expect(authorizationOf(request)).toBe(`Basic ${Buffer.from(`user@example.com:${SECRET}`).toString("base64")}`);
    expect(request.init.headers.SOAPAction).toContain("/GetFolder");
    expect(request.init.body).toContain('DistinguishedFolderId Id="inbox"');
  });

  it("HTTP 401 映射为 auth，且错误文本不含密码", async () => {
    const fake = fakeFetch(() => failed(401, ""));
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const result = await source.verify();

    expect(result.ok).toBe(false);
    expect(result.detail.startsWith("auth:")).toBe(true);
    expect(result.detail).not.toContain(SECRET);
    expect(result.detail).toContain("password/ntlm");
  });

  it("超时映射为 network 且可重试", async () => {
    const hanging: EwsFetch = (_url, init) =>
      new Promise<EwsResponse>((_resolve, reject) => {
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
    const source = new EwsMailSource(ewsAccount(), { fetch: hanging, timeoutMs: 20 });

    const result = await source.verify();

    expect(result.ok).toBe(false);
    expect(result.detail.startsWith("network:")).toBe(true);
    expect(result.detail).toContain("超时");
  });
});

  it("响应头返回后响应体挂住，超时仍然生效（覆盖响应体）", async () => {
    const stalling: EwsFetch = async (_url, init) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => null },
      text: () =>
        new Promise<string>((_resolve, reject) => {
          const signal = init.signal;
          const onAbort = (): void => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          };
          if (signal === undefined) {
            reject(new Error("测试缺少 signal"));
            return;
          }
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }),
    });
    const source = new EwsMailSource(ewsAccount(), { fetch: stalling, timeoutMs: 20 });

    const result = await source.verify();

    expect(result.ok).toBe(false);
    expect(result.detail.startsWith("network:")).toBe(true);
    expect(result.detail).toContain("超时");
    expect(result.detail).toContain("含响应体");
  });

describe("EwsMailSource fetch", () => {
  it("FindItem → GetItem(MimeContent) → RawEmail，并给出 ISO 游标", async () => {
    const fake = fakeFetch((request) => {
      if (request.init.body.includes("FindItem")) return ok(findItemResponse([findItemEntry("item-1")]));
      if (request.init.body.includes("GetItem")) return ok(opResponse("GetItem", `<m:Items>${mimeItem()}</m:Items>`));
      throw new Error(`未预期的请求：${request.init.body.slice(0, 120)}`);
    });
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const result = await source.fetch();

    expect(result.emails).toHaveLength(1);
    const email = at(result.emails, 0);
    expect(email.uid).toBe("item-1");
    expect(email.messageId).toBe("<mime-1@example.com>");
    expect(email.subject).toBe("Hello MIME");
    expect(email.fromEmail).toBe("alice@example.com");
    expect(email.bodyText).toContain("Hello world.");
    expect(result.cursor?.value).toBe("2026-11-04T01:00:00.000Z");
    expect(result.hasMore).toBe(false);
  });

  it("传入 since 时按 5 分钟回退窗口查询，且空结果保留原游标", async () => {
    const fake = fakeFetch(() => ok(findItemResponse([])));
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });
    const since = { accountId: "acc-1", value: "2026-11-04T02:00:00.000Z", updatedAt: "2026-11-04T02:00:00.000Z" };

    const result = await source.fetch({ since, limit: 10 });

    expect(result.emails).toHaveLength(0);
    expect(result.cursor?.value).toBe(since.value);
    const body = at(fake.requests, 0).init.body;
    expect(body).toContain("2026-11-04T01:55:00.000Z");
  });

  it("批中一条 GetItem 失败：不推进游标，下一轮重新取到该邮件", async () => {
    let getItemRound = 0;
    const fake = fakeFetch((request) => {
      const body = request.init.body;
      if (body.includes("FindItem")) {
        return ok(
          findItemResponse([
            findItemEntry("item-b", "2026-11-04T01:00:00Z"),
            findItemEntry("item-c", "2026-11-04T02:00:00Z"),
          ]),
        );
      }
      if (body.includes("GetItem")) {
        getItemRound += 1;
        return ok(
          getItemRound === 1
            ? getItemMixedMessages([
                { id: "item-b", failed: true },
                { id: "item-c", receivedAt: "2026-11-04T02:00:00Z" },
              ])
            : getItemMixedMessages([{ id: "item-b", receivedAt: "2026-11-04T01:00:00Z" }]),
        );
      }
      throw new Error(`未预期的请求：${body.slice(0, 120)}`);
    });
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const first = await source.fetch();
    expect(first.emails.map((email) => email.uid)).toEqual(["item-c"]);
    // item-b 失败 → 游标不能越过它（否则下一轮永远拉不到 item-b）
    expect(first.cursor).toBeNull();

    const second = await source.fetch();
    expect(second.emails.map((email) => email.uid)).toEqual(["item-b"]);
  });

  it("limit 生效：只取一页上限并标记 hasMore", async () => {
    const fake = fakeFetch((request) => {
      if (request.init.body.includes("FindItem")) {
        return ok(findItemResponse([findItemEntry("item-a"), findItemEntry("item-b")], false));
      }
      return ok(opResponse("GetItem", `<m:Items>${mimeItem("item-a")}</m:Items>`));
    });
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const result = await source.fetch({ limit: 1 });

    expect(result.emails).toHaveLength(1);
    expect(result.hasMore).toBe(true);
    expect(at(result.emails, 0).uid).toBe("item-a");
    const getItemRequest = fake.requests.find((request) => request.init.body.includes("GetItem"));
    if (getItemRequest === undefined) throw new Error("没有发出 GetItem 请求");
    expect(getItemRequest.init.body).not.toContain("item-b");
  });

  it("MimeContent 缺失时退回字段拼装（正文/收件人/附件旗标）", async () => {
    const fallbackItem = [
      '<t:Message><t:ItemId Id="item-2"/>',
      "<t:Subject>Fallback</t:Subject>",
      "<t:DateTimeReceived>2026-11-05T00:00:00Z</t:DateTimeReceived>",
      "<t:InternetMessageId>&lt;fallback@example.com&gt;</t:InternetMessageId>",
      "<t:HasAttachments>true</t:HasAttachments>",
      "<t:From><t:Mailbox><t:Name>Carol</t:Name><t:EmailAddress>carol@example.com</t:EmailAddress></t:Mailbox></t:From>",
      '<t:Body BodyType="HTML">&lt;b&gt;plain&lt;/b&gt;</t:Body>',
      "</t:Message>",
    ].join("");
    const fake = fakeFetch((request) => {
      if (request.init.body.includes("FindItem")) return ok(findItemResponse([findItemEntry("item-2")]));
      return ok(opResponse("GetItem", `<m:Items>${fallbackItem}</m:Items>`));
    });
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const result = await source.fetch();

    const email = at(result.emails, 0);
    expect(email.messageId).toBe("<fallback@example.com>");
    expect(email.fromName).toBe("Carol");
    expect(email.bodyText).toBe("plain");
    expect(email.hasAttachments).toBe(true);
  });
});

describe("EwsMailSource 邮件与附件", () => {
  it("getMessage 返回正文、收件人与附件元数据", async () => {
    const fake = fakeFetch(() => ok(opResponse("GetItem", `<m:Items>${FULL_MESSAGE_ITEM}</m:Items>`)));
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const body = await source.getMessage({ id: "item-1" });

    expect(body.id).toBe("item-1");
    expect(body.folderId).toBeNull();
    expect(body.subject).toBe("Report");
    expect(body.fromName).toBe("Bob");
    expect(body.fromEmail).toBe("bob@example.com");
    expect(body.to).toEqual(["user@example.com"]);
    expect(body.cc).toEqual(["cc@example.com"]);
    expect(body.html).toContain("<p>Hi");
    expect(body.text).toBe("Hi & bye");
    expect(body.isRead).toBe(false);
    expect(body.attachments).toEqual([
      { id: "att-1", filename: "a.txt", mimeType: "text/plain", size: 5, inline: false },
    ]);
    expect(at(fake.requests, 0).init.body).toContain("AllProperties");
  });

  it("getAttachment 返回原始字节与元数据", async () => {
    const fake = fakeFetch(() =>
      ok(
        opResponse(
          "GetAttachment",
          '<m:Attachments><t:FileAttachment><t:AttachmentId Id="att-1"/><t:Name>a.txt</t:Name><t:ContentType>text/plain</t:ContentType><t:Size>5</t:Size><t:IsInline>false</t:IsInline><t:Content>aGVsbG8=</t:Content></t:FileAttachment></m:Attachments>',
        ),
      ),
    );
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const attachment = await source.getAttachment({ id: "item-1" }, "att-1");

    expect(attachment.info.filename).toBe("a.txt");
    expect(Buffer.from(attachment.content).toString("utf8")).toBe("hello");
  });

  it("listFolders 映射 WellKnownFolderName，并跳过不存在的归档/垃圾箱", async () => {
    const messages = [
      '<m:GetFolderResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Folders><t:Folder><t:FolderId Id="f-0"/><t:DisplayName>Inbox</t:DisplayName><t:UnreadCount>3</t:UnreadCount></t:Folder></m:Folders></m:GetFolderResponseMessage>',
      '<m:GetFolderResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Folders><t:Folder><t:FolderId Id="f-1"/><t:DisplayName>Sent</t:DisplayName><t:UnreadCount>0</t:UnreadCount></t:Folder></m:Folders></m:GetFolderResponseMessage>',
      '<m:GetFolderResponseMessage ResponseClass="Error"><m:ResponseCode>ErrorFolderNotFound</m:ResponseCode></m:GetFolderResponseMessage>',
      '<m:GetFolderResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Folders><t:Folder><t:FolderId Id="f-3"/><t:DisplayName>Deleted</t:DisplayName><t:UnreadCount>1</t:UnreadCount></t:Folder></m:Folders></m:GetFolderResponseMessage>',
      '<m:GetFolderResponseMessage ResponseClass="Error"><m:ResponseCode>ErrorFolderNotFound</m:ResponseCode></m:GetFolderResponseMessage>',
      '<m:GetFolderResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Folders><t:Folder><t:FolderId Id="f-5"/><t:DisplayName>Junk</t:DisplayName><t:UnreadCount>0</t:UnreadCount></t:Folder></m:Folders></m:GetFolderResponseMessage>',
    ].join("");
    const fake = fakeFetch(() =>
      ok(soapEnvelope(`<m:GetFolderResponse><m:ResponseMessages>${messages}</m:ResponseMessages></m:GetFolderResponse>`)),
    );
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const folders = await source.listFolders();

    expect(folders.map((folder) => folder.role)).toEqual(["inbox", "sent", "trash", "junk"]);
    expect(folders.map((folder) => folder.id)).toEqual(["f-0", "f-1", "f-3", "f-5"]);
    expect(at(folders, 0).unreadCount).toBe(3);
  });
});

describe("EwsMailSource 写操作", () => {
  it("setFlags 只提交给出的字段（MarkAsRead → message:IsRead）", async () => {
    const fake = fakeFetch(() => ok(opResponse("UpdateItem", "")));
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    await source.setFlags({ id: "item-1" }, { read: true });

    const body = at(fake.requests, 0).init.body;
    expect(body).toContain("message:IsRead");
    expect(body).toContain("<t:IsRead>true</t:IsRead>");
    expect(body).not.toContain("FlagStatus");
  });

  it("move 返回服务器给的新 ItemId", async () => {
    const fake = fakeFetch(() =>
      ok(opResponse("MoveItem", '<m:Items><t:Message><t:ItemId Id="moved-id"/></t:Message></m:Items>')),
    );
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const moved = await source.move({ id: "item-1" }, "f-archive");

    expect(moved).toEqual({ id: "moved-id", folderId: "f-archive" });
    expect(at(fake.requests, 0).init.body).toContain('FolderId Id="f-archive"');
  });

  it("delete 默认 SoftDelete，permanent 才 HardDelete", async () => {
    const fake = fakeFetch(() => ok(opResponse("DeleteItem", "")));
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    await source.delete({ id: "item-1" });
    await source.delete({ id: "item-1" }, { permanent: true });

    expect(at(fake.requests, 0).init.body).toContain('DeleteType="SoftDelete"');
    expect(at(fake.requests, 1).init.body).toContain('DeleteType="HardDelete"');
  });

  it("search 组合 Contains/日期/未读条件并返回命中项", async () => {
    const fake = fakeFetch(() => ok(findItemResponse([findItemEntry("hit-1"), findItemEntry("hit-2")])));
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const hits = await source.search({ subject: "invoice", unreadOnly: true, since: "2026-11-01T00:00:00Z" });

    expect(hits.map((hit) => hit.id)).toEqual(["hit-1", "hit-2"]);
    const body = at(fake.requests, 0).init.body;
    expect(body).toContain('ContainmentMode="Substring"');
    expect(body).toContain("message:IsRead");
    expect(body).toContain("2026-11-01T00:00:00.000Z");
  });
});

describe("EwsMailSource 发信", () => {
  it("sendViaEws 用 CreateItem(SendAndSaveCopy) 写入服务器 Sent 副本", async () => {
    const fake = fakeFetch(() =>
      ok(opResponse("CreateItem", '<m:Items><t:Message><t:ItemId Id="sent-id"/></t:Message></m:Items>')),
    );
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });
    const mime = new Uint8Array(Buffer.from(MIME, "utf8"));

    const result = await source.sendViaEws({
      mime,
      to: ["user@example.com"],
      cc: [],
      bcc: [],
      from: "user@example.com",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.transport).toBe("ews");
      expect(result.messageId).toBe("sent-id");
      expect(result.savedToSent).toBe("server");
    }
    const body = at(fake.requests, 0).init.body;
    expect(body).toContain("SendAndSaveCopy");
    expect(body).toContain('DistinguishedFolderId Id="sentitems"');
    expect(body).toContain(MIME_BASE64);
  });

  it("发信失败返回 ok:false + 类型化错误，不抛异常也不回显密码", async () => {
    const fake = fakeFetch(() => ok(errorResponse("CreateItem", "ErrorAccessDenied", `bad ${SECRET}`)));
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const result = await source.sendViaEws({
      mime: new Uint8Array(Buffer.from(MIME, "utf8")),
      to: ["user@example.com"],
      cc: [],
      bcc: [],
      from: "user@example.com",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("auth");
      expect(result.detail).not.toContain(SECRET);
    }
  });
});

describe("错误映射", () => {
  const cases: readonly { code: string; expected: string; retryable: boolean }[] = [
    { code: "ErrorAccessDenied", expected: "auth", retryable: false },
    { code: "ErrorServerBusy", expected: "rate_limited", retryable: true },
    { code: "ErrorTimeoutExpired", expected: "network", retryable: true },
    { code: "ErrorInvalidOperation", expected: "unsupported", retryable: false },
    { code: "ErrorItemNotFound", expected: "protocol", retryable: false },
  ];

  for (const testCase of cases) {
    it(`${testCase.code} → ${testCase.expected}`, async () => {
      const verifyFake = fakeFetch(() => ok(errorResponse("GetFolder", testCase.code)));
      const verifySource = new EwsMailSource(ewsAccount(), { fetch: verifyFake.fetch });
      const result = await verifySource.verify();
      expect(result.ok).toBe(false);
      expect(result.detail.startsWith(`${testCase.expected}:`)).toBe(true);

      const sendFake = fakeFetch(() => ok(errorResponse("CreateItem", testCase.code)));
      const sendSource = new EwsMailSource(ewsAccount(), { fetch: sendFake.fetch });
      const sent = await sendSource.sendViaEws({
        mime: new Uint8Array(Buffer.from(MIME, "utf8")),
        to: ["user@example.com"],
        cc: [],
        bcc: [],
        from: "user@example.com",
      });
      expect(sent.ok).toBe(false);
      if (!sent.ok) {
        expect(sent.error).toBeInstanceOf(MailError);
        expect(sent.error.code).toBe(testCase.expected);
        expect(sent.error.retryable).toBe(testCase.retryable);
      }
    });
  }

  it("HTTP 500 → network（可重试），HTTP 404 → protocol（提示检查 ewsUrl）", async () => {
    const serverError = new EwsMailSource(ewsAccount(), { fetch: fakeFetch(() => failed(500, "boom")).fetch });
    const notFound = new EwsMailSource(ewsAccount(), { fetch: fakeFetch(() => failed(404, "not found")).fetch });

    const network = await serverError.verify();
    const protocol = await notFound.verify();

    expect(network.detail.startsWith("network:")).toBe(true);
    expect(protocol.detail.startsWith("protocol:")).toBe(true);
    expect(protocol.detail).toContain("EWS/Exchange.asmx");
  });

  it("SOAP Fault（HTTP 200）映射为 protocol 并保留可读原因", async () => {
    const fault = soapEnvelope('<soap:Fault><faultcode>soap:Server</faultcode><faultstring>server exploded</faultstring></soap:Fault>');
    const source = new EwsMailSource(ewsAccount(), { fetch: fakeFetch(() => ok(fault)).fetch });

    const result = await source.verify();

    expect(result.detail.startsWith("protocol:")).toBe(true);
    expect(result.detail).toContain("server exploded");
  });

  it("服务器回显的密码会被擦除", async () => {
    const fake = fakeFetch(() => ok(errorResponse("GetFolder", "ErrorAccessDenied", `bad password ${SECRET}`)));
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const result = await source.verify();

    expect(result.detail).not.toContain(SECRET);
    expect(result.detail).toContain("***");
  });
});

describe("NTLM", () => {
  function buildType2(): string {
    const targetInfo = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    const bytes = Buffer.alloc(56 + targetInfo.length);
    bytes.write("NTLMSSP\0", 0, "latin1");
    bytes.writeUInt32LE(2, 8);
    bytes.writeUInt32LE(0x0088_8207, 20);
    bytes.write("12345678", 24, "latin1");
    bytes.writeUInt16LE(targetInfo.length, 40);
    bytes.writeUInt16LE(targetInfo.length, 42);
    bytes.writeUInt32LE(56, 44);
    targetInfo.copy(bytes, 56);
    return bytes.toString("base64");
  }

  function decodeNtlmToken(authorization: string): Buffer {
    expect(authorization.startsWith("NTLM ")).toBe(true);
    return Buffer.from(authorization.slice(5), "base64");
  }

  it("md4 命中 RFC 1320 测试向量", () => {
    const hex = (text: string): string => Buffer.from(md4(new Uint8Array(Buffer.from(text, "utf8")))).toString("hex");
    expect(hex("")).toBe("31d6cfe0d16ae931b73c59d7e0c089c0");
    expect(hex("abc")).toBe("a448017aaf21d8525fc10ae87aa6729d");
    expect(hex("message digest")).toBe("d9130a8164549fe818874806e1c7014b");
  });

  it("parseNtlmChallenge 识别裸挑战与带 token 的挑战", () => {
    expect(parseNtlmChallenge(null)).toEqual({ offered: false, token: null });
    expect(parseNtlmChallenge("Negotiate")).toEqual({ offered: false, token: null });
    expect(parseNtlmChallenge("Negotiate, NTLM")).toEqual({ offered: true, token: null });
    expect(parseNtlmChallenge("NTLM TlRMTVNTUAACAAAA")).toEqual({ offered: true, token: "TlRMTVNTUAACAAAA" });
  });

  it("三次握手：无认证 → Type1 → Type2 → Type3", async () => {
    const type2 = buildType2();
    const fake = fakeFetch((request) => {
      switch (fake.requests.length) {
        case 1:
          expect(request.init.headers.Authorization).toBeUndefined();
          return failed(401, "", { "www-authenticate": "Negotiate, NTLM" });
        case 2:
          return failed(401, "", { "www-authenticate": `NTLM ${type2}` });
        default:
          return ok(opResponse("GetFolder", ""));
      }
    });
    const source = new EwsMailSource(ewsAccount({ authMode: "ntlm" }), { fetch: fake.fetch });

    const result = await source.verify();

    expect(result.ok).toBe(true);
    expect(fake.requests).toHaveLength(3);
    const type1 = decodeNtlmToken(authorizationOf(at(fake.requests, 1)));
    expect(type1.subarray(0, 8).toString("latin1")).toBe("NTLMSSP\u0000");
    expect(type1.readUInt32LE(8)).toBe(1);
    const type3 = decodeNtlmToken(authorizationOf(at(fake.requests, 2)));
    expect(type3.subarray(0, 8).toString("latin1")).toBe("NTLMSSP\u0000");
    expect(type3.readUInt32LE(8)).toBe(3);
  });

  it("NtlmClient 的 Type3 带 NTLMv2 响应（NTProofStr 长度 16）", () => {
    const client = new NtlmClient("user@example.com", SECRET, {
      domain: "CORP",
      nowMs: 1_760_000_000_000,
      clientChallenge: () => new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    const type3 = Buffer.from(client.authenticate(buildType2()), "base64");
    const lmLength = type3.readUInt16LE(12);
    const ntLength = type3.readUInt16LE(20);
    expect(lmLength).toBe(24);
    expect(ntLength).toBeGreaterThan(16);
    expect(type3.readUInt16LE(28)).toBeGreaterThan(0); // domain bytes
    expect(type3.readUInt16LE(36)).toBeGreaterThan(0); // user bytes
  });
});

describe("EwsMailSource receivedAt 语义", () => {
  it("fetch 用 DateTimeReceived 作接收时间，sentAt 取 Date 头（两者分开）", async () => {
    const received = "2026-11-05T03:00:00Z";
    const fake = fakeFetch((request) => {
      if (request.init.body.includes("FindItem")) return ok(findItemResponse([findItemEntry("item-1", received)]));
      if (request.init.body.includes("GetItem")) {
        return ok(opResponse("GetItem", `<m:Items>${mimeItem("item-1", received)}</m:Items>`));
      }
      throw new Error("未预期的请求");
    });
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const result = await source.fetch();

    expect(result.receivedAtByUid?.get("item-1")?.toISOString()).toBe("2026-11-05T03:00:00.000Z");
    // MIME 的 Date 头是 2026-11-04T01:00:00Z，没有被接收时间顶替
    expect(result.emails[0]?.sentAt).toBe("2026-11-04T01:00:00.000Z");
  });

  it("getMessage 的 receivedAt 取 DateTimeReceived，sentAt 取 DateTimeSent", async () => {
    const fake = fakeFetch(() => ok(opResponse("GetItem", `<m:Items>${FULL_MESSAGE_ITEM}</m:Items>`)));
    const source = new EwsMailSource(ewsAccount(), { fetch: fake.fetch });

    const body = await source.getMessage({ id: "item-1" });

    expect(body.receivedAt?.toISOString()).toBe("2026-11-04T01:31:00.000Z");
    expect(body.sentAt).toBe("2026-11-04T01:30:00.000Z");
  });
});
