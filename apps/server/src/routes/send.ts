import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type {
  Account,
  AttachmentPayload,
  ComposeMode,
  DraftListResponse,
  OutboxActionResponse,
  OutboxListResponse,
  OutboxStatus,
  OutgoingMessage,
  SaveDraftResponse,
  SendEventData,
  SendMessageResponse,
  SendStatus,
  ServerEvent,
} from "@mailcollect/shared";
import { API_PREFIX } from "@mailcollect/shared";
import type {
  ComposeOriginal,
  MailSource,
  MailSourceAccount,
  MailSourceFactory,
  SendOutcome,
} from "@mailcollect/core/mail";
import { dispatchSend, MailError, redact } from "@mailcollect/core/mail";
import { StoreError, type Store } from "@mailcollect/core";
import { fail, type ApiFailure } from "./errors.js";
import type { RouteDeps } from "./deps.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const redactAll = (text: string, secrets: readonly string[]): string =>
  redact(text, secrets.filter((secret) => secret.length > 0));

/* ------------------------------ 账号 / 投递 ------------------------------ */

const escapeHtmlText = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

interface LoadedAccount {
  /** dispatch/适配器用的最小账号（含解密后的收信 secret，只在本进程内存里过一遍）。 */
  readonly account: MailSourceAccount;
  readonly stored: Account;
  readonly smtpPassword: string;
  readonly sentFolderId: string | null;
  readonly displayName: string | null;
  /** 账号签名（纯文本，来自非密 config 的 `signature` 键）。 */
  readonly signature: string;
}

const secretsOf = (loaded: LoadedAccount): string[] => [
  loaded.account.secret,
  loaded.smtpPassword,
];

/**
 * 解密账号凭据（调用点都是「马上要发信」）。
 *
 * 签名/显示名约定：账号 `config` 里的非密键 `signature`（纯文本签名）与
 * `displayName`（From 显示名）。From 地址永远是账号地址（C5），别名发件不在 v1。
 */
/**
 * 解密账号凭据并读出签名/显示名/服务器 Sent 文件夹。
 *
 * 导出给测试与 outbox worker 复用（同一份「密码从哪来」逻辑不能有两套）。
 */
export const loadSendAccount = (target: Store, accountId: string): LoadedAccount | null => {
  const withSecret = target.getAccountWithSecret(accountId);
  if (!withSecret) return null;
  const withSmtp = target.getAccountWithSmtpSecret(accountId);
  const config = withSecret.account.config;
  return {
    account: {
      id: withSecret.account.id,
      provider: withSecret.account.provider,
      email: withSecret.account.email,
      config,
      secret: withSecret.secret,
    },
    stored: withSecret.account,
    smtpPassword: withSmtp?.smtpPassword ?? "",
    sentFolderId:
      target.listFolders(accountId).find((folder) => folder.role === "sent")?.path ?? null,
    displayName: (config["displayName"] ?? "").trim() || null,
    signature: (config["signature"] ?? "").trim(),
  };
};

/** 单封可关签名：`includeSignature === false` 时原样发送；签名只追加一次（outbox 存原始快照）。 */
const prepareOutgoing = (loaded: LoadedAccount, message: OutgoingMessage): OutgoingMessage => {
  if (message.includeSignature === false || loaded.signature === "") return message;
  const text = message.bodyText.trimEnd();
  const bodyText = text === "" ? loaded.signature : `${text}\r\n\r\n${loaded.signature}`;
  const bodyHtml =
    message.bodyHtml === null
      ? null
      : `${message.bodyHtml}<p>${escapeHtmlText(loaded.signature).replace(/\r?\n/g, "<br>")}</p>`;
  return { ...message, bodyText, bodyHtml };
};

/** 回复/转发的原文引用（In-Reply-To/References/引用块）：从本地已同步邮件重建。 */
const originalFor = (target: Store, message: OutgoingMessage): ComposeOriginal | null => {
  if (message.mode === "new" || message.replyToEmailId === null) return null;
  const email = target.getEmail(message.replyToEmailId);
  if (!email) return null;
  const references = (email.headers["references"] ?? "")
    .split(/\s+/)
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return {
    messageId: email.messageId,
    references,
    fromName: email.fromName,
    fromEmail: email.fromEmail,
    to: email.to,
    subject: email.subject,
    date: email.sentAt,
    bodyText: email.bodyText,
    bodyHtml: null,
  };
};

