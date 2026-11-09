import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawEmail, ServerEvent } from "@mailcollect/shared";
import type {
  AttachmentData,
  MailSource,
  MessageBody as MailMessageBody,
  MessageRef,
} from "@mailcollect/core";
import { MailError, openStore, type Store } from "@mailcollect/core";
import { createApp } from "../app.js";
import { createEventBus, type EventBus, type ServerServices } from "../services.js";
import { sanitizeHtml } from "./mail.js";

/**
 * 服务端读信端点（C5 / AC-14/15/16/17）的 fixture 测试。
 *
 * 全部走真实 `Store`（临时 SQLite）+ 注入的假适配器：路由层只能看到
 * `services.mailSource` 端口，测试因此同时覆盖「有服务器 / 纯本地」两种模式。
 */

const TOKEN = "test-token";

let dir: string;
let store: Store;
let accountId: string;
let app: ReturnType<typeof createApp>;
let events: EventBus;

const baseServices = (): ServerServices => ({
  verifyAccount: vi.fn(async () => ({ ok: true, detail: "OK" })),
  loginAccount: vi.fn(async () => undefined),
  syncAccount: vi.fn(async () => undefined),
  extract: vi.fn(async () => ({ done: 0, total: 0 })),
  testLlm: vi.fn(async () => ({ ok: true, latencyMs: 1, detail: "pong" })),
  startBackground: vi.fn(),
  stopBackground: vi.fn(async () => undefined),
});

const buildApp = (source?: MailSource): void => {
  events = createEventBus();
  app = createApp({
    store,
    services: {
      ...baseServices(),
      events,
      ...(source ? { mailSource: () => source } : {}),
    },
    token: TOKEN,
    version: "test",
  });
};

const call = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("content-type", "application/json");
  return Promise.resolve(app.request(path, { ...init, headers }));
};

const bodyOf = async <T>(res: Response): Promise<T> => (await res.json()) as T;

const emailOf = (id: string, patch: Partial<RawEmail> = {}): RawEmail => ({
  id,
  accountId,
  uid: `uid-${id}`,
  messageId: `<${id}@corp.com>`,
  threadId: null,
  fromName: "李雷",
  fromEmail: "lilei@corp.com",
  to: ["me@corp.com"],
  cc: [],
  subject: "预算确认",
  sentAt: "2026-11-02T09:00:00.000Z",
  bodyText: "请确认预算。",
  hasAttachments: false,
  headers: {},
  createdAt: "2026-11-02T09:00:01.000Z",
  ...patch,
});

const seedEmail = (id: string, patch: Partial<RawEmail> = {}): void => {
  store.upsertEmails([emailOf(id, patch)]);
};

const seedFolders = (): void => {
  store.replaceFolders(accountId, [
    { accountId, path: "INBOX", role: "inbox", unread: 2 },
    { accountId, path: "Sent", role: "sent", unread: 0 },
    { accountId, path: "Trash", role: "trash", unread: 0 },
    { accountId, path: "Archive", role: "archive", unread: 1 },
  ]);
};

const makeSource = (overrides: Partial<MailSource> = {}): MailSource => ({
  provider: "imap",
  verify: vi.fn(async () => ({ ok: true, detail: "OK" })),
  fetch: vi.fn(async () => ({ emails: [], cursor: null, hasMore: false })),
  close: vi.fn(async () => undefined),
  ...overrides,
});

const remoteMessage = (patch: Partial<MailMessageBody> = {}): MailMessageBody => ({
  id: "uid-e1",
  folderId: "INBOX",
  subject: "预算确认",
  fromName: "李雷",
  fromEmail: "lilei@corp.com",
  to: ["me@corp.com"],
  cc: [],
  sentAt: "2026-11-02T09:00:00.000Z",
  isRead: false,
  text: "服务器纯文本",
  html: null,
  attachments: [],
  ...patch,
});

