import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
  ApiErrorBody,
  AttachmentListResponse,
  AttachmentMeta,
  EmailListResponse,
  FolderListResponse,
  FolderRole,
  MessageBody,
  MessageDetailResponse,
  MessageListItem,
  MessageListResponse,
  RawEmail,
  SyncChangesResponse,
  TaskListResponse,
  UpdateMessageInput,
  UpdateTaskInput,
} from "@mailcollect/shared";
import { API_PREFIX } from "@mailcollect/shared";
import type { MailSource, MessageRef } from "@mailcollect/core";
import { MailError } from "@mailcollect/core";
import { redact } from "@mailcollect/core/mail";
import { normalizeListId } from "../list-id.js";
import { fail, type ApiFailure } from "./errors.js";
import type { RouteDeps } from "./deps.js";

/**
 * 邮件数据、收发动作与抽取管线：本地邮件列表、待办、手动同步/抽取、R7 变更流，
 * 以及 v1.1 的文件夹 / 邮件详情 / 附件 / 已读 / 移动删除 / 本地搜索（C5、AC-14/15/16/17）。
 *
 * 分工（依赖方向 `routes → services → core`）：
 * - 列表、已读、文件夹往返、标签都读 {@link RouteDeps.store}（本地镜像，离线可用）；
 * - 正文 HTML 与附件字节只能来自服务器，经 `services.mailSource` 适配器端口取，
 *   路由层不 import 任何具体协议实现；
 * - 改动类操作（已读、移动、删除）先让服务器确认成功再改本地镜像：本地库是服务器
 *   的副本，不能出现「UI 说已移动、服务器没动」的假状态。协议不支持该能力（POP3
 *   没有文件夹/旗标）或没有适配器时按本地模式处理。
 *
 * 已知边界（不在本任务写权限内，需 store/sync 车道补）：
 * - 服务器移动后会换 id（IMAP uid 是文件夹作用域的，Graph 也换），所以新定位由
 *   store 持久化在 `raw_email.provider_ref_json`：移动成功后写入，重启后仍然生效；
 *   `unresolved` 表示「服务器已移动但新定位不可知」，此时必须重同步，绝不回落旧 uid。
 * - 本地搜索用 SQLite `LIKE`：ASCII 大小写不敏感、CJK 子串可命中（CJK 无大小写），
 *   用户输入里的 `%` / `_` 仍是通配符（store 的查询不接受 ESCAPE，不在本任务范围）。
 *
 * 同步与抽取都是「先返回、进度走 SSE」，所以写操作只调用 services，不在这里等待。
 */
