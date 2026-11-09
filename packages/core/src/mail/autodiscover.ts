import type { MailSourceAccount } from "./account.js";
import { readConfig } from "./account.js";
import { isAbortError, notConfiguredError, redact, toMailError } from "./errors.js";
import { MailError } from "./types.js";

/**
 * Exchange Autodiscover 与「极简 XML 解析」。
 *
 * 为什么自带 XML 解析：本仓库不引第三方 XML 依赖（`packages/core/package.json` 不归本任务），
 * 而 Autodiscover 与 EWS 都只需要「元素、属性、直接文本」这一层，实体展开与 CDATA
 * 由这里一次处理。解析失败一律映射成类型化 `MailError("protocol")`，绝不把原始异常抛给调用方。
 *
 * 安全：请求里的密码只出现在 `Authorization: Basic` 头里；错误文本在装配成 `MailError`
 * 之前统一经过 `redact()`，不会把 secret 回显给 UI 或日志。
 */

/* ------------------------------- XML 解析 -------------------------------- */

/** 解析后的元素：`name` 是去掉命名空间前缀的本地名（`soap:Envelope` → `Envelope`）。 */
export interface XmlElement {
  readonly name: string;
  /** 属性名同样去掉前缀；值已展开实体。 */
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlElement[];
  /** 直接文本（不含子元素文本）；已展开实体、保留 CDATA 原样。 */
  readonly text: string;
}

interface MutableXmlElement {
  name: string;
  attributes: Record<string, string>;
  children: MutableXmlElement[];
  text: string;
}

/** 自动发现响应可能包含的 XML 实体；未知实体保持原样，避免吞掉正文。 */
const XML_ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** XML 树深度上限：防止恶意/损坏文档把递归解析拖爆栈。 */
const MAX_XML_DEPTH = 256;

function decodeXmlEntities(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return XML_ENTITIES[body] ?? match;
  });
}

/** `t:Body` → `Body`；没有前缀时原样返回。 */
function localName(name: string): string {
  const colon = name.indexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** 找到标签的结束 `>`，跳过引号里的 `>`。 */
function findTagEnd(input: string, start: number): number {
  let quote: string | null = null;
  for (let index = start + 1; index < input.length; index += 1) {
    const char = input[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index;
  }
  return -1;
}

const ATTRIBUTE_PATTERN = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

function parseAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    const rawName = match[1];
    if (rawName === undefined) continue;
    const value = match[2] ?? match[3] ?? "";
    attributes[localName(rawName)] = decodeXmlEntities(value);
  }
  return attributes;
}

/**
 * 解析一段 XML 文档（正好一个根元素）。
 *
 * 容忍：XML 声明、注释、DOCTYPE、CDATA、命名空间前缀、属性单双引号。
 * 拒绝（`MailError("protocol")`）：未闭合标签、标签不匹配、多根、深度超限。
 */