const attachmentInfo = (
  id: string,
  filename: string,
  mimeType: string,
  inline = false,
): { id: string; filename: string; mimeType: string; size: number; inline: boolean } => ({
  id,
  filename,
  mimeType,
  size: 5,
  inline,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mailcollect-mail-"));
  store = await openStore(join(dir, "db.sqlite"), "device-test");
  accountId = store.createAccount({
    provider: "imap",
    label: "测试邮箱",
    email: "me@corp.com",
    config: { host: "imap.corp.com" },
    secret: "app-password",
  }).id;
  buildApp();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/folders", () => {
  it("requires accountId and rejects an unknown account with typed 400/404", async () => {
    const missing = await call("/api/folders");
    expect(missing.status).toBe(400);
    expect((await bodyOf<{ error: { code: string } }>(missing)).error.code).toBe(
      "invalid_input",
    );

    const unknown = await call("/api/folders?accountId=nope");
    expect(unknown.status).toBe(404);
    expect((await bodyOf<{ error: { code: string } }>(unknown)).error.code).toBe("not_found");
  });

  it("returns the stored snapshot with unread counts (no adapter round-trip)", async () => {
    const listFolders = vi.fn(async () => []);
    buildApp(makeSource({ listFolders }));
    seedFolders();

    const res = await call(`/api/folders?accountId=${accountId}`);
    expect(res.status).toBe(200);
    const body = await bodyOf<{
      items: Array<{ path: string; role: string; unread: number; accountId: string }>;
    }>(res);
    expect(body.items.map((item) => item.path)).toEqual(["Archive", "INBOX", "Sent", "Trash"]);
    const inbox = body.items.find((item) => item.role === "inbox");
    expect(inbox).toMatchObject({ path: "INBOX", accountId, unread: 2 });
    expect(listFolders).not.toHaveBeenCalled();
  });

  it("fills an empty snapshot from the adapter and persists it", async () => {
    const close = vi.fn(async () => undefined);
    buildApp(
      makeSource({
        close,
        listFolders: vi.fn(async () => [
          { id: "INBOX", name: "收件箱", role: "inbox" as const, unreadCount: 5 },
          { id: "Archive", name: "归档", role: "archive" as const, unreadCount: 1 },
        ]),
      }),
    );

    const res = await call(`/api/folders?accountId=${accountId}`);
    expect(res.status).toBe(200);
    const body = await bodyOf<{ items: Array<{ path: string; unread: number }> }>(res);
    expect(body.items).toEqual([
      { accountId, path: "Archive", role: "archive", unread: 1 },
      { accountId, path: "INBOX", role: "inbox", unread: 5 },
    ]);
    expect(store.listFolders(accountId)).toHaveLength(2);
    expect(close).toHaveBeenCalled();
  });
});