export function registerMail(app: Hono, deps: RouteDeps): void {
  const { store, services } = deps;
  const emit = deps.events.emit;

  /* --------------------------------- emails --------------------------------- */

  app.get(`${API_PREFIX}/emails`, (c) => {
    const url = c.req.query();
    const body: EmailListResponse = store.listEmails({
      accountId: url.accountId,
      limit: url.limit ? Number(url.limit) : undefined,
      cursor: url.cursor,
      search: url.search,
    });
    return c.json(body);
  });

  app.get(`${API_PREFIX}/emails/:id`, (c) => {
    const email = store.getEmail(c.req.param("id"));
    if (!email) {
      const { body, status } = fail("not_found", "邮件不存在", 404);
      return c.json(body, status as 404);
    }
    return c.json({
      email,
      verdict: store.getBroadcastVerdict(email.id),
      // The stable key a "remember this list" decision is stored under. The UI
      // must echo this exact value back in BulkDecisionInput.listId.
      listId: normalizeListId(email.headers["list-id"]),
    });
  });

  /* ------------------------- v1.1 message plumbing (C5) ---------------------- */

  const jsonFailure = (c: Context, failure: ApiFailure) =>
    c.json(failure.body, failure.status as ContentfulStatusCode);

  const invalid = (c: Context, message: string) =>
    jsonFailure(c, fail("invalid_input", message, 400));

  const missing = (c: Context, message: string) =>
    jsonFailure(c, fail("not_found", message, 404));

  const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : "未知错误";

  /** 账号的明文凭据（收信 + SMTP）；只用于把错误文案里的密码擦掉，绝不回显。 */
  const secretsFor = (accountId: string): string[] => {
    const inbound = store.getAccountWithSecret(accountId)?.secret ?? "";
    const smtp = store.getAccountWithSmtpSecret(accountId)?.smtpPassword ?? "";
    return [inbound, smtp].filter((secret) => secret.length > 0);
  };

  /**
   * 适配器错误 → 类型化 HTTP 失败；auth 保留 401，其余是上游/协议问题。
   * 文案一律过 `redact`（T65 F5）：适配器可能把密码/令牌抄进报错，而路由手里
   * 正好有解密的凭据，必须在出站前擦掉。
   */
  const mailFailure = (
    error: unknown,
    action: string,
    secrets: readonly string[] = [],
  ): ApiFailure => {
    const safe = (text: string): string => (secrets.length === 0 ? text : redact(text, secrets));
    if (error instanceof MailError) {
      const code: ApiErrorBody["error"]["code"] =
        error.code === "auth" ? "unauthorized" : "upstream_error";
      return fail(
        code,
        safe(`${action}失败：${error.message}`),
        error.code === "auth" ? 401 : 502,
      );
    }
    return fail("internal", safe(`${action}失败：${errorMessage(error)}`), 500);
  };

  const readJson = async <T>(c: Context): Promise<T | null> => {
    try {
      return (await c.req.json()) as T;
    } catch {
      // 空体 / 非法 JSON 都按「没给有效输入」处理，由调用方给 400。
      return null;
    }
  };

  type OpenResult =
    | { kind: "none" }
    | { kind: "source"; source: MailSource }
    | { kind: "error"; failure: ApiFailure };

  /**
   * 构造账号适配器；未注入 `services.mailSource` 时返回 `none`（纯本地模式）。
   * 工厂自己可能抛类型化错误（Graph 缺 clientId、EWS 缺 URL），照样映射成失败。
   */
  const openSource = (accountId: string): OpenResult => {
    const factory = services.mailSource;
    if (!factory) return { kind: "none" };
    const row = store.getAccountWithSecret(accountId);
    if (!row) return { kind: "none" };
    try {
      return {
        kind: "source",
        source: factory({
          id: row.account.id,
          provider: row.account.provider,
          email: row.account.email,
          config: row.account.config,
          secret: row.secret,
        }),
      };
    } catch (error) {
      return { kind: "error", failure: mailFailure(error, "连接邮件服务器", secretsFor(accountId)) };
    }
  };

  const release = async (source: MailSource | null): Promise<void> => {
    if (!source) return;
    try {
      await source.close();
    } catch {
      // 关闭连接失败不能覆盖已经写好的响应。
    }
  };

  /**
   * 持久化的服务端定位（见模块注释）：`ref` 是权威定位；`unresolved` = 移动成功但
   * 目标定位不可知，调用方必须重新同步文件夹，不得拿旧 ref 去读/标/删；`unknown`
   * 是 v1 旧行，退回「uid + 同步时的文件夹」这一唯一可知的信息。
   */
  const refFor = (email: RawEmail, folder: string): MessageRef | null => {
    const state = store.getEmailRefState(email.id);
    switch (state.kind) {
      case "ref":
        return state.ref;
      case "unresolved":
        return null;
      case "unknown":
        return { id: email.uid, folderId: folder };
    }
  };

  const DEFAULT_FOLDER = "INBOX";
  const FOLDER_ROLES: readonly FolderRole[] = [
    "inbox",
    "sent",
    "drafts",
    "trash",
    "archive",
    "junk",
    "other",
  ];

  /**
   * 目标既可以是服务器路径，也可以是角色名（inbox/archive/trash…）。
   *
   * 关键边界（T65 F3）：本地模式 / v1 迁移库没有 folder 行，而 raw_email.folder
   * 的默认值是字面 `INBOX`。角色名只有在**已存在对应 folder 行**时才解析成该行
   * 的路径；否则 inbox 回退到字面 `INBOX`（本地行就是它），其它角色回退到请求
   * 原值——绝不返回 `inbox` 这种不存在的路径把本地邮件「变没」。
   */
  const resolveFolder = (accountId: string, requested: string): string => {
    const target = requested.trim() === "" ? DEFAULT_FOLDER : requested.trim();
    const folders = store.listFolders(accountId);
    const exact = folders.find((folder) => folder.path === target);
    if (exact) return exact.path;
    const role = FOLDER_ROLES.find((candidate) => candidate === target.toLowerCase());
    if (role !== undefined) {
      const byRole = folders.find((folder) => folder.role === role);
      if (byRole !== undefined) return byRole.path;
      return role === "inbox" ? DEFAULT_FOLDER : target;
    }
    const lower = target.toLowerCase();
    return folders.find((folder) => folder.path.toLowerCase() === lower)?.path ?? target;
  };

  /** 本地标记已读后同步文件夹未读数（Folder.unread 是 UI 侧栏显示的值）。 */
  const adjustFolderUnread = (accountId: string, path: string, delta: number): void => {
    const folder = store.listFolders(accountId).find((item) => item.path === path);
    if (!folder || delta === 0) return;
    store.setFolderUnread(accountId, path, Math.max(0, folder.unread + delta));
  };

  const parseLimit = (raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return undefined;
    return Math.floor(value);
  };

  const SNIPPET_MAX = 160;

  /** 纯文本预览：折叠空白并按码点截断（CJK 不会被切成半个字符）。 */
  const snippetOf = (text: string): string => {
    const flat = text.replace(/\s+/g, " ").trim();
    const chars = Array.from(flat);
    return chars.length <= SNIPPET_MAX ? flat : `${chars.slice(0, SNIPPET_MAX).join("")}…`;
  };

  const toAttachmentMeta = (info: {
    id: string;
    filename: string;
    mimeType: string;
    size: number;
  }): AttachmentMeta => ({
    id: info.id,
    filename: info.filename,
    mimeType: info.mimeType,
    size: info.size,
  });

  /* ------------------------------ 附件下载响应头 ------------------------------ */

  const headerSafe = (value: string): string =>
    value.replace(/[\r\n]+/g, " ").replace(/["\\]/g, "_").trim();

  const asciiFallback = (value: string): string => {
    let ascii = "";
    for (const char of value) {
      const code = char.codePointAt(0) ?? 0;
      ascii += code >= 0x20 && code <= 0x7e ? char : "_";
    }
    return ascii === "" ? "attachment" : ascii;
  };

  /** RFC 6266 / RFC 5987：ASCII 退回名 + `filename*` 原名（UI 优先读后者）。 */
  const contentDisposition = (filename: string): string => {
    const safe = headerSafe(filename) || "attachment";
    const fallback = asciiFallback(safe);
    try {
      const encoded = encodeURIComponent(safe).replace(
        /['()*]/g,
        (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
      );
      return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
    } catch {
      // 孤立代理项等非法序列：只发 ASCII 退回名。
      return `attachment; filename="${fallback}"`;
    }
  };

  const MIME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

  /**
   * 附件下载的 Content-Type 白名单（T65 F4）：`text/html`、`image/svg+xml` 这类
   * 可执行/可内联渲染的类型一律回退 `application/octet-stream`；配合
   * `Content-Disposition: attachment` + `nosniff`，浏览器不会把附件当页面执行。
   */
  const SAFE_ATTACHMENT_MIME_TYPES: ReadonlySet<string> = new Set([
    "application/pdf",
    "application/zip",
    "application/json",
    "application/msword",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "image/avif",
    "image/bmp",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/tiff",
    "image/webp",
    "message/rfc822",
    "text/calendar",
    "text/csv",
    "text/markdown",
    "text/plain",
  ]);

  const safeMimeType = (value: string): string => {
    const header = headerSafe(value).toLowerCase();
    // 参数（charset 等）不参与白名单判断，也不回显（避免奇怪参数带进响应头）。
    const base = header.split(";")[0]?.trim() ?? "";
    if (!MIME_PATTERN.test(base)) return "application/octet-stream";
    return SAFE_ATTACHMENT_MIME_TYPES.has(base) ? base : "application/octet-stream";
  };

  /* --------------------------------- folders -------------------------------- */

  app.get(`${API_PREFIX}/folders`, async (c) => {
    const accountId = (c.req.query("accountId") ?? "").trim();
    if (accountId === "") return invalid(c, "accountId 必填");
    if (!store.getAccountWithSecret(accountId)) return missing(c, "账号不存在");

    let items = store.listFolders(accountId);
    if (items.length === 0) {
      // 本地还没有文件夹快照：向服务器要一次并落库（同步器之后会覆盖它）。
      const opened = openSource(accountId);
      if (opened.kind === "error") return jsonFailure(c, opened.failure);
      if (opened.kind === "source") {
        try {
          if (opened.source.listFolders) {
            const remote = await opened.source.listFolders();
            items = store.replaceFolders(
              accountId,
              remote.map((folder) => ({
                accountId,
                path: folder.id,
                role: folder.role,
                unread: folder.unreadCount,
              })),
            );
          }
        } catch (error) {
          return jsonFailure(c, mailFailure(error, "读取文件夹", secretsFor(accountId)));
        } finally {
          await release(opened.source);
        }
      }
    }
    const body: FolderListResponse = { items };
    return c.json(body);
  });

  /* --------------------------------- messages -------------------------------- */

  app.get(`${API_PREFIX}/messages`, (c) => {
    const url = c.req.query();
    const accountId = (url.accountId ?? "").trim() || undefined;
    const folder = accountId
      ? resolveFolder(accountId, url.folder ?? "")
      : (url.folder ?? "").trim() || DEFAULT_FOLDER;
    const search = (url.search ?? "").trim();
    const unreadOnly = url.unreadOnly === "1" || url.unreadOnly === "true";
    const categoryIds = [
      ...new Set(
        (c.req.queries("categoryIds") ?? [])
          .flatMap((value) => value.split(","))
          .map((value) => value.trim())
          .filter((value) => value !== ""),
      ),
    ];
    const limit = parseLimit(url.limit);

    const page = store.listEmailsInFolder({
      accountId,
      folder,
      ...(search === "" ? {} : { search }),
      ...(unreadOnly ? { unreadOnly: true } : {}),
      ...(categoryIds.length === 0 ? {} : { categoryIds }),
      ...(limit === undefined ? {} : { limit }),
      ...(url.cursor ? { cursor: url.cursor } : {}),
    });

    // 一页一次批查，避免逐封查标签的 N+1。
    const tagsByEmail = new Map<string, string[]>();
    for (const tag of store.listTagsForEmails(page.items.map((item) => item.email.id))) {
      const ids = tagsByEmail.get(tag.emailId) ?? [];
      if (!ids.includes(tag.categoryId)) ids.push(tag.categoryId);
      tagsByEmail.set(tag.emailId, ids);
    }

    const items: MessageListItem[] = page.items.map(({ email, folder: inFolder, isRead }) => ({
      id: email.id,
      accountId: email.accountId,
      folder: inFolder,
      fromName: email.fromName,
      fromEmail: email.fromEmail,
      subject: email.subject,
      snippet: snippetOf(email.bodyText),
      sentAt: email.sentAt,
      isRead,
      hasAttachments: email.hasAttachments,
      categoryIds: tagsByEmail.get(email.id) ?? [],
    }));

    const body: MessageListResponse = { items, nextCursor: page.nextCursor };
    return c.json(body);
  });

  app.get(`${API_PREFIX}/messages/:id`, async (c) => {
    const email = store.getEmail(c.req.param("id"));
    if (!email) return missing(c, "邮件不存在");
    const state = store.getEmailState(email.id);
    const folder = state?.folder ?? DEFAULT_FOLDER;
    const isRead = state?.isRead ?? false;
    const categoryIds = [
      ...new Set(store.listTagsForEmail(email.id).map((tag) => tag.categoryId)),
    ];

    const body: MessageBody = { text: email.bodyText, html: null };
    const attachments: AttachmentMeta[] = [];

    const opened = openSource(email.accountId);
    if (opened.kind === "source") {
      try {
        const ref = refFor(email, folder);
        if (ref !== null && opened.source.getMessage) {
          const remote = await opened.source.getMessage(ref);
          // 本地 bodyText 已剥离引文/签名，代表列表/详情一致的那份纯文本。
          body.text = email.bodyText.trim() === "" ? remote.text : email.bodyText;
          body.html = sanitizeHtml(remote.html);
          attachments.push(
            ...remote.attachments.filter((info) => !info.inline).map(toAttachmentMeta),
          );
        }
      } catch (error) {
        // 正文/附件是服务端内容：取不到就降级为本地纯文本，不能因此 500。
        emit({
          type: "error",
          data: { message: mailFailure(error, "读取邮件正文", secretsFor(email.accountId)).body.error.message },
        });
      } finally {
        await release(opened.source);
      }
    } else if (opened.kind === "error") {
      emit({ type: "error", data: { message: opened.failure.body.error.message } });
    }

    const detail: MessageDetailResponse = {
      message: email,
      body,
      attachments,
      folder,
      isRead,
      categoryIds,
    };
    return c.json(detail);
  });

  /* ------------------------------- attachments ------------------------------- */

  const messageForAttachments = (
    c: Context,
    id: string,
  ): { email: RawEmail; folder: string } | Response => {
    const email = store.getEmail(id);
    if (!email) return missing(c, "邮件不存在");
    const state = store.getEmailState(email.id);
    return { email, folder: state?.folder ?? DEFAULT_FOLDER };
  };

  app.get(`${API_PREFIX}/messages/:id/attachments`, async (c) => {
    const found = messageForAttachments(c, c.req.param("id"));
    if (found instanceof Response) return found;
    const { email, folder } = found;
    const ref = refFor(email, folder);
    if (ref === null) {
      return jsonFailure(
        c,
        fail("upstream_error", "邮件已移动，需要重新同步该文件夹后才能读取附件", 502),
      );
    }
    const opened = openSource(email.accountId);
    if (opened.kind === "error") return jsonFailure(c, opened.failure);
    if (opened.kind === "none" || !opened.source.getMessage) {
      return jsonFailure(
        c,
        fail("upstream_error", "当前没有可用的邮件服务器连接，无法列出附件", 502),
      );
    }
    try {
      const remote = await opened.source.getMessage(ref);
      const body: AttachmentListResponse = {
        items: remote.attachments.filter((info) => !info.inline).map(toAttachmentMeta),
      };
      return c.json(body);
    } catch (error) {
      return jsonFailure(c, mailFailure(error, "读取附件列表", secretsFor(email.accountId)));
    } finally {
      await release(opened.source);
    }
  });

  app.get(`${API_PREFIX}/messages/:id/attachments/:attachmentId`, async (c) => {
    const found = messageForAttachments(c, c.req.param("id"));
    if (found instanceof Response) return found;
    const { email, folder } = found;
    const attachmentId = c.req.param("attachmentId");
    const ref = refFor(email, folder);
    if (ref === null) {
      return jsonFailure(
        c,
        fail("upstream_error", "邮件已移动，需要重新同步该文件夹后才能下载附件", 502),
      );
    }
    const opened = openSource(email.accountId);
    if (opened.kind === "error") return jsonFailure(c, opened.failure);
    if (opened.kind === "none" || !opened.source.getMessage) {
      return jsonFailure(
        c,
        fail("upstream_error", "当前没有可用的邮件服务器连接，无法下载附件", 502),
      );
    }
    try {
      const remote = await opened.source.getMessage(ref);
      const meta = remote.attachments.find((info) => info.id === attachmentId);
      if (!meta) return missing(c, "附件不存在或不属于这封邮件");
      if (!opened.source.getAttachment) {
        return jsonFailure(c, fail("upstream_error", "当前协议不支持按附件下载", 502));
      }
      const data = await opened.source.getAttachment(ref, attachmentId);
      const bytes = new Uint8Array(data.content);
      return c.body(bytes, 200, {
        "content-type": safeMimeType(data.info.mimeType),
        "content-disposition": contentDisposition(data.info.filename),
        "content-length": String(bytes.byteLength),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      });
    } catch (error) {
      return jsonFailure(c, mailFailure(error, "下载附件", secretsFor(email.accountId)));
    } finally {
      await release(opened.source);
    }
  });

  /* ----------------------------- 已读 / 移动 / 删除 ---------------------------- */

  app.patch(`${API_PREFIX}/messages/:id`, async (c) => {
    const email = store.getEmail(c.req.param("id"));
    if (!email) return missing(c, "邮件不存在");
    const state = store.getEmailState(email.id);
    if (!state) return missing(c, "邮件的本地状态不存在");
    const input = await readJson<UpdateMessageInput>(c);
    if (!input || typeof input.isRead !== "boolean") {
      return invalid(c, "isRead 必须是布尔值");
    }

    let warning: string | null = null;
    const opened = openSource(email.accountId);
    if (opened.kind === "error") return jsonFailure(c, opened.failure);
    if (opened.kind === "source") {
      try {
        const ref = refFor(email, state.folder);
        if (opened.source.setFlags) {
          if (ref === null) {
            warning = "邮件上一次移动后尚未重新同步，本次只更新了本地已读状态";
          } else {
            await opened.source.setFlags(ref, { read: input.isRead });
          }
        }
      } catch (error) {
        return jsonFailure(c, mailFailure(error, "更新已读状态", secretsFor(email.accountId)));
      } finally {
        await release(opened.source);
      }
    }

    const changed = state.isRead !== input.isRead;
    store.markEmailRead(email.id, input.isRead);
    if (changed) adjustFolderUnread(email.accountId, state.folder, input.isRead ? -1 : 1);
    return c.json({ ok: true, warning });
  });

  app.post(`${API_PREFIX}/messages/:id/move`, async (c) => {
    const email = store.getEmail(c.req.param("id"));
    if (!email) return missing(c, "邮件不存在");
    const state = store.getEmailState(email.id);
    if (!state) return missing(c, "邮件的本地状态不存在");
    const input = await readJson<{ folder?: unknown }>(c);
    const requested = typeof input?.folder === "string" ? input.folder.trim() : "";
    if (requested === "") return invalid(c, "folder 必填（目标路径或角色名）");

    const target = resolveFolder(email.accountId, requested);
    let warning: string | null = null;

    const opened = openSource(email.accountId);
    if (opened.kind === "error") return jsonFailure(c, opened.failure);
    if (opened.kind === "source") {
      try {
        if (opened.source.move) {
          const ref = refFor(email, state.folder);
          if (ref === null) {
            warning = "邮件上一次移动后尚未重新同步，本次只更新了本地文件夹";
          } else {
            const moved = await opened.source.move(ref, target);
            // 服务端新定位持久化（见模块注释）；null 代表必须重同步。
            if (moved === null) {
              store.markEmailRefUnresolved(email.id);
              warning = "服务器已移动，但无法确定目标文件夹里的新定位；请重新同步该文件夹";
            } else {
              store.setEmailRef(email.id, { id: moved.id, folderId: moved.folderId ?? target });
            }
          }
        } else {
          // 纯本地移动：服务器上的位置没变，旧定位不能再拼上新的本地文件夹。
          store.markEmailRefUnresolved(email.id);
        }
      } catch (error) {
        return jsonFailure(c, mailFailure(error, "移动邮件", secretsFor(email.accountId)));
      } finally {
        await release(opened.source);
      }
    } else {
      store.markEmailRefUnresolved(email.id);
    }

    if (!store.moveEmail(email.id, target)) return missing(c, "邮件不存在");
    return c.json({ ok: true, folder: target, warning });
  });

  app.delete(`${API_PREFIX}/messages/:id`, async (c) => {
    const email = store.getEmail(c.req.param("id"));
    if (!email) return missing(c, "邮件不存在");
    const state = store.getEmailState(email.id);
    if (!state) return missing(c, "邮件的本地状态不存在");
    const raw = c.req.query("permanent");
    const permanent = raw === "1" || raw === "true";
    let warning: string | null = null;

    const opened = openSource(email.accountId);
    if (opened.kind === "error") return jsonFailure(c, opened.failure);
    if (opened.kind === "source") {
      try {
        if (opened.source.delete) {
          const ref = refFor(email, state.folder);
          if (ref === null) {
            warning = "邮件上一次移动后尚未重新同步，本次只删除了本地副本";
          } else {
            await opened.source.delete(ref, { permanent });
          }
        }
      } catch (error) {
        return jsonFailure(c, mailFailure(error, "删除邮件", secretsFor(email.accountId)));
      } finally {
        await release(opened.source);
      }
    }

    if (permanent) {
      store.deleteEmail(email.id);
      return c.json({ ok: true, folder: null, warning });
    }
    // 软删除 = 进回收站；服务端回收站里的定位未知（移动会换 id），标记需要重同步。
    store.markEmailRefUnresolved(email.id);
    const trash = store.listFolders(email.accountId).find((folder) => folder.role === "trash");
    if (trash && trash.path !== state.folder) {
      store.moveEmail(email.id, trash.path);
      return c.json({ ok: true, folder: trash.path, warning });
    }
    store.deleteEmail(email.id);
    return c.json({ ok: true, folder: null, warning });
  });

  /* ---------------------------------- tasks --------------------------------- */

  app.get(`${API_PREFIX}/tasks`, (c) => {
    const url = c.req.query();
    const items = store.listTasks({
      ...(url.status ? { status: url.status as TaskListResponse["items"][number]["status"] } : {}),
      ...(url.from ? { from: url.from } : {}),
      ...(url.to ? { to: url.to } : {}),
      ...(url.includeBroadcast === "false" ? { includeBroadcast: false } : {}),
    });
    const body: TaskListResponse = { items, counts: store.taskCounts() };
    return c.json(body);
  });

  app.patch(`${API_PREFIX}/tasks/:id`, async (c) => {
    const patch = (await c.req.json()) as UpdateTaskInput;
    const task = store.updateTask(c.req.param("id"), patch);
    if (!task) {
      const { body, status } = fail("not_found", "待办不存在", 404);
      return c.json(body, status as 404);
    }
    emit({ type: "task", data: task });
    return c.json({ task });
  });

  app.post(`${API_PREFIX}/tasks/bulk`, async (c) => {
    const input = (await c.req.json()) as {
      ids: string[];
      decision: "confirm" | "dismiss";
      listId?: string | null;
    };
    const status = input.decision === "confirm" ? "confirmed" : "dismissed";
    const updated = store.setTasksStatus(input.ids ?? [], status);
    if (input.listId) {
      // Normalise here too: the UI may echo a raw header value from an older build.
      const listId = normalizeListId(input.listId) ?? input.listId;
      store.setBroadcastDecision(listId, input.decision === "confirm" ? "always_task" : "always_ignore");
    }
    for (const task of updated) emit({ type: "task", data: task });
    return c.json({ items: updated });
  });

  /* ----------------------------------- sync --------------------------------- */

  app.post(`${API_PREFIX}/sync`, async (c) => {
    const input = (await c.req.json()) as { accountId: string; full?: boolean };
    if (!store.getAccountWithSecret(input.accountId)) {
      const { body, status } = fail("not_found", "账号不存在", 404);
      return c.json(body, status as 404);
    }
    void services
      .syncAccount(input.accountId, { full: input.full === true }, emit)
      .catch((error: unknown) => {
        emit({
          type: "error",
          data: { message: error instanceof Error ? error.message : "同步失败" },
        });
      });
    return c.json({ jobId: `sync-${input.accountId}-${Date.now()}` });
  });

  app.post(`${API_PREFIX}/extract`, async (c) => {
    void services.extract(emit).catch((error: unknown) => {
      emit({
        type: "error",
        data: { message: error instanceof Error ? error.message : "抽取失败" },
      });
    });
    return c.json({ ok: true });
  });

  /* ------------------------- cloud-sync seam (R7) --------------------------- */

  app.get(`${API_PREFIX}/sync/changes`, (c) => {
    const since = Number(c.req.query("since") ?? "0");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "500"), 1), 2000);
    const body: SyncChangesResponse = {
      head: store.head(),
      items: store.changes(Number.isFinite(since) ? since : 0, limit),
    };
    return c.json(body);
  });
}

/* ------------------------------ HTML sanitize ------------------------------ */

/**
 * 出站 HTML 白名单清洗器（AC-16；T65 F1/F2 修复）。
 *
 * 为什么不是给正则打补丁：浏览器把 `/`、引号结束、`>` 都当作属性分隔符，实体解码
 * 也没有位数上限，任何「空白 + on…」或「空白 + href」式正则都能被绕过。这里改为
 * 手写 tokenizer：无条件解析出标签名与属性表（属性名在任意分隔符后开始），再按
 * 白名单重建：
 * - 标签白名单：常见排版标签；script/style/iframe/svg/math/object/embed/… 连同内容
 *   一起丢弃；未知标签只丢标签、保留文本。
 * - 属性白名单（按标签）：`on*`、`style`、`id`、`class` 等一律不在白名单。
 * - URL 属性：实体解码**不设位数上限**并循环到稳定、去掉控制/空白字符后，scheme
 *   必须属于 http/https/mailto/cid（相对 URL 允许）；其余协议整条属性删除。
 * - 重建时转义属性值，属性值一律双引号包裹。
 *
 * 纯字符串实现，不引入 DOM / 新依赖；输出是安全子集。
 */

const isHtmlSpace = (char: string | undefined): boolean =>
  char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";

const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "a", "abbr", "address", "article", "aside", "b", "bdi", "bdo", "big", "blockquote", "br",
  "caption", "center", "cite", "code", "col", "colgroup", "dd", "del", "div", "dl", "dt", "em",
  "figcaption", "figure", "font", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr",
  "i", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "rp", "rt",
  "ruby", "s", "samp", "section", "small", "span", "strike", "strong", "sub", "summary", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "wbr",
]);

