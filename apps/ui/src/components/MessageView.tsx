import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import type { AttachmentMeta, MessageBody, RawEmail } from "@mailcollect/shared";
import { Icon } from "./Icon";

/**
 * 只读的邮件正文视图：正文（HTML 走前端二次净化，可切纯文本）+「引用原文」+ 附件列表。
 *
 * HTML 由服务端 sanitize 后通过 `MessageDetailResponse.body.html` 下发；这里再做一层白名单
 * 清洗（AC-16 的浏览器侧第二次机会）。原则是**剥掉一切主动内容**而不是「重新格式化」：
 * `<script>/<style>/<iframe>/<object>/<embed>/<form>` 等整棵子树删除，`on*` 事件属性、
 * `srcdoc`、`javascript:` 协议一律移除；链接补 `rel="noopener noreferrer nofollow"` 与新窗口。
 *
 * 样式走内联（`apps/ui/src/styles/global.css` 不在本任务写域内），只复用既有的
 * `.mail-body` / `.filter-chip` / `.btn` / `.field-hint` / `.test-result` 外观。
 */

const DROP_ELEMENTS = new Set([
  "script",
  "style",
  "link",
  "meta",
  "base",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "svg",
  "math",
  "template",
  "noscript",
]);

const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:", "cid:"]);

/** 相对地址（无 scheme）视为同源安全；`//host` 也按 http(s) 处理。 */
function isSafeUrl(raw: string): boolean {
  const value = raw.trim();
  if (value === "") return true;
  if (value.startsWith("#") || value.startsWith("/") || value.startsWith("./") || value.startsWith("../")) {
    return true;
  }
  if (value.startsWith("//")) return true;
  const colon = value.indexOf(":");
  if (colon < 0) return true;
  const scheme = `${value.slice(0, colon).toLowerCase()}:`;
  return SAFE_SCHEMES.has(scheme);
}

/** `img src` 额外允许 `data:image/*`（服务端下发的内联图片），但拒绝 `data:text/html`。 */
function isSafeImageUrl(raw: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value.startsWith("data:")) return value.startsWith("data:image/") && !value.includes("svg");
  return isSafeUrl(raw);
}

/** 内联样式里的主动内容：expression()/behavior/url(javascript:) 等。 */
const UNSAFE_STYLE = /expression\s*\(|javascript:|vbscript:|behavior\s*:|@import/i;

function sanitizeStyle(value: string): string {
  if (UNSAFE_STYLE.test(value)) return "";
  // `url(...)` 只允许 http(s)/data:image，其余整段丢弃。
  const urlPattern = /url\(\s*(['"]?)([^)'"]*)\1\s*\)/gi;
  let unsafe = false;
  for (const match of value.matchAll(urlPattern)) {
    const target = match[2] ?? "";
    if (!isSafeImageUrl(target)) unsafe = true;
  }
  return unsafe ? "" : value;
}

/**
 * 前端二次净化：返回可安全交给 `dangerouslySetInnerHTML` 的 HTML 字符串。
 * 解析失败（环境无 DOMParser）时按纯文本处理，宁可丢样式也不放行脚本。
 */
export function sanitizeHtml(input: string): string {
  if (input.trim() === "") return "";
  if (typeof DOMParser === "undefined") return "";
  const doc = new DOMParser().parseFromString(input, "text/html");
  const root = doc.body;

  for (const element of Array.from(root.querySelectorAll(Array.from(DROP_ELEMENTS).join(",")))) {
    element.remove();
  }

  for (const element of Array.from(root.querySelectorAll("*"))) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith("on")) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "srcdoc" || name === "id" || name === "name") {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "style") {
        const cleaned = sanitizeStyle(attribute.value);
        if (cleaned === "") element.removeAttribute("style");
        else element.setAttribute("style", cleaned);
        continue;
      }
      if (name === "href" || name === "xlink:href" || name === "action" || name === "formaction") {
        if (!isSafeUrl(attribute.value)) element.removeAttribute(attribute.name);
        continue;
      }
      if (name === "src" || name === "srcset" || name === "background" || name === "poster") {
        if (!isSafeImageUrl(attribute.value)) element.removeAttribute(attribute.name);
      }
    }
    if (element.tagName.toLowerCase() === "a") {
      element.setAttribute("target", "_blank");
      element.setAttribute("rel", "noopener noreferrer nofollow");
    }
  }

  return root.innerHTML;
}

