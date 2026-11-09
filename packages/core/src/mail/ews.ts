import { createHmac, randomBytes } from "node:crypto";
import type { FolderRole, MailProvider, RawEmail } from "@mailcollect/shared";
import type { MailSourceAccount } from "./account.js";
import { makeCursor, readConfig, readConfigInt } from "./account.js";
import {
  parseEwsUrl,
  parseXmlDocument,
  type EwsUrlProblem,
  withTimeout,
  xmlAttr,
  xmlChildren,
  xmlEscape,
  xmlFirst,
  xmlText,
  xmlValue,
  type XmlElement,
} from "./autodiscover.js";
import { abortedError, isAbortError, notConfiguredError, redact, toMailError, unsupportedError } from "./errors.js";
import { buildRawEmail, htmlToText, parseMimeEmail } from "./message.js";
import type {
  AttachmentData,
  AttachmentInfo,
  DeleteOptions,
  FetchOptions,
  FetchResult,
  FolderInfo,
  MailSearchHit,
  MailSearchQuery,
  MailSource,
  MessageBody,
  MessageFlagsPatch,
  MessageRef,
  SendRequest,
  SendResult,
} from "./types.js";
import { MailError } from "./types.js";

/**
 * 本地 Exchange（EWS）收件适配器。
 *
 * 传输：SOAP 1.1 over HTTPS（全局 `fetch`），只发送 XML；不引入第三方 SOAP/XML 依赖。
 * 认证：`password` → HTTP Basic；`ntlm` → NTLMv2 三次握手（纯 JS MD4 + HMAC-MD5，
 * 避免把未在 CI 验证的二进制依赖带进来）。凭据只来自 `account.secret`。
 * 错误：HTTP 状态、SOAP ResponseCode、NTLM 挑战解析失败全部映射为类型化 `MailError`，
 * 文案经过 `redact()`，不会把密码回显到错误/日志。
 * 范围：Exchange 2016+；Exchange Online 一律走 Graph（Autodiscover 命中 O365 时提示改用 Graph）。
 */

/* ------------------------------- 配置与传输 ------------------------------- */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_FETCH_LIMIT = 500;
/** GetItem 一次最多带的 ItemId 数量；Exchange 默认限制 100，取 20 留余量。 */
const GET_ITEM_BATCH = 20;
/** 增量游标回退窗口：时间戳相同的多封邮件靠重复拉取 + 上层按 uid 去重兜住。 */
const CURSOR_OVERLAP_MS = 5 * 60 * 1000;

const SOAP_ACTION_PREFIX = "http://schemas.microsoft.com/exchange/services/2006/messages/";

const SOAP_ENVELOPE_HEAD = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages">',
  '  <soap:Header><t:RequestServerVersion Version="Exchange2016"/></soap:Header>',
  "  <soap:Body>",
].join("\n");
const SOAP_ENVELOPE_TAIL = "</soap:Body></soap:Envelope>";

/** 读单封邮件需要的完整属性集（含附件元数据）。 */
const ITEM_SHAPE_ALL = "<m:ItemShape><t:BaseShape>AllProperties</t:BaseShape></m:ItemShape>";
/** 同步用的属性集：默认字段 + MIME（正文/头都由调用方统一解析）。 */
const ITEM_SHAPE_SYNC = [
  "<m:ItemShape>",
  "<t:BaseShape>Default</t:BaseShape>",
  "<t:IncludeMimeContent>true</t:IncludeMimeContent>",
  "<t:AdditionalProperties>",
  '<t:FieldURI FieldURI="item:DateTimeSent"/>',
  '<t:FieldURI FieldURI="item:InternetMessageId"/>',
  "</t:AdditionalProperties>",
  "</m:ItemShape>",
].join("");

/** 文件夹角色映射：EWS 用 WellKnownFolderName（DistinguishedFolderId）。 */
const WELL_KNOWN_FOLDERS: readonly { readonly id: string; readonly role: FolderRole }[] = [
  { id: "inbox", role: "inbox" },
  { id: "sentitems", role: "sent" },
  { id: "drafts", role: "drafts" },
  { id: "deleteditems", role: "trash" },
  { id: "archive", role: "archive" },
  { id: "junkemail", role: "junk" },
];

export type EwsAuthMode = "password" | "ntlm";

export interface EwsResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export interface EwsRequestInit {
  readonly method: "POST";
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly signal?: AbortSignal;
}

/** 传输层注入点；生产默认用全局 `fetch`（HTTPS + HTTP/1.1）。 */
export type EwsFetch = (url: string, init: EwsRequestInit) => Promise<EwsResponse>;

const defaultEwsFetch: EwsFetch = (url, init) => fetch(url, init);

export interface EwsSourceOptions {
  readonly fetch?: EwsFetch | undefined;
  /** 覆盖账号配置 `ewsTimeoutMs`（测试用）。 */
  readonly timeoutMs?: number | undefined;
  /** NTLM 测试注入点：固定随机客户端挑战/时间戳。 */
  readonly ntlm?: NtlmClientOptions | undefined;
}

interface EwsConfig {
  readonly url: string;
  readonly host: string;
  readonly authMode: EwsAuthMode;
  readonly user: string;
  readonly domain: string;
  readonly timeoutMs: number;
  readonly pageSize: number;
}

/** `parseEwsUrl` 的失败原因 → 类型化 not_configured（文案不回显 URL/用户名/密码）。 */
function ewsUrlProblemError(problem: EwsUrlProblem): MailError {
  switch (problem) {
    case "missing":
      return notConfiguredError(
        "ews",
        "缺少 ewsUrl：先跑 Autodiscover，或手工填写 EWS 端点（形如 https://exchange.example.com/EWS/Exchange.asmx）",
      );
    case "invalid":
      return notConfiguredError(
        "ews",
        "ewsUrl 不是合法的 https 地址（需要 https:// 开头的完整地址；Exchange 2016+ 拒绝明文 EWS）",
      );
    case "credentials":
      return notConfiguredError("ews", "ewsUrl 不得包含用户名或密码：凭据只能走加密的 secret store");
  }
}

function readEwsConfig(account: MailSourceAccount, options: EwsSourceOptions): EwsConfig {
  // 与 Autodiscover（XML/Redirect/手工填写）共用同一个判定：https + 无 userinfo。
  const parsedUrl = parseEwsUrl(readConfig(account, "ewsUrl"));
  if (!parsedUrl.ok) throw ewsUrlProblemError(parsedUrl.problem);
  const url = parsedUrl.url;

  const authRaw = (readConfig(account, "authMode") ?? "password").toLowerCase();
  let authMode: EwsAuthMode;
  switch (authRaw) {
    case "password":
      authMode = "password";
      break;
    case "ntlm":
      authMode = "ntlm";
      break;
    default:
      throw notConfiguredError(
        "ews",
        `EWS 只支持 password/ntlm 认证（收到 authMode=${authRaw}）；Kerberos/OAuth 不在本版承诺内`,
      );
  }

  return {
    url: url.toString(),
    host: url.host,
    authMode,
    user: readConfig(account, "ewsUser") ?? account.email,
    domain: readConfig(account, "ewsDomain") ?? "",
    timeoutMs:
      options.timeoutMs ?? readConfigInt(account, "ewsTimeoutMs", 1_000, 120_000) ?? DEFAULT_TIMEOUT_MS,
    pageSize: readConfigInt(account, "ewsPageSize", 1, 200) ?? DEFAULT_PAGE_SIZE,
  };
}