const VOID_TAGS: ReadonlySet<string> = new Set(["br", "col", "hr", "img", "wbr"]);

/** 这些标签只丢标签本身（浏览器里就是空元素）。 */
const DROP_EMPTY_TAGS: ReadonlySet<string> = new Set([
  "area", "base", "basefont", "bgsound", "embed", "frame", "input", "keygen", "link", "meta",
  "param", "source", "track",
]);

/** 这些标签连同内容整体丢弃（脚本、样式、可执行/可嵌入容器）。 */
const DROP_CONTENT_TAGS: ReadonlySet<string> = new Set([
  "applet", "audio", "canvas", "datalist", "dialog", "fieldset", "frameset", "iframe", "math",
  "noembed", "noframes", "noscript", "object", "optgroup", "option", "output", "plaintext",
  "script", "select", "style", "svg", "template", "textarea", "title", "video", "xmp",
]);

const GLOBAL_ATTRIBUTES: ReadonlySet<string> = new Set(["dir", "lang", "title"]);

const TAG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(["href", "name", "rel", "target", "title"]),
  abbr: new Set(["title"]),
  blockquote: new Set(["cite"]),
  caption: new Set(["align"]),
  center: new Set(["align"]),
  col: new Set(["align", "span", "valign", "width"]),
  colgroup: new Set(["align", "span", "valign", "width"]),
  del: new Set(["cite", "datetime"]),
  div: new Set(["align"]),
  font: new Set(["color", "face", "size"]),
  h1: new Set(["align"]),
  h2: new Set(["align"]),
  h3: new Set(["align"]),
  h4: new Set(["align"]),
  h5: new Set(["align"]),
  h6: new Set(["align"]),
  hr: new Set(["align", "noshade", "size", "width"]),
  img: new Set(["align", "alt", "border", "height", "hspace", "src", "title", "vspace", "width"]),
  ins: new Set(["cite", "datetime"]),
  li: new Set(["type", "value"]),
  ol: new Set(["start", "type"]),
  p: new Set(["align"]),
  pre: new Set(["width"]),
  q: new Set(["cite"]),
  table: new Set(["align", "bgcolor", "border", "cellpadding", "cellspacing", "summary", "width"]),
  tbody: new Set(["align", "valign"]),
  td: new Set(["abbr", "align", "bgcolor", "colspan", "headers", "height", "nowrap", "rowspan", "scope", "valign", "width"]),
  tfoot: new Set(["align", "valign"]),
  th: new Set(["abbr", "align", "bgcolor", "colspan", "headers", "height", "nowrap", "rowspan", "scope", "valign", "width"]),
  thead: new Set(["align", "valign"]),
  time: new Set(["datetime"]),
  tr: new Set(["align", "bgcolor", "valign"]),
  ul: new Set(["type"]),
};