/** 附件大小：B/KB/MB，保留一位小数，避免 `102400 B` 这种难读的数字。 */
export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"] as const;
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit] ?? "B"}`;
}

const QUOTE_MARKER =
  /^(?:\s*>|\s*--\s*$|\s*(?:在|On)\s.+?(?:写道|wrote)\s*:?\s*$|-----+\s*(?:原始邮件|转发邮件|Original Message))/;

/**
 * 把正文拆成「本次内容」与「引用原文」：同步时引文已被剥离，但本地/已发送镜像仍可能保留
 * `>` 引用块或「在 … 写道」分隔行，折叠展示而不是丢掉。
 */
export function splitQuoted(text: string): { readonly main: string; readonly quoted: string } {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => QUOTE_MARKER.test(line));
  if (index <= 0) return { main: text.trim(), quoted: "" };
  return {
    main: lines.slice(0, index).join("\n").trim(),
    quoted: lines.slice(index).join("\n").trim(),
  };
}

const MODE_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flexWrap: "wrap",
  marginBottom: 10,
};

const QUOTE_BOX: CSSProperties = {
  marginTop: 12,
  borderTop: "1px dashed rgba(47,124,246,.28)",
  paddingTop: 8,
};

const QUOTE_SUMMARY: CSSProperties = {
  cursor: "pointer",
  fontSize: 12,
  color: "var(--text-dim, #5B7290)",
  fontWeight: 600,
};

const QUOTE_BODY: CSSProperties = {
  margin: "8px 0 0",
  padding: "10px 12px",
  borderRadius: 12,
  background: "rgba(47,124,246,.05)",
  color: "var(--text-dim, #5B7290)",
  fontSize: 12.5,
  lineHeight: 1.6,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "inherit",
};

const ATTACH_BOX: CSSProperties = {
  marginTop: 14,
  borderTop: "1px solid rgba(47,124,246,.14)",
  paddingTop: 10,
};

const ATTACH_HEAD: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  fontSize: 12,
  fontWeight: 700,
  color: "var(--text-dim, #5B7290)",
  marginBottom: 8,
};

const ATTACH_ROW: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "6px 8px",
  borderRadius: 12,
  background: "rgba(255,255,255,.66)",
  border: "1px solid rgba(47,124,246,.14)",
  marginBottom: 6,
};

const ATTACH_NAME: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12.5,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const ATTACH_SIZE: CSSProperties = {
  fontSize: 11.5,
  color: "var(--text-dim, #5B7290)",
  fontVariantNumeric: "tabular-nums",
};

export interface MessageViewProps {
  readonly message: Pick<RawEmail, "id" | "subject">;
  readonly body: MessageBody;
  readonly attachments: readonly AttachmentMeta[];
  /** 点击附件下载；缺省时按钮禁用（演示数据没有真实字节）。 */
  readonly onDownload?: (attachment: AttachmentMeta) => void;
  readonly downloadingId?: string | null;
  /** 附件下载失败的可读原因。 */
  readonly downloadError?: string | null;
}

export function MessageView({
  message,
  body,
  attachments,
  onDownload,
  downloadingId = null,
  downloadError = null,
}: MessageViewProps) {
  const cleanHtml = useMemo(() => (body.html === null ? "" : sanitizeHtml(body.html)), [body.html]);
  const hasHtml = cleanHtml.trim() !== "";
  const [renderMode, setRenderMode] = useState<"html" | "text">("html");
  const quoted = useMemo(() => splitQuoted(body.text), [body.text]);
  const htmlActive = hasHtml && renderMode === "html";

  return (
    <div data-message-id={message.id} data-render-mode={htmlActive ? "html" : "text"}>
      {hasHtml ? (
        <div style={MODE_ROW}>
          <button
            type="button"
            className={htmlActive ? "filter-chip is-active" : "filter-chip"}
            onClick={() => setRenderMode("html")}
          >
            富文本
          </button>
          <button
            type="button"
            className={htmlActive ? "filter-chip" : "filter-chip is-active"}
            onClick={() => setRenderMode("text")}
          >
            纯文本
          </button>
          <span className="field-hint">已清洗：脚本、事件属性与危险协议均已移除。</span>
        </div>
      ) : null}

      {htmlActive ? (
        <div className="mail-body" dangerouslySetInnerHTML={{ __html: cleanHtml }} />
      ) : (
        <div className="mail-body">{quoted.main === "" ? body.text : quoted.main}</div>
      )}

      {quoted.quoted === "" ? null : (
        <details style={QUOTE_BOX}>
          <summary style={QUOTE_SUMMARY}>
            引用原文（{quoted.quoted.split(/\r?\n/).length} 行）
          </summary>
          <pre style={QUOTE_BODY}>{quoted.quoted}</pre>
        </details>
      )}

      {attachments.length === 0 ? null : (
        <div style={ATTACH_BOX}>
          <div style={ATTACH_HEAD}>
            <Icon name="paperclip" size={13} />
            附件 {attachments.length} 个
          </div>
          {downloadError === null ? null : (
            <div className="test-result is-error" role="status">
              <Icon name="alert" size={13} />
              {downloadError}
            </div>
          )}
          {attachments.map((attachment) => (
            <div key={attachment.id} style={ATTACH_ROW}>
              <span style={ATTACH_NAME} title={attachment.filename}>
                {attachment.filename}
              </span>
              <span style={ATTACH_SIZE}>{formatBytes(attachment.size)}</span>
              <button
                type="button"
                className="btn btn--sm btn--quiet"
                disabled={onDownload === undefined || downloadingId === attachment.id}
                title={onDownload === undefined ? "演示数据没有附件字节" : "下载附件"}
                onClick={() => onDownload?.(attachment)}
              >
                {downloadingId === attachment.id ? "下载中…" : "下载"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