export function parseXmlDocument(source: string, context = "XML"): XmlElement {
  const input = source.replace(/^\uFEFF/, "");
  const stack: MutableXmlElement[] = [];
  let root: MutableXmlElement | null = null;
  let index = 0;

  const malformed = (detail: string): MailError =>
    new MailError("protocol", `${context} 解析失败：${detail}`, false);
  const appendText = (raw: string): void => {
    if (raw.length === 0) return;
    const top = stack[stack.length - 1];
    if (top !== undefined) top.text += decodeXmlEntities(raw);
  };
  const appendRaw = (raw: string): void => {
    const top = stack[stack.length - 1];
    if (top !== undefined) top.text += raw;
  };

  while (index < input.length) {
    const lt = input.indexOf("<", index);
    if (lt === -1) {
      appendText(input.slice(index));
      break;
    }
    appendText(input.slice(index, lt));

    if (input.startsWith("<?", lt)) {
      const end = input.indexOf("?>", lt + 2);
      if (end === -1) throw malformed("XML 声明没有结束");
      index = end + 2;
      continue;
    }
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      if (end === -1) throw malformed("注释没有结束");
      index = end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      if (end === -1) throw malformed("CDATA 没有结束");
      appendRaw(input.slice(lt + 9, end));
      index = end + 3;
      continue;
    }
    if (input.startsWith("<!", lt)) {
      const end = findTagEnd(input, lt);
      if (end === -1) throw malformed("文档类型声明没有结束");
      index = end + 1;
      continue;
    }

    const end = findTagEnd(input, lt);
    if (end === -1) throw malformed("标签没有结束");
    const tag = input.slice(lt + 1, end).trim();
    index = end + 1;
    if (tag.length === 0) throw malformed("空标签");

    if (tag.startsWith("/")) {
      const name = localName(tag.slice(1).trim());
      const closed = stack.pop();
      if (closed === undefined) throw malformed(`多余的结束标签 </${name}>`);
      if (closed.name !== name) throw malformed(`结束标签 </${name}> 与 <${closed.name}> 不匹配`);
      if (stack.length === 0) {
        if (root !== null) throw malformed("存在多个根元素");
        root = closed;
      }
      continue;
    }

    const selfClosing = tag.endsWith("/");
    const inner = selfClosing ? tag.slice(0, -1).trim() : tag;
    const nameEnd = inner.search(/\s/);
    const rawName = nameEnd === -1 ? inner : inner.slice(0, nameEnd);
    const name = localName(rawName);
    if (name.length === 0) throw malformed("标签名称为空");
    const element: MutableXmlElement = {
      name,
      attributes: parseAttributes(nameEnd === -1 ? "" : inner.slice(nameEnd)),
      children: [],
      text: "",
    };

    const parent = stack[stack.length - 1];
    if (parent === undefined) {
      if (root !== null) throw malformed("存在多个根元素");
      if (selfClosing) {
        root = element;
      } else {
        stack.push(element);
      }
      continue;
    }
    parent.children.push(element);
    if (!selfClosing) {
      if (stack.length >= MAX_XML_DEPTH) throw malformed(`元素嵌套超过 ${MAX_XML_DEPTH} 层`);
      stack.push(element);
    }
  }

  if (stack.length > 0) {
    const open = stack[stack.length - 1];
    throw malformed(`元素 <${open?.name ?? "?"}> 没有闭合`);
  }
  if (root === null) throw malformed("没有根元素");
  return root;
}

/** 直接子元素；给出 `name` 时只保留同名子元素。 */
export function xmlChildren(element: XmlElement, name?: string): readonly XmlElement[] {
  return name === undefined ? element.children : element.children.filter((child) => child.name === name);
}

/** 深度优先找第一个同名后代（不含自身）。 */
export function xmlFirst(element: XmlElement, name: string): XmlElement | null {
  for (const child of element.children) {
    if (child.name === name) return child;
    const nested = xmlFirst(child, name);
    if (nested !== null) return nested;
  }
  return null;
}

/** 深度优先找全部同名后代（不含自身），保持文档顺序。 */
export function xmlAll(element: XmlElement, name: string): readonly XmlElement[] {
  const found: XmlElement[] = [];
  const visit = (node: XmlElement): void => {
    for (const child of node.children) {
      if (child.name === name) found.push(child);
      visit(child);
    }
  };
  visit(element);
  return found;
}

/** 第一个同名子元素的直接文本（已 trim）；不存在或空白时返回 null。 */
export function xmlText(element: XmlElement, name: string): string | null {
  const child = xmlFirst(element, name);
  if (child === null) return null;
  const text = child.text.trim();
  return text.length > 0 ? text : null;
}

/** 元素自身的直接文本（已 trim）。 */
export function xmlValue(element: XmlElement): string {
  return element.text.trim();
}

/** 元素属性；不存在时返回 null。 */
export function xmlAttr(element: XmlElement, name: string): string | null {
  const value = element.attributes[name];
  return value === undefined ? null : value;
}

/** 文本/属性值转义，避免把用户输入拼成结构。 */
export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/* ----------------------------- Autodiscover ------------------------------ */

const AUTODISCOVER_REQUEST_SCHEMA = "http://schemas.microsoft.com/exchange/autodiscover/outlook/requestschema/2006";
const AUTODISCOVER_RESPONSE_SCHEMA = "http://schemas.microsoft.com/exchange/autodiscover/outlook/responseschema/2006a";
const DEFAULT_AUTODISCOVER_TIMEOUT_MS = 15_000;
/** 跟随 Autodiscover Redirect 的上限；超过即报可读错误，避免环路。 */
const MAX_AUTODISCOVER_REDIRECTS = 2;

