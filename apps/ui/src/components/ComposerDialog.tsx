import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type {
  AccountView,
  AttachmentPayload,
  ComposeMode,
  Draft,
  OutgoingMessage,
  SendMessageResponse,
} from "@mailcollect/shared";
import { api, isApiError } from "../lib/api";
import { Icon } from "./Icon";
import { formatBytes, sanitizeHtml } from "./MessageView";

export type ComposerInitialMode = ComposeMode;

/** 被回复/转发的本地邮件（来自已同步数据，不额外拉取）。 */
export interface ComposerSource {
  readonly id: string;
  readonly subject: string;
  readonly fromName: string | null;
  readonly fromEmail: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly sentAt: string;
  readonly bodyText: string;
}

export interface ComposerDialogProps {
  readonly open: boolean;
  readonly mode: ComposerInitialMode;
  readonly accounts: readonly AccountView[];
  /** 默认发件账号；null = 还没有可用账号（显示未配置提示）。 */
  readonly accountId: string | null;
  /** 回复/转发的原文；new 时为 null。服务端据此生成 In-Reply-To/References 与引用原文。 */
  readonly replyTo?: ComposerSource | null;
  /** 从草稿恢复：它的 id 作为 `(accountId, draftId)` upsert 键，同一会话的每次保存都带同一个值。 */
  readonly draft?: Draft | null;
  readonly onClose: () => void;
  readonly onSent?: (result: SendMessageResponse) => void;
  readonly onNotice?: (kind: "ok" | "error", text: string) => void;
}

const AUTOSAVE_DELAY_MS = 3000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ComposerForm {
  readonly to: string;
  readonly cc: string;
  readonly bcc: string;
  readonly subject: string;
  readonly body: string;
  readonly htmlMode: boolean;
  readonly includeSignature: boolean;
  readonly attachments: readonly AttachmentPayload[];
}

interface DraftSnapshot {
  readonly accountId: string;
  readonly draftId: string;
  readonly message: OutgoingMessage;
  readonly signature: string;
}

type DraftState = "idle" | "saving" | "saved" | "failed";

function newDraftId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parseAddresses(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 纯文本 → 最小 HTML 文档：保留换行（`<br/>`），其余全部转义，绝不拼接未转义内容。 */
function htmlFromText(text: string): string {
  const paragraphs = text
    .split(/\r?\n/)
    .map((line) => (line === "" ? "<br/>" : escapeHtml(line)))
    .join("<br/>");
  return `<!doctype html><html><body style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:14px;line-height:1.7;color:#0F2540"><div>${paragraphs}</div></body></html>`;
}

function readBase64(file: File): Promise<string> {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
    }
    return btoa(binary);
  });
}

function replySubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^re\s*:/i.test(trimmed)) return trimmed;
  return `Re: ${trimmed === "" ? "(无主题)" : trimmed}`;
}

function forwardSubject(subject: string): string {
  const trimmed = subject.trim();
  if (/^fwd?\s*:/i.test(trimmed)) return trimmed;
  return `Fwd: ${trimmed === "" ? "(无主题)" : trimmed}`;
}

const CARD_STYLE: CSSProperties = { width: "min(880px, 100%)", maxHeight: "min(88vh, 900px)", overflowY: "auto" };
const ROW_HINT: CSSProperties = { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" };
const ATTACH_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 10px",
  borderRadius: 12,
  background: "rgba(255,255,255,.7)",
  border: "1px solid rgba(47,124,246,.14)",
  marginTop: 6,
};
const ATTACH_NAME: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};
const QUOTE_PREVIEW: CSSProperties = {
  marginTop: 6,
  padding: "8px 10px",
  borderRadius: 12,
  background: "rgba(47,124,246,.05)",
  border: "1px dashed rgba(47,124,246,.24)",
  color: "var(--text-secondary, #5B7290)",
  fontSize: 12,
  lineHeight: 1.6,
  maxHeight: 120,
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
};

