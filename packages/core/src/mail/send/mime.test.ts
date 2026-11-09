import { describe, expect, it } from "vitest";
import { simpleParser } from "mailparser";
import { buildMime, forwardSubject, replySubject, type MimeComposeInput } from "./mime.js";
import { MailError } from "../types.js";

/**
 * MIME 构造的验收（AC-09）：不靠「看起来像」，而是用 mailparser 把生成的字节
 * 重新解析回来，断言收件人、主题编码、线程头、引用原文、附件文件名与字节。
 */

function compose(overrides: Partial<MimeComposeInput> = {}): MimeComposeInput {
  return {
    mode: "new",
    from: "me@example.com",
    fromName: null,
    to: ["alice@example.com"],
    cc: [],
    bcc: [],
    subject: "Hello",
    bodyText: "正文",
    bodyHtml: null,
    attachments: [],
    original: null,
    ...overrides,
  };
}

async function parse(mime: Uint8Array) {
  return simpleParser(Buffer.from(mime));
}

function addressList(value: unknown): string[] {
  const groups = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  const addresses: string[] = [];
  for (const group of groups) {
    if (typeof group !== "object" || group === null) continue;
    const values: unknown = Reflect.get(group, "value");
    if (!Array.isArray(values)) continue;
    for (const item of values) {
      if (typeof item !== "object" || item === null) continue;
      const address: unknown = Reflect.get(item, "address");
      if (typeof address === "string") addresses.push(address);
    }
  }
  return addresses;
}

function referencesOf(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

describe("buildMime — 新邮件", () => {
  it("写入 To/Cc/Bcc 与信封，中文主题按 RFC 2047 编码后可解码", async () => {
    const built = buildMime(
      compose({
        to: ["Alice <alice@example.com>"],
        cc: ["bob@example.com"],
        bcc: ["carol@example.com"],
        subject: "季度报告与下一步计划",
      }),
    );
    const parsed = await parse(built.mime);

    expect(parsed.subject).toBe("季度报告与下一步计划");
    expect(addressList(parsed.to)).toEqual(["alice@example.com"]);
    expect(addressList(parsed.cc)).toEqual(["bob@example.com"]);
    expect(addressList(parsed.bcc)).toEqual(["carol@example.com"]);
    // 信封（SMTP RCPT / Graph recipients 的来源）是纯地址。
    expect(built.request.to).toEqual(["alice@example.com"]);
    expect(built.request.cc).toEqual(["bob@example.com"]);
    expect(built.request.bcc).toEqual(["carol@example.com"]);
    expect(built.request.from).toBe("me@example.com");

    // 头部不含原始 CJK，只有编码字；行未超硬上限。
    const [head = ""] = Buffer.from(built.mime).toString("utf8").split("\r\n\r\n");
    expect(head).not.toContain("季度报告");
    expect(head).toContain("=?UTF-8?B?");
    for (const line of head.split("\r\n")) expect(line.length).toBeLessThanOrEqual(998);
  });

  it("多附件：文件名（中文/ASCII）与原始字节往返一致", async () => {
    const bytes = [0, 1, 2, 254, 255];
    const built = buildMime(
      compose({
        attachments: [
          {
            filename: "报告 2026.pdf",
            mimeType: "application/pdf",
            size: bytes.length,
            dataBase64: Buffer.from(bytes).toString("base64"),
          },
          {
            filename: "plain.txt",
            mimeType: "text/plain",
            size: 3,
            dataBase64: Buffer.from("abc").toString("base64"),
          },
        ],
      }),
    );
    const parsed = await parse(built.mime);
    expect(parsed.attachments).toHaveLength(2);
    const [first, second] = parsed.attachments;
    if (first === undefined || second === undefined) throw new Error("附件丢失");
    expect(first.filename).toBe("报告 2026.pdf");
    expect([...first.content]).toEqual(bytes);
    expect(first.contentType).toBe("application/pdf");
    expect(second.filename).toBe("plain.txt");
    expect(second.content.toString("utf8")).toBe("abc");
  });

  it("提供 HTML 时生成 text+html 双体；纯文本模式只有 text/plain", async () => {
    const both = buildMime(compose({ bodyText: "纯文本正文", bodyHtml: "<p>HTML <b>正文</b></p>" }));
    expect(Buffer.from(both.mime).toString("utf8")).toContain("multipart/alternative");
    const parsedBoth = await parse(both.mime);
    expect(parsedBoth.text).toContain("纯文本正文");
    expect(String(parsedBoth.html)).toContain("<b>正文</b>");

    const plain = buildMime(compose({ bodyText: "只有纯文本", bodyHtml: null }));
    expect(Buffer.from(plain.mime).toString("utf8")).not.toContain("multipart/alternative");
    expect(Buffer.from(plain.mime).toString("utf8")).toContain("text/plain");
  });

  it("HTML 双体与附件同时存在时嵌套 multipart 仍可正确解析（边界不冲突）", async () => {
    const built = buildMime(
      compose({
        bodyText: "纯文本正文",
        bodyHtml: "<p>HTML <b>正文</b></p>",
        attachments: [
          {
            filename: "数据.csv",
            mimeType: "text/csv",
            size: 3,
            dataBase64: Buffer.from("a,b").toString("base64"),
          },
        ],
      }),
    );
    const parsed = await parse(built.mime);
    expect(parsed.text).toContain("纯文本正文");
    expect(String(parsed.html)).toContain("<b>正文</b>");
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]?.filename).toBe("数据.csv");
    // 两个 boundary 必须不同。
    const raw = Buffer.from(built.mime).toString("utf8");
    const boundaries = new Set([...raw.matchAll(/boundary="([^"]+)"/g)].map((match) => match[1]));
    expect(boundaries.size).toBe(2);
  });

  it("附件类型非法时降级为 application/octet-stream", async () => {
    const built = buildMime(
      compose({
        attachments: [
          {
            filename: "x.bin",
            mimeType: "text/plain; name=evil",
            size: 1,
            dataBase64: Buffer.from("x").toString("base64"),
          },
        ],
      }),
    );
    const parsed = await parse(built.mime);
    expect(parsed.attachments[0]?.contentType).toBe("application/octet-stream");
  });

  it("生成合法 Message-ID 与 Date 头", async () => {
    const built = buildMime(compose());
    expect(built.messageId).toMatch(/^<[^<>@]+@example\.com>$/);
    expect(Buffer.from(built.mime).toString("utf8")).toContain(`Message-ID: ${built.messageId}`);
    expect(Buffer.from(built.mime).toString("utf8")).toMatch(/^Date: .+ \+0000$/m);
  });
});

