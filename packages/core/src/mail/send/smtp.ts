import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { redact, toMailError } from "../errors.js";
import { MailError, type SendRequest } from "../types.js";

/**
 * 最小 SMTP 提交客户端（RFC 5321/3207），不引入第三方依赖。
 *
 * 支持的路径：
 * - 隐式 TLS（`secure: true`，常见 465）；
 * - 明文连接 + STARTTLS 升级（常见 587）。服务器不宣告 STARTTLS 时默认拒绝发送，
 *   避免密码与正文明文上网；账号配置显式允许后才继续；
 * - `AUTH PLAIN` / `AUTH LOGIN`（用户名+密码，密码只出现在 base64 参数里）。
 *
 * 传输层可注入（`SmtpWire`）：单元测试用脚本化的假 wire 覆盖成功/认证失败/连接失败/
 * 超时，不连真实服务器。错误统一映射为 `MailError`，密码与完整用户名经 `errors.ts`
 * 擦除后才进文案。
 *
 * 除了发信，本文件还提供连接探测 `verifySmtp(config)`（连接 + EHLO + STARTTLS +
 * AUTH + QUIT），供账号「测试连接」端点使用；它与 `send()` 共用同一套握手实现，
 * 不维护第二份 SMTP 状态机。
 *
 * 隐私投影：SMTP 的 DATA 负载在发送前由 `stripBccHeader()` 删掉 `Bcc:` 头，
 * 盲抄地址只出现在 `RCPT TO`（信封）里。原因是 RFC 5322 §3.6.3 要求在投递时
 * 删除 Bcc，而中继/MTA 并不保证会替我们删。Graph/EWS 路径不经过这里——它们靠
 * MIME 头取收件人，必须保留 Bcc。
 */

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CLIENT_NAME = "mailcollect.local";
const MAX_SERVER_TEXT = 200;

/** 服务器的一次完整回复（多行响应折成一条）。 */
export interface SmtpReply {
  readonly code: number;
  /** 依次是每一行去掉 `NNN-`/`NNN ` 前缀后的文本。 */
  readonly lines: readonly string[];
}

/**
 * SMTP 行协议传输。真实实现见 `NodeSmtpWire`；测试注入脚本化的假实现。
 * `readReply` 只返回一条完整回复；终止符由调用方写。
 */
export interface SmtpWire {
  readonly encrypted: boolean;
  readReply(): Promise<SmtpReply>;
  writeLine(line: string): void;
  writeData(data: Uint8Array): void;
  /** STARTTLS 升级；升级后 `encrypted` 变为 true。 */
  startTls(): Promise<void>;
  close(): void;
}

export type SmtpWireFactory = (config: SmtpConfig) => Promise<SmtpWire>;

/** 发信配置：非敏字段来自账号 config，密码来自加密 secret store。 */
export interface SmtpConfig {
  readonly host: string;
  readonly port: number;
  readonly secure: boolean;
  /** null 表示不做认证（内网中继）。 */
  readonly user: string | null;
  readonly password: string;
  readonly timeoutMs?: number | undefined;
  /** 服务器不提供 STARTTLS 时是否仍允许明文发送；默认 false。 */
  readonly allowInsecure?: boolean | undefined;
  /** EHLO 里声明的客户端名；默认 `mailcollect.local`。 */
  readonly clientName?: string | undefined;
}

/** 投递成功的结果；失败一律抛 `MailError`。 */
export interface SmtpDelivery {
  readonly accepted: readonly string[];
  readonly detail: string;
}

/** 发信端口；`dispatch.ts` 只依赖这个接口，测试注入假实现。 */
export interface SmtpTransportPort {
  send(request: SendRequest): Promise<SmtpDelivery>;
}

/**
 * 连接探测结果。成功与失败都带可读结论（已脱敏），失败时不抛异常，
 * 直接交给账号「测试连接」端点展示。
 */
export interface SmtpVerifyResult {
  readonly ok: boolean;
  /** 中文结论（主机名可回显；密码与完整用户名不会出现）。 */
  readonly detail: string;
}