const URL_ATTRIBUTES: ReadonlySet<string> = new Set([
  "action", "background", "cite", "dynsrc", "formaction", "href", "longdesc", "lowsrc",
  "poster", "src", "usemap", "xlink:href",
]);

const SAFE_URL_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto", "cid"]);

interface RawAttribute {
  readonly name: string;
  readonly value: string | null;
}

interface RawTag {
  readonly name: string;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: readonly RawAttribute[];
  /** 标签结束（`>` 之后）在源串里的下标。 */
  readonly end: number;
}

/** 从 `<` 开始解析一个标签；不是标签（`<` 后没有标签名）时返回 null。 */
const parseHtmlTag = (html: string, start: number): RawTag | null => {
  const length = html.length;
  let index = start + 1;
  if (index >= length) return null;
  let closing = false;
  if (html[index] === "/") {
    closing = true;
    index += 1;
  }
  const nameStart = index;
  while (index < length && /[A-Za-z0-9:-]/.test(html[index] ?? "")) index += 1;
  if (index === nameStart) return null;
  const name = html.slice(nameStart, index).toLowerCase();
  const attributes: RawAttribute[] = [];

  if (closing) {
    while (index < length && isHtmlSpace(html[index])) index += 1;
    if (html[index] === ">") index += 1;
    return { name, closing: true, selfClosing: false, attributes, end: index };
  }

  let selfClosing = false;
  for (;;) {
    let sawSlash = false;
    while (index < length && (isHtmlSpace(html[index]) || html[index] === "/")) {
      if (html[index] === "/") sawSlash = true;
      index += 1;
    }
    if (index >= length) {
      selfClosing = sawSlash;
      break;
    }
    if (html[index] === ">") {
      selfClosing = sawSlash;
      index += 1;
      break;
    }
    // 属性名：到空白 / `=` / `/` / `>` 为止。注意 `<img src="x"onerror=…>` 与
    // `<img/onerror=…>` 都会走到这里，不会因为缺少空白而被跳过。
    const attributeStart = index;
    while (index < length) {
      const char = html[index] ?? "";
      if (isHtmlSpace(char) || char === "=" || char === "/" || char === ">") break;
      index += 1;
    }
    if (index === attributeStart) {
      index += 1; // 防御：异常字符，跳过避免死循环
      continue;
    }
    const attributeName = html.slice(attributeStart, index).toLowerCase();
    while (index < length && isHtmlSpace(html[index])) index += 1;
    let value: string | null = null;
    if (html[index] === "=") {
      index += 1;
      while (index < length && isHtmlSpace(html[index])) index += 1;
      const quote = html[index];
      if (quote === '"' || quote === "'") {
        index += 1;
        const valueStart = index;
        while (index < length && html[index] !== quote) index += 1;
        value = html.slice(valueStart, index);
        if (index < length) index += 1;
      } else {
        const valueStart = index;
        while (index < length) {
          const char = html[index] ?? "";
          if (isHtmlSpace(char) || char === ">") break;
          index += 1;
        }
        value = html.slice(valueStart, index);
      }
    }
    attributes.push({ name: attributeName, value });
  }
  return { name, closing: false, selfClosing, attributes, end: index };
};