/** Autodiscover 的结论：本地 Exchange（EWS）还是 Exchange Online（Graph）。 */
export type AutodiscoverKind = "ews" | "graph";

export interface AutodiscoverResult {
  readonly kind: AutodiscoverKind;
  /** `kind === "graph"` 时为 null：Exchange Online 不应再走 EWS。 */
  readonly ewsUrl: string | null;
  readonly server: string | null;
  readonly serverVersion: string | null;
  /** 给用户看的可读结论。 */
  readonly detail: string;
}

export interface AutodiscoverRequest {
  readonly email: string;
  /** 密码只用于 `Authorization: Basic`；探测失败的错误文本会擦除它。 */
  readonly secret?: string | null;
  readonly signal?: AbortSignal;
}

/** 测试注入点；生产默认用全局 `fetch`。 */
export interface AutodiscoverResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface AutodiscoverInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

export type AutodiscoverFetch = (url: string, init: AutodiscoverInit) => Promise<AutodiscoverResponse>;

export interface AutodiscoverOptions {
  readonly fetch?: AutodiscoverFetch | undefined;
  /** 覆盖默认端点（测试/特殊部署用）；默认按邮箱域名推导。 */
  readonly endpoints?: readonly string[] | undefined;
  readonly timeoutMs?: number | undefined;
}

/** 标准 Autodiscover 端点顺序：先 `autodiscover.<domain>`，再裸域名。 */
export function autodiscoverEndpoints(email: string): readonly string[] {
  const at = email.lastIndexOf("@");
  if (at === -1 || at === email.length - 1) {
    throw notConfiguredError("ews", "Autodiscover 需要一个完整邮箱地址（形如 user@example.com）");
  }
  const domain = email.slice(at + 1).trim().toLowerCase();
  return [`https://autodiscover.${domain}/autodiscover/autodiscover.xml`, `https://${domain}/autodiscover/autodiscover.xml`];
}

/** 标准 Outlook Autodiscover 请求 XML（邮箱地址已转义）。 */
export function buildAutodiscoverRequestXml(email: string): string {
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<Autodiscover xmlns="${AUTODISCOVER_REQUEST_SCHEMA}">`,
    "  <Request>",
    `    <EMailAddress>${xmlEscape(email)}</EMailAddress>`,
    `    <AcceptableResponseSchema>${AUTODISCOVER_RESPONSE_SCHEMA}</AcceptableResponseSchema>`,
    "  </Request>",
    "</Autodiscover>",
  ].join("\n");
}

/** Office 365 / Exchange Online 的 EWS 主机；命中即提示改用 Graph。 */
function isOffice365Host(host: string): boolean {
  const lower = host.toLowerCase();
  return (
    lower === "outlook.office365.com" ||
    lower === "outlook.office.com" ||
    lower === "partner.outlook.cn" ||
    lower.endsWith(".office365.com") ||
    lower.endsWith(".office.com") ||
    lower.endsWith(".outlook.com") ||
    lower.endsWith(".outlook.cn")
  );
}

/**
 * Redirect 允许列表（安全）：同源，或 `autodiscover.*` / Microsoft 365 家族主机。
 *
 * 探测请求带着 Basic 凭据，绝不能跟随重定向把密码转发给任意 https 主机；
 * 不在列表内的目标一律拒绝，由调用方提示手工填写 EWS URL。
 */
function isAllowedRedirect(source: string, target: URL): boolean {
  let sourceUrl: URL;
  try {
    sourceUrl = new URL(source);
  } catch {
    return false;
  }
  if (sourceUrl.origin === target.origin) return true;
  const host = target.hostname.toLowerCase();
  return host.startsWith("autodiscover.") || isOffice365Host(host);
}

/** `parseEwsUrl` 的失败原因；调用方据此给可读文案（任何分支都不回显 URL 内容）。 */
export type EwsUrlProblem = "missing" | "invalid" | "credentials";

export type EwsUrlParse =
  | { readonly ok: true; readonly url: URL }
  | { readonly ok: false; readonly problem: EwsUrlProblem };

/**
 * 解析 EWS URL：只接受 **https 绝对地址**，并**拒绝内嵌凭据（userinfo）的 URL**。
 *
 * 语义（纵深防御）：
 * - `missing`：没填 / 空白；
 * - `invalid`：不是 URL、不是绝对地址，或不是 https（Exchange 2016+ 拒绝明文 EWS）；
 * - `credentials`：`https://user:pass@host/EWS/…` 这种写法。凭据只能走加密的 secret
 *   store，因此这里**拒绝而不是悄悄剥掉**——剥掉会让用户以为 URL 里的密码生效了。
 *   四个入口（Autodiscover XML、Redirect、手工填写、EWS 适配器自身）都走这一个判定，
 *   谁都不需要再实现一遍防错；错误文案只说「不许带凭据」，绝不回显 URL 或密码本体。
 */
export function parseEwsUrl(raw: string | null): EwsUrlParse {
  if (raw === null) return { ok: false, problem: "missing" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, problem: "missing" };
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // no-excuse-ok: catch —— 解析失败就是「不是合法 URL」，文案由调用方给。
    return { ok: false, problem: "invalid" };
  }
  if (url.protocol !== "https:") return { ok: false, problem: "invalid" };
  if (url.username !== "" || url.password !== "") return { ok: false, problem: "credentials" };
  return { ok: true, url };
}