/**
 * SMTP 连接探测：连接 + EHLO + STARTTLS/隐式 TLS + AUTH + QUIT。
 *
 * 只探测用户名/密码（password）认证；OAuth2/设备码账号不应调用本函数。
 * 不发送任何邮件，也不把用户名或密码写进 detail。
 */
export async function verifySmtp(
  config: SmtpConfig,
  factory: SmtpWireFactory = nodeSmtpWireFactory,
): Promise<SmtpVerifyResult> {
  return new SmtpClient(config, factory).verify();
}

interface SmtpCapabilities {
  readonly extensions: ReadonlySet<string>;
  readonly auth: ReadonlySet<string>;
}

/** 默认传输工厂：真实 TCP/TLS。 */
export const nodeSmtpWireFactory: SmtpWireFactory = (config) => NodeSmtpWire.open(config);

export class SmtpClient implements SmtpTransportPort {
  readonly #config: SmtpConfig;
  readonly #factory: SmtpWireFactory;
  readonly #secrets: readonly string[];
  readonly #timeoutMs: number;
  readonly #clientName: string;

  constructor(config: SmtpConfig, factory: SmtpWireFactory = nodeSmtpWireFactory) {
    this.#config = config;
    this.#factory = factory;
    // 失败文案里既不能出现密码，也不能出现完整用户名；两者都交给 redact() 擦除。
    const user = config.user?.trim() ?? "";
    this.#secrets = [config.password, user].filter((secret) => secret.length > 0);
    this.#timeoutMs = Math.max(1, Math.min(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000));
    this.#clientName = sanitizeClientName(config.clientName ?? DEFAULT_CLIENT_NAME);
  }

  async send(request: SendRequest): Promise<SmtpDelivery> {
    let wire: SmtpWire | null = null;
    try {
      wire = await this.#factory(this.#config);
      await this.#handshake(wire);

      this.#expect(await this.#command(wire, `MAIL FROM:<${request.from}>`, "MAIL FROM"), null, "MAIL FROM");
      const recipients = uniqueAddresses([...request.to, ...request.cc, ...request.bcc]);
      if (recipients.length === 0) throw new MailError("protocol", "没有收件人：To/Cc/Bcc 至少需要一个地址", false);
      const rejected: string[] = [];
      for (const recipient of recipients) {
        const reply = await this.#command(wire, `RCPT TO:<${recipient}>`, "RCPT TO");
        if (reply.code < 200 || reply.code >= 300) rejected.push(recipient);
      }
      if (rejected.length > 0) {
        // 宁可整封不发，也不做「部分投递」：用户看到的失败必须与实际一致。
        throw new MailError("protocol", `SMTP 拒绝了收件人，邮件未发送：${rejected.join(", ")}`, false);
      }

      this.#expect(await this.#command(wire, "DATA", "DATA"), [354], "DATA");
      // DATA 是唯一会把 MIME 直接交给中继的通道：Bcc 只留在信封 RCPT 里。
      wire.writeData(dotStuff(stripBccHeader(request.mime)));
      wire.writeLine(".");
      const delivered = await this.#read(wire, "投递");
      this.#expect(delivered, null, "投递");

      await this.#quit(wire);
      return { accepted: recipients, detail: `SMTP 已投递（${recipients.length} 个收件人）` };
    } catch (err) {
      throw this.#mapFailure(err, "SMTP 发信");
    } finally {
      wire?.close();
    }
  }

