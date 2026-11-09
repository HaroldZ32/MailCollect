import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openStore } from "@mailcollect/core";
import type { OutgoingMessage } from "@mailcollect/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * T62 集成级验证：**真实启动 `apps/server/src/main.ts`**（真 sqlite、真 HTTP、
 * 真 outbox worker），而不是用路由测试代替。
 *
 * 锁住两个曾缺失的注入：
 * 1. `services.mailSource` —— 不注入时 `POST /api/send` 恒 502「未注入邮件适配器」；
 * 2. `services.outbox` + 启动 kick —— 不注入时启动前入队的行永远不会被投递。
 *
 * 假适配器：账号的 SMTP 指向 `127.0.0.1:1`（必然拒绝连接），所以
 * - 直发路径按「可重试的网络错误」入队并返回 200 queued（不再 502）；
 * - worker 认领队列行后标记 failed + 可读 lastError（证明 kick 生效）。
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const TSX_CLI = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
const MAIN_TS = join(ROOT, "apps", "server", "src", "main.ts");
const TOKEN = "t62-integration-token";
const CLOSED_PORT = 1;
const ACCOUNT_EMAIL = "me@corp.example.com";
const SMTP_PASSWORD = "smtp-secret-t62";
const INBOUND_SECRET = "inbound-secret-t62";

const dataDir = mkdtempSync(join(tmpdir(), "mailcollect-t62-"));
let child: ChildProcess | null = null;
let base = "";
let accountId = "";
let preQueuedId = "";

function message(subject: string): OutgoingMessage {
  return {
    mode: "new",
    to: ["peer@example.com"],
    cc: [],
    bcc: [],
    subject,
    bodyText: "T62 集成验证正文。",
    bodyHtml: null,
    attachments: [],
    includeSignature: false,
    replyToEmailId: null,
  };
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${base}${path}`, { ...init, headers });
}

async function waitFor<T>(probe: () => Promise<T | null>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`等待超时（${timeoutMs}ms）`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  // 启动前预置：一个账号 + 一条 queued 发件箱行（重启恢复的典型状态）。
  const seeded = await openStore(join(dataDir, "mailcollect.sqlite"), "device-t62");
  const account = seeded.createAccount({
    provider: "imap",
    label: "T62",
    email: ACCOUNT_EMAIL,
    config: { host: "127.0.0.1", port: "1", tls: "false", user: ACCOUNT_EMAIL },
    secret: INBOUND_SECRET,
    send: {
      smtpHost: "127.0.0.1",
      smtpPort: CLOSED_PORT,
      smtpSecure: false,
      smtpUser: ACCOUNT_EMAIL,
      smtpPassword: SMTP_PASSWORD,
    },
  });
  accountId = account.id;
  const preQueued = seeded.enqueueOutbox(account.id, message("T62 启动恢复验证"));
  preQueuedId = preQueued.id;
  expect(preQueued.status).toBe("queued");
  expect(preQueued.attempts).toBe(0);
  seeded.close();

  child = spawn(process.execPath, [TSX_CLI, MAIN_TS], {
    cwd: ROOT,
    env: {
      ...process.env,
      MAILCOLLECT_PORT: "0",
      MAILCOLLECT_TOKEN: TOKEN,
      MAILCOLLECT_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ready = await new Promise<{ port: number; token: string }>((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error(`服务启动超时\n${stderr}`)), 30_000);
    child?.stdout?.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const line = buffer
        .split("\n")
        .find((entry) => entry.startsWith("MAILCOLLECT_READY "));
      if (!line) return;
      clearTimeout(timer);
      resolve(
        JSON.parse(line.slice("MAILCOLLECT_READY ".length)) as {
          port: number;
          token: string;
        },
      );
    });
    child?.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`服务退出 code=${code}\n${stderr}`));
    });
  });
  base = `http://127.0.0.1:${ready.port}`;
}, 60_000);

afterAll(async () => {
  if (child !== null) {
    const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([
      exited,
      new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
    ]);
  }
  rmSync(dataDir, { recursive: true, force: true });
});

describe("真实 main.ts 启动：发信依赖注入", () => {
  it("启动即 kick：启动前入队的 queued 行在 READY 后被 worker 认领（不是路由 kick）", async () => {
    // 注意顺序：本用例在任何 POST /api/send 之前完成，因此把行处理掉的只能是
    // main.ts 启动时的 kick（registerSend 装配 kick + startBackground kick）。
    const item = await waitFor(async () => {
      const res = await api(`/api/outbox?accountId=${accountId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        items: Array<{
          id: string;
          status: string;
          attempts: number;
          lastError: string | null;
        }>;
      };
      const found = body.items.find((entry) => entry.id === preQueuedId);
      return found !== undefined && found.attempts >= 1 ? found : null;
    }, 20_000);

    expect(item.status).not.toBe("queued");
    expect(item.status).not.toBe("sending");
    expect(item.attempts).toBeGreaterThanOrEqual(1);
    // 127.0.0.1:1 连接被拒：失败原因可读且已退避——不是「没有适配器」。
    expect(item.lastError ?? "").not.toBe("");
    expect(item.lastError ?? "").not.toContain(SMTP_PASSWORD);
    expect(item.lastError ?? "").not.toContain(INBOUND_SECRET);
  }, 30_000);

  it("POST /api/send 走真实适配器工厂，不再返回 502「未注入邮件适配器」", async () => {
    const res = await api("/api/send", {
      method: "POST",
      body: JSON.stringify({ accountId, message: message("T62 直发注入验证") }),
    });
    const body = (await res.json()) as {
      status?: string;
      outboxId?: string;
      error?: string | null;
    };

    expect(res.status, `不应再是 502：${JSON.stringify(body)}`).not.toBe(502);
    // SMTP 连接被拒属于可重试网络错误 → 路由入队并返回 200 queued。
    expect(res.status).toBe(200);
    expect(body.status).toBe("queued");
    expect(body.outboxId).toBeTruthy();
    // 凭据不得出现在响应里。
    const text = JSON.stringify(body);
    expect(text).not.toContain(SMTP_PASSWORD);
    expect(text).not.toContain(INBOUND_SECRET);
  }, 30_000);
});