interface ProbeOutcome {
  readonly result: AutodiscoverResult | null;
  /** 需要跟随的 Redirect；null 表示没有。 */
  readonly redirect: string | null;
}

/**
 * 解析一份 Autodiscover 响应。
 *
 * 顺序：Redirect → Error → Protocol（Type=EXCH，取 EwsUrl）。
 * O365 命中时返回 `kind: "graph"`；`EwsUrl` 缺失时抛可读错误并提示手工填写。
 */
function parseAutodiscoverResponse(text: string, secrets: readonly string[]): ProbeOutcome {
  const xml = parseXmlDocument(text, "Autodiscover 响应");

  const redirectElement = xmlFirst(xml, "Redirect");
  if (redirectElement !== null) {
    const target = xmlValue(redirectElement);
    if (target.length === 0) {
      throw new MailError("protocol", "Autodiscover 返回了空的重定向地址", false);
    }
    return { result: null, redirect: target };
  }

  const errorElement = xmlFirst(xml, "Error");
  if (errorElement !== null) {
    const code = xmlAttr(errorElement, "ErrorCode") ?? "未知";
    const message = xmlAttr(errorElement, "Message") ?? xmlValue(errorElement);
    const detail = redact(message, secrets);
    throw new MailError(
      "protocol",
      `Autodiscover 返回错误（${code}）${detail.length > 0 ? `：${detail}` : ""}；可以手工填写 EWS URL、认证方式与 SMTP 参数后继续`,
      false,
    );
  }

  const protocols = xmlAll(xml, "Protocol");
  if (protocols.length === 0) {
    throw new MailError("protocol", "Autodiscover 响应里没有 Protocol 节点；可以手工填写 EWS URL 后继续", false);
  }

  const exchange =
    protocols.find((protocol) => (xmlText(protocol, "Type") ?? xmlAttr(protocol, "Type") ?? "").toUpperCase() === "EXCH") ??
    protocols[0];
  if (exchange === undefined) {
    throw new MailError("protocol", "Autodiscover 响应里没有可用的 Exchange 协议信息；可以手工填写 EWS URL 后继续", false);
  }

  const server = xmlText(exchange, "Server");
  const serverVersion = xmlText(exchange, "ServerVersion");
  const ewsUrlText =
    xmlText(exchange, "EwsUrl") ?? xmlText(exchange, "ExternalEwsUrl") ?? xmlText(exchange, "InternalEwsUrl");
  const parsedUrl = parseEwsUrl(ewsUrlText);
  if (!parsedUrl.ok) {
    // credentials 单独给一句：这是安全拒绝，不是「格式不合法」。
    throw new MailError(
      "protocol",
      parsedUrl.problem === "missing"
        ? "Autodiscover 响应里没有 EWS URL；可以手工填写 EWS 端点后继续"
        : parsedUrl.problem === "credentials"
          ? "Autodiscover 返回的 EWS URL 不得包含用户名或密码：凭据只能走加密的 secret store；请手工填写不含凭据的 EWS 端点"
          : "Autodiscover 返回的 EWS URL 不是合法的 https 地址；请手工填写 EWS 端点",
      false,
    );
  }
  const ewsUrl = parsedUrl.url;

  if (isOffice365Host(ewsUrl.hostname)) {
    return {
      result: {
        kind: "graph",
        ewsUrl: null,
        server,
        serverVersion,
        detail: `识别到 Exchange Online（${ewsUrl.hostname}）：请改用 Microsoft Graph 设备码登录，不要走 EWS`,
      },
      redirect: null,
    };
  }

  return {
    result: {
      kind: "ews",
      ewsUrl: ewsUrl.toString(),
      server,
      serverVersion,
      detail: `已找到本地 Exchange EWS 端点：${ewsUrl.toString()}`,
    },
    redirect: null,
  };
}