/* ------------------------------ XML/SOAP 工具 ----------------------------- */

function envelope(body: string): string {
  return `${SOAP_ENVELOPE_HEAD}${body}${SOAP_ENVELOPE_TAIL}`;
}

function itemIdsXml(ids: readonly string[]): string {
  return `<m:ItemIds>${ids.map((id) => `<t:ItemId Id="${xmlEscape(id)}"/>`).join("")}</m:ItemIds>`;
}

/** 从 XML 文本里抓 `ResponseCode`（错误响应也走这里，不依赖完整解析）。 */
function extractResponseCode(text: string): string | null {
  const match = /<(?:[A-Za-z0-9_-]+:)?ResponseCode>([^<]+)</.exec(text);
  return match?.[1]?.trim() ?? null;
}

function extractMessageText(text: string): string | null {
  const match = /<(?:[A-Za-z0-9_-]+:)?MessageText>([^<]*)</.exec(text);
  return match?.[1]?.trim() ?? null;
}

/** HTTP 500 的 SOAP Fault 也带可读原因；优先按协议错误报出，而不是笼统的 5xx。 */
function extractFaultString(text: string): string | null {
  const match = /<(?:[A-Za-z0-9_-]+:)?faultstring>([^<]*)</.exec(text);
  return match?.[1]?.trim() ?? null;
}

const EWS_AUTH_CODES: ReadonlySet<string> = new Set([
  "ErrorAccessDenied",
  "ErrorInvalidCredentials",
  "ErrorAuthenticationFailure",
  "ErrorAccountDisabled",
  "ErrorImpersonationFailed",
  "ErrorInvalidUser",
  "ErrorWrongServerVersion",
]);

const EWS_UNSUPPORTED_CODES: ReadonlySet<string> = new Set([
  "ErrorInvalidOperation",
  "ErrorUnsupportedPathForOperation",
  "ErrorNotSupported",
  "ErrorInvalidRequest",
]);

const EWS_RATE_CODES: ReadonlySet<string> = new Set(["ErrorServerBusy", "ErrorMailboxStoreUnavailable"]);
const EWS_TRANSIENT_CODES: ReadonlySet<string> = new Set([
  "ErrorTimeoutExpired",
  "ErrorConnectionFailed",
  "ErrorADUnavailable",
  "ErrorMailboxMoveInProgress",
]);

/** SOAP ResponseCode → 类型化 `MailError`；文案擦除 secret。 */
function ewsCodeError(code: string, detail: string, secrets: readonly string[]): MailError {
  const text = redact(detail, secrets);
  const suffix = text.length > 0 ? `：${text}` : "";
  if (EWS_RATE_CODES.has(code)) {
    return new MailError("rate_limited", `EWS 服务器限流（${code}）${suffix}，请稍后重试`, true);
  }
  if (EWS_AUTH_CODES.has(code)) {
    return new MailError("auth", `EWS 认证失败（${code}）${suffix}`, false);
  }
  if (EWS_UNSUPPORTED_CODES.has(code)) {
    return new MailError("unsupported", `EWS 不支持该操作（${code}）${suffix}`, false);
  }
  if (EWS_TRANSIENT_CODES.has(code)) {
    return new MailError("network", `EWS 服务器暂时不可用（${code}）${suffix}`, true);
  }
  if (code === "ErrorItemNotFound" || code === "ErrorFolderNotFound") {
    return new MailError("protocol", `EWS 找不到目标（${code}）${suffix}：可能已被移动或删除，需要重新同步`, false);
  }
  return new MailError("protocol", `EWS 返回错误（${code}）${suffix}`, false);
}

function responseMessages(root: XmlElement, responseName: string): readonly XmlElement[] {
  const response = xmlFirst(root, responseName);
  if (response === null) return [];
  const container = xmlFirst(response, "ResponseMessages");
  return container === null ? [] : container.children;
}

function assertNoFault(root: XmlElement, secrets: readonly string[]): void {
  const fault = xmlFirst(root, "Fault");
  if (fault === null) return;
  const responseCodeElement = xmlFirst(fault, "ResponseCode");
  const responseCode = responseCodeElement === null ? null : xmlValue(responseCodeElement);
  const faultString = xmlText(fault, "faultstring") ?? "";
  if (responseCode !== null && responseCode.length > 0) {
    throw ewsCodeError(responseCode, faultString, secrets);
  }
  const faultCode = xmlText(fault, "faultcode") ?? "SOAP Fault";
  throw new MailError("protocol", `EWS 返回 SOAP 错误（${faultCode}）：${redact(faultString, secrets)}`, false);
}

function singleResponse(
  root: XmlElement,
  responseName: string,
  operation: string,
  secrets: readonly string[],
): XmlElement {
  const messages = responseMessages(root, responseName);
  if (messages.length === 0) {
    throw new MailError("protocol", `EWS ${operation} 响应缺少 ResponseMessages`, false);
  }
  for (const message of messages) {
    const code = xmlText(message, "ResponseCode");
    if (code !== null && code !== "NoError") {
      throw ewsCodeError(code, xmlText(message, "MessageText") ?? "", secrets);
    }
  }
  const first = messages[0];
  if (first === undefined) {
    throw new MailError("protocol", `EWS ${operation} 响应为空`, false);
  }
  return first;
}

function itemsOf(message: XmlElement): readonly XmlElement[] {
  const container = xmlFirst(message, "Items");
  return container === null ? [] : container.children;
}

function itemIdOf(element: XmlElement): string | null {
  const itemId = xmlFirst(element, "ItemId");
  return itemId === null ? null : xmlAttr(itemId, "Id");
}