const NUMERIC_ENTITY_PATTERN = /&#(?:[xX]([0-9a-fA-F]+)|([0-9]+));?/g;
const NAMED_ENTITY_PATTERN = /&(colon|tab|newline|amp|lt|gt|quot|apos);/gi;
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  colon: ":",
  tab: "\t",
  newline: "\n",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * 实体解码：数字实体不设位数上限，并循环到稳定（浏览器接受任意多位数字，
 * `&#x0000006a;` 与 `&#00000106;` 都是 `j`）。
 */
const decodeHtmlEntities = (value: string): string => {
  let decoded = value;
  for (let round = 0; round < 5; round += 1) {
    const next = decoded
      .replace(NUMERIC_ENTITY_PATTERN, (match: string, hex?: string, dec?: string) => {
        const codePoint =
          hex !== undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec ?? "", 10);
        if (
          !Number.isFinite(codePoint) ||
          codePoint <= 0 ||
          codePoint > 0x10ffff ||
          (codePoint >= 0xd800 && codePoint <= 0xdfff)
        ) {
          return "\ufffd";
        }
        return String.fromCodePoint(codePoint);
      })
      .replace(
        NAMED_ENTITY_PATTERN,
        (match: string, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match,
      );
    if (next === decoded) return decoded;
    decoded = next;
  }
  return decoded;
};