  /**
   * 只做连接探测：握手（含 STARTTLS/AUTH）后 QUIT，不发送任何邮件。
   * 失败不抛异常，返回 `ok:false` + 可读原因（DNS/拒连/TLS/认证/超时）。
   */
  async verify(): Promise<SmtpVerifyResult> {
    let wire: SmtpWire | null = null;
    try {
      wire = await this.#factory(this.#config);
      await this.#handshake(wire);
      await this.#quit(wire);
      const security = this.#config.secure || wire.encrypted ? "TLS" : "未加密";
      return {
        ok: true,
        detail: `SMTP 连接与认证正常（${this.#config.host}:${this.#config.port}，${security}）`,
      };
    } catch (err) {
      return { ok: false, detail: this.#mapFailure(err, "SMTP 验证").message };
    } finally {
      wire?.close();
    }
  }

  /** 连接 + EHLO（必要时 STARTTLS）+ 认证；`send()` 与 `verify()` 共用这一份状态机。 */
  async #handshake(wire: SmtpWire): Promise<void> {
    this.#expect(await this.#read(wire, "连接"), [220], "连接问候");

    let capabilities = await this.#ehlo(wire);
    if (!this.#config.secure) {
      if (capabilities.extensions.has("STARTTLS")) {
        this.#expect(await this.#command(wire, "STARTTLS", "STARTTLS"), [220], "STARTTLS");
        await wire.startTls();
        capabilities = await this.#ehlo(wire);
      } else if (this.#config.allowInsecure !== true) {
        throw new MailError(
          "protocol",
          "SMTP 服务器未提供 STARTTLS：为避免密码与正文明文上网，已拒绝发送；如确需明文，请在账号发信设置里显式允许不安全连接",
          false,
        );
      }
    }

    if (this.#config.user !== null && this.#config.user.trim().length > 0) {
      await this.#authenticate(wire, capabilities);
    }
  }

  /** 统一错误出口：TLS 握手失败给出比 protocol 更具体的可读原因。 */
  #mapFailure(err: unknown, operation: string): MailError {
    const mapped = toMailError(err, this.#secrets, { host: this.#config.host, operation });
    const tls = tlsFailureDetail(err, this.#secrets);
    if (tls === null || mapped.code !== "protocol") return mapped;
    return new MailError("network", `${operation}：TLS 握手失败（${this.#config.host}）：${tls}`, false);
  }

  async #ehlo(wire: SmtpWire): Promise<SmtpCapabilities> {
    const reply = await this.#command(wire, `EHLO ${this.#clientName}`, "EHLO");
    if (reply.code === 250) return readCapabilities(reply);
    // 老式中继只认 HELO：退一步，不把「扩展不支持」当成发信失败。
    if (reply.code === 500 || reply.code === 502 || reply.code === 504) {
      this.#expect(await this.#command(wire, `HELO ${this.#clientName}`, "HELO"), [250], "HELO");
      return { extensions: new Set(), auth: new Set() };
    }
    throw this.#rejected(reply, "EHLO", "protocol");
  }