interface DeliveryDeps {
  readonly store: Store;
  readonly mailSource?: MailSourceFactory | undefined;
}

/**
 * 账号没有 Sent 角色行时，本地「已发送」桶的字面名（T70）。
 * 与收件侧「inbox 角色未解析即回退字面 INBOX」是同一套回退规则。
 */
const DEFAULT_SENT_FOLDER = "Sent";

/** 发信成功后本地镜像该去的文件夹：store 里 Sent 角色的真实路径，否则字面 `Sent`。 */
const sentFolderFor = (loaded: LoadedAccount): string =>
  loaded.sentFolderId ?? DEFAULT_SENT_FOLDER;

/**
 * 单封投递：构造适配器 → dispatchSend → 关闭连接。
 *
 * 只抛「构造/连接适配器失败」这类发生在投递前的错误；投递结果一律由
 * `SendOutcome`（不抛）表达，和 core 的契约一致。
 */
const deliver = async (
  delivery: DeliveryDeps,
  loaded: LoadedAccount,
  message: OutgoingMessage,
): Promise<SendOutcome> => {
  const factory = delivery.mailSource;
  if (!factory) {
    throw new MailError("not_configured", "未注入邮件适配器（services.mailSource）", false);
  }
  let source: MailSource | null = null;
  try {
    source = factory(loaded.account);
    const outcome = await dispatchSend({
      account: loaded.account,
      source,
      store: delivery.store,
      message: prepareOutgoing(loaded, message),
      original: originalFor(delivery.store, message),
      fromName: loaded.displayName,
      sentFolderId: loaded.sentFolderId,
      // 专用 SMTP/EWS 密码优先；为空时 dispatch 自动回退 account.secret。
      smtpPassword: loaded.smtpPassword,
    });
    // T70：`mirrorSentMessage` 只经 `upsertEmails` 写入（SentMirrorPort 没有 folder 参数），
    // 新行会落到 raw_email.folder 的默认值 INBOX，导致按 Sent 角色筛选的「已发送」永远为空。
    // 发信成功后立刻把镜像归位到 Sent 角色对应的真实文件夹（无该角色行时回退字面 `Sent`）。
    // 这段在通道选择之外，所以 SMTP/IMAP APPEND、Graph、EWS、POP3 四条路径归属一致。
    if (outcome.result.ok && outcome.emailId !== null) {
      delivery.store.moveEmail(outcome.emailId, sentFolderFor(loaded));
    }
    return outcome;
  } finally {
    if (source !== null) {
      try {
        await source.close();
      } catch {
        // 关闭连接失败不能覆盖已经拿到的投递结果。
      }
    }
  }
};



/**
 * v1.1 撰写 / 发送 / 草稿 / 离线发件队列（C5）的挂载点。
 *
 * 端点契约已在 `packages/shared/src/api.ts` 冻结，由 server-mail-send 任务接入：
 *   POST /api/send
 *   GET/POST/DELETE /api/drafts…
 *   GET /api/outbox，POST /api/outbox/:id/retry，DELETE /api/outbox/:id
 *
 * 发件传输与 outbox 后台循环分别经 `services.mailSource` /
 * `services.outbox`（{@link import("../services.js").OutboxWorkerPort}）注入，
 * 路由层不直接连 SMTP。
 *
 * 三条铁律（T27 合同 + captain 裁定）：
 * 1. **发信密码只能从 `store.getAccountWithSmtpSecret` 取**，经 `dispatchSend({ smtpPassword })`
 *    传入；为空时 dispatch 自己回退收信 secret。本模块从不打印、回显或落库密码，所有
 *    出站文案都过 `redact(..., [secret, smtpPassword])`。
 * 2. **Bcc 原样交给 dispatch**：SMTP DATA 路径按 RFC 5322 删 Bcc 头，Graph/EWS 从 MIME
 *    读收件人，路由不做任何收件人裁剪。
 * 3. **已投递但服务器 Sent 副本失败仍是成功**：dispatch 返回 `ok:true` +
 *    `savedToSent:"local"|"none"`，路由必须报 `sent`，绝不转成失败诱发重试（重试 = 重复投递）。
 *
 * 投递结果一律 HTTP 200 + `SendMessageResponse.status`（frozen `SendStatus`：sent/queued/failed），
 * 因为客户端需要 `outboxId` 才能去发件箱重试；HTTP 4xx/5xx 只用于请求级错误：
 * 400 输入不合法、404 账号/被回复邮件不存在、401 发信认证失败（Auth 只有这一个正确状态码，
 * 同时仍把消息停在 outbox 的 failed 行里，用户可在发件箱重试）、502 上游/适配器故障、
 * 500 本地存储或真正的内部错误（文案不携带任何厂商原文）。
 *
 * 幂等键：`draftId`（客户端在首次自动保存前生成并固定的编辑会话 id；契约里它就是草稿
 * upsert 键）或请求体里的显式 `idempotencyKey`。投递失败不写「成功台账」但保留 outbox 行；
 * 成功/入队的键在进程内台账里保留 10 分钟，同一键的重试直接复用结果或 outbox 行，
 * **不会二次投递**。跨重启的持久幂等需要 store 增加一列（与 T53 同类），已作为发现上报。
 */
