import type { SendRequest } from "../types.js";
import type { SmtpConfig, SmtpReply, SmtpWire } from "./smtp.js";

/**
 * 发信测试共用的脚本化 SMTP 传输（不连真实服务器）。
 *
 * 用法：按客户端将要读取的顺序放入回复；`readReply()` 依次消费。
 * `transcript` 记录客户端写出的命令行，`payloads` 记录 DATA 字节，
 * 测试据此断言命令序列、认证参数与隐私投影。
 */
export class ScriptedSmtpWire implements SmtpWire {
  readonly transcript: string[] = [];
  readonly payloads: Uint8Array[] = [];
  readonly replies: Array<SmtpReply | (() => Promise<SmtpReply>)>;
  encrypted: boolean;
  startTlsCalls = 0;
  closeCalls = 0;
  readonly #index = { value: 0 };

  constructor(replies: Array<SmtpReply | (() => Promise<SmtpReply>)>, encrypted = false) {
    this.replies = replies;
    this.encrypted = encrypted;
  }

  readReply(): Promise<SmtpReply> {
    const next = this.replies[this.#index.value];
    this.#index.value += 1;
    if (next === undefined) return Promise.reject(new Error("假 wire 的脚本回复已用完"));
    return typeof next === "function" ? next() : Promise.resolve(next);
  }

  writeLine(line: string): void {
    this.transcript.push(line);
  }

  writeData(data: Uint8Array): void {
    this.payloads.push(data);
  }

  async startTls(): Promise<void> {
    this.startTlsCalls += 1;
    this.encrypted = true;
  }

  close(): void {
    this.closeCalls += 1;
  }

  text(): string {
    return this.transcript.join("\n");
  }

  payloadText(): string {
    return this.payloads.map((payload) => Buffer.from(payload).toString("utf8")).join("");
  }
}

export function smtpReply(code: number, ...lines: string[]): SmtpReply {
  return { code, lines };
}

export function smtpConfig(overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: "smtp.example.com",
    port: 587,
    secure: false,
    user: "me@example.com",
    password: "s3cret-app-password",
    timeoutMs: 2_000,
    ...overrides,
  };
}

export function smtpRequest(overrides: Partial<SendRequest> = {}): SendRequest {
  return {
    mime: new Uint8Array(Buffer.from("Subject: Hi\r\nFrom: me@example.com\r\n\r\nbody", "utf8")),
    to: ["alice@example.com"],
    cc: ["bob@example.com"],
    bcc: ["carol@example.com"],
    from: "me@example.com",
    ...overrides,
  };
}