  async #authenticate(wire: SmtpWire, capabilities: SmtpCapabilities): Promise<void> {
    const mechanisms = capabilities.auth;
    if (mechanisms.size === 0) {
      // 服务器不宣告任何认证机制：按无需认证处理，交给 MAIL FROM 的响应判定。
      return;
    }
    if (mechanisms.has("PLAIN")) {
      const token = Buffer.from(`\0${this.#config.user ?? ""}\0${this.#config.password}`, "utf8").toString("base64");
      const reply = await this.#command(wire, `AUTH PLAIN ${token}`, "AUTH PLAIN");
      if (reply.code === 235) return;
      throw this.#authFailed(reply);
    }
    if (mechanisms.has("LOGIN")) {
      const start = await this.#command(wire, "AUTH LOGIN", "AUTH LOGIN");
      if (start.code !== 334) throw this.#authFailed(start);
      const userStep = await this.#exchange(wire, Buffer.from(this.#config.user ?? "", "utf8").toString("base64"));
      if (userStep.code !== 334) throw this.#authFailed(userStep);
      const passwordStep = await this.#exchange(wire, Buffer.from(this.#config.password, "utf8").toString("base64"));
      if (passwordStep.code !== 235) throw this.#authFailed(passwordStep);
      return;
    }
    throw new MailError("auth", `SMTP 服务器只提供当前不支持的认证方式：${[...mechanisms].join(", ")}`, false);
  }

  async #exchange(wire: SmtpWire, line: string): Promise<SmtpReply> {
    wire.writeLine(line);
    return this.#read(wire, "认证");
  }

  async #command(wire: SmtpWire, line: string, step: string): Promise<SmtpReply> {
    wire.writeLine(line);
    return this.#read(wire, step);
  }

  async #read(wire: SmtpWire, step: string): Promise<SmtpReply> {
    try {
      return await withTimeout(
        wire.readReply(),
        this.#timeoutMs,
        () => new MailError("network", `SMTP ${step}超时（${this.#timeoutMs}ms 内没有响应）`, true),
      );
    } catch (err) {
      throw toMailError(err, this.#secrets, { host: this.#config.host, operation: `SMTP ${step}` });
    }
  }

  /** `expected === null` 表示接受任意 2xx（MAIL/RCPT/DATA 的最终回执）。 */
  #expect(reply: SmtpReply, expected: readonly number[] | null, step: string): void {
    const ok = expected === null ? reply.code >= 200 && reply.code < 300 : expected.includes(reply.code);
    if (!ok) throw this.#rejected(reply, step, "protocol");
  }

  #rejected(reply: SmtpReply, step: string, code: "protocol" | "auth"): MailError {
    return new MailError(code, `SMTP ${step} 被服务器拒绝（${this.#replyDetail(reply)}）`, false);
  }

  #authFailed(reply: SmtpReply): MailError {
    return new MailError(
      "auth",
      `SMTP 认证失败：服务器拒绝了用户名或密码（${this.#replyDetail(reply)}）`,
      false,
    );
  }

  #replyDetail(reply: SmtpReply): string {
    const text = redact(reply.lines.join(" ").trim(), this.#secrets);
    if (text.length === 0) return String(reply.code);
    return `${reply.code}：${text.length > MAX_SERVER_TEXT ? `${text.slice(0, MAX_SERVER_TEXT)}…` : text}`;
  }

  async #quit(wire: SmtpWire): Promise<void> {
    try {
      wire.writeLine("QUIT");
      await withTimeout(wire.readReply(), this.#timeoutMs, () => new MailError("network", "SMTP QUIT 超时", false));
    } catch {
      // QUIT 失败不影响投递结果：邮件已经被服务器接收。
    }
  }
}

/** 识别 TLS/证书类失败，返回擦除过 secret 的可读细节；不是 TLS 问题返回 null。 */
function tlsFailureDetail(err: unknown, secrets: readonly string[]): string | null {
  const code =
    typeof err === "object" && err !== null && "code" in err ? String(Reflect.get(err, "code") ?? "") : "";
  const message = err instanceof Error ? err.message : "";
  if (!/certificate|self[- ]signed|\btls\b|\bssl\b|handshake|altname/i.test(`${code} ${message}`)) return null;
  const text = redact((message.length > 0 ? message : code).trim(), secrets);
  return text.length > 0 ? (text.length > MAX_SERVER_TEXT ? `${text.slice(0, MAX_SERVER_TEXT)}…` : text) : "证书校验未通过";
}

function readCapabilities(reply: SmtpReply): SmtpCapabilities {
  const extensions = new Set<string>();
  const auth = new Set<string>();
  // 第一行是服务器域名，不参与扩展识别。
  for (const line of reply.lines.slice(1)) {
    const tokens = line.trim().split(/\s+/).filter((token) => token.length > 0);
    const keyword = tokens[0]?.toUpperCase() ?? "";
    if (keyword.length === 0) continue;
    extensions.add(keyword);
    if (keyword === "AUTH") {
      for (const mechanism of tokens.slice(1)) auth.add(mechanism.toUpperCase());
    }
  }
  return { extensions, auth };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, error: () => MailError): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(error()), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function uniqueAddresses(addresses: readonly string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const address of addresses) {
    const trimmed = address.trim();
    if (trimmed.length === 0) continue;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(trimmed);
  }
  return unique;
}

/**
 * 删掉 MIME 头块里的 `Bcc:`（含其折叠续行），其余字节原样保留。
 *
 * 只在 SMTP DATA 前调用：Graph/EWS 用 MIME 头决定收件人，不能删。
 * 不修改入参（返回新字节数组；没有 Bcc 时原样返回同一个引用）。
 */