export function registerSend(app: Hono, deps: RouteDeps): void {
  const { store, services } = deps;
  const emit = deps.events.emit;

  /* ------------------------------ 共享小工具 ------------------------------ */

  const jsonFailure = (c: Context, failure: ApiFailure) =>
    c.json(failure.body, failure.status as ContentfulStatusCode);

  const invalid = (c: Context, message: string) =>
    jsonFailure(c, fail("invalid_input", message, 400));

  const missing = (c: Context, message: string) =>
    jsonFailure(c, fail("not_found", message, 404));

  /** store 的类型化错误 → HTTP；不把 SQLite 原文泄到 5xx 文案里。 */
  const storeFailure = (error: unknown, action: string): ApiFailure | null => {
    if (!(error instanceof StoreError)) return null;
    switch (error.code) {
      case "invalid":
      case "conflict":
        return fail("invalid_input", `${action}失败：${error.message}`, 400);
      case "not_found":
        return fail("not_found", `${action}失败：${error.message}`, 404);
      case "state":
        return fail("internal", `${action}失败：本地状态不一致`, 500);
    }
  };

  const mailFailure = (error: unknown, action: string, secrets: readonly string[] = []): ApiFailure => {
    const fromStore = storeFailure(error, action);
    if (fromStore !== null) return fromStore;
    if (error instanceof MailError) {
      const message = redactAll(`${action}失败：${error.message}`, secrets);
      return error.code === "auth"
        ? fail("unauthorized", message, 401)
        : fail("upstream_error", message, 502);
    }
    return fail("internal", `${action}失败（内部错误）`, 500);
  };

  const readJson = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      return null;
    }
  };

  /* ------------------------------ 消息校验 ------------------------------ */

  type MessageCheck = { ok: true; value: OutgoingMessage } | { ok: false; message: string };

  const parseRecipients = (raw: unknown, field: string, errors: string[]): string[] => {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw) || raw.some((item) => typeof item !== "string")) {
      errors.push(`${field} 必须是字符串数组`);
      return [];
    }
    return raw.map((item: string) => item.trim()).filter((item) => item !== "");
  };

  const parseAttachments = (raw: unknown, errors: string[]): AttachmentPayload[] => {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      errors.push("attachments 必须是数组");
      return [];
    }
    const result: AttachmentPayload[] = [];
    for (const item of raw) {
      if (
        !isRecord(item) ||
        typeof item["filename"] !== "string" ||
        typeof item["mimeType"] !== "string" ||
        typeof item["size"] !== "number" ||
        typeof item["dataBase64"] !== "string"
      ) {
        errors.push("attachments 每项必须含 filename/mimeType/size/dataBase64");
        return [];
      }
      result.push({
        filename: item["filename"],
        mimeType: item["mimeType"],
        size: item["size"],
        dataBase64: item["dataBase64"],
      });
    }
    return result;
  };

  /**
   * 把请求体里的 `message` 收窄成冻结的 `OutgoingMessage`。
   * `requireRecipients=false` 用于草稿自动保存（还没填收件人也要能存）。
   */
  const parseMessage = (raw: unknown, requireRecipients: boolean): MessageCheck => {
    if (!isRecord(raw)) return { ok: false, message: "message 必须是对象" };
    const errors: string[] = [];
    const to = parseRecipients(raw["to"], "to", errors);
    const cc = parseRecipients(raw["cc"], "cc", errors);
    const bcc = parseRecipients(raw["bcc"], "bcc", errors);

    const modeRaw = raw["mode"];
    const mode: ComposeMode = modeRaw === "reply" || modeRaw === "forward" ? modeRaw : "new";
    if (
      modeRaw !== undefined &&
      modeRaw !== null &&
      modeRaw !== "new" &&
      modeRaw !== "reply" &&
      modeRaw !== "forward"
    ) {
      errors.push("mode 必须是 new/reply/forward");
    }

    const subjectRaw = raw["subject"];
    const subject = typeof subjectRaw === "string" ? subjectRaw : "";
    if (subjectRaw !== undefined && typeof subjectRaw !== "string") {
      errors.push("subject 必须是字符串");
    }

    const bodyTextRaw = raw["bodyText"];
    const bodyText = typeof bodyTextRaw === "string" ? bodyTextRaw : "";
    if (bodyTextRaw !== undefined && typeof bodyTextRaw !== "string") {
      errors.push("bodyText 必须是字符串");
    }

    const bodyHtmlRaw = raw["bodyHtml"];
    const bodyHtml = typeof bodyHtmlRaw === "string" ? bodyHtmlRaw : null;
    if (bodyHtmlRaw !== undefined && bodyHtmlRaw !== null && typeof bodyHtmlRaw !== "string") {
      errors.push("bodyHtml 必须是字符串或 null");
    }

    const includeSignatureRaw = raw["includeSignature"];
    const includeSignature = typeof includeSignatureRaw === "boolean" ? includeSignatureRaw : true;
    if (includeSignatureRaw !== undefined && typeof includeSignatureRaw !== "boolean") {
      errors.push("includeSignature 必须是布尔值");
    }

    const replyToRaw = raw["replyToEmailId"];
    const replyToEmailId =
      typeof replyToRaw === "string" && replyToRaw.trim() !== "" ? replyToRaw.trim() : null;
    if (replyToRaw !== undefined && replyToRaw !== null && typeof replyToRaw !== "string") {
      errors.push("replyToEmailId 必须是字符串或 null");
    }

    const attachments = parseAttachments(raw["attachments"], errors);

    const recipients = [...to, ...cc, ...bcc];
    if (requireRecipients) {
      if (recipients.length === 0) errors.push("To/Cc/Bcc 至少需要一个收件人");
      for (const address of recipients) {
        if (!address.includes("@")) errors.push(`收件人地址不合法：${address}`);
      }
    }

    if (errors.length > 0) return { ok: false, message: errors[0] ?? "输入不合法" };
    return {
      ok: true,
      value: {
        mode,
        to,
        cc,
        bcc,
        subject,
        bodyText,
        bodyHtml,
        attachments,
        includeSignature,
        replyToEmailId,
      },
    };
  };

  const emitSend = (data: SendEventData): void => emit({ type: "send", data });

  /* ------------------------------ 幂等台账 ------------------------------ */

  interface LedgerEntry {
    readonly status: SendStatus;
    readonly outboxId: string | null;
    readonly emailId: string | null;
    readonly error: string | null;
    readonly messageHash: string;
    readonly at: number;
  }

  const LEDGER_TTL_MS = 10 * 60_000;
  const LEDGER_MAX = 200;
  const ledger = new Map<string, LedgerEntry>();

  const remember = (key: string | null, entry: Omit<LedgerEntry, "at">): void => {
    if (key === null) return;
    ledger.set(key, { ...entry, at: Date.now() });
    if (ledger.size > LEDGER_MAX) {
      const oldest = [...ledger.entries()].sort((a, b) => a[1].at - b[1].at);
      for (let index = 0; index < oldest.length - LEDGER_MAX; index += 1) {
        const entryKey = oldest[index]?.[0];
        if (entryKey !== undefined) ledger.delete(entryKey);
      }
    }
  };

  const pruneLedger = (): void => {
    const now = Date.now();
    for (const [key, entry] of ledger) {
      if (now - entry.at > LEDGER_TTL_MS) ledger.delete(key);
    }
  };

  /**
   * 同一个幂等键的重试：能复用就复用（sent 直接回成功；queued/failed 重置那一行再投递），
   * 内容变了就删掉从未投递的旧行、按新内容重新走。返回 null = 继续全新发送。
   */
  const resumeLedger = (
    c: Context,
    key: string,
    entry: LedgerEntry,
    accountId: string,
    messageHash: string,
    draftId: string | null,
  ): Response | null => {
    const sameMessage = entry.messageHash === messageHash;
    const item = entry.outboxId === null ? null : store.getOutboxItem(entry.outboxId);

    if (!sameMessage) {
      if (item !== null) {
        if (item.status === "sent") {
          // 旧内容已被后台 worker 投递成功，本次编辑后的内容还没发出去：
          // 既不能重复投递旧内容，也不能谎报「已发送新内容」。
          return invalid(c, "上一封邮件已由后台发送完成；请新建一封再发送修改后的内容");
        }
        if (item.status === "sending") {
          return jsonFailure(c, fail("upstream_error", "上一封正在发送中，请稍后重试", 502));
        }
        // queued/failed 从未投递：删掉旧快照，按本次编辑后的内容重新发送。
        store.deleteOutbox(item.id);
      }
      ledger.delete(key);
      return null;
    }

    if (entry.status === "sent") {
      // 审计行可能已被用户在发件箱里删掉：回 null 而不是一个已不存在的 id。
      return c.json({
        status: "sent",
        outboxId: item?.id ?? null,
        emailId: entry.emailId,
        error: null,
      } satisfies SendMessageResponse);
    }

    if (item !== null) {
      if (item.status === "sent") {
        // 入队后由 worker 完成投递；这里不知道本地镜像 id，但不重复投递。
        return c.json({
          status: "sent",
          outboxId: item.id,
          emailId: entry.emailId,
          error: null,
        } satisfies SendMessageResponse);
      }
      if (item.status !== "sending") store.retryOutbox(item.id);
      services.outbox?.kick();
      if (draftId !== null) store.deleteDraft(draftId);
      emitSend({ outboxId: item.id, accountId, status: "queued", emailId: null, error: null });
      remember(key, {
        status: "queued",
        outboxId: item.id,
        emailId: null,
        error: null,
        messageHash,
      });
      return c.json({
        status: "queued",
        outboxId: item.id,
        emailId: null,
        error: null,
      } satisfies SendMessageResponse);
    }

    // outbox 行被用户在发件箱里删掉了：同一封可以重新投递。
    ledger.delete(key);
    return null;
  };

  /* -------------------------------- POST /send ------------------------------- */

  app.post(`${API_PREFIX}/send`, async (c) => {
    const raw = await readJson(c);
    if (!isRecord(raw)) return invalid(c, "请求体必须是对象");
    const accountId = typeof raw["accountId"] === "string" ? raw["accountId"].trim() : "";
    if (accountId === "") return invalid(c, "accountId 必填");
    const parsed = parseMessage(raw["message"], true);
    if (!parsed.ok) return invalid(c, parsed.message);
    const message = parsed.value;
    const draftId =
      typeof raw["draftId"] === "string" && raw["draftId"].trim() !== ""
        ? raw["draftId"].trim()
        : null;
    const idempotencyKey =
      typeof raw["idempotencyKey"] === "string" && raw["idempotencyKey"].trim() !== ""
        ? raw["idempotencyKey"].trim()
        : draftId;
    const queueOnly = raw["queueOnly"] === true;

    const loaded = loadSendAccount(store, accountId);
    if (!loaded) return missing(c, "账号不存在");
    if (
      message.mode !== "new" &&
      message.replyToEmailId !== null &&
      !store.getEmail(message.replyToEmailId)
    ) {
      return missing(c, "被回复/转发的邮件不存在");
    }

    const key = idempotencyKey === null ? null : `${accountId}::${idempotencyKey}`;
    const messageHash = JSON.stringify(message);
    if (key !== null) {
      pruneLedger();
      const entry = ledger.get(key);
      if (entry !== undefined) {
        const resumed = resumeLedger(c, key, entry, accountId, messageHash, draftId);
        if (resumed !== null) return resumed;
      }
    }

    const queue = (): Response => {
      const item = store.enqueueOutbox(accountId, message);
      services.outbox?.kick();
      if (draftId !== null) store.deleteDraft(draftId);
      emitSend({ outboxId: item.id, accountId, status: "queued", emailId: null, error: null });
      remember(key, {
        status: "queued",
        outboxId: item.id,
        emailId: null,
        error: null,
        messageHash,
      });
      return c.json({
        status: "queued",
        outboxId: item.id,
        emailId: null,
        error: null,
      } satisfies SendMessageResponse);
    };

    if (queueOnly) return queue();

    let outcome: SendOutcome;
    try {
      outcome = await deliver({ store, mailSource: services.mailSource }, loaded, message);
    } catch (error) {
      // 适配器构造失败（缺 clientId/EWS URL 等）：没有发生任何投递。
      return jsonFailure(c, mailFailure(error, "发送邮件", secretsOf(loaded)));
    }

    if (outcome.result.ok) {
      // 成功审计行：同步入队并立即置 sent（两步之间没有 await，后台 worker 抢不到这一行）。
      const audit = store.enqueueOutbox(accountId, message);
      store.markOutboxSent(audit.id);
      if (draftId !== null) store.deleteDraft(draftId);
      emitSend({
        outboxId: audit.id,
        accountId,
        status: "sent",
        emailId: outcome.emailId,
        error: null,
      });
      remember(key, {
        status: "sent",
        outboxId: audit.id,
        emailId: outcome.emailId,
        error: null,
        messageHash,
      });
      return c.json({
        status: "sent",
        outboxId: audit.id,
        emailId: outcome.emailId,
        error: null,
      } satisfies SendMessageResponse);
    }

    // 投递失败；「已投递但 Sent 副本失败」在上面 ok 分支里已经按成功处理。
    const failure = outcome.result.error;
    const detail = redactAll(outcome.result.detail, secretsOf(loaded));
    if (failure.retryable) {
      // 断网/限流：入队，恢复后由 worker 按 ≥30s 退避重试（AC-12）。
      return queue();
    }

    // 不可重试（auth/protocol/not_configured/unsupported）：停在发件箱，可看原因、可手动重试。
    const parked = store.enqueueOutbox(accountId, message);
    store.markOutboxFailed(parked.id, detail, PARKED_RETRY_MS);
    emitSend({
      outboxId: parked.id,
      accountId,
      status: "failed",
      emailId: null,
      error: detail,
    });
    remember(key, {
      status: "failed",
      outboxId: parked.id,
      emailId: null,
      error: detail,
      messageHash,
    });
    // auth 用 401（唯一正确状态码），其余上游问题 502；文案已 redact。
    return jsonFailure(c, mailFailure(failure, "发送邮件", secretsOf(loaded)));
  });

  /* --------------------------------- drafts --------------------------------- */

  app.get(`${API_PREFIX}/drafts`, (c) => {
    const accountId = (c.req.query("accountId") ?? "").trim() || undefined;
    if (accountId !== undefined && !store.getAccountWithSecret(accountId)) {
      return missing(c, "账号不存在");
    }
    const body: DraftListResponse = { items: store.listDrafts(accountId) };
    return c.json(body);
  });

  app.get(`${API_PREFIX}/drafts/:id`, (c) => {
    const draft = store.getDraft(c.req.param("id"));
    if (!draft) return missing(c, "草稿不存在");
    return c.json({ draft });
  });

  app.put(`${API_PREFIX}/drafts`, async (c) => {
    const raw = await readJson(c);
    if (!isRecord(raw)) return invalid(c, "请求体必须是对象");
    const accountId = typeof raw["accountId"] === "string" ? raw["accountId"].trim() : "";
    if (accountId === "") return invalid(c, "accountId 必填");
    if (!store.getAccountWithSecret(accountId)) return missing(c, "账号不存在");
    const parsed = parseMessage(raw, false);
    if (!parsed.ok) return invalid(c, parsed.message);
    const draftId =
      typeof raw["draftId"] === "string" && raw["draftId"].trim() !== ""
        ? raw["draftId"].trim()
        : null;
    try {
      const draft = store.saveDraft(accountId, parsed.value, draftId);
      const body: SaveDraftResponse = { draft };
      return c.json(body);
    } catch (error) {
      return jsonFailure(c, mailFailure(error, "保存草稿"));
    }
  });

  app.delete(`${API_PREFIX}/drafts/:id`, (c) => {
    if (!store.deleteDraft(c.req.param("id"))) return missing(c, "草稿不存在");
    return c.json({ ok: true });
  });

  /* --------------------------------- outbox --------------------------------- */

  const OUTBOX_STATUSES: readonly OutboxStatus[] = ["queued", "sending", "failed", "sent"];

  app.get(`${API_PREFIX}/outbox`, (c) => {
    const accountId = (c.req.query("accountId") ?? "").trim() || undefined;
    const statusRaw = (c.req.query("status") ?? "").trim();
    if (accountId !== undefined && !store.getAccountWithSecret(accountId)) {
      return missing(c, "账号不存在");
    }
    if (statusRaw !== "" && !OUTBOX_STATUSES.includes(statusRaw as OutboxStatus)) {
      return invalid(c, "status 必须是 queued/sending/failed/sent");
    }
    const body: OutboxListResponse = {
      items: store.listOutbox({
        ...(accountId === undefined ? {} : { accountId }),
        ...(statusRaw === "" ? {} : { status: statusRaw as OutboxStatus }),
      }),
    };
    return c.json(body);
  });

  app.post(`${API_PREFIX}/outbox`, async (c) => {
    const raw = await readJson(c);
    if (!isRecord(raw)) return invalid(c, "请求体必须是对象");
    const accountId = typeof raw["accountId"] === "string" ? raw["accountId"].trim() : "";
    if (accountId === "") return invalid(c, "accountId 必填");
    if (!loadSendAccount(store, accountId)) return missing(c, "账号不存在");
    const parsed = parseMessage(raw["message"], true);
    if (!parsed.ok) return invalid(c, parsed.message);
    const item = store.enqueueOutbox(accountId, parsed.value);
    services.outbox?.kick();
    emitSend({ outboxId: item.id, accountId, status: "queued", emailId: null, error: null });
    const body: OutboxActionResponse = { item };
    return c.json(body);
  });

  app.post(`${API_PREFIX}/outbox/:id/retry`, (c) => {
    const id = c.req.param("id");
    const existing = store.getOutboxItem(id);
    if (!existing) return missing(c, "发件箱条目不存在");
    if (existing.status === "sent") return invalid(c, "已发送的邮件不能重试");
    if (existing.status === "sending") return invalid(c, "邮件正在发送中，请稍后");
    const item = store.retryOutbox(id);
    if (!item) return missing(c, "发件箱条目不存在");
    services.outbox?.kick();
    emitSend({
      outboxId: item.id,
      accountId: item.accountId,
      status: "queued",
      emailId: null,
      error: null,
    });
    const body: OutboxActionResponse = { item };
    return c.json(body);
  });

  app.delete(`${API_PREFIX}/outbox/:id`, (c) => {
    const id = c.req.param("id");
    const existing = store.getOutboxItem(id);
    if (!existing) return missing(c, "发件箱条目不存在");
    if (existing.status === "sending") return invalid(c, "邮件正在发送中，请稍后");
    store.deleteOutbox(id);
    const body: OutboxActionResponse = { item: existing };
    return c.json(body);
  });

  /* --------------------------- 启动即恢复离线队列 --------------------------- */

  // 上一进程留下的 queued/failed 行在重启后继续投递（AC-12 重启恢复）：应用装配完成时
  // 唤醒一次后台循环；`createOutboxWorker` 自己会先把残留的 `sending` 行拉回 `queued`。
  services.outbox?.kick();
}