/** URL 属性值：实体解码 → 去控制/空白 → scheme 白名单；不合规返回 null（删属性）。 */
const sanitizeUrlValue = (raw: string): string | null => {
  const decoded = decodeHtmlEntities(raw).trim();
  if (decoded === "") return null;
  const compact = decoded
    .replace(/[\u0000-\u0020\u007f-\u009f\u00a0\ufeff]+/g, "")
    .toLowerCase();
  const scheme = /^([a-z][a-z0-9+.-]*):/.exec(compact)?.[1];
  if (scheme === undefined) return decoded; // 相对 URL / 协议相对：允许
  return SAFE_URL_SCHEMES.has(scheme) ? decoded : null;
};

const escapeHtmlAttribute = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** 按标签白名单重建属性串；事件属性/样式/未知属性一律不出现。 */
const buildAttributes = (tag: string, attributes: readonly RawAttribute[]): string => {
  const allowedHere = TAG_ATTRIBUTES[tag];
  const parts: string[] = [];
  for (const attribute of attributes) {
    const name = attribute.name;
    if (name === "" || name.startsWith("on")) continue;
    if (!GLOBAL_ATTRIBUTES.has(name) && !(allowedHere?.has(name) ?? false)) continue;
    if (attribute.value === null) continue; // 白名单里没有布尔属性
    const value = URL_ATTRIBUTES.has(name)
      ? sanitizeUrlValue(attribute.value)
      : attribute.value.replace(/[\u0000-\u001f\u007f]+/g, " ");
    if (value === null) continue;
    parts.push(` ${name}="${escapeHtmlAttribute(value)}"`);
  }
  return parts.join("");
};