export function stripBccHeader(mime: Uint8Array): Uint8Array {
  const text = Buffer.from(mime).toString("latin1");
  const crlfSeparator = text.indexOf("\r\n\r\n");
  const lfSeparator = crlfSeparator >= 0 ? -1 : text.indexOf("\n\n");
  const headerEnd = crlfSeparator >= 0 ? crlfSeparator : lfSeparator;
  if (headerEnd < 0) return mime;
  const lineBreak = crlfSeparator >= 0 ? "\r\n" : "\n";
  const lines = text.slice(0, headerEnd).split(lineBreak);
  const kept: string[] = [];
  let dropping = false;
  for (const line of lines) {
    if (dropping && /^[ \t]/.test(line)) continue; // Bcc 的折叠续行
    dropping = false;
    if (/^bcc[ \t]*:/i.test(line)) {
      dropping = true;
      continue;
    }
    kept.push(line);
  }
  if (kept.length === lines.length) return mime;
  return new Uint8Array(Buffer.from(`${kept.join(lineBreak)}${text.slice(headerEnd)}`, "latin1"));
}

/** SMTP DATA 的透明度处理：行首 `.` 加倍，并统一 CRLF 行尾。 */
function dotStuff(mime: Uint8Array): Uint8Array {
  const text = Buffer.from(mime).toString("binary").replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
  const normalized = text.endsWith("\r\n") ? text : `${text}\r\n`;
  return new Uint8Array(Buffer.from(normalized, "binary"));
}

function sanitizeClientName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9.-]/g, "");
  return cleaned.length > 0 ? cleaned : DEFAULT_CLIENT_NAME;
}

/* ------------------------------ 真实传输实现 ------------------------------ */

/**
 * 基于 `node:net` / `node:tls` 的行协议传输。
 *
 * 读取按 CRLF 切行；一条回复以「`NNN `（空格）」终止，多行用 `NNN-` 续行。
 * socket 错误/关闭/空闲超时都转为拒绝当前挂起的 `readReply`，并让后续读取立即失败。
 */
export class NodeSmtpWire implements SmtpWire {
  readonly #config: SmtpConfig;
  readonly #timeoutMs: number;
  #socket: Socket;
  #encrypted: boolean;
  #buffer: Buffer = Buffer.alloc(0);
  #pending: { resolve: (reply: SmtpReply) => void; reject: (error: unknown) => void } | null = null;
  #failure: unknown = null;
  #closed = false;

  private constructor(config: SmtpConfig, socket: Socket, encrypted: boolean) {
    this.#config = config;
    this.#timeoutMs = Math.max(1, Math.min(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000));
    this.#socket = socket;
    this.#encrypted = encrypted;
    this.#attach(socket);
  }

  static async open(config: SmtpConfig): Promise<NodeSmtpWire> {
    const socket = config.secure ? await connectTls(config) : await connectTcp(config);
    return new NodeSmtpWire(config, socket, config.secure);
  }

  get encrypted(): boolean {
    return this.#encrypted;
  }