function parseEwsDate(raw: string | null): Date | null {
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseInteger(raw: string | null): number {
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mailboxAddresses(element: XmlElement, containerName: string): readonly string[] {
  const container = xmlFirst(element, containerName);
  if (container === null) return [];
  const addresses: string[] = [];
  for (const mailbox of xmlChildren(container, "Mailbox")) {
    const address = xmlText(mailbox, "EmailAddress");
    if (address !== null) addresses.push(address);
  }
  return addresses;
}

/* ------------------------------- NTLMv2 ------------------------------- */

const NTLM_SIGNATURE = [0x4e, 0x54, 0x4c, 0x4d, 0x53, 0x53, 0x50, 0x00] as const;
/** UNICODE|OEM|REQUEST_TARGET|NTLM|ALWAYS_SIGN|EXTENDED_SESSIONSECURITY|TARGET_INFO。 */
const NTLM_FLAGS = 0x0088_8207;
const NTLM_TIMESTAMP_EPOCH_OFFSET = 11_644_473_600_000_000n;

export interface NtlmClientOptions {
  /** 测试注入：固定 FILETIME 时间戳来源（毫秒）。 */
  readonly nowMs?: number | undefined;
  /** 测试注入：固定 8 字节客户端挑战。 */
  readonly clientChallenge?: (() => Uint8Array) | undefined;
  readonly domain?: string | undefined;
  readonly workstation?: string | undefined;
}

function rotl(value: number, bits: number): number {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0;
}

/**
 * MD4（RFC 1320）纯 JS 实现。
 *
 * Node 24 的 OpenSSL 3 默认禁用 MD4（`createHash("md4")` 抛 unsupported），
 * 而 NTLMv2 的 NT hash 必须是 MD4；这里自带 80 行实现，避免引入原生依赖。
 */
export function md4(input: Uint8Array): Uint8Array {
  const length = input.length;
  const paddedLength = Math.ceil((length + 9) / 64) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(input);
  buffer[length] = 0x80;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  view.setUint32(paddedLength - 8, (length * 8) >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(length / 0x2000_0000), true);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const words = new Uint32Array(16);
  const round2Order = [0, 4, 8, 12, 1, 5, 9, 13, 2, 6, 10, 14, 3, 7, 11, 15] as const;
  const round3Order = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15] as const;
  const shifts1 = [3, 7, 11, 19] as const;
  const shifts2 = [3, 5, 9, 13] as const;
  const shifts3 = [3, 9, 11, 15] as const;

  const f = (x: number, y: number, z: number): number => ((x & y) | (~x & z)) >>> 0;
  const g = (x: number, y: number, z: number): number => ((x & y) | (x & z) | (y & z)) >>> 0;
  const h = (x: number, y: number, z: number): number => (x ^ y ^ z) >>> 0;

  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, true);
    }
    const beforeA = a;
    const beforeB = b;
    const beforeC = c;
    const beforeD = d;

    for (let index = 0; index < 16; index += 1) {
      const word = words[index] ?? 0;
      const shift = shifts1[index % 4] ?? 3;
      const operation = index % 4;
      if (operation === 0) a = rotl((a + f(b, c, d) + word) >>> 0, shift);
      else if (operation === 1) d = rotl((d + f(a, b, c) + word) >>> 0, shift);
      else if (operation === 2) c = rotl((c + f(d, a, b) + word) >>> 0, shift);
      else b = rotl((b + f(c, d, a) + word) >>> 0, shift);
    }
    for (let index = 0; index < 16; index += 1) {
      const word = words[round2Order[index] ?? 0] ?? 0;
      const shift = shifts2[index % 4] ?? 3;
      const operation = index % 4;
      if (operation === 0) a = rotl((a + g(b, c, d) + word + 0x5a827999) >>> 0, shift);
      else if (operation === 1) d = rotl((d + g(a, b, c) + word + 0x5a827999) >>> 0, shift);
      else if (operation === 2) c = rotl((c + g(d, a, b) + word + 0x5a827999) >>> 0, shift);
      else b = rotl((b + g(c, d, a) + word + 0x5a827999) >>> 0, shift);
    }
    for (let index = 0; index < 16; index += 1) {
      const word = words[round3Order[index] ?? 0] ?? 0;
      const shift = shifts3[index % 4] ?? 3;
      const operation = index % 4;
      if (operation === 0) a = rotl((a + h(b, c, d) + word + 0x6ed9eba1) >>> 0, shift);
      else if (operation === 1) d = rotl((d + h(a, b, c) + word + 0x6ed9eba1) >>> 0, shift);
      else if (operation === 2) c = rotl((c + h(d, a, b) + word + 0x6ed9eba1) >>> 0, shift);
      else b = rotl((b + h(c, d, a) + word + 0x6ed9eba1) >>> 0, shift);
    }

    a = (a + beforeA) >>> 0;
    b = (b + beforeB) >>> 0;
    c = (c + beforeC) >>> 0;
    d = (d + beforeD) >>> 0;
  }

  const digest = new Uint8Array(16);
  const digestView = new DataView(digest.buffer);
  digestView.setUint32(0, a, true);
  digestView.setUint32(4, b, true);
  digestView.setUint32(8, c, true);
  digestView.setUint32(12, d, true);
  return digest;
}

function utf16le(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    bytes[index * 2] = code & 0xff;
    bytes[index * 2 + 1] = code >>> 8;
  }
  return bytes;
}

function hmacMd5(key: Uint8Array, data: Uint8Array): Uint8Array {
  return new Uint8Array(createHmac("md5", key).update(data).digest());
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    merged.set(part, offset);
    offset += part.length;
  }
  return merged;
}

function writeSecurityBuffer(view: DataView, offset: number, length: number, payloadOffset: number): void {
  view.setUint16(offset, length, true);
  view.setUint16(offset + 2, length, true);
  view.setUint32(offset + 4, payloadOffset, true);
}

function buildNegotiateMessage(domain: string, workstation: string): Uint8Array {
  const domainBytes = utf16le(domain.toUpperCase());
  const workstationBytes = utf16le(workstation.toUpperCase());
  const headerLength = 32;
  const message = new Uint8Array(headerLength + domainBytes.length + workstationBytes.length);
  const view = new DataView(message.buffer);
  for (let index = 0; index < NTLM_SIGNATURE.length; index += 1) {
    message[index] = NTLM_SIGNATURE[index] ?? 0;
  }
  view.setUint32(8, 1, true);
  view.setUint32(12, NTLM_FLAGS, true);
  writeSecurityBuffer(view, 16, domainBytes.length, headerLength);
  writeSecurityBuffer(view, 24, workstationBytes.length, headerLength + domainBytes.length);
  message.set(domainBytes, headerLength);
  message.set(workstationBytes, headerLength + domainBytes.length);
  return message;
}

interface NtlmType2 {
  readonly flags: number;
  readonly serverChallenge: Uint8Array;
  readonly targetInfo: Uint8Array;
}

function parseNtlmType2(token: string): NtlmType2 {
  const bytes = new Uint8Array(Buffer.from(token, "base64"));
  if (bytes.length < 32) {
    throw new MailError("protocol", "NTLM 挑战过短，无法识别（服务器可能只支持 NTLMv1）", false);
  }
  for (let index = 0; index < NTLM_SIGNATURE.length; index += 1) {
    if (bytes[index] !== NTLM_SIGNATURE[index]) {
      throw new MailError("protocol", "NTLM 挑战签名不正确", false);
    }
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, true) !== 2) {
    throw new MailError("protocol", "NTLM 挑战类型不是 CHALLENGE(2)", false);
  }
  let targetInfo = new Uint8Array(0);
  if (bytes.length >= 48) {
    const length = view.getUint16(40, true);
    const offset = view.getUint32(44, true);
    if (length > 0 && offset + length <= bytes.length) {
      targetInfo = bytes.slice(offset, offset + length);
    }
  }
  return {
    flags: view.getUint32(20, true),
    serverChallenge: bytes.slice(24, 32),
    targetInfo,
  };
}

interface AuthenticateParams {
  readonly user: string;
  readonly password: string;
  readonly domain: string;
  readonly workstation: string;
  readonly type2: NtlmType2;
  readonly options: NtlmClientOptions;
}