describe("buildMime — 回复", () => {
  const original = {
    messageId: "<orig-1@example.com>",
    fromName: "Alice",
    fromEmail: "alice@example.com",
    date: "2026-11-01T02:00:00.000Z",
    bodyText: "第一行\n第二行",
  } as const;

  it("自动加 Re:、In-Reply-To/References 与引用原文", async () => {
    const built = buildMime(compose({ mode: "reply", subject: "Hello", bodyText: "收到，谢谢。", original }));
    const parsed = await parse(built.mime);

    expect(parsed.subject).toBe("Re: Hello");
    expect(parsed.inReplyTo).toBe("<orig-1@example.com>");
    expect(referencesOf(parsed.references)).toEqual(["<orig-1@example.com>"]);
    expect(parsed.text).toContain("> 第一行");
    expect(parsed.text).toContain("> 第二行");
    expect(parsed.text).toContain("Alice <alice@example.com>");
    expect(built.inReplyTo).toBe("<orig-1@example.com>");
    expect(built.references).toEqual(["<orig-1@example.com>"]);
  });

  it("已有 Re: 前缀不重复；References 接在父链末尾", async () => {
    const built = buildMime(
      compose({
        mode: "reply",
        subject: "RE: Hello",
        original: { ...original, references: ["<root@example.com>", "<parent@example.com>"] },
      }),
    );
    const parsed = await parse(built.mime);
    expect(parsed.subject).toBe("RE: Hello");
    expect(referencesOf(parsed.references)).toEqual([
      "<root@example.com>",
      "<parent@example.com>",
      "<orig-1@example.com>",
    ]);
  });

  it("HTML 回复把原文放进 blockquote", async () => {
    const built = buildMime(
      compose({
        mode: "reply",
        bodyHtml: "<p>收到</p>",
        original: { ...original, bodyHtml: "<p>原始 <b>HTML</b></p>" },
      }),
    );
    const parsed = await parse(built.mime);
    expect(String(parsed.html)).toContain("<blockquote>");
    expect(String(parsed.html)).toContain("原始 <b>HTML</b>");
  });
});

describe("buildMime — 转发", () => {
  const original = {
    messageId: "<orig-2@example.com>",
    fromName: "Alice",
    fromEmail: "alice@example.com",
    to: ["me@example.com"],
    subject: "Notes",
    date: "2026-11-02T03:00:00.000Z",
    bodyText: "转发的原文",
  } as const;

  it("自动加 Fwd:、保留原文与头部块，且不设置线程头", async () => {
    const built = buildMime(compose({ mode: "forward", subject: "Notes", bodyText: "见下。", original }));
    const parsed = await parse(built.mime);

    expect(parsed.subject).toBe("Fwd: Notes");
    expect(parsed.inReplyTo).toBeUndefined();
    expect(parsed.references).toBeUndefined();
    expect(parsed.text).toContain("---------- 转发的邮件 ----------");
    expect(parsed.text).toContain("发件人: Alice <alice@example.com>");
    expect(parsed.text).toContain("转发的原文");
  });

  it("已有 Fwd:/Fw: 前缀不重复", () => {
    expect(forwardSubject("Fwd: Notes")).toBe("Fwd: Notes");
    expect(forwardSubject("FW: Notes")).toBe("FW: Notes");
    expect(forwardSubject("Notes")).toBe("Fwd: Notes");
    expect(replySubject("Re: Hello")).toBe("Re: Hello");
  });
});

describe("buildMime — 输入防护", () => {
  it("主题含换行时拒绝（头注入）", () => {
    expect(() => buildMime(compose({ subject: "Hello\r\nBcc: evil@example.com" }))).toThrowError(MailError);
    try {
      buildMime(compose({ subject: "Hello\nX: y" }));
    } catch (err) {
      expect(err).toBeInstanceOf(MailError);
      expect((err as MailError).code).toBe("protocol");
    }
  });

  it("地址含换行或非法格式时拒绝", () => {
    expect(() => buildMime(compose({ to: ["alice@example.com\r\nBcc: evil@example.com"] }))).toThrowError(MailError);
    expect(() => buildMime(compose({ to: ["not-an-address"] }))).toThrowError(MailError);
  });

  it("没有收件人时拒绝", () => {
    expect(() => buildMime(compose({ to: [], cc: [], bcc: [] }))).toThrowError(MailError);
  });
});