  readReply(): Promise<SmtpReply> {
    if (this.#failure !== null) return Promise.reject(this.#failure);
    if (this.#closed) return Promise.reject(new MailError("network", "SMTP 连接已关闭", true));
    return new Promise<SmtpReply>((resolve, reject) => {
      this.#pending = { resolve, reject };
      this.#drain();
    });
  }

  writeLine(line: string): void {
    this.#socket.write(`${line}\r\n`);
  }

  writeData(data: Uint8Array): void {
    this.#socket.write(Buffer.from(data));
  }

  async startTls(): Promise<void> {
    const raw = this.#socket;
    raw.removeListener("data", this.#onData);
    raw.removeListener("error", this.#onError);
    raw.removeListener("close", this.#onClose);
    raw.removeListener("timeout", this.#onTimeout);
    raw.setTimeout(0);
    const secured = await upgradeToTls(raw, this.#config);
    // RFC 3207：升级后服务器不得再发明文；残留缓冲一律丢弃。
    this.#buffer = Buffer.alloc(0);
    this.#socket = secured;
    this.#encrypted = true;
    this.#attach(secured);
  }

  close(): void {
    this.#closed = true;
    this.#socket.destroy();
  }

  #attach(socket: Socket): void {
    socket.setTimeout(this.#timeoutMs);
    socket.on("data", this.#onData);
    socket.on("error", this.#onError);
    socket.on("close", this.#onClose);
    socket.on("timeout", this.#onTimeout);
  }

  readonly #onData = (chunk: Buffer): void => {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    this.#drain();
  };

  readonly #onError = (err: Error): void => {
    this.#fail(err);
  };

  readonly #onClose = (): void => {
    this.#closed = true;
    this.#fail(new MailError("network", "SMTP 连接被服务器关闭", true));
  };

  readonly #onTimeout = (): void => {
    this.#fail(new MailError("network", `SMTP 连接空闲超时（${this.#timeoutMs}ms）`, true));
    this.#socket.destroy();
  };

  #fail(error: unknown): void {
    this.#failure = error;
    const pending = this.#pending;
    this.#pending = null;
    pending?.reject(error);
  }

  #drain(): void {
    if (this.#pending === null) return;
    let parsed: SmtpReply | null;
    try {
      parsed = this.#parseReply();
    } catch (err) {
      this.#fail(err);
      return;
    }
    if (parsed === null) return;
    const pending = this.#pending;
    this.#pending = null;
    pending.resolve(parsed);
  }

  #parseReply(): SmtpReply | null {
    const lines: string[] = [];
    let offset = 0;
    let code = -1;
    for (;;) {
      const end = this.#buffer.indexOf("\r\n", offset);
      if (end < 0) return null;
      const line = this.#buffer.subarray(offset, end).toString("utf8");
      const next = end + 2;
      const match = /^(\d{3})([ -])(.*)$/.exec(line);
      if (match === null) {
        // 容错：跳过无法识别的前导行（部分中继会先吐欢迎语）。
        offset = next;
        continue;
      }
      const lineCode = Number(match[1]);
      if (code === -1) code = lineCode;
      if (lineCode !== code) {
        this.#buffer = this.#buffer.subarray(next);
        throw new MailError("protocol", "SMTP 回复码不一致，无法判断服务器状态", false);
      }
      lines.push(match[3] ?? "");
      if (match[2] === " ") {
        this.#buffer = this.#buffer.subarray(next);
        return { code, lines };
      }
      offset = next;
    }
  }
}

function connectionTimeoutError(config: SmtpConfig, timeoutMs: number): MailError {
  return new MailError("network", `连接 SMTP 服务器 ${config.host}:${config.port} 超时（${timeoutMs}ms）`, true);
}

function effectiveTimeout(config: SmtpConfig): number {
  return Math.max(1, Math.min(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 120_000));
}

function connectTcp(config: SmtpConfig): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const timeoutMs = effectiveTimeout(config);
    const socket = netConnect({ host: config.host, port: config.port });
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => {
      socket.destroy();
      reject(connectionTimeoutError(config, timeoutMs));
    });
    socket.once("error", (err) => reject(err));
    socket.once("connect", () => {
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

function connectTls(config: SmtpConfig): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const timeoutMs = effectiveTimeout(config);
    const socket = tlsConnect({ host: config.host, port: config.port, servername: config.host });
    socket.setTimeout(timeoutMs);
    socket.once("timeout", () => {
      socket.destroy();
      reject(connectionTimeoutError(config, timeoutMs));
    });
    socket.once("error", (err) => reject(err));
    socket.once("secureConnect", () => {
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

function upgradeToTls(socket: Socket, config: SmtpConfig): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const timeoutMs = effectiveTimeout(config);
    const secured = tlsConnect({ socket, servername: config.host });
    secured.setTimeout(timeoutMs);
    secured.once("timeout", () => {
      secured.destroy();
      reject(connectionTimeoutError(config, timeoutMs));
    });
    secured.once("error", (err) => reject(err));
    secured.once("secureConnect", () => {
      secured.setTimeout(0);
      resolve(secured);
    });
  });
}