/* ------------------------------ 离线发件 worker ----------------------------- */

/** 不可重试的失败停在发件箱里等用户手动重试：不自动重试，避免对错误配置反复发信。 */
const PARKED_RETRY_MS = 365 * 24 * 60 * 60 * 1000;
/** setTimeout 的安全上限（>2^31-1ms 会被 Node 截断成 1ms）。 */
const MAX_TIMER_MS = 24 * 60 * 60 * 1000;

export interface OutboxWorkerDeps {
  readonly store: Store;
  /** 账号 → 适配器工厂；未注入时 worker 不投递（保持队列原样，等接线）。 */
  readonly mailSource?: MailSourceFactory | undefined;
  /** SSE 发布（`type:"send"` 的 queued/sending/failed/sent）。 */
  readonly emit?: ((event: ServerEvent) => void) | undefined;
}

export interface OutboxWorker {
  /** 同步唤醒（立即返回）：请求线程不等待实际投递。 */
  kick(): void;
  /** 停掉定时器并等待进行中的一轮结束。 */
  stop(): Promise<void>;
  /** 跑完所有到期的 queued/failed 行（测试与启动扫描用）。 */
  drain(): Promise<{ sent: number; failed: number }>;
}

/**
 * 离线发件队列的后台循环（C5 / AC-12）。
 *
 * 状态机由 store 驱动：`claimNextOutbox` 原子地把最老的到期行 queued|failed → sending
 * 并 `attempts += 1`；成功 `markOutboxSent`，失败 `markOutboxFailed`（退避 ≥30 秒、翻倍，
 * 上限 30 分钟）。进程重启时 `recoverOutbox()` 把残留 `sending` 拉回 queued。
 * 单进程内单实例即可保证一行只被投递一次；跨进程并发不在 v1 范围（桌面单实例）。
 */