function buildAuthenticateMessage(params: AuthenticateParams): Uint8Array {
  const { user, domain, workstation, type2, options } = params;
  const clientChallenge = (options.clientChallenge?.() ?? new Uint8Array(randomBytes(8))).slice(0, 8);
  if (clientChallenge.length !== 8) {
    throw new MailError("protocol", "NTLM 客户端挑战必须是 8 字节", false);
  }
  const ntlmHash = md4(utf16le(params.password));
  const ntlmV2Hash = hmacMd5(ntlmHash, utf16le(`${user.toUpperCase()}${domain}`));

  const nowMs = options.nowMs ?? Date.now();
  const timestamp = new Uint8Array(8);
  new DataView(timestamp.buffer).setBigUint64(0, BigInt(nowMs) * 10_000n + NTLM_TIMESTAMP_EPOCH_OFFSET, true);
  const targetInfo = type2.targetInfo.length > 0 ? type2.targetInfo : new Uint8Array(4);
  const blob = concatBytes([
    new Uint8Array([0x01, 0x01, 0x00, 0x00]),
    new Uint8Array(4),
    timestamp,
    clientChallenge,
    new Uint8Array(4),
    targetInfo,
  ]);
  const proof = hmacMd5(ntlmV2Hash, concatBytes([type2.serverChallenge, blob]));
  const ntResponse = concatBytes([proof, blob]);
  const lmResponse = concatBytes([
    hmacMd5(ntlmV2Hash, concatBytes([type2.serverChallenge, clientChallenge])),
    clientChallenge,
  ]);

  const domainBytes = utf16le(domain);
  const userBytes = utf16le(user);
  const workstationBytes = utf16le(workstation);
  const sessionKey = new Uint8Array(0);
  const payloads = [domainBytes, userBytes, workstationBytes, sessionKey, lmResponse, ntResponse];
  const headerLength = 64;
  const offsets: number[] = [];
  let cursor = headerLength;
  for (const payload of payloads) {
    offsets.push(cursor);
    cursor += payload.length;
  }

  const message = new Uint8Array(cursor);
  const view = new DataView(message.buffer);
  for (let index = 0; index < NTLM_SIGNATURE.length; index += 1) {
    message[index] = NTLM_SIGNATURE[index] ?? 0;
  }
  view.setUint32(8, 3, true);
  writeSecurityBuffer(view, 12, lmResponse.length, offsets[4] ?? 0);
  writeSecurityBuffer(view, 20, ntResponse.length, offsets[5] ?? 0);
  writeSecurityBuffer(view, 28, domainBytes.length, offsets[0] ?? 0);
  writeSecurityBuffer(view, 36, userBytes.length, offsets[1] ?? 0);
  writeSecurityBuffer(view, 44, workstationBytes.length, offsets[2] ?? 0);
  writeSecurityBuffer(view, 52, sessionKey.length, offsets[3] ?? 0);
  view.setUint32(60, NTLM_FLAGS, true);
  for (let index = 0; index < payloads.length; index += 1) {
    const payload = payloads[index];
    if (payload !== undefined) message.set(payload, offsets[index] ?? 0);
  }
  return message;
}

/**
 * NTLMv2 客户端：`negotiate()` 产 Type1，`authenticate(challenge)` 产 Type3。
 *
 * 无状态（挑战由服务器每次给出），因此适配器只要在收到 401 后按三轮握手即可。
 */
export class NtlmClient {
  readonly #user: string;
  readonly #password: string;
  readonly #options: NtlmClientOptions;

  constructor(user: string, password: string, options: NtlmClientOptions = {}) {
    this.#user = user;
    this.#password = password;
    this.#options = options;
  }

  negotiate(): string {
    const domain = this.#options.domain ?? "";
    const workstation = this.#options.workstation ?? "";
    return Buffer.from(buildNegotiateMessage(domain, workstation)).toString("base64");
  }

  authenticate(challengeBase64: string): string {
    const type2 = parseNtlmType2(challengeBase64);
    const message = buildAuthenticateMessage({
      user: this.#user,
      password: this.#password,
      domain: this.#options.domain ?? "",
      workstation: this.#options.workstation ?? "",
      type2,
      options: this.#options,
    });
    return Buffer.from(message).toString("base64");
  }
}

/** 解析 `WWW-Authenticate`：返回是否提供 NTLM 以及（可选的）挑战 token。 */
export function parseNtlmChallenge(header: string | null): { readonly offered: boolean; readonly token: string | null } {
  if (header === null) return { offered: false, token: null };
  const match = /(?:^|[\s,])NTLM(?:\s+([A-Za-z0-9+/=]+))?/i.exec(header);
  if (match === null) return { offered: false, token: null };
  return { offered: true, token: match[1] ?? null };
}

/* -------------------------------- 适配器 -------------------------------- */

export class EwsMailSource implements MailSource {
  readonly provider: MailProvider = "ews";
  readonly #account: MailSourceAccount;
  readonly #config: EwsConfig;
  readonly #secrets: readonly string[];
  readonly #fetch: EwsFetch;
  readonly #ntlmOptions: NtlmClientOptions;
  #ntlm: NtlmClient | null = null;

  constructor(account: MailSourceAccount, options: EwsSourceOptions = {}) {
    this.#account = account;
    this.#config = readEwsConfig(account, options);
    this.#secrets = [account.secret];
    this.#fetch = options.fetch ?? defaultEwsFetch;
    this.#ntlmOptions = { domain: this.#config.domain, ...(options.ntlm ?? {}) };
  }

  /** 探测一次 Inbox：认证/传输/协议错误都收敛成 `ok:false` 的可读说明。 */
  async verify(): Promise<{ ok: boolean; detail: string }> {
    try {
      const response = await this.#soap(
        "GetFolder",
        "<m:GetFolder><m:FolderShape><t:BaseShape>IdOnly</t:BaseShape></m:FolderShape>" +
          '<m:FolderIds><t:DistinguishedFolderId Id="inbox"/></m:FolderIds></m:GetFolder>',
      );
      singleResponse(response, "GetFolderResponse", "GetFolder", this.#secrets);
      const version = xmlFirst(response, "ServerVersionInfo");
      const versionText =
        version === null
          ? null
          : (xmlAttr(version, "Version") ?? [xmlAttr(version, "MajorVersion"), xmlAttr(version, "MinorVersion")].filter((part): part is string => part !== null).join("."));
      return {
        ok: true,
        detail: `EWS 已连接：${this.#account.email} @ ${this.#config.host}${versionText === null || versionText.length === 0 ? "" : `（Exchange ${versionText}）`}`,
      };
    } catch (err) {
      const mapped = this.#mapError(err);
      return { ok: false, detail: `${mapped.code}: ${mapped.message}` };
    }
  }