/**
 * 撰写 / 回复 / 转发弹层（C5）。
 *
 * 行为要点（与冻结的 HTTP 契约一一对应）：
 * - `draftId` 在**第一次自动保存前**生成并固定，停输 3 秒或关闭/切换邮件时保存；第二次保存是
 *   覆盖而不是新增行（upsert 键 `(accountId, draftId)`）。发送成功由服务端清理草稿。
 * - 发送结果分三态：`sent` 已投递（即使本地「已发送」副本写入失败也不重发）、`queued` 已入队
 *   （离线由服务端入队，联网后按 ≥30 秒退避重试）、硬失败（类型化 4xx/5xx）显示可读原因。
 * - Bcc 只在发送时透传：本地镜像不含 Bcc 是正确的，这里不做任何「补齐」。
 * - 签名由服务端按账号配置追加，单封可关（`includeSignature`）。
 */
export function ComposerDialog({
  open,
  mode,
  accounts,
  accountId,
  replyTo = null,
  draft = null,
  onClose,
  onSent,
  onNotice,
}: ComposerDialogProps) {
  const [account, setAccount] = useState<string | null>(accountId);
  const [form, setForm] = useState<ComposerForm>({
    to: "",
    cc: "",
    bcc: "",
    subject: "",
    body: "",
    htmlMode: false,
    includeSignature: true,
    attachments: [],
  });
  const [showCc, setShowCc] = useState(false);
  const [showBcc, setShowBcc] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [draftState, setDraftState] = useState<DraftState>("idle");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const draftIdRef = useRef<string | null>(null);
  const lastSavedRef = useRef<string | null>(null);
  const snapshotRef = useRef<DraftSnapshot | null>(null);
  const submitRef = useRef<() => void>(() => undefined);
  const persistRef = useRef<(snapshot: DraftSnapshot) => Promise<void>>(async () => undefined);

  const sessionKey = `${mode}|${accountId ?? ""}|${replyTo?.id ?? ""}|${draft?.id ?? ""}`;

  /** 由当前表单构出待发送消息；undefined 表示账号缺失，无法构成草稿/发送主体。 */
  const buildMessage = useCallback((): OutgoingMessage => {
    return {
      mode,
      to: parseAddresses(form.to),
      cc: parseAddresses(form.cc),
      bcc: parseAddresses(form.bcc),
      subject: form.subject.trim(),
      bodyText: form.body,
      bodyHtml: form.htmlMode ? htmlFromText(form.body) : null,
      attachments: [...form.attachments],
      includeSignature: form.includeSignature,
      // 恢复草稿时原文可能已不在本页上下文里：沿用草稿记录的 replyToEmailId，
      // 否则重新保存会把「这是回复」这条线索丢掉（In-Reply-To/引用原文随之消失）。
      replyToEmailId: replyTo?.id ?? draft?.replyToEmailId ?? null,
    };
  }, [mode, form, replyTo, draft]);

  const isEmptyForm = useCallback(
    (current: ComposerForm): boolean =>
      current.to.trim() === "" &&
      current.subject.trim() === "" &&
      current.body.trim() === "" &&
      current.attachments.length === 0,
    [],
  );

  /** 落草稿：`draftId` 缺失时先固定一个稳定 id，保证第二次保存是覆盖而不是新增。 */
  const flushDraft = useCallback(
    (snapshot: DraftSnapshot): void => {
      if (snapshot.draftId === "") draftIdRef.current ??= newDraftId();
      const draftId = snapshot.draftId === "" ? draftIdRef.current : snapshot.draftId;
      if (draftId === null || draftId === "") return;
      void persistRef.current({ ...snapshot, draftId });
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    // 切换邮件/模式：先把上一个会话里未保存的内容落成草稿，再重置。
    const previous = snapshotRef.current;
    if (previous !== null && previous.signature !== lastSavedRef.current && previous.draftId !== "") {
      flushDraft(previous);
    }
    draftIdRef.current = draft?.id ?? null;
    lastSavedRef.current = null;
    setAccount(accountId);
    setForm({
      to: draft === null ? (mode === "reply" && replyTo !== null ? replyTo.fromEmail : "") : draft.to.join(", "),
      cc: draft === null ? "" : draft.cc.join(", "),
      bcc: draft === null ? "" : draft.bcc.join(", "),
      subject:
        draft !== null
          ? draft.subject
          : replyTo === null || mode === "new"
            ? ""
            : mode === "reply"
              ? replySubject(replyTo.subject)
              : forwardSubject(replyTo.subject),
      body: draft === null ? "" : draft.bodyText,
      htmlMode: draft !== null && draft.bodyHtml !== null,
      includeSignature: draft === null ? true : draft.includeSignature,
      attachments: draft === null ? [] : [...draft.attachments],
    });
    setShowCc(draft !== null && draft.cc.length > 0);
    setShowBcc(draft !== null && draft.bcc.length > 0);
    setSendError(null);
    setAttachmentError(null);
    setDraftState("idle");
    setDraftError(null);
    setSavedAt(draft === null ? null : draft.savedAt);
    // sessionKey 已涵盖 mode/accountId/replyTo.id/draft.id：它一变就重建整张表单。
    // 不能把 replyTo/draft 对象本身列入依赖——父级重渲染会给出新引用，从而把用户正在打的内容重置掉。
  }, [open, sessionKey]);

  const signature = useMemo(
    () =>
      JSON.stringify([
        account,
        form.to,
        form.cc,
        form.bcc,
        form.subject,
        form.body,
        form.htmlMode,
        form.includeSignature,
        form.attachments.map((item) => `${item.filename}:${item.size}`),
        mode,
        replyTo?.id ?? null,
      ]),
    [account, form, mode, replyTo],
  );

  snapshotRef.current =
    account === null
      ? null
      : {
          accountId: account,
          draftId: draftIdRef.current ?? "",
          message: buildMessage(),
          signature,
        };

  const persistDraft = useCallback(async (snapshot: DraftSnapshot): Promise<void> => {
    if (snapshot.draftId === "") return;
    if (lastSavedRef.current === snapshot.signature) return;
    setDraftState("saving");
    try {
      const saved = await api.drafts.save({
        accountId: snapshot.accountId,
        draftId: snapshot.draftId,
        ...snapshot.message,
      });
      lastSavedRef.current = snapshot.signature;
      setDraftState("saved");
      setSavedAt(saved.savedAt);
      setDraftError(null);
    } catch (error) {
      setDraftState("failed");
      setDraftError(isApiError(error) ? error.message : "草稿保存失败");
    }
  }, []);
  persistRef.current = persistDraft;

  // 停输 3 秒自动保存；内容为空、账号缺失或正在发送时不落草稿。
  useEffect(() => {
    if (!open || sending || account === null) return;
    if (isEmptyForm(form)) return;
    if (signature === lastSavedRef.current) return;
    const timer = window.setTimeout(() => {
      const snapshot = snapshotRef.current;
      if (snapshot === null) return;
      flushDraft(snapshot);
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [open, sending, account, form, signature, isEmptyForm, flushDraft]);

  const close = useCallback(() => {
    if (sending) return;
    const snapshot = snapshotRef.current;
    if (snapshot !== null && !isEmptyForm(form) && snapshot.signature !== lastSavedRef.current) {
      flushDraft(snapshot);
    }
    onClose();
  }, [sending, onClose, flushDraft, isEmptyForm, form]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submitRef.current();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  const validate = (message: OutgoingMessage): string | null => {
    if (account === null) return "还没有可用的发件账号：先在设置页添加邮箱账号并填好发信设置。";
    if (message.to.length === 0) return "至少填一个收件人。";
    const bad = [...message.to, ...message.cc, ...message.bcc].find((item) => !EMAIL_PATTERN.test(item));
    if (bad !== undefined) return `地址格式不对：${bad}`;
    return null;
  };

  const submitSend = useCallback(async (): Promise<void> => {
    if (sending || account === null) return;
    const message = buildMessage();
    const problem = validate(message);
    if (problem !== null) {
      setSendError(problem);
      return;
    }
    setSendError(null);
    setSending(true);
    const draftId = draftIdRef.current ?? (draft === null ? null : draft.id);
    try {
      const result = await api.send.submit({
        accountId: account,
        message,
        draftId: draftId === null ? undefined : draftId,
      });
      if (result.status === "sent") {
        // emailId === null 表示本地「已发送」镜像没写成功：邮件已经投递，绝不提示重发。
        onNotice?.(
          "ok",
          result.emailId === null
            ? "已发送；本地「已发送」副本未写入（服务器 Sent 可能缺失，邮件本身已投递）。"
            : "已发送。",
        );
      } else if (result.status === "queued") {
        onNotice?.("ok", "已加入发件箱：联网或退避到期后由服务端自动重试（至少 30 秒间隔）。");
      } else {
        onNotice?.("error", result.error ?? "发送失败，可在发件箱查看原因并重试。");
      }
      draftIdRef.current = null;
      onSent?.(result);
      onClose();
    } catch (error) {
      if (isApiError(error)) {
        setSendError(
          error.code === "network"
            ? `${error.message}（网络不可达：可改为「仅入队」稍后自动重试）`
            : error.message,
        );
      } else {
        setSendError("发送失败：未知错误");
      }
    } finally {
      setSending(false);
    }
  }, [sending, account, buildMessage, draft, onNotice, onSent, onClose, validate]);

  // Cmd/Ctrl+Enter 走 ref：键盘监听只注册一次，这里每次渲染刷新到最新的表单快照。
  submitRef.current = () => {
    void submitSend();
  };

  const queueOnly = useCallback(async (): Promise<void> => {
    if (sending || account === null) return;
    const message = buildMessage();
    const problem = validate(message);
    if (problem !== null) {
      setSendError(problem);
      return;
    }
    setSendError(null);
    setSending(true);
    try {
      const result = await api.send.submit({
        accountId: account,
        message,
        draftId: draftIdRef.current ?? undefined,
        queueOnly: true,
      });
      onNotice?.("ok", "已加入发件箱（仅入队），联网后自动投递。");
      draftIdRef.current = null;
      onSent?.(result);
      onClose();
    } catch (error) {
      setSendError(isApiError(error) ? error.message : "入队失败：未知错误");
    } finally {
      setSending(false);
    }
  }, [sending, account, buildMessage, onNotice, onSent, onClose]);

  const deleteDraft = useCallback(async (): Promise<void> => {
    const id = draftIdRef.current ?? draft?.id ?? null;
    if (id === null) {
      onClose();
      return;
    }
    try {
      await api.drafts.remove(id);
      draftIdRef.current = null;
      onNotice?.("ok", "草稿已删除。");
    } catch (error) {
      onNotice?.("error", isApiError(error) ? error.message : "草稿删除失败");
    }
    onClose();
  }, [draft, onClose, onNotice]);

  const handleFiles = async (fileList: FileList | null): Promise<void> => {
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;
    if (form.attachments.length + files.length > MAX_ATTACHMENTS) {
      setAttachmentError(`最多 ${MAX_ATTACHMENTS} 个附件`);
      return;
    }
    let total = form.attachments.reduce((sum, item) => sum + item.size, 0);
    const added: AttachmentPayload[] = [];
    let problem: string | null = null;
    for (const file of files) {
      if (file.size > MAX_FILE_BYTES) {
        problem = `${file.name} 超过单附件 10 MB 上限`;
        continue;
      }
      if (total + file.size > MAX_TOTAL_BYTES) {
        problem = "附件总大小超过 20 MB";
        break;
      }
      const dataBase64 = await readBase64(file);
      added.push({
        filename: file.name,
        mimeType: file.type === "" ? "application/octet-stream" : file.type,
        size: file.size,
        dataBase64,
      });
      total += file.size;
    }
    if (added.length > 0) {
      setForm((previous) => ({ ...previous, attachments: [...previous.attachments, ...added] }));
    }
    setAttachmentError(problem);
  };

  if (!open) return null;

  const modeLabel = mode === "reply" ? "回复" : mode === "forward" ? "转发" : "写邮件";
  const activeAccount = accounts.find((item) => item.id === account) ?? null;
  const sendCopyNote = replyTo === null ? null : `将引用「${replyTo.subject}」原文`;
  const draftLabel =
    draftState === "saving"
      ? "草稿保存中…"
      : draftState === "failed"
        ? `草稿未保存：${draftError ?? "未知原因"}`
        : draftState === "saved"
          ? `草稿已保存 · ${savedAt === null ? "刚刚" : new Date(savedAt).toLocaleTimeString("zh-CN", { hour12: false })}`
          : savedAt === null
            ? "草稿自动保存：停输 3 秒或关闭时"
            : "草稿已保存";

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={close}>
      <div
        className="dialog-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="composer-title"
        style={CARD_STYLE}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-head">
          <div className="dialog-icon">
            <Icon name="mail" size={20} />
          </div>
          <div className="dialog-titles">
            <h2 className="dialog-title" id="composer-title">
              {modeLabel}
            </h2>
            <p className="dialog-sub">
              {activeAccount === null
                ? "尚未选择发件账号"
                : `发件账号 ${activeAccount.label} · ${activeAccount.email}`}
              {sendCopyNote === null ? "" : ` · ${sendCopyNote}`}
            </p>
          </div>
          <button type="button" className="dialog-close" aria-label="关闭" onClick={close}>
            <Icon name="close" size={16} />
          </button>
        </div>

        {accounts.length === 0 ? (
          <div className="test-result is-error" role="status">
            <Icon name="alert" size={14} />
            还没有邮箱账号：先在设置页添加账号并填写 SMTP / Graph / EWS 发信设置，然后再写信。
          </div>
        ) : null}

        <div className="form-grid">
          <div className="form-row form-row--full">
            <label className="field-label" htmlFor="composer-account">
              发件账号（From 固定为该账号地址）
            </label>
            <div style={ROW_HINT}>
              <select
                className="select"
                id="composer-account"
                value={account ?? ""}
                onChange={(event) => {
                  const next = event.target.value === "" ? null : event.target.value;
                  const snapshot = snapshotRef.current;
                  if (snapshot !== null && snapshot.signature !== lastSavedRef.current && !isEmptyForm(form)) {
                    flushDraft(snapshot);
                  }
                  draftIdRef.current = null;
                  lastSavedRef.current = null;
                  setDraftState("idle");
                  setAccount(next);
                }}
              >
                <option value="">（选择账号）</option>
                {accounts.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label} · {item.email}
                  </option>
                ))}
              </select>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.includeSignature}
                  onChange={(event) =>
                    setForm((previous) => ({ ...previous, includeSignature: event.target.checked }))
                  }
                />
                附加账号签名
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={form.htmlMode}
                  onChange={(event) => setForm((previous) => ({ ...previous, htmlMode: event.target.checked }))}
                />
                以 HTML 发送
              </label>
            </div>
          </div>

          <div className="form-row form-row--full">
            <label className="field-label" htmlFor="composer-to">
              收件人（To，逗号分隔）
            </label>
            <input
              className="input"
              id="composer-to"
              value={form.to}
              placeholder="name@example.com"
              onChange={(event) => setForm((previous) => ({ ...previous, to: event.target.value }))}
            />
            <div style={ROW_HINT}>
              {showCc ? null : (
                <button type="button" className="btn btn--sm btn--quiet" onClick={() => setShowCc(true)}>
                  添加抄送 Cc
                </button>
              )}
              {showBcc ? null : (
                <button type="button" className="btn btn--sm btn--quiet" onClick={() => setShowBcc(true)}>
                  添加密送 Bcc
                </button>
              )}
              <span className="field-hint">Bcc 只随投递发出，本地「已发送」副本不含密送地址。</span>
            </div>
          </div>

          {showCc ? (
            <div className="form-row form-row--full">
              <label className="field-label" htmlFor="composer-cc">
                抄送（Cc）
              </label>
              <input
                className="input"
                id="composer-cc"
                value={form.cc}
                placeholder="cc@example.com"
                onChange={(event) => setForm((previous) => ({ ...previous, cc: event.target.value }))}
              />
            </div>
          ) : null}

          {showBcc ? (
            <div className="form-row form-row--full">
              <label className="field-label" htmlFor="composer-bcc">
                密送（Bcc）
              </label>
              <input
                className="input"
                id="composer-bcc"
                value={form.bcc}
                placeholder="bcc@example.com"
                onChange={(event) => setForm((previous) => ({ ...previous, bcc: event.target.value }))}
              />
            </div>
          ) : null}

          <div className="form-row form-row--full">
            <label className="field-label" htmlFor="composer-subject">
              主题
            </label>
            <input
              className="input"
              id="composer-subject"
              value={form.subject}
              placeholder="主题"
              onChange={(event) => setForm((previous) => ({ ...previous, subject: event.target.value }))}
            />
          </div>

          <div className="form-row form-row--full">
            <label className="field-label" htmlFor="composer-body">
              正文（{form.htmlMode ? "HTML 发送 / 纯文本编辑" : "纯文本"}）
            </label>
            <textarea
              className="textarea"
              id="composer-body"
              rows={9}
              value={form.body}
              placeholder={replyTo === null ? "写点什么…" : "（引用原文由服务端按回复/转发规则追加）"}
              onChange={(event) => setForm((previous) => ({ ...previous, body: event.target.value }))}
            />
          </div>

          {form.htmlMode && form.body.trim() !== "" ? (
            <div className="form-row form-row--full">
              <span className="field-label">HTML 预览（同一份清洗函数，最终仍以服务端投递为准）</span>
              <div
                style={QUOTE_PREVIEW}
                dangerouslySetInnerHTML={{ __html: sanitizeHtml(htmlFromText(form.body)) }}
              />
            </div>
          ) : null}

          <div className="form-row form-row--full">
            <div style={ROW_HINT}>
              <label className="btn btn--sm btn--quiet" style={{ cursor: "pointer" }}>
                <Icon name="paperclip" size={13} />
                添加附件
                <input
                  type="file"
                  multiple
                  style={{ display: "none" }}
                  onChange={(event) => {
                    void handleFiles(event.target.files);
                    event.target.value = "";
                  }}
                />
              </label>
              <span className="field-hint">
                共 {form.attachments.length} 个 ·{" "}
                {formatBytes(form.attachments.reduce((sum, item) => sum + item.size, 0))}（单附件 ≤10 MB，合计 ≤20 MB）
              </span>
            </div>
            {form.attachments.map((attachment, index) => (
              <div key={`${attachment.filename}-${index.toString()}`} style={ATTACH_ROW}>
                <span style={ATTACH_NAME} title={attachment.filename}>
                  {attachment.filename}
                </span>
                <span className="field-hint">{formatBytes(attachment.size)}</span>
                <button
                  type="button"
                  className="btn btn--sm btn--quiet"
                  onClick={() =>
                    setForm((previous) => ({
                      ...previous,
                      attachments: previous.attachments.filter((_, item) => item !== index),
                    }))
                  }
                >
                  移除
                </button>
              </div>
            ))}
            {attachmentError === null ? null : (
              <div className="test-result is-error" role="status">
                <Icon name="alert" size={13} />
                {attachmentError}
              </div>
            )}
          </div>
        </div>

        {sendError === null ? null : (
          <div className="test-result is-error" role="status">
            <Icon name="alert" size={14} />
            {sendError}
          </div>
        )}

        <div className="dialog-actions">
          <span className="field-hint" style={{ marginRight: "auto" }}>
            {draftLabel}
          </span>
          <button type="button" className="btn btn--quiet" disabled={sending} onClick={() => void deleteDraft()}>
            删除草稿
          </button>
          <button type="button" className="btn btn--quiet" disabled={sending} onClick={() => void queueOnly()}>
            仅入队
          </button>
          <button type="button" className="btn btn--primary" disabled={sending} onClick={() => void submitSend()}>
            {sending ? "发送中…" : "发送"}
          </button>
          <button type="button" className="btn btn--quiet" disabled={sending} onClick={close}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