export function createOutboxWorker(deps: OutboxWorkerDeps): OutboxWorker {
  const { store, mailSource, emit } = deps;
  store.recoverOutbox();

  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let again = false;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const emitSend = (data: SendEventData): void => {
    emit?.({ type: "send", data });
  };

  const nextDelay = (): number | null => {
    let earliest: number | null = null;
    for (const item of store.listOutbox()) {
      if (item.status !== "queued" && item.status !== "failed") continue;
      const due = item.nextAttemptAt === null ? Date.now() : Date.parse(item.nextAttemptAt);
      if (!Number.isFinite(due)) continue;
      const delay = Math.max(0, due - Date.now());
      if (earliest === null || delay < earliest) earliest = delay;
    }
    return earliest === null ? null : Math.min(earliest, MAX_TIMER_MS);
  };

  const schedule = (): void => {
    // 没有适配器工厂时队列不会前进（drain 直接返回），不能再按 0ms 自唤醒空转。
    if (stopped || mailSource === undefined) return;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const delay = nextDelay();
    if (delay === null) return;
    timer = setTimeout(() => {
      timer = null;
      kick();
    }, delay);
    timer.unref?.();
  };

  /** 认领并投递一行；返回 null = 没有可认领的行（队列空或全在退避中）。 */
  const processOne = async (): Promise<"sent" | "failed" | null> => {
    const item = store.claimNextOutbox();
    if (item === null) return null;
    const accountId = item.accountId;
    emitSend({ outboxId: item.id, accountId, status: "sending", emailId: null, error: null });

    const loaded = loadSendAccount(store, accountId);
    if (loaded === null) {
      const detail = "账号不存在，无法发送";
      store.markOutboxFailed(item.id, detail, PARKED_RETRY_MS);
      emitSend({ outboxId: item.id, accountId, status: "failed", emailId: null, error: detail });
      return "failed";
    }

    try {
      const outcome = await deliver({ store, mailSource }, loaded, item.message);
      if (outcome.result.ok) {
        store.markOutboxSent(item.id);
        emitSend({
          outboxId: item.id,
          accountId,
          status: "sent",
          emailId: outcome.emailId,
          error: null,
        });
        return "sent";
      }
      const detail = redact(outcome.result.detail, secretsOf(loaded)).slice(0, 500);
      store.markOutboxFailed(
        item.id,
        detail,
        outcome.result.error.retryable ? undefined : PARKED_RETRY_MS,
      );
      emitSend({ outboxId: item.id, accountId, status: "failed", emailId: null, error: detail });
      return "failed";
    } catch (error) {
      const detail = redact(errorText(error), secretsOf(loaded)).slice(0, 500);
      const parked = error instanceof MailError && !error.retryable;
      store.markOutboxFailed(item.id, detail, parked ? PARKED_RETRY_MS : undefined);
      emitSend({ outboxId: item.id, accountId, status: "failed", emailId: null, error: detail });
      return "failed";
    }
  };

  const drain = async (): Promise<{ sent: number; failed: number }> => {
    let sent = 0;
    let failed = 0;
    // 没有适配器工厂时整个循环保持静默：队列行留在 queued，接线后自然恢复。
    if (mailSource === undefined) return { sent, failed };
    for (;;) {
      const result = await processOne();
      if (result === null) break;
      if (result === "sent") sent += 1;
      else failed += 1;
    }
    return { sent, failed };
  };

  const kick = (): void => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    inFlight = drain()
      .catch(() => undefined)
      .finally(() => {
        running = false;
        inFlight = null;
        if (again) {
          again = false;
          kick();
          return;
        }
        schedule();
      }) as Promise<void>;
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (inFlight !== null) {
      try {
        await inFlight;
      } catch {
        // 停止不需要传播投递错误。
      }
    }
  };

  return { kick, stop, drain };
}