  /**
   * 增量拉取 Inbox。
   *
   * 游标是「已取到的最大 DateTimeReceived」ISO 时间；下一次按该时间回退
   * `CURSOR_OVERLAP_MS` 再查（时间戳相同的邮件不会漏），重复部分由上层按 uid 去重。
   */
  async fetch(options: FetchOptions = {}): Promise<FetchResult> {
    const signal = options.signal;
    const since = this.#parseCursor(options.since?.value);
    const limit = Math.max(1, Math.min(options.limit ?? this.#config.pageSize, MAX_FETCH_LIMIT));
    const found: { readonly id: string; readonly receivedAt: Date | null }[] = [];

    let offset = 0;
    let includesLast = true;
    for (;;) {
      const want = Math.min(this.#config.pageSize, limit - found.length);
      if (want <= 0) break;
      const page = await this.#findInbox(since, offset, want, signal);
      found.push(...page.items);
      offset += page.items.length;
      includesLast = page.includesLast;
      if (page.items.length === 0 || includesLast) break;
    }

    const capped = found.slice(0, limit);
    const hasMore = !includesLast && capped.length >= limit;

    const emails: RawEmail[] = [];
    const receivedAtByUid = new Map<string, Date>();
    const fetchedIds = new Set<string>();
    for (let start = 0; start < capped.length; start += GET_ITEM_BATCH) {
      const chunk = capped.slice(start, start + GET_ITEM_BATCH).map((item) => item.id);
      const items = await this.#getItems(chunk, true, signal);
      for (const item of items) {
        const fetched = await this.#toRawEmail(item);
        if (fetched === null) continue;
        emails.push(fetched.email);
        if (fetched.receivedAt !== null) receivedAtByUid.set(fetched.email.uid, fetched.receivedAt);
        const itemId = itemIdOf(item);
        if (itemId !== null) fetchedIds.add(itemId);
      }
      options.onProgress?.(emails.length);
    }

    // 游标只推进到「按时间升序连续成功」的最后一条：批中任何一封 GetItem 失败都停住，
    // 下一轮从失败处重查（重复由上层按 uid 去重），避免没取到的邮件被永久跳过。
    // 例外：失败项的时间戳不晚于旧游标，说明它上一轮已成功落库，只是重叠窗口的重复拉取，
    // 不能让一封已删除的邮件把游标永久卡住。
    let cursorDate = since;
    for (const item of capped) {
      const succeeded = fetchedIds.has(item.id);
      const alreadySynced =
        since !== null && item.receivedAt !== null && item.receivedAt.getTime() <= since.getTime();
      if (!succeeded && !alreadySynced) break;
      if (succeeded && item.receivedAt !== null && (cursorDate === null || item.receivedAt.getTime() > cursorDate.getTime())) {
        cursorDate = item.receivedAt;
      }
    }

    return {
      emails,
      cursor: cursorDate === null ? null : makeCursor(this.#account.id, cursorDate.toISOString()),
      hasMore,
      ...(receivedAtByUid.size > 0 ? { receivedAtByUid } : {}),
    };
  }

  async close(): Promise<void> {
    // 无持久连接（每次请求一条 HTTPS），不需要断开。
  }

  /* ---------------------------- v1.1 能力端口 ---------------------------- */

  /** 文件夹列表：只用 WellKnownFolderName，角色映射与语言无关。 */
  async listFolders(): Promise<readonly FolderInfo[]> {
    const folderIds = WELL_KNOWN_FOLDERS.map((folder) => `<t:DistinguishedFolderId Id="${folder.id}"/>`).join("");
    const response = await this.#soap(
      "GetFolder",
      `<m:GetFolder><m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape><m:FolderIds>${folderIds}</m:FolderIds></m:GetFolder>`,
    );
    const messages = responseMessages(response, "GetFolderResponse");
    const folders: FolderInfo[] = [];
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      const wellKnown = WELL_KNOWN_FOLDERS[index];
      if (message === undefined || wellKnown === undefined) continue;
      const code = xmlText(message, "ResponseCode");
      // 本地 Exchange 没有在线归档/垃圾邮件文件夹时该 well-known 会报 ErrorFolderNotFound，
      // 这不是整体失败：跳过这一项，其余文件夹照常返回。
      if (code !== null && code !== "NoError") continue;
      const container = xmlFirst(message, "Folders");
      const folder = container === null ? undefined : xmlChildren(container, "Folder")[0];
      if (folder === undefined) continue;
      const folderId = xmlFirst(folder, "FolderId");
      const id = folderId === null ? null : xmlAttr(folderId, "Id");
      if (id === null) continue;
      folders.push({
        id,
        name: xmlText(folder, "DisplayName") ?? wellKnown.role,
        role: wellKnown.role,
        unreadCount: parseInteger(xmlText(folder, "UnreadCount")),
      });
    }
    return folders;
  }

  /** 读单封邮件：正文（text/html）与附件元数据。 */
  async getMessage(ref: MessageRef): Promise<MessageBody> {
    const id = this.#requireId(ref.id, "EWS 读邮件");
    const response = await this.#soap(
      "GetItem",
      `<m:GetItem>${ITEM_SHAPE_ALL}${itemIdsXml([id])}</m:GetItem>`,
    );
    const message = singleResponse(response, "GetItemResponse", "GetItem", this.#secrets);
    const item = itemsOf(message)[0];
    if (item === undefined) {
      throw new MailError("protocol", `EWS 找不到这封邮件：${id}（可能已被移动或删除，需要重新同步）`, false);
    }
    return this.#toMessageBody(item, id, ref.folderId ?? null);
  }

  /** 附件原始字节；EWS 的 AttachmentId 自带定位，不需要再带邮件 id。 */
  async getAttachment(ref: MessageRef, attachmentId: string): Promise<AttachmentData> {
    this.#requireId(ref.id, "EWS 取附件");
    const id = attachmentId.trim();
    if (id.length === 0) {
      throw new MailError("protocol", "EWS 取附件需要非空的 AttachmentId", false);
    }
    const response = await this.#soap(
      "GetAttachment",
      `<m:GetAttachment><m:AttachmentIds><t:AttachmentId Id="${xmlEscape(id)}"/></m:AttachmentIds></m:GetAttachment>`,
    );
    const message = singleResponse(response, "GetAttachmentResponse", "GetAttachment", this.#secrets);
    const container = xmlFirst(message, "Attachments");
    const attachment = container === null ? null : xmlFirst(container, "FileAttachment");
    if (attachment === null) {
      throw unsupportedError("EWS 下载附件", "只支持 FileAttachment；内嵌的 ItemAttachment 需要先在 Outlook 里打开");
    }
    const contentElement = xmlFirst(attachment, "Content");
    const base64 = contentElement === null ? "" : contentElement.text.replace(/\s+/g, "");
    if (base64.length === 0) {
      throw new MailError("protocol", "EWS 返回的附件内容为空", false);
    }
    return {
      info: {
        id,
        filename: xmlText(attachment, "Name") ?? "attachment",
        mimeType: xmlText(attachment, "ContentType") ?? "application/octet-stream",
        size: parseInteger(xmlText(attachment, "Size")),
        inline: (xmlText(attachment, "IsInline") ?? "").toLowerCase() === "true",
      },
      content: new Uint8Array(Buffer.from(base64, "base64")),
    };
  }

  /** 已读/旗标：只提交给出的字段（MarkAsRead = message:IsRead）。 */
  async setFlags(ref: MessageRef, patch: MessageFlagsPatch): Promise<void> {
    const id = this.#requireId(ref.id, "EWS 设置旗标");
    const updates: string[] = [];
    if (patch.read !== undefined) {
      updates.push(
        `<t:SetItemField><t:FieldURI FieldURI="message:IsRead"/><t:Message><t:IsRead>${patch.read ? "true" : "false"}</t:IsRead></t:Message></t:SetItemField>`,
      );
    }
    if (patch.flagged !== undefined) {
      updates.push(
        `<t:SetItemField><t:FieldURI FieldURI="message:FlagStatus"/><t:Message><t:FlagStatus>${patch.flagged ? "Flagged" : "NotFlagged"}</t:FlagStatus></t:Message></t:SetItemField>`,
      );
    }
    if (updates.length === 0) return;
    const response = await this.#soap(
      "UpdateItem",
      `<m:UpdateItem ConflictResolution="AlwaysOverwrite" MessageDisposition="SaveOnly"><m:ItemChanges><t:ItemChange><t:ItemId Id="${xmlEscape(id)}"/><t:Updates>${updates.join("")}</t:Updates></t:ItemChange></m:ItemChanges></m:UpdateItem>`,
    );
    singleResponse(response, "UpdateItemResponse", "UpdateItem", this.#secrets);
  }

  /** 移动到目标文件夹；返回服务器给的新 ItemId。 */
  async move(ref: MessageRef, targetFolderId: string): Promise<MessageRef> {
    const id = this.#requireId(ref.id, "EWS 移动邮件");
    const target = targetFolderId.trim();
    if (target.length === 0) {
      throw new MailError("protocol", "EWS 移动邮件需要目标文件夹 id", false);
    }
    const response = await this.#soap(
      "MoveItem",
      `<m:MoveItem><m:ToFolderId><t:FolderId Id="${xmlEscape(target)}"/></m:ToFolderId>${itemIdsXml([id])}</m:MoveItem>`,
    );
    const message = singleResponse(response, "MoveItemResponse", "MoveItem", this.#secrets);
    const moved = itemsOf(message)[0];
    const movedId = moved === undefined ? null : itemIdOf(moved);
    return { id: movedId ?? id, folderId: target };
  }

  /** 删除：默认进回收站（SoftDelete），`permanent` 才是 HardDelete。 */
  async delete(ref: MessageRef, options: DeleteOptions = {}): Promise<void> {
    const id = this.#requireId(ref.id, "EWS 删除邮件");
    const deleteType = options.permanent === true ? "HardDelete" : "SoftDelete";
    const response = await this.#soap(
      "DeleteItem",
      `<m:DeleteItem DeleteType="${deleteType}" SendMeetingCancellations="SendToNone" AffectedTaskOccurrences="AllOccurrences">${itemIdsXml([id])}</m:DeleteItem>`,
    );
    singleResponse(response, "DeleteItemResponse", "DeleteItem", this.#secrets);
  }

  /**
   * 服务器端搜索（FindItem + Restriction）。
   *
   * EWS 的 FindItem 不能跨文件夹深搜：给了 `folderId` 搜该文件夹，否则搜 Inbox。
   */
  async search(query: MailSearchQuery): Promise<readonly MailSearchHit[]> {
    const restrictions: string[] = [];
    const contains = (field: string, value: string): string =>
      `<t:Contains ContainmentMode="Substring" ContainmentComparison="IgnoreCase"><t:FieldURI FieldURI="${field}"/><t:Constant Value="${xmlEscape(value)}"/></t:Contains>`;
    if (query.subject !== undefined && query.subject.trim().length > 0) {
      restrictions.push(contains("item:Subject", query.subject.trim()));
    }
    if (query.from !== undefined && query.from.trim().length > 0) {
      restrictions.push(contains("message:From", query.from.trim()));
    }
    if (query.body !== undefined && query.body.trim().length > 0) {
      restrictions.push(contains("item:Body", query.body.trim()));
    }
    const dateConstant = (raw: string | undefined, label: string): string | null => {
      if (raw === undefined || raw.trim().length === 0) return null;
      const parsed = new Date(raw);
      if (Number.isNaN(parsed.getTime())) {
        throw new MailError("protocol", `EWS 搜索条件 ${label} 不是合法日期：${raw}`, false);
      }
      return parsed.toISOString();
    };
    const since = dateConstant(query.since, "since");
    if (since !== null) {
      restrictions.push(
        `<t:IsGreaterThanOrEqualTo><t:FieldURI FieldURI="item:DateTimeReceived"/><t:FieldURIOrConstant><t:Constant Value="${xmlEscape(since)}"/></t:FieldURIOrConstant></t:IsGreaterThanOrEqualTo>`,
      );
    }
    const before = dateConstant(query.before, "before");
    if (before !== null) {
      restrictions.push(
        `<t:IsLessThan><t:FieldURI FieldURI="item:DateTimeReceived"/><t:FieldURIOrConstant><t:Constant Value="${xmlEscape(before)}"/></t:FieldURIOrConstant></t:IsLessThan>`,
      );
    }
    if (query.unreadOnly === true) {
      restrictions.push(
        '<t:IsEqualTo><t:FieldURI FieldURI="message:IsRead"/><t:FieldURIOrConstant><t:Constant Value="false"/></t:FieldURIOrConstant></t:IsEqualTo>',
      );
    }
    const restriction =
      restrictions.length === 0
        ? ""
        : `<m:Restriction>${restrictions.length === 1 ? restrictions.join("") : `<t:And>${restrictions.join("")}</t:And>`}</m:Restriction>`;
    const parentFolder =
      query.folderId === undefined || query.folderId.trim().length === 0
        ? '<t:DistinguishedFolderId Id="inbox"/>'
        : `<t:FolderId Id="${xmlEscape(query.folderId.trim())}"/>`;
    const limit = Math.max(1, Math.min(query.limit ?? this.#config.pageSize, MAX_FETCH_LIMIT));

    const response = await this.#soap(
      "FindItem",
      `<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape>` +
        `<m:IndexedPageItemView MaxEntriesReturned="${limit}" Offset="0" BasePoint="Beginning"/>` +
        `<m:SortOrder><t:FieldOrder Order="Descending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder></m:SortOrder>` +
        `${restriction}<m:ParentFolderIds>${parentFolder}</m:ParentFolderIds></m:FindItem>`,
    );
    const message = singleResponse(response, "FindItemResponse", "FindItem", this.#secrets);
    const rootFolder = xmlFirst(message, "RootFolder");
    const container = rootFolder === null ? null : xmlFirst(rootFolder, "Items");
    const hits: MailSearchHit[] = [];
    if (container !== null) {
      for (const element of container.children) {
        const id = itemIdOf(element);
        if (id !== null) {
          const folderId = query.folderId === undefined || query.folderId.trim().length === 0 ? null : query.folderId;
          hits.push({ id, folderId });
        }
      }
    }
    return hits;
  }

  /**
   * 发送 + 在服务器「已发送」保存副本（CreateItem + MessageDisposition=SendAndSaveCopy）。
   * 失败不抛：返回 `ok:false` + 类型化 error，调用方负责本地镜像与提示。
   */
  async sendViaEws(request: SendRequest): Promise<SendResult> {
    try {
      if (request.mime.length === 0) {
        throw new MailError("protocol", "EWS 发信需要完整 MIME 内容", false);
      }
      const savedFolder =
        request.sentFolderId === undefined || request.sentFolderId === null
          ? '<m:SavedItemFolderId><t:DistinguishedFolderId Id="sentitems"/></m:SavedItemFolderId>'
          : `<m:SavedItemFolderId><t:FolderId Id="${xmlEscape(request.sentFolderId)}"/></m:SavedItemFolderId>`;
      const mimeBase64 = Buffer.from(request.mime).toString("base64");
      const response = await this.#soap(
        "CreateItem",
        `<m:CreateItem MessageDisposition="SendAndSaveCopy">${savedFolder}` +
          `<m:Items><t:Message><t:MimeContent CharacterSet="UTF-8">${mimeBase64}</t:MimeContent></t:Message></m:Items></m:CreateItem>`,
      );
      const message = singleResponse(response, "CreateItemResponse", "CreateItem", this.#secrets);
      const item = itemsOf(message)[0];
      const messageId = item === undefined ? null : itemIdOf(item);
      return {
        ok: true,
        transport: "ews",
        messageId,
        savedToSent: "server",
        detail: "已通过 EWS 发送，并在服务器「已发送」保存副本",
      };
    } catch (err) {
      const error = err instanceof MailError ? err : this.#mapError(err);
      return { ok: false, transport: "ews", savedToSent: "none", detail: error.message, error };
    }
  }

  /* ------------------------------- 内部实现 ------------------------------- */

  #parseCursor(value: string | undefined): Date | null {
    if (value === undefined || value.trim().length === 0) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  #requireId(raw: string, operation: string): string {
    const id = raw.trim();
    if (id.length === 0) {
      throw new MailError("protocol", `${operation}需要非空的 EWS ItemId`, false);
    }
    return id;
  }

  async #findInbox(
    since: Date | null,
    offset: number,
    max: number,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly items: readonly { readonly id: string; readonly receivedAt: Date | null }[]; readonly includesLast: boolean }> {
    const overlapSince = since === null ? null : new Date(since.getTime() - CURSOR_OVERLAP_MS);
    const restriction =
      overlapSince === null
        ? ""
        : `<m:Restriction><t:IsGreaterThanOrEqualTo><t:FieldURI FieldURI="item:DateTimeReceived"/><t:FieldURIOrConstant><t:Constant Value="${xmlEscape(overlapSince.toISOString())}"/></t:FieldURIOrConstant></t:IsGreaterThanOrEqualTo></m:Restriction>`;
    const response = await this.#soap(
      "FindItem",
      `<m:FindItem Traversal="Shallow"><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties><t:FieldURI FieldURI="item:DateTimeReceived"/></t:AdditionalProperties></m:ItemShape>` +
        `<m:IndexedPageItemView MaxEntriesReturned="${max}" Offset="${offset}" BasePoint="Beginning"/>` +
        `<m:SortOrder><t:FieldOrder Order="Ascending"><t:FieldURI FieldURI="item:DateTimeReceived"/></t:FieldOrder></m:SortOrder>` +
        `${restriction}<m:ParentFolderIds><t:DistinguishedFolderId Id="inbox"/></m:ParentFolderIds></m:FindItem>`,
      signal,
    );
    const message = singleResponse(response, "FindItemResponse", "FindItem", this.#secrets);
    const rootFolder = xmlFirst(message, "RootFolder");
    if (rootFolder === null) {
      throw new MailError("protocol", "EWS FindItem 响应缺少 RootFolder", false);
    }
    const container = xmlFirst(rootFolder, "Items");
    const items: { id: string; receivedAt: Date | null }[] = [];
    if (container !== null) {
      for (const element of container.children) {
        const id = itemIdOf(element);
        if (id === null) continue;
        items.push({ id, receivedAt: parseEwsDate(xmlText(element, "DateTimeReceived")) });
      }
    }
    return {
      items,
      includesLast: (xmlAttr(rootFolder, "IncludesLastItemInRange") ?? "true").toLowerCase() === "true",
    };
  }

  async #getItems(ids: readonly string[], tolerateErrors: boolean, signal: AbortSignal | undefined): Promise<readonly XmlElement[]> {
    if (ids.length === 0) return [];
    const response = await this.#soap("GetItem", `<m:GetItem>${ITEM_SHAPE_SYNC}${itemIdsXml(ids)}</m:GetItem>`, signal);
    const messages = responseMessages(response, "GetItemResponse");
    const items: XmlElement[] = [];
    let firstError: MailError | null = null;
    for (const message of messages) {
      const code = xmlText(message, "ResponseCode");
      if (code !== null && code !== "NoError") {
        if (firstError === null) {
          firstError = ewsCodeError(code, xmlText(message, "MessageText") ?? "", this.#secrets);
        }
        continue;
      }
      items.push(...itemsOf(message));
    }
    // 同步路径容忍单封失败（FindItem 之后被删/被移走的邮件），但整批失败必须报出来。
    if (firstError !== null && (items.length === 0 || !tolerateErrors)) throw firstError;
    return items;
  }

  /**
   * GetItem 的 `<t:Message>` → `RawEmail` + 服务器接收时间。
   *
   * `DateTimeReceived` 是服务器记录的接收时间（`DateTimeSent` 是发件人声明的时间，
   * 两者都可能缺失）。这里如实返回：拿不到就 null，绝不拿 DateTimeSent 冒充。
   */
  async #toRawEmail(item: XmlElement): Promise<{ email: RawEmail; receivedAt: Date | null } | null> {
    const idElement = xmlFirst(item, "ItemId");
    const uid = idElement === null ? null : xmlAttr(idElement, "Id");
    if (uid === null) return null;
    const receivedAt = parseEwsDate(xmlText(item, "DateTimeReceived"));

    const mimeElement = xmlFirst(item, "MimeContent");
    if (mimeElement !== null) {
      const base64 = mimeElement.text.replace(/\s+/g, "");
      if (base64.length > 0) {
        try {
          const email = await parseMimeEmail(this.#account.id, uid, Buffer.from(base64, "base64"), receivedAt);
          return { email, receivedAt };
        } catch (err) {
          if (!(err instanceof Error)) throw err;
          // MIME 解析失败时退回字段拼装：宁可少几个头，也不要整封丢掉。
        }
      }
    }

    const bodyElement = xmlFirst(item, "Body");
    const bodyType = bodyElement === null ? "" : (xmlAttr(bodyElement, "BodyType") ?? "").toUpperCase();
    const html = bodyElement !== null && bodyType === "HTML" ? bodyElement.text.trim() : null;
    const fromContainer = xmlFirst(item, "From");
    const fromMailbox = fromContainer === null ? null : xmlFirst(fromContainer, "Mailbox");
    const sentAt = parseEwsDate(xmlText(item, "DateTimeSent")) ?? receivedAt ?? new Date();
    const email = buildRawEmail(this.#account.id, {
      uid,
      messageId: xmlText(item, "InternetMessageId") ?? `<${this.#account.id}.${uid}@mailcollect.local>`,
      threadId: null,
      fromName: fromMailbox === null ? null : xmlText(fromMailbox, "Name"),
      fromEmail: fromMailbox === null ? "" : (xmlText(fromMailbox, "EmailAddress") ?? ""),
      to: mailboxAddresses(item, "ToRecipients"),
      cc: mailboxAddresses(item, "CcRecipients"),
      subject: xmlText(item, "Subject") ?? "",
      sentAt: sentAt.toISOString(),
      bodyText: html !== null ? htmlToText(html) : (bodyElement?.text.trim() ?? ""),
      hasAttachments: (xmlText(item, "HasAttachments") ?? "").toLowerCase() === "true",
      headers: {},
    });
    return { email, receivedAt };
  }

  #toMessageBody(item: XmlElement, fallbackId: string, folderId: string | null): MessageBody {
    const id = itemIdOf(item) ?? fallbackId;
    const bodyElement = xmlFirst(item, "Body");
    const bodyType = bodyElement === null ? "" : (xmlAttr(bodyElement, "BodyType") ?? "").toUpperCase();
    const html = bodyElement !== null && bodyType === "HTML" ? bodyElement.text.trim() : null;
    const text =
      bodyElement === null
        ? ""
        : bodyType === "TEXT"
          ? bodyElement.text.trim()
          : html !== null
            ? htmlToText(html)
            : bodyElement.text.trim();
    const fromContainer = xmlFirst(item, "From");
    const fromMailbox = fromContainer === null ? null : xmlFirst(fromContainer, "Mailbox");
    const receivedAt = parseEwsDate(xmlText(item, "DateTimeReceived"));
    const sentAt = parseEwsDate(xmlText(item, "DateTimeSent")) ?? receivedAt ?? new Date();

    const attachments: AttachmentInfo[] = [];
    const attachmentContainer = xmlFirst(item, "Attachments");
    if (attachmentContainer !== null) {
      for (const attachment of xmlChildren(attachmentContainer, "FileAttachment")) {
        const attachmentId = xmlFirst(attachment, "AttachmentId");
        const value = attachmentId === null ? null : xmlAttr(attachmentId, "Id");
        if (value === null) continue;
        attachments.push({
          id: value,
          filename: xmlText(attachment, "Name") ?? "attachment",
          mimeType: xmlText(attachment, "ContentType") ?? "application/octet-stream",
          size: parseInteger(xmlText(attachment, "Size")),
          inline: (xmlText(attachment, "IsInline") ?? "").toLowerCase() === "true",
        });
      }
    }

    return {
      id,
      folderId,
      subject: xmlText(item, "Subject") ?? "",
      fromName: fromMailbox === null ? null : xmlText(fromMailbox, "Name"),
      fromEmail: fromMailbox === null ? "" : (xmlText(fromMailbox, "EmailAddress") ?? ""),
      to: mailboxAddresses(item, "ToRecipients"),
      cc: mailboxAddresses(item, "CcRecipients"),
      sentAt: sentAt.toISOString(),
      ...(receivedAt === null ? {} : { receivedAt }),
      isRead: (xmlText(item, "IsRead") ?? "").toLowerCase() === "true",
      text,
      html,
      attachments,
    };
  }