describe("GET /api/messages", () => {
  it("lists the inbox with folder, read state, snippet and labels", async () => {
    seedEmail("e1", {
      subject: "Quarterly REPORT",
      bodyText: "第一行\n\n  第二行   第三行",
      hasAttachments: true,
    });
    seedEmail("e2", {
      subject: "已发送",
      bodyText: "x",
      sentAt: "2026-11-01T09:00:00.000Z",
    });
    store.moveEmail("e2", "Sent");
    store.markEmailRead("e1", true);
    const category = store.createCategory({ name: "测试分类-点名", enterTodo: true, broadcast: false });
    store.replaceTagsForEmail("e1", [{ categoryId: category.id, ruleId: null }]);

    const res = await call("/api/messages");
    expect(res.status).toBe(200);
    const body = await bodyOf<{
      items: Array<{
        id: string;
        folder: string;
        isRead: boolean;
        snippet: string;
        hasAttachments: boolean;
        categoryIds: string[];
        fromEmail: string;
      }>;
      nextCursor: string | null;
    }>(res);

    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      id: "e1",
      folder: "INBOX",
      isRead: true,
      hasAttachments: true,
      fromEmail: "lilei@corp.com",
      categoryIds: [category.id],
    });
    expect(body.items[0]?.snippet).toBe("第一行 第二行 第三行");
    expect(body.nextCursor).toBeNull();
  });

  it("truncates the snippet by code point and paginates without duplicates", async () => {
    seedEmail("late", {
      subject: "late",
      sentAt: "2026-11-03T09:00:00.000Z",
      bodyText: "报".repeat(200),
    });
    seedEmail("early", { subject: "early", sentAt: "2026-11-01T09:00:00.000Z" });
    seedEmail("mid", { subject: "mid", sentAt: "2026-11-02T09:00:00.000Z" });

    const first = await call("/api/messages?limit=2");
    const firstBody = await bodyOf<{
      items: Array<{ id: string; snippet: string }>;
      nextCursor: string | null;
    }>(first);
    expect(firstBody.items.map((item) => item.id)).toEqual(["late", "mid"]);
    expect(firstBody.items[0]?.snippet).toBe(`${"报".repeat(160)}…`);
    expect(firstBody.nextCursor).not.toBeNull();

    const second = await call(
      `/api/messages?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
    );
    const secondBody = await bodyOf<{ items: Array<{ id: string }>; nextCursor: string | null }>(
      second,
    );
    expect(secondBody.items.map((item) => item.id)).toEqual(["early"]);
    expect(secondBody.nextCursor).toBeNull();
  });

  it("searches subject, sender and body case-insensitively (AC-17)", async () => {
    seedEmail("subject-hit", { subject: "QUARTERLY Report", sentAt: "2026-11-02T09:00:00.000Z" });
    seedEmail("from-hit", {
      fromEmail: "Boss@Corp.com",
      subject: "预算确认",
      bodyText: "请确认预算。",
      sentAt: "2026-11-01T09:00:00.000Z",
    });
    seedEmail("body-hit", {
      subject: "跟进",
      bodyText: "张三，请把季度报告和 REPORT 一起发我。",
      sentAt: "2026-11-03T09:00:00.000Z",
    });

    const bySubject = await call("/api/messages?search=report");
    expect((await bodyOf<{ items: Array<{ id: string }> }>(bySubject)).items.map((i) => i.id)).toEqual(
      ["body-hit", "subject-hit"],
    );

    const bySender = await call("/api/messages?search=boss@CORP");
    expect((await bodyOf<{ items: Array<{ id: string }> }>(bySender)).items.map((i) => i.id)).toEqual([
      "from-hit",
    ]);

    const byBody = await call(`/api/messages?search=${encodeURIComponent("季度报告")}`);
    expect((await bodyOf<{ items: Array<{ id: string }> }>(byBody)).items.map((i) => i.id)).toEqual([
      "body-hit",
    ]);

    const none = await call("/api/messages?search=nomatch");
    expect((await bodyOf<{ items: unknown[] }>(none)).items).toHaveLength(0);
  });

  it("filters by unreadOnly and by category id (ANY semantics)", async () => {
    seedEmail("read", { sentAt: "2026-11-02T09:00:00.000Z" });
    seedEmail("unread", { sentAt: "2026-11-03T09:00:00.000Z" });
    store.markEmailRead("read", true);
    const category = store.createCategory({ name: "测试分类-群发", enterTodo: false, broadcast: true });
    store.replaceTagsForEmail("read", [{ categoryId: category.id, ruleId: null }]);

    const unread = await call("/api/messages?unreadOnly=true");
    expect((await bodyOf<{ items: Array<{ id: string }> }>(unread)).items.map((i) => i.id)).toEqual([
      "unread",
    ]);

    const tagged = await call(`/api/messages?categoryIds=${encodeURIComponent(category.id)}`);
    expect((await bodyOf<{ items: Array<{ id: string }> }>(tagged)).items.map((i) => i.id)).toEqual([
      "read",
    ]);

    const multi = await call(
      `/api/messages?categoryIds=${encodeURIComponent(category.id)}&categoryIds=other`,
    );
    expect((await bodyOf<{ items: Array<{ id: string }> }>(multi)).items).toHaveLength(1);
  });

  it("resolves a folder role name to the stored folder path", async () => {
    seedEmail("archived");
    store.moveEmail("archived", "Archive");
    seedFolders();

    const byRole = await call(`/api/messages?accountId=${accountId}&folder=archive`);
    const body = await bodyOf<{ items: Array<{ id: string; folder: string }> }>(byRole);
    expect(body.items.map((item) => item.id)).toEqual(["archived"]);
    expect(body.items[0]?.folder).toBe("Archive");

    const inbox = await call(`/api/messages?accountId=${accountId}`);
    expect((await bodyOf<{ items: unknown[] }>(inbox)).items).toHaveLength(0);
  });
});

describe("local mode without a folder snapshot (T65 F3)", () => {
  it("lists locally stored mail without any folder rows", async () => {
    seedEmail("a1");
    buildApp(); // 纯本地模式：没有适配器、也从没写过 folder 行

    const all = await bodyOf<{ items: Array<{ id: string }> }>(await call("/api/messages"));
    expect(all.items.map((item) => item.id)).toEqual(["a1"]);

    const byAccount = await bodyOf<{ items: Array<{ id: string }> }>(
      await call(`/api/messages?accountId=${accountId}`),
    );
    expect(byAccount.items.map((item) => item.id)).toEqual(["a1"]);

    const literal = await bodyOf<{ items: Array<{ id: string }> }>(
      await call(`/api/messages?accountId=${accountId}&folder=INBOX`),
    );
    expect(literal.items.map((item) => item.id)).toEqual(["a1"]);

    // 小写 inbox 是「角色名」写法：没有 folder 行时必须落到字面 INBOX，而不是造一个 "inbox" 路径。
    const roleName = await bodyOf<{ items: Array<{ id: string }> }>(
      await call(`/api/messages?accountId=${accountId}&folder=inbox`),
    );
    expect(roleName.items.map((item) => item.id)).toEqual(["a1"]);
  });

  it("moves to the literal INBOX when the inbox role has no folder row", async () => {
    seedEmail("a1");
    buildApp();

    const res = await call("/api/messages/a1/move", {
      method: "POST",
      body: JSON.stringify({ folder: "inbox" }),
    });
    expect(res.status).toBe(200);
    expect(store.getEmailState("a1")?.folder).toBe("INBOX");

    const listed = await bodyOf<{ items: Array<{ id: string }> }>(
      await call(`/api/messages?accountId=${accountId}&folder=INBOX`),
    );
    expect(listed.items.map((item) => item.id)).toEqual(["a1"]);
  });

  it("keeps the literal role name when no folder row exists instead of inventing a path", async () => {
    seedEmail("a1");
    buildApp();

    const res = await call("/api/messages/a1/move", {
      method: "POST",
      body: JSON.stringify({ folder: "archive" }),
    });
    expect(res.status).toBe(200);
    expect(store.getEmailState("a1")?.folder).toBe("archive");
  });
});

describe("GET /api/messages/:id", () => {
  it("returns local text, sanitized html, attachment metadata and labels", async () => {
    seedEmail("e1", { bodyText: "本地纯文本" });
    const category = store.createCategory({ name: "测试分类-点名", enterTodo: true, broadcast: false });
    store.replaceTagsForEmail("e1", [{ categoryId: category.id, ruleId: null }]);
    const getMessage = vi.fn(
      async (_ref: MessageRef): Promise<MailMessageBody> =>
        remoteMessage({
          html: '<p onclick="steal()">hi</p><script>alert(1)</script><iframe src="https://x"></iframe><a href="https://ok.example">ok</a>',
          attachments: [
            attachmentInfo("att-1", "报告.pdf", "application/pdf"),
            attachmentInfo("att-2", "logo.png", "image/png", true),
          ],
        }),
    );
    buildApp(makeSource({ getMessage }));

    const res = await call("/api/messages/e1");
    expect(res.status).toBe(200);
    const body = await bodyOf<{
      body: { text: string; html: string | null };
      attachments: Array<{ id: string }>;
      folder: string;
      isRead: boolean;
      categoryIds: string[];
      message: RawEmail;
    }>(res);

    expect(body.message.id).toBe("e1");
    expect(body.body.text).toBe("本地纯文本");
    expect(body.body.html).toContain('<p>hi</p>');
    expect(body.body.html).not.toContain("<script");
    expect(body.body.html).not.toContain("<iframe");
    expect(body.body.html).not.toContain("onclick");
    expect(body.attachments.map((item) => item.id)).toEqual(["att-1"]);
    expect(body.folder).toBe("INBOX");
    expect(body.isRead).toBe(false);
    expect(body.categoryIds).toEqual([category.id]);
    expect(getMessage).toHaveBeenCalledWith({ id: "uid-e1", folderId: "INBOX" });
  });

  it("degrades to local plain text when no adapter is wired", async () => {
    seedEmail("e1", { bodyText: "本地纯文本" });
    const res = await call("/api/messages/e1");
    expect(res.status).toBe(200);
    const body = await bodyOf<{
      body: { text: string; html: string | null };
      attachments: unknown[];
    }>(res);
    expect(body.body).toEqual({ text: "本地纯文本", html: null });
    expect(body.attachments).toEqual([]);
  });

  it("degrades to local text when the adapter fails instead of 500", async () => {
    seedEmail("e1", { bodyText: "本地纯文本" });
    const getMessage = vi.fn(
      async (_ref: MessageRef): Promise<MailMessageBody> => {
        throw new MailError("network", "连接超时", true);
      },
    );
    buildApp(makeSource({ getMessage }));

    const res = await call("/api/messages/e1");
    expect(res.status).toBe(200);
    const body = await bodyOf<{ body: { text: string; html: string | null } }>(res);
    expect(body.body).toEqual({ text: "本地纯文本", html: null });
  });

  it("returns typed 404 for an unknown message", async () => {
    const res = await call("/api/messages/nope");
    expect(res.status).toBe(404);
    expect((await bodyOf<{ error: { code: string } }>(res)).error.code).toBe("not_found");
  });
});

describe("sanitizeHtml (AC-16)", () => {
  it("removes scripts, event handlers, iframes and javascript: URLs", () => {
    expect(sanitizeHtml('<p onclick="steal()">hi</p>')).toBe("<p>hi</p>");
    expect(sanitizeHtml("<script>alert(1)</script><p>ok</p>")).toBe("<p>ok</p>");
    expect(sanitizeHtml('<SCRIPT>alert(1)</SCRIPT><p>ok</p>')).toBe("<p>ok</p>");
    expect(sanitizeHtml('<iframe src="https://evil.example"></iframe>')).toBe("");
    expect(sanitizeHtml('<object data="x"></object><embed src="x">')).toBe("");
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="java\tscript:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="java&#x09;script:alert(1)">x</a>')).toBe("<a>x</a>");
    expect(sanitizeHtml('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>')).toBe("<a>x</a>");
    const svgData = sanitizeHtml('<img src="data:image/svg+xml;base64,AAA" onerror="x()">') ?? "";
    expect(svgData).not.toContain("data:image/svg");
    expect(svgData).not.toContain("onerror");
    expect(sanitizeHtml(null)).toBeNull();
  });

  it("keeps ordinary markup and whitelisted URL schemes intact", () => {
    expect(sanitizeHtml("<p>普通文本 <strong>加粗</strong></p>")).toBe(
      "<p>普通文本 <strong>加粗</strong></p>",
    );
    expect(sanitizeHtml('<a href="https://ok.example/a">x</a>')).toBe(
      '<a href="https://ok.example/a">x</a>',
    );
    // T65 F2：URL scheme 白名单只有 http/https/mailto/cid；data: 一律剔除。
    expect(sanitizeHtml('<img src="data:image/png;base64,AAA">')).toBe("<img>");
    expect(sanitizeHtml('<img src="cid:logo@corp">')).toBe('<img src="cid:logo@corp">');
  });
});

describe("sanitizeHtml — T65 F1/F2 separators & entities", () => {
  it("drops event handlers that follow a quoted value or a slash (F1)", () => {
    const vectors = [
      '<img src="x"onerror=alert(1)>',
      "<img/onerror=alert(1)>",
      "<svg/onload=alert(1)>",
      '<a href="x"onmouseover="alert(1)">y</a>',
      '<IMG SRC="x"ONERROR=alert(1)>',
      '<a href="x"\tonmouseover="alert(1)">y</a>',
    ];
    for (const vector of vectors) {
      const out = (sanitizeHtml(vector) ?? "").toLowerCase();
      expect(out).not.toContain("onerror");
      expect(out).not.toContain("onload");
      expect(out).not.toContain("onmouseover");
    }
  });

  it("neutralizes javascript: URLs regardless of separators and unbounded entities (F2)", () => {
    const vectors = [
      '<a/href="javascript:alert(1)">x</a>',
      '<a href="&#x0000006a;avascript:alert(1)">x</a>',
      '<a href="&#00000106;avascript:alert(1)">x</a>',
      '<a href="JaVaScRiPt:alert(1)">x</a>',
      '<a href="vbscript:msgbox(1)">x</a>',
      '<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>',
      '<a href="java\tscript:alert(1)">x</a>',
    ];
    for (const vector of vectors) {
      const out = (sanitizeHtml(vector) ?? "").toLowerCase();
      expect(out).not.toContain("javascript:");
      expect(out).not.toContain("vbscript:");
      expect(out).not.toContain("data:text/html");
    }
  });

  it("keeps only whitelisted tags/attributes (event/style/id/class never survive)", () => {
    expect(sanitizeHtml('<div style="background:url(javascript:1)" id="x" class="y">t</div>')).toBe(
      "<div>t</div>",
    );
    expect(sanitizeHtml('<form action="javascript:1"><input onfocus="x()"></form>t')).toBe(
      "t",
    );
  });
});

describe("sanitizeHtml end-to-end in GET /api/messages/:id (T65 F1)", () => {
  it("never returns a live event handler in body.html", async () => {
    seedEmail("e1");
    buildApp(
      makeSource({
        getMessage: vi.fn(
          async (_ref: MessageRef): Promise<MailMessageBody> =>
            remoteMessage({
              html: '<p onclick="a()">hi</p><img src="x"onerror=alert(1)><svg/onload=alert(1)>',
            }),
        ),
      }),
    );
    const body = await bodyOf<{ body: { html: string | null } }>(await call("/api/messages/e1"));
    const html = body.body.html ?? "";
    expect(html).not.toContain("onerror");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("onload");
    expect(html).toContain("<p>hi</p>");
  });
});

describe("attachments", () => {
  const detailSource = (): { source: MailSource; getMessage: ReturnType<typeof vi.fn> } => {
    const getMessage = vi.fn(
      async (_ref: MessageRef): Promise<MailMessageBody> =>
        remoteMessage({
          html: "<p>hi</p>",
          attachments: [
            attachmentInfo("att-1", "报告.pdf", "application/pdf"),
            attachmentInfo("att-2", "logo.png", "image/png", true),
          ],
        }),
    );
    const getAttachment = vi.fn(
      async (_ref: MessageRef, _id: string): Promise<AttachmentData> => ({
        info: attachmentInfo("att-1", "报告.pdf", "application/pdf"),
        content: new Uint8Array([1, 2, 3, 4, 5]),
      }),
    );
    return { source: makeSource({ getMessage, getAttachment }), getMessage };
  };

  it("lists only non-inline attachments", async () => {
    seedEmail("e1");
    const { source } = detailSource();
    buildApp(source);

    const res = await call("/api/messages/e1/attachments");
    expect(res.status).toBe(200);
    const body = await bodyOf<{ items: Array<{ id: string; filename: string }> }>(res);
    expect(body.items).toEqual([
      { id: "att-1", filename: "报告.pdf", mimeType: "application/pdf", size: 5 },
    ]);
  });

  it("downloads raw bytes with Content-Type and an RFC 5987 filename (AC-15)", async () => {
    seedEmail("e1");
    const { source } = detailSource();
    buildApp(source);

    const res = await call("/api/messages/e1/attachments/att-1");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-length")).toBe("5");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const disposition = res.headers.get("content-disposition") ?? "";
    expect(disposition).toContain('filename="__.pdf"');
    expect(disposition).toContain(
      "filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf",
    );
    expect(disposition).not.toContain("\r");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("returns typed 404 for an attachment that is not on the message", async () => {
    seedEmail("e1");
    const { source } = detailSource();
    buildApp(source);

    const res = await call("/api/messages/e1/attachments/att-9");
    expect(res.status).toBe(404);
    expect((await bodyOf<{ error: { code: string } }>(res)).error.code).toBe("not_found");
  });

  it("returns typed 404 for an unknown message", async () => {
    seedEmail("e1");
    const { source } = detailSource();
    buildApp(source);

    const res = await call("/api/messages/nope/attachments");
    expect(res.status).toBe(404);
  });

  it("returns typed 502 when no adapter is available for bytes", async () => {
    seedEmail("e1");
    const res = await call("/api/messages/e1/attachments/att-1");
    expect(res.status).toBe(502);
    expect((await bodyOf<{ error: { code: string } }>(res)).error.code).toBe("upstream_error");
  });

  it("maps an adapter auth failure to a typed 401", async () => {
    seedEmail("e1");
    const getMessage = vi.fn(async (_ref: MessageRef): Promise<MailMessageBody> => {
      throw new MailError("auth", "登录已失效，请重新授权", false);
    });
    buildApp(makeSource({ getMessage }));

    const res = await call("/api/messages/e1/attachments");
    expect(res.status).toBe(401);
    expect((await bodyOf<{ error: { code: string } }>(res)).error.code).toBe("unauthorized");
  });

  it("falls back to application/octet-stream for executable Content-Types (T65 F4)", async () => {
    seedEmail("e1");
    const getMessage = vi.fn(
      async (_ref: MessageRef): Promise<MailMessageBody> =>
        remoteMessage({
          attachments: [
            { id: "att-html", filename: "page.html", mimeType: "text/html", size: 5, inline: false },
            { id: "att-svg", filename: "logo.svg", mimeType: "image/svg+xml", size: 5, inline: false },
          ],
        }),
    );
    const getAttachment = vi.fn(
      async (_ref: MessageRef, attachmentId: string): Promise<AttachmentData> => ({
        info: {
          id: attachmentId,
          filename: attachmentId === "att-svg" ? "logo.svg" : "page.html",
          mimeType: attachmentId === "att-svg" ? "image/svg+xml" : "text/html",
          size: 5,
          inline: false,
        },
        content: new Uint8Array([1, 2, 3, 4, 5]),
      }),
    );
    buildApp(makeSource({ getMessage, getAttachment }));

    const html = await call("/api/messages/e1/attachments/att-html");
    expect(html.status).toBe(200);
    expect(html.headers.get("content-type")).toBe("application/octet-stream");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");

    const svg = await call("/api/messages/e1/attachments/att-svg");
    expect(svg.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("redacts account secrets from adapter errors in responses and SSE (T65 F5)", async () => {
    const secret = "TOPSECRET-XYZ";
    const secretAccountId = store.createAccount({
      provider: "imap",
      label: "带密钥的账号",
      email: "secret@corp.com",
      config: { host: "imap.corp.com" },
      secret,
    }).id;
    store.upsertEmails([emailOf("e-secret", { accountId: secretAccountId, uid: "uid-secret" })]);

    const getMessage = vi.fn(async (_ref: MessageRef): Promise<MailMessageBody> => {
      throw new MailError("auth", `bad creds ${secret}`, false);
    });
    buildApp(makeSource({ getMessage }));
    const emitted: ServerEvent[] = [];
    events.subscribe((event) => emitted.push(event));

    const attachmentRes = await call("/api/messages/e-secret/attachments");
    expect(attachmentRes.status).toBe(401);
    expect(await attachmentRes.text()).not.toContain(secret);

    // 详情路径把适配器失败降级为本地文本 + SSE error，SSE 里也不能出现密码。
    const detail = await call("/api/messages/e-secret");
    expect(detail.status).toBe(200);
    const sseText = emitted
      .filter((event) => event.type === "error")
      .map((event) => JSON.stringify(event))
      .join(" ");
    expect(sseText).not.toContain(secret);
    expect(sseText.length).toBeGreaterThan(0);
  });
});

describe("read / move / delete", () => {
  it("marks read and unread, mirrors the server flag and adjusts folder unread", async () => {
    seedEmail("e1");
    seedFolders();
    const setFlags = vi.fn(async (_ref: MessageRef, _patch: { read?: boolean }): Promise<void> => {});
    buildApp(makeSource({ setFlags }));

    const markRead = await call("/api/messages/e1", {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
    });
    expect(markRead.status).toBe(200);
    expect(setFlags).toHaveBeenLastCalledWith(
      { id: "uid-e1", folderId: "INBOX" },
      { read: true },
    );
    expect(store.getEmailState("e1")?.isRead).toBe(true);
    expect(store.listFolders(accountId).find((item) => item.path === "INBOX")?.unread).toBe(1);

    const markUnread = await call("/api/messages/e1", {
      method: "PATCH",
      body: JSON.stringify({ isRead: false }),
    });
    expect(markUnread.status).toBe(200);
    expect(store.getEmailState("e1")?.isRead).toBe(false);
    expect(store.listFolders(accountId).find((item) => item.path === "INBOX")?.unread).toBe(2);
  });

  it("applies read state locally when the protocol has no flag support", async () => {
    seedEmail("e1");
    buildApp(makeSource());

    const res = await call("/api/messages/e1", {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
    });
    expect(res.status).toBe(200);
    expect(store.getEmailState("e1")?.isRead).toBe(true);
  });

  it("rejects a patch without a boolean isRead and an unknown message", async () => {
    seedEmail("e1");
    const noFlag = await call("/api/messages/e1", {
      method: "PATCH",
      body: JSON.stringify({}),
    });
    expect(noFlag.status).toBe(400);
    expect((await bodyOf<{ error: { code: string } }>(noFlag)).error.code).toBe("invalid_input");

    const unknown = await call("/api/messages/nope", {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
    });
    expect(unknown.status).toBe(404);
  });

  it("moves a message to a role folder and re-reads it through the new server ref", async () => {
    seedEmail("e1");
    seedFolders();
    const move = vi.fn(
      async (_ref: MessageRef, _target: string): Promise<MessageRef | null> => ({
        id: "uid-e1-new",
        folderId: "Archive",
      }),
    );
    const getMessage = vi.fn(
      async (_ref: MessageRef): Promise<MailMessageBody> => remoteMessage({ html: "<p>moved</p>" }),
    );
    buildApp(makeSource({ move, getMessage }));

    const res = await call("/api/messages/e1/move", {
      method: "POST",
      body: JSON.stringify({ folder: "archive" }),
    });
    expect(res.status).toBe(200);
    const body = await bodyOf<{ ok: boolean; folder: string; warning: string | null }>(res);
    expect(body).toMatchObject({ ok: true, folder: "Archive", warning: null });
    expect(move).toHaveBeenCalledWith({ id: "uid-e1", folderId: "INBOX" }, "Archive");
    expect(store.getEmailState("e1")?.folder).toBe("Archive");

    // 服务器移动会换 id：详情读取必须用会话内记录的新定位，而不是旧 uid。
    await call("/api/messages/e1");
    expect(getMessage).toHaveBeenLastCalledWith({ id: "uid-e1-new", folderId: "Archive" });
  });

  it("warns when the server moved but the new ref is unknown", async () => {
    seedEmail("e1");
    seedFolders();
    const move = vi.fn(async (_ref: MessageRef, _target: string): Promise<MessageRef | null> => null);
    const getMessage = vi.fn(
      async (_ref: MessageRef): Promise<MailMessageBody> => remoteMessage({ html: "<p>x</p>" }),
    );
    buildApp(makeSource({ move, getMessage }));

    const res = await call("/api/messages/e1/move", {
      method: "POST",
      body: JSON.stringify({ folder: "Archive" }),
    });
    expect(res.status).toBe(200);
    const body = await bodyOf<{ warning: string | null }>(res);
    expect(body.warning).toContain("重新同步");
    expect(store.getEmailState("e1")?.folder).toBe("Archive");

    // ref 未知期间不得拿旧 uid 去读服务端内容。
    await call("/api/messages/e1");
    expect(getMessage).not.toHaveBeenCalled();
  });

  it("rejects a move without a folder or for an unknown message", async () => {
    seedEmail("e1");
    buildApp(makeSource());

    const noFolder = await call("/api/messages/e1/move", {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(noFolder.status).toBe(400);

    const unknown = await call("/api/messages/nope/move", {
      method: "POST",
      body: JSON.stringify({ folder: "Archive" }),
    });
    expect(unknown.status).toBe(404);
  });

  it("soft-deletes into Trash", async () => {
    seedEmail("e1");
    seedFolders();
    const remove = vi.fn(async (_ref: MessageRef, _options?: { permanent?: boolean }): Promise<void> => {});
    buildApp(makeSource({ delete: remove }));

    const soft = await call("/api/messages/e1", { method: "DELETE" });
    expect(soft.status).toBe(200);
    expect((await bodyOf<{ folder: string | null }>(soft)).folder).toBe("Trash");
    expect(store.getEmailState("e1")?.folder).toBe("Trash");
    expect(remove).toHaveBeenLastCalledWith({ id: "uid-e1", folderId: "INBOX" }, {
      permanent: false,
    });
  });

  it("permanently deletes on request", async () => {
    seedEmail("e2");
    seedFolders();
    const remove = vi.fn(async (_ref: MessageRef, _options?: { permanent?: boolean }): Promise<void> => {});
    buildApp(makeSource({ delete: remove }));

    const hard = await call("/api/messages/e2?permanent=true", { method: "DELETE" });
    expect(hard.status).toBe(200);
    expect((await bodyOf<{ folder: string | null }>(hard)).folder).toBeNull();
    expect(store.getEmail("e2")).toBeNull();
    expect(remove).toHaveBeenLastCalledWith({ id: "uid-e2", folderId: "INBOX" }, {
      permanent: true,
    });
  });

  it("keeps the local mirror untouched when the server rejects a mutation", async () => {
    seedEmail("e1");
    const setFlags = vi.fn(async (_ref: MessageRef, _patch: { read?: boolean }): Promise<void> => {
      throw new MailError("network", "连接被重置", true);
    });
    buildApp(makeSource({ setFlags }));

    const res = await call("/api/messages/e1", {
      method: "PATCH",
      body: JSON.stringify({ isRead: true }),
    });
    expect(res.status).toBe(502);
    expect((await bodyOf<{ error: { code: string } }>(res)).error.code).toBe("upstream_error");
    expect(store.getEmailState("e1")?.isRead).toBe(false);
  });
});

describe("folder-scoped sync writes (T53)", () => {
  it("lists a non-INBOX message written by folder-scoped sync", async () => {
    // 这两步就是 syncAccount 对每个文件夹做的事：落文件夹快照 + 带 folder 落邮件。
    store.replaceFolders(accountId, [
      { accountId, path: "INBOX", role: "inbox", unread: 0 },
      { accountId, path: "Archive", role: "archive", unread: 1 },
    ]);
    store.upsertEmails([emailOf("archived", { uid: "a-1", subject: "归档邮件" })], "Archive");

    const folders = await bodyOf<{ items: Array<{ path: string; unread: number }> }>(
      await call(`/api/folders?accountId=${accountId}`),
    );
    expect(folders.items.map((item) => item.path)).toEqual(["Archive", "INBOX"]);
    expect(folders.items.find((item) => item.path === "Archive")?.unread).toBe(1);

    const archived = await bodyOf<{ items: Array<{ id: string; folder: string }> }>(
      await call(`/api/messages?accountId=${accountId}&folder=Archive`),
    );
    expect(archived.items.map((item) => item.id)).toEqual(["archived"]);
    expect(archived.items[0]?.folder).toBe("Archive");

    const inbox = await bodyOf<{ items: Array<{ id: string }> }>(
      await call(`/api/messages?accountId=${accountId}&folder=INBOX`),
    );
    expect(inbox.items).toEqual([]);
  });
});

describe("server ref persistence (T53)", () => {
  it("re-reads a moved message through the persisted ref after a restart", async () => {
    seedEmail("e1");
    seedFolders();
    const move = vi.fn(
      async (_ref: MessageRef, _target: string): Promise<MessageRef | null> => ({
        id: "uid-e1-new",
        folderId: "Archive",
      }),
    );
    const getMessage = vi.fn(
      async (_ref: MessageRef): Promise<MailMessageBody> => remoteMessage({ html: "<p>moved</p>" }),
    );
    buildApp(makeSource({ move, getMessage }));

    const res = await call("/api/messages/e1/move", {
      method: "POST",
      body: JSON.stringify({ folder: "archive" }),
    });
    expect(res.status).toBe(200);

    // 重启：同一个库重新打开，进程内状态全部丢失，只剩持久化的 ref。
    store.close();
    store = await openStore(join(dir, "db.sqlite"), "device-test");
    buildApp(makeSource({ move, getMessage }));

    await call("/api/messages/e1");
    expect(getMessage).toHaveBeenLastCalledWith({ id: "uid-e1-new", folderId: "Archive" });
  });

  it("refuses to reuse the old uid after an unresolved move, across a restart too", async () => {
    seedEmail("e1");
    seedFolders();
    const move = vi.fn(async (_ref: MessageRef, _target: string): Promise<MessageRef | null> => null);
    const getMessage = vi.fn(
      async (_ref: MessageRef): Promise<MailMessageBody> => remoteMessage({ html: "<p>x</p>" }),
    );
    buildApp(makeSource({ move, getMessage }));

    const res = await call("/api/messages/e1/move", {
      method: "POST",
      body: JSON.stringify({ folder: "archive" }),
    });
    expect(res.status).toBe(200);
    expect((await bodyOf<{ warning: string | null }>(res)).warning).toContain("重新同步");

    store.close();
    store = await openStore(join(dir, "db.sqlite"), "device-test");
    buildApp(makeSource({ move, getMessage }));

    await call("/api/messages/e1");
    expect(getMessage).not.toHaveBeenCalled();
  });
});