/** 出站 HTML 的统一 sanitize（AC-16）：白名单标签/属性 + URL scheme 白名单。 */
export function sanitizeHtml(input: string | null): string | null {
  if (input === null) return null;
  const html = input;
  const output: string[] = [];
  let index = 0;
  let skipTag: string | null = null;
  let skipDepth = 0;

  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next === -1) {
      if (skipTag === null) output.push(html.slice(index));
      break;
    }
    if (next > index && skipTag === null) output.push(html.slice(index, next));
    index = next;

    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }
    const marker = html[index + 1];
    if (marker === "!" || marker === "?") {
      const end = html.indexOf(">", index + 2);
      index = end === -1 ? html.length : end + 1;
      continue;
    }

    const tag = parseHtmlTag(html, index);
    if (tag === null) {
      // `<` 后面不是标签名：当文本保留（浏览器也这么解析）。
      if (skipTag === null) output.push("<");
      index += 1;
      continue;
    }
    index = tag.end;

    if (skipTag !== null) {
      if (tag.name === skipTag && tag.closing) {
        skipDepth -= 1;
        if (skipDepth <= 0) {
          skipTag = null;
          skipDepth = 0;
        }
      } else if (tag.name === skipTag && !tag.closing) {
        skipDepth += 1;
      }
      continue;
    }

    if (!tag.closing && DROP_EMPTY_TAGS.has(tag.name)) continue;
    if (!tag.closing && DROP_CONTENT_TAGS.has(tag.name)) {
      skipTag = tag.name;
      skipDepth = 1;
      continue;
    }
    if (!ALLOWED_TAGS.has(tag.name)) continue; // 未知标签：丢标签、保留文本
    if (tag.closing) {
      if (!VOID_TAGS.has(tag.name)) output.push(`</${tag.name}>`);
      continue;
    }
    output.push(`<${tag.name}${buildAttributes(tag.name, tag.attributes)}>`);
  }

  return output.join("");
}