  async #soap(operation: string, body: string, signal?: AbortSignal): Promise<XmlElement> {
    const headers: Record<string, string> = {
      "Content-Type": "text/xml; charset=utf-8",
      Accept: "text/xml",
      SOAPAction: `"${SOAP_ACTION_PREFIX}${operation}"`,
    };
    const payload = envelope(body);
    // 超时必须覆盖整个交换（含响应体）：服务端可能发完响应头后挂住正文，
    // 若在 fetch resolve 时就清定时器，慢响应会无限等待。
    const timed = withTimeout(signal, this.#config.timeoutMs);
    try {
      const response =
        this.#config.authMode === "ntlm"
          ? await this.#ntlmRequest(headers, payload, timed.signal)
          : await this.#http({ ...headers, Authorization: this.#basicHeader() }, payload, timed.signal);
      const text = await response.text();
      if (!response.ok) throw this.#httpError(response, text);

      const xml = parseXmlDocument(text, `EWS ${operation} 响应`);
      assertNoFault(xml, this.#secrets);
      return xml;
    } catch (err) {
      throw this.#mapRequestError(err, signal, timed.didTimeout());
    } finally {
      timed.dispose();
    }
  }

  #basicHeader(): string {
    return `Basic ${Buffer.from(`${this.#config.user}:${this.#account.secret}`, "utf8").toString("base64")}`;
  }

  /** NTLMv2 三轮握手：无认证 → Type1 → Type3；中间 401 正文必须读掉以复用连接。 */
  async #ntlmRequest(
    headers: Readonly<Record<string, string>>,
    body: string,
    signal: AbortSignal,
  ): Promise<EwsResponse> {
    const client = this.#ntlmClient();
    let response = await this.#http({ ...headers }, body, signal);
    if (response.status !== 401) return response;
    const first = parseNtlmChallenge(response.headers.get("www-authenticate"));
    if (!first.offered) return response;
    await response.text();

    let challenge = first.token;
    if (challenge === null) {
      const type1 = client.negotiate();
      response = await this.#http({ ...headers, Authorization: `NTLM ${type1}` }, body, signal);
      if (response.status !== 401) return response;
      await response.text();
      challenge = parseNtlmChallenge(response.headers.get("www-authenticate")).token;
      if (challenge === null) return response;
    }

    return this.#http({ ...headers, Authorization: `NTLM ${client.authenticate(challenge)}` }, body, signal);
  }