function basicAuthHeader(email: string, secret: string): string {
  return `Basic ${Buffer.from(`${email}:${secret}`, "utf8").toString("base64")}`;
}

export interface TimedSignal {
  readonly signal: AbortSignal;
  readonly didTimeout: () => boolean;
  readonly dispose: () => void;
}

/** 把外部 signal 与超时合成一个；`didTimeout()` 用于区分「超时」和「调用方取消」。 */
export function withTimeout(external: AbortSignal | undefined, timeoutMs: number): TimedSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer.unref?.();
  const onAbort = (): void => controller.abort();
  if (external !== undefined) {
    if (external.aborted) controller.abort();
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

async function postXml(
  transport: AutodiscoverFetch,
  url: string,
  body: string,
  headers: Readonly<Record<string, string>>,
  timeoutMs: number,
  external: AbortSignal | undefined,
  secrets: readonly string[],
): Promise<{ readonly response: AutodiscoverResponse; readonly text: string }> {
  const timed = withTimeout(external, timeoutMs);
  try {
    const response = await transport(url, {
      method: "POST",
      headers,
      body,
      signal: timed.signal,
    });
    const text = await response.text();
    return { response, text };
  } catch (err) {
    if (external?.aborted === true) throw new MailError("network", "Autodiscover 探测已取消", false);
    if (timed.didTimeout()) {
      throw new MailError(
        "network",
        `Autodiscover 探测超时（${Math.round(timeoutMs / 1000)} 秒）：网络不通、被防火墙拦截或服务器无响应；可以手工填写 EWS URL 后继续`,
        true,
      );
    }
    if (isAbortError(err)) throw new MailError("network", "Autodiscover 探测已取消", false);
    throw toMailError(err, secrets, { operation: "Autodiscover", host: hostOf(url) });
  } finally {
    timed.dispose();
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * 按邮箱域名探测 Autodiscover，返回 EWS URL 或「改用 Graph」的结论。
 *
 * 端点顺序：`autodiscover.<domain>` → `<domain>`；遇到 Redirect 最多跟 2 跳。
 * 任何失败都抛可读 `MailError`（`auth`/`network`/`protocol`），文案提示手工填写，
 * 调用方（向导/设置页）因此可以直接展示「手动配置」入口。
 */
export async function discoverAutodiscover(
  request: AutodiscoverRequest,
  options: AutodiscoverOptions = {},
): Promise<AutodiscoverResult> {
  const email = request.email.trim();
  const endpoints = options.endpoints ?? autodiscoverEndpoints(email);
  const secret = request.secret?.trim() ?? "";
  const secrets = secret.length > 0 ? [secret] : [];
  const transport: AutodiscoverFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_AUTODISCOVER_TIMEOUT_MS;
  const body = buildAutodiscoverRequestXml(email);
  const headers: Record<string, string> = {
    "Content-Type": "text/xml; charset=utf-8",
    Accept: "text/xml",
  };
  if (secret.length > 0) headers.Authorization = basicAuthHeader(email, secret);

  const visited = new Set<string>();
  let lastError: MailError | null = null;

  for (const endpoint of endpoints) {
    let target: string | null = endpoint;
    let redirects = 0;
    while (target !== null) {
      if (visited.has(target)) {
        target = null;
        break;
      }
      visited.add(target);
      try {
        const { response, text } = await postXml(transport, target, body, headers, timeoutMs, request.signal, secrets);
        if (!response.ok) {
          const host = hostOf(target);
          if (response.status === 401 || response.status === 403) {
            throw new MailError(
              "auth",
              `Autodiscover 拒绝认证（HTTP ${response.status}${host === null ? "" : `，${host}`}）：请检查邮箱地址与密码，或手工填写 EWS URL 后继续`,
              false,
            );
          }
          if (response.status >= 500) {
            throw new MailError(
              "network",
              `Autodiscover 服务器暂时不可用（HTTP ${response.status}${host === null ? "" : `，${host}`}）：可以手工填写 EWS URL 后继续`,
              true,
            );
          }
          throw new MailError(
            "protocol",
            `Autodiscover 端点返回 HTTP ${response.status}${host === null ? "" : `（${host}）`}；可以手工填写 EWS URL 后继续`,
            false,
          );
        }
        const outcome = parseAutodiscoverResponse(text, secrets);
        if (outcome.result !== null) return outcome.result;
        if (outcome.redirect === null) {
          throw new MailError("protocol", "Autodiscover 响应无法识别（既不是结果也不是重定向）；可以手工填写 EWS URL 后继续", false);
        }
        if (redirects >= MAX_AUTODISCOVER_REDIRECTS) {
          throw new MailError("protocol", `Autodiscover 重定向超过 ${MAX_AUTODISCOVER_REDIRECTS} 跳；可以手工填写 EWS URL 后继续`, false);
        }
        const redirect = parseEwsUrl(outcome.redirect);
        if (!redirect.ok) {
          throw new MailError(
            "protocol",
            redirect.problem === "credentials"
              ? "Autodiscover 重定向地址不得包含用户名或密码：凭据只能走加密的 secret store；可以手工填写 EWS URL 后继续"
              : "Autodiscover 重定向地址不是合法的 https 地址；可以手工填写 EWS URL 后继续",
            false,
          );
        }
        const redirectUrl = redirect.url;
        if (!isAllowedRedirect(target, redirectUrl)) {
          throw new MailError(
            "protocol",
            `Autodiscover 重定向到未允许的主机（${redirectUrl.host}）：为避免把 Basic 凭据转发给任意主机，已拒绝该重定向；可以手工填写 EWS URL 后继续`,
            false,
          );
        }
        redirects += 1;
        target = redirectUrl.toString();
      } catch (err) {
        if (request.signal?.aborted === true) throw new MailError("network", "Autodiscover 探测已取消", false);
        lastError = err instanceof MailError ? err : toMailError(err, secrets, { operation: "Autodiscover" });
        target = null;
      }
    }
  }

  const fallback = lastError ?? new MailError("protocol", "Autodiscover 没有可用结果", false);
  throw new MailError(
    fallback.code,
    `${fallback.message}；自动探测失败，请手工填写 EWS URL（并选择 password/ntlm 认证）后继续`,
    fallback.retryable,
  );
}

/**
 * 从账号配置构造探测入参：`ewsUrl` 已填时直接返回，不发起探测。
 * 服务端/向导用它把「自动探测」和「手工填写」收敛到一条路径。
 */
export function autodiscoverForAccount(
  account: MailSourceAccount,
  options: AutodiscoverOptions = {},
): Promise<AutodiscoverResult> {
  const manuallyConfigured = readConfig(account, "ewsUrl");
  if (manuallyConfigured !== null) {
    const parsed = parseEwsUrl(manuallyConfigured);
    if (!parsed.ok) {
      return Promise.reject(
        notConfiguredError(
          "ews",
          parsed.problem === "credentials"
            ? "手工填写的 ewsUrl 不得包含用户名或密码：凭据只能走加密的 secret store"
            : "手工填写的 ewsUrl 不是合法的 https 地址（Exchange 2016+ 拒绝明文 EWS）",
        ),
      );
    }
    const url = parsed.url;
    const host = url.hostname;
    if (isOffice365Host(host)) {
      return Promise.resolve({
        kind: "graph",
        ewsUrl: null,
        server: null,
        serverVersion: null,
        detail: `手工填写的 EWS URL 指向 Exchange Online（${host}）：请改用 Microsoft Graph 设备码登录`,
      });
    }
    return Promise.resolve({
      kind: "ews",
      ewsUrl: url.toString(),
      server: host,
      serverVersion: null,
      detail: `使用手工填写的 EWS 端点：${url.toString()}`,
    });
  }
  return discoverAutodiscover(
    {
      email: account.email,
      secret: account.secret,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.endpoints === undefined ? {} : { endpoints: options.endpoints }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    },
    options,
  );
}