  #ntlmClient(): NtlmClient {
    if (this.#ntlm === null) {
      this.#ntlm = new NtlmClient(this.#config.user, this.#account.secret, this.#ntlmOptions);
    }
    return this.#ntlm;
  }

  /** 单次 HTTP 交换；超时/取消由此处上游的 `#soap` 统一分类（定时器覆盖响应体）。 */
  async #http(headers: Readonly<Record<string, string>>, body: string, signal: AbortSignal): Promise<EwsResponse> {
    return this.#fetch(this.#config.url, { method: "POST", headers, body, signal });
  }

  #mapRequestError(err: unknown, external: AbortSignal | undefined, didTimeout: boolean): MailError {
    // 调用方取消优先于超时，避免把用户取消报成超时。
    if (external?.aborted === true) return abortedError();
    if (didTimeout) {
      return new MailError(
        "network",
        `EWS 请求超时（${Math.round(this.#config.timeoutMs / 1000)} 秒，含响应体）：${this.#config.host} 无响应`,
        true,
      );
    }
    if (err instanceof MailError) return err;
    if (isAbortError(err)) return abortedError();
    return toMailError(err, this.#secrets, { operation: "EWS 请求", host: this.#config.host });
  }

  #httpError(response: EwsResponse, text: string): MailError {
    const code = extractResponseCode(text);
    if (code !== null) {
      return ewsCodeError(code, extractMessageText(text) ?? "", this.#secrets);
    }
    const faultString = extractFaultString(text);
    if (faultString !== null && faultString.length > 0) {
      return new MailError("protocol", `EWS 返回 SOAP 错误：${redact(faultString, this.#secrets)}`, false);
    }
    const detail = `EWS 请求失败：HTTP ${response.status}${response.statusText.length > 0 ? ` ${response.statusText}` : ""}（${this.#config.host}）`;
    if (response.status === 401 || response.status === 403) {
      return new MailError("auth", `${detail}；请检查用户名/密码与认证方式（password/ntlm）`, false);
    }
    if (response.status === 429) return new MailError("rate_limited", `${detail}，请稍后重试`, true);
    if (response.status === 404) {
      return new MailError("protocol", `${detail}；请检查 ewsUrl 是否指向 .../EWS/Exchange.asmx`, false);
    }
    if (response.status >= 500) return new MailError("network", detail, true);
    return new MailError("protocol", detail, false);
  }

  #mapError(err: unknown): MailError {
    if (err instanceof MailError) return err;
    if (isAbortError(err)) return abortedError();
    return toMailError(err, this.#secrets, { operation: "EWS", host: this.#config.host });
  }
}
