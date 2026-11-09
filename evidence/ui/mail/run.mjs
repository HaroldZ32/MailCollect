/**
 * T35（UI：收发界面）的黑盒证据脚本。
 *
 * 它做四件事，全部输出到 evidence/ui/mail/：
 *   1) 跑仓库自己的门禁（`npm run typecheck -w @mailcollect/ui`、`npm run build`）并记录退出码；
 *   2) 用一次性数据目录种演示数据 + 补文件夹/分类/多标签，再起真实 server（8787）与 vite dev（5173）；
 *   3) 用 Playwright 走真实浏览器：列表/详情/多标签筛选/撰写（Cc/Bcc/HTML/附件/草稿自动保存）/
 *      发件箱（失败重试删除位）/真实 SMTP 投递（本地 sink）/离线入队；
 *   4) 再用空库起一次，验证「未配置账号」的可见提示（AC-02 的收件箱侧）。
 *
 * 用法：node evidence/ui/mail/run.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";

const ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");
const EVIDENCE = join(ROOT, "evidence/ui/mail");
const RUNTIME = join(EVIDENCE, ".runtime");
const TOKEN = "dev-local-token";
const API_PORT = 8801;
const UI_PORT = 8099;
const API = `http://127.0.0.1:${API_PORT}`;
const UI = `http://127.0.0.1:${UI_PORT}`;
const TSX = join(ROOT, "node_modules/tsx/dist/cli.mjs");

/**
 * Chromium 二进制不在仓库里（~150 MB）。解析顺序：
 *   MAILCOLLECT_PW_CHROME → PLAYWRIGHT_BROWSERS_PATH → node_modules/.cache/ms-playwright
 *   → ~/.cache/ms-playwright
 * 缺浏览器时先跑：
 *   PLAYWRIGHT_BROWSERS_PATH=$PWD/node_modules/.cache/ms-playwright npx playwright install chromium
 */
function findChromium() {
  if (process.env["MAILCOLLECT_PW_CHROME"]) return process.env["MAILCOLLECT_PW_CHROME"];
  const roots = [
    process.env["PLAYWRIGHT_BROWSERS_PATH"],
    join(ROOT, "node_modules/.cache/ms-playwright"),
    process.env["HOME"] ? join(process.env["HOME"], ".cache/ms-playwright") : null,
  ].filter((root) => typeof root === "string" && root !== "");
  for (const root of roots) {
    if (!existsSync(root)) continue;
    // 优先 headless shell（Playwright 默认），完整 Chromium 在无 crashpad 数据库的沙箱里会 SIGTRAP。
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("chromium_headless_shell-")) continue;
      for (const candidate of [
        join(root, entry, "chrome-headless-shell-linux64/chrome-headless-shell"),
        join(root, entry, "chrome-headless-shell-linux/chrome-headless-shell"),
      ]) {
        if (existsSync(candidate)) return candidate;
      }
    }
    for (const entry of readdirSync(root)) {
      if (!entry.startsWith("chromium-")) continue;
      for (const candidate of [
        join(root, entry, "chrome-linux64/chrome"),
        join(root, entry, "chrome-linux/chrome"),
      ]) {
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

const results = [];
const record = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === "" ? "" : ` — ${detail}`}`);
};

/* ------------------------------- child helpers ------------------------------ */

function spawnChild(command, args, options = {}) {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
  const out = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    out.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    out.stderr += chunk.toString();
  });
  return { child, out };
}

function runToEnd(command, args, options = {}) {
  return new Promise((resolve) => {
    const { child, out } = spawnChild(command, args, options);
    child.on("exit", (code) => resolve({ code: code ?? -1, ...out }));
  });
}

async function waitForReady(child, timeoutMs = 30000) {
  const started = Date.now();
  let buffer = "";
  return new Promise((resolve, reject) => {
    const onData = (chunk) => {
      buffer += chunk.toString();
      const line = buffer.split("\n").find((item) => item.startsWith("MAILCOLLECT_READY "));
      if (line === undefined) return;
      child.stdout.off("data", onData);
      resolve(JSON.parse(line.slice("MAILCOLLECT_READY ".length)));
    };
    child.stdout.on("data", onData);
    child.once("exit", (code) => reject(new Error(`server 提前退出 code=${code}`)));
    const timer = setInterval(() => {
      if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error("server 启动超时"));
      }
    }, 250);
    timer.unref?.();
  });
}

async function waitForHttp(url, timeoutMs = 30000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return true;
    } catch {
      // 还没起来
    }
    if (Date.now() - started > timeoutMs) return false;
    await sleep(200);
  }
}

async function apiFetch(path, init = {}) {
  const headers = new Headers(init.headers ?? {});
  headers.set("authorization", `Bearer ${TOKEN}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(`${API}${path}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

/* ---------------------- 生产构建静态服务 + /api 反向代理 ---------------------- */

/**
 * 同一来源伺服 `apps/ui/dist` 并把 `/api/*` 转发给本脚本的 server：
 * - 浏览器侧不需要 CORS，也不需要注入 `window.__MAILCOLLECT__.apiBase`；
 * - SSE 用流式转发（`Readable.fromWeb(...).pipe`），否则实时事件流一断就会在界面上出现错误横幅。
 */
async function startUiServer(distDir, listenPort) {
  const { createServer: createHttpServer } = await import("node:http");
  const { readFile, stat } = await import("node:fs/promises");
  const { Readable } = await import("node:stream");
  const TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
  };
  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${listenPort}`);
    if (url.pathname.startsWith("/api/") || url.pathname === "/api") {
      try {
        const upstream = await fetch(`${API}${url.pathname}${url.search}`, {
          method: request.method,
          headers: { ...request.headers, host: `127.0.0.1:${API_PORT}` },
          body: ["GET", "HEAD"].includes(request.method ?? "GET") ? undefined : request,
          duplex: "half",
        });
        const headers = {};
        upstream.headers.forEach((value, key) => {
          headers[key] = value;
        });
        response.writeHead(upstream.status, headers);
        if (upstream.body === null) {
          response.end();
          return;
        }
        // SSE 是长连接：浏览器/服务端任一侧断开都会让流报错，必须自己收口，否则进程被未捕获错误带走。
        const stream = Readable.fromWeb(upstream.body);
        stream.on("error", () => {
          try {
            response.destroy();
          } catch {
            // 已经断开
          }
        });
        response.on("close", () => stream.destroy());
        stream.pipe(response);
      } catch (error) {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { code: "upstream_error", message: String(error) } }));
      }
      return;
    }
    const relative = url.pathname === "/" ? "/index.html" : url.pathname;
    const file = join(distDir, decodeURIComponent(relative));
    try {
      await stat(file);
      const body = await readFile(file);
      const extension = file.slice(file.lastIndexOf("."));
      response.writeHead(200, { "content-type": TYPES[extension] ?? "application/octet-stream" });
      response.end(body);
    } catch {
      // SPA：未知路径回退到 index.html
      const body = await readFile(join(distDir, "index.html"));
      response.writeHead(200, { "content-type": TYPES[".html"] });
      response.end(body);
    }
  });
  return new Promise((resolve) => {
    server.listen(listenPort, "127.0.0.1", () => resolve(server));
  });
}

/* ------------------------------- SMTP sink -------------------------------- */

/** 最小 SMTP 接收端：不宣告 AUTH/STARTTLS，只记录 DATA 字节，用于跑通「真的发出去」。 */
function startSmtpSink(port, options = {}) {
  const messages = [];
  const server = createServer((socket) => {
    let buffer = "";
    let data = null;
    socket.write("220 evidence-smtp ESMTP\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      for (;;) {
        const index = buffer.indexOf("\r\n");
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (data !== null) {
          if (line === "." || line === "..") {
            messages.push(data);
            data = null;
            socket.write("250 OK queued\r\n");
          } else {
            data += `${line}\r\n`;
          }
          continue;
        }
        const upper = line.toUpperCase();
        if (options.rejectAuth === true && upper.startsWith("AUTH")) {
          socket.write("535 5.7.8 认证失败\r\n");
          continue;
        }
        if (upper.startsWith("EHLO")) {
          socket.write(
            options.rejectAuth === true
              ? "250-evidence-smtp\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n"
              : "250-evidence-smtp\r\n250 8BITMIME\r\n",
          );
        }
        else if (upper.startsWith("HELO")) socket.write("250 evidence-smtp\r\n");
        else if (upper.startsWith("DATA")) {
          data = "";
          socket.write("354 Go ahead\r\n");
        } else if (upper.startsWith("QUIT")) {
          socket.write("221 Bye\r\n");
          socket.end();
        } else socket.write("250 OK\r\n");
      }
    });
    socket.on("error", () => undefined);
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve({ server, messages }));
  });
}

/* -------------------------------- the run -------------------------------- */

rmSync(RUNTIME, { recursive: true, force: true });
// 旧截图不能和新一轮混在一起：先清掉上一轮的 png。
for (const file of readdirSync(EVIDENCE)) {
  if (file.endsWith(".png")) rmSync(join(EVIDENCE, file), { force: true });
}
mkdirSync(join(RUNTIME, "data-a"), { recursive: true });
mkdirSync(join(RUNTIME, "data-b"), { recursive: true });
mkdirSync(EVIDENCE, { recursive: true });

const servers = [];
const browserHolder = { browser: null };

try {
  /* 1) 门禁：仓库自己的命令，原样跑、原样记退出码。 */
  const typecheck = await runToEnd("npm", ["run", "typecheck", "-w", "@mailcollect/ui"], { cwd: ROOT });
  record("gate: npm run typecheck -w @mailcollect/ui", typecheck.code === 0, `exit=${typecheck.code}`);
  const build = await runToEnd("npm", ["run", "build"], { cwd: ROOT });
  record("gate: npm run build", build.code === 0, `exit=${build.code}`);

  /* 2) 种子数据 + 真实 server + vite dev */
  const dataA = join(RUNTIME, "data-a");
  const seed = await runToEnd(process.execPath, [TSX, join(ROOT, "scripts/seed-demo.ts")], {
    cwd: ROOT,
    env: { ...process.env, MAILCOLLECT_DATA_DIR: dataA },
  });
  record("seed: scripts/seed-demo.ts", seed.code === 0, `exit=${seed.code}`);
  const extra = await runToEnd(process.execPath, [TSX, join(EVIDENCE, "seed-extra.ts")], {
    cwd: ROOT,
    env: { ...process.env, MAILCOLLECT_DATA_DIR: dataA },
  });
  record("seed: evidence/ui/mail/seed-extra.ts", extra.code === 0, extra.stdout.trim().slice(0, 200));

  const smtp = await startSmtpSink(2525);
  const smtpAuthReject = await startSmtpSink(2526, { rejectAuth: true });

  const startServer = async (dataDir) => {
    const { child } = spawnChild(process.execPath, [TSX, join(ROOT, "apps/server/src/main.ts")], {
      cwd: ROOT,
      env: {
        ...process.env,
        MAILCOLLECT_PORT: String(API_PORT),
        MAILCOLLECT_TOKEN: TOKEN,
        MAILCOLLECT_DATA_DIR: dataDir,
      },
    });
    servers.push(child);
    await waitForReady(child);
    return child;
  };

  await startServer(dataA);
  // 种子库没有初始化标记 → 侧栏会自动全屏向导；这里按「跳过」落地，才能截到收件箱。
  const skipOnboarding = await apiFetch("/api/onboarding", {
    method: "PUT",
    body: JSON.stringify({ skipped: true }),
  });
  record("seed: 标记初始化已跳过", skipOnboarding.status === 200, `status=${skipOnboarding.status}`);

  // 演示账号原先指向 imap.acme.cn：详情端点会去连真实服务器（实测阻塞 81 秒）。
  // 证据环境把所有账号的收信地址改成本机不可达端口，让「适配器失败 → 降级为本地正文」秒级返回。
  const seededAccounts = (await apiFetch("/api/accounts")).body?.items ?? [];
  for (const account of seededAccounts) {
    const patched = await apiFetch(`/api/accounts/${account.id}`, {
      method: "PATCH",
      body: JSON.stringify({ config: { host: "127.0.0.1", port: "1", tls: "false", mailbox: "INBOX" } }),
    });
    record(`seed: 账号 ${account.label} 指向本机不可达端口`, patched.status === 200, `status=${patched.status}`);
  }

  const uiServer = await startUiServer(join(ROOT, "apps/ui/dist"), UI_PORT);
  servers.push({ kill: () => uiServer.close() });
  const uiUp = await waitForHttp(`${UI}/`, 20000);
  record("boot: 生产构建静态服务（同源 /api 反向代理）", uiUp, UI);

  const executablePath = findChromium();
  record("boot: 找到 Chromium 二进制", executablePath !== null, executablePath ?? "未找到（先 npx playwright install chromium）");
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(executablePath === null ? {} : { executablePath }),
  });
  browserHolder.browser = browser;
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("dialog", (dialog) => void dialog.dismiss());

  const shot = async (name) => {
    await page.screenshot({ path: join(EVIDENCE, name) });
    const text = await page.evaluate(() => document.body.innerText.trim().length);
    record(`shot: ${name}`, text > 0, `bodyTextChars=${text}`);
  };

  await page.goto(`${UI}/`, { waitUntil: "networkidle", timeout: 30000 });
  if (process.env["MAILCOLLECT_EVIDENCE_DEBUG"] === "1") {
    await sleep(2500);
    console.log("DEBUG body:", (await page.evaluate(() => document.body.innerText)).slice(0, 800));
    console.log("DEBUG consoleErrors:", JSON.stringify(consoleErrors.slice(0, 10)));
    console.log("DEBUG pageErrors:", JSON.stringify(pageErrors.slice(0, 10)));
    const probe = await page.evaluate(async () => {
      const response = await fetch("/api/messages?folder=inbox&limit=3", {
        headers: { authorization: "Bearer dev-local-token" },
      });
      return { status: response.status, body: (await response.text()).slice(0, 300) };
    });
    console.log("DEBUG /api/messages:", JSON.stringify(probe));
    await page.screenshot({ path: join(EVIDENCE, "debug.png") });
  }
  await page.waitForSelector(".mail-item", { timeout: 20000 });
  await page.waitForTimeout(400);

  /* 3a) 收件箱列表：多标签、未读点、文件夹未读数、账号筛选 */
  const itemCount = await page.locator(".mail-item").count();
  record("inbox: 列表渲染", itemCount >= 8, `items=${itemCount}`);
  const multiTagged = await page.locator(".mail-item").filter({ hasText: "Q4 预算表初稿" }).locator(".chip--iris").count();
  record("inbox: 邮件显示全部标签", multiTagged >= 1, `Q4 预算表标签数=${multiTagged}`);
  const projectTagged = await page.locator(".mail-item").filter({ hasText: "苏州客户现场走访" }).locator(".chip--iris").count();
  record("inbox: 多标签邮件（2 个分类）", projectTagged >= 2, `苏州邮件标签数=${projectTagged}`);
  const sidebarFolders = await page.locator('aside [aria-label="文件夹"] .nav-item').count();
  record("sidebar: 文件夹条目", sidebarFolders >= 3, `folders=${sidebarFolders}`);
  const folderUnread = await page.locator('aside [aria-label="文件夹"] .nav-badge').first().textContent();
  record("sidebar: 文件夹未读数", folderUnread !== null && Number(folderUnread) > 0, `未读=${folderUnread ?? "无"}`);
  await shot("01-inbox-list.png");

  /* 3b) 分类多选筛选（ANY） */
  await page.locator(".filter-chip", { hasText: "项目跟进" }).first().click();
  await page.waitForTimeout(600);
  const anyCount = await page.locator(".mail-item").count();
  record("inbox: 分类筛选（项目跟进）", anyCount === 2, `items=${anyCount}（期望 2：苏州 + 评审会）`);
  await shot("02-inbox-filter-category.png");
  await page.locator(".filter-chip", { hasText: "群发/通知" }).first().click();
  await page.waitForTimeout(600);
  const anyUnion = await page.locator(".mail-item").count();
  record("inbox: 多选分类按 ANY 取并集", anyUnion > anyCount, `items=${anyUnion}（并集 > 单分类 ${anyCount}）`);
  await page.locator("button", { hasText: "清空分类" }).click();
  await page.waitForTimeout(500);

  /* 3c) 详情：正文 / 标签 / 附件区 / 已读 */
  await page.locator(".mail-item", { hasText: "Q4 预算表初稿" }).first().click();
  await page.waitForSelector(".mail-detail-subject", { timeout: 15000 });
  const detailSubject = await page.locator(".mail-detail-subject").textContent();
  record("detail: 正文渲染", (detailSubject ?? "").includes("Q4 预算表"), `subject=${detailSubject ?? ""}`);
  const detailBody = await page.locator(".mail-detail-scroll .mail-body").first().textContent();
  record("detail: 纯文本正文可见", (detailBody ?? "").includes("预算表"), `bodyChars=${(detailBody ?? "").length}`);
  await shot("03-inbox-detail.png");

  /* 3d) 前端二次净化：即使服务端下发了带脚本的 html，页面也不能执行或保留它 */
  const sanitizePage = await context.newPage();
  const sanitizeErrors = [];
  sanitizePage.on("pageerror", (error) => sanitizeErrors.push(error.message));
  await sanitizePage.route("**/api/messages/e1*", (route) => {
    if (route.request().method() !== "GET" || route.request().url().endsWith("/attachments")) {
      void route.continue();
      return;
    }
    void route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        message: {
          id: "e1",
          accountId: "a1",
          uid: "101",
          messageId: "<xss@evidence>",
          threadId: null,
          fromName: "攻击者",
          fromEmail: "attacker@example.com",
          to: ["zhangsan@acme.cn"],
          cc: [],
          subject: "HTML 净化证据",
          sentAt: "2026-11-09T02:00:00+08:00",
          bodyText: "富文本安全渲染证据",
          hasAttachments: false,
          headers: {},
          createdAt: "2026-11-09T02:00:00+08:00",
        },
        body: {
          text: "富文本安全渲染证据",
          html: '<div><p>富文本安全渲染证据</p><script>window.__xss = 1;</script><img src=x onerror="window.__xss=2"><a href="javascript:window.__xss=3">点我</a><iframe src="https://example.com"></iframe><p onclick="window.__xss=4">点击文本</p></div>',
        },
        attachments: [{ id: "att-1", filename: "预算模板.xlsx", mimeType: "application/vnd.ms-excel", size: 20480 }],
        folder: "INBOX",
        isRead: true,
        categoryIds: [],
      }),
    });
  });
  await sanitizePage.goto(`${UI}/`, { waitUntil: "networkidle", timeout: 30000 });
  await sanitizePage.waitForSelector(".mail-item", { timeout: 20000 });
  await sanitizePage.locator(".mail-item").first().click();
  await sanitizePage.waitForSelector(".mail-detail-subject", { timeout: 15000 });
  await sanitizePage.waitForTimeout(600);
  const sanitizeState = await sanitizePage.evaluate(() => ({
    xss: window.__xss ?? null,
    scripts: document.querySelectorAll(".mail-body script").length,
    iframes: document.querySelectorAll(".mail-body iframe").length,
    onclick: document.querySelectorAll(".mail-body [onclick], .mail-body [onerror]").length,
    jsLinks: Array.from(document.querySelectorAll(".mail-body a")).filter((anchor) =>
      anchor.getAttribute("href")?.toLowerCase().startsWith("javascript:"),
    ).length,
    text: document.querySelector(".mail-body")?.textContent ?? "",
    attachments: document.querySelectorAll(".mail-attachment-row, .mail-detail-scroll [title='预算模板.xlsx']").length,
  }));
  record("sanitize: 脚本未执行", sanitizeState.xss === null, `window.__xss=${String(sanitizeState.xss)}`);
  record("sanitize: script/iframe/on*/javascript: 全部移除", sanitizeState.scripts === 0 && sanitizeState.iframes === 0 && sanitizeState.onclick === 0 && sanitizeState.jsLinks === 0, JSON.stringify(sanitizeState));
  record("sanitize: 正文仍可读", sanitizeState.text.includes("富文本安全渲染证据"), sanitizeState.text.slice(0, 40));
  record("sanitize: 附件条目可见", sanitizeState.attachments >= 1, `matches=${sanitizeState.attachments}`);
  record("sanitize: 无 pageerror", sanitizeErrors.length === 0, sanitizeErrors.join(" | ").slice(0, 200));
  await sanitizePage.screenshot({ path: join(EVIDENCE, "04-html-sanitize.png") });
  await sanitizePage.close();

  /* 3e) 撰写：Cc/Bcc、HTML 切换、附件、停输 3 秒自动保存（第二次保存必须覆盖同一草稿） */
  await page.locator("button", { hasText: "写邮件" }).click();
  await page.waitForSelector("#composer-to", { timeout: 10000 });
  await page.fill("#composer-to", "liting@acme.cn");
  await page.locator("button", { hasText: "添加抄送 Cc" }).click();
  await page.fill("#composer-cc", "wangqiang@acme.cn");
  await page.locator("button", { hasText: "添加密送 Bcc" }).click();
  await page.fill("#composer-bcc", "audit@example.com");
  await page.fill("#composer-subject", "Q4 预算表初稿（回填）");
  await page.fill("#composer-body", "李婷，你好：\n\n预算表初稿已按你给的口径补齐，两栏都在附件里。\n\n张三");
  await page.locator('label.check:has-text("以 HTML 发送") input').click();
  await page.setInputFiles('input[type="file"]', {
    name: "预算模板.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("evidence attachment payload\n"),
  });
  await page.waitForTimeout(300);
  await shot("05-composer.png");
  await page.locator('[role="dialog"]').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.waitForTimeout(300);
  await shot("05b-composer-attachments.png");
  await page.locator('[role="dialog"]').evaluate((element) => {
    element.scrollTop = 0;
  });

  const draftState = { first: [], second: [] };
  await page.waitForTimeout(3600);
  draftState.first = (await apiFetch("/api/drafts")).body?.items ?? [];
  record("draft: 停输 3 秒自动保存", draftState.first.length === 1, `drafts=${draftState.first.length}`);
  await page.fill("#composer-body", "李婷，你好：\n\n预算表初稿已按你给的口径补齐，两栏都在附件里。\n补一句：差异说明也写在表里。\n\n张三");
  await page.waitForTimeout(3600);
  draftState.second = (await apiFetch("/api/drafts")).body?.items ?? [];
  const sameDraft =
    draftState.second.length === 1 &&
    draftState.first.length === 1 &&
    draftState.second[0]?.id === draftState.first[0]?.id;
  record(
    "draft: 第二次保存是覆盖（同 draftId，不新增行）",
    sameDraft,
    `first=${draftState.first[0]?.id ?? "无"} second=${draftState.second[0]?.id ?? "无"} count=${draftState.second.length}`,
  );
  record(
    "draft: 附件/密送随草稿持久化",
    (draftState.second[0]?.attachments?.length ?? 0) === 1 && (draftState.second[0]?.bcc?.length ?? 0) === 1,
    `attachments=${draftState.second[0]?.attachments?.length ?? 0} bcc=${draftState.second[0]?.bcc?.length ?? 0}`,
  );
  const savedLabel = await page.locator('[role="dialog"] .field-hint', { hasText: "草稿已保存" }).count();
  record("draft: UI 显示已保存", savedLabel >= 1, `matches=${savedLabel}`);
  await shot("06-composer-autosaved.png");

  /* 3f) 草稿页：关闭弹层后列表刷新，草稿可继续编辑 */
  await page.locator('[role="dialog"] button:has-text("关闭")').click();
  await page.waitForTimeout(700);
  await page.locator("button", { hasText: "草稿" }).first().click();
  await page.waitForTimeout(700);
  const draftRows = await page.locator("button", { hasText: "继续编辑" }).count();
  record("drafts: 草稿可从列表恢复", draftRows >= 1, `rows=${draftRows}`);
  await shot("07-drafts.png");

  /* 3g) 三个证据账号：一个真投递、一个认证失败、一个端口不可达 */
  const createAccount = (label, email, smtpPortValue) =>
    apiFetch("/api/accounts", {
      method: "POST",
      body: JSON.stringify({
        provider: "imap",
        label,
        email,
        config: {
          host: "127.0.0.1",
          port: "1",
          tls: "false",
          mailbox: "INBOX",
          smtpAllowInsecure: "1",
        },
        secret: "evidence-local-only",
        send: {
          smtpHost: "127.0.0.1",
          smtpPort: smtpPortValue,
          smtpSecure: false,
          smtpUser: "evidence",
          smtpPassword: "evidence-local-only",
        },
      }),
    });
  const okAccount = await createAccount("证据发信账号", "evidence@example.com", 2525);
  const authAccount = await createAccount("证据认证失败账号", "authfail@example.com", 2526);
  const offlineAccount = await createAccount("证据离线账号", "offline@example.com", 1);
  record(
    "account: 创建三个证据账号",
    okAccount.status === 201 && authAccount.status === 201 && offlineAccount.status === 201,
    `status=${[okAccount.status, authAccount.status, offlineAccount.status].join("/")}`,
  );
  const okAccountId = okAccount.body?.account?.id ?? null;
  const authAccountId = authAccount.body?.account?.id ?? null;
  const offlineAccountId = offlineAccount.body?.account?.id ?? null;

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector(".mail-item", { timeout: 20000 });

  const compose = async (accountId, to, subject, body) => {
    await page.locator("button", { hasText: "写邮件" }).click();
    await page.waitForSelector("#composer-to", { timeout: 10000 });
    if (accountId !== null) await page.selectOption("#composer-account", accountId);
    await page.fill("#composer-to", to);
    await page.fill("#composer-subject", subject);
    await page.fill("#composer-body", body);
  };

  /* 3h) 认证失败（服务端 535）：类型化错误可见，并停在发件箱可重试/删除 */
  await compose(authAccountId, "liting@acme.cn", "证据：SMTP 认证失败", "服务端应当把认证失败停在发件箱。");
  await page.locator('[role="dialog"] button:has-text("发送")').click();
  await page.waitForTimeout(2500);
  const sendError = await page.locator('[role="dialog"] .test-result.is-error').first().textContent();
  record("send: 认证失败给出可读错误", (sendError ?? "").includes("认证失败"), (sendError ?? "").slice(0, 140));
  record("smtp: 认证失败 sink 收到了 AUTH 但不收信", smtpAuthReject.messages.length === 0, `messages=${smtpAuthReject.messages.length}`);
  await shot("08-send-auth-failure.png");
  await page.locator('[role="dialog"] button:has-text("关闭")').click();
  await page.waitForTimeout(500);

  await page.locator("button", { hasText: "发件箱" }).first().click();
  await page.waitForTimeout(900);
  const failedRow = (await apiFetch("/api/outbox")).body?.items?.find(
    (item) => item.message?.subject === "证据：SMTP 认证失败",
  );
  record("outbox: 认证失败停在发件箱（failed + lastError）", failedRow?.status === "failed" && failedRow?.lastError !== null, `status=${failedRow?.status ?? "无行"} error=${(failedRow?.lastError ?? "").slice(0, 60)}`);
  const retryButtons = await page.locator("button", { hasText: "重试" }).count();
  const deleteButtons = await page.locator("button", { hasText: "删除" }).count();
  record("outbox: 失败行带「重试」「删除」", retryButtons >= 1 && deleteButtons >= 1, `retry=${retryButtons} delete=${deleteButtons}`);
  await shot("09-outbox-failed.png");

  /* 3i) 真投递：本地 SMTP sink 收下邮件 → status=sent → 已发送提示 */
  await page.locator("button", { hasText: "写邮件" }).click();
  await page.waitForSelector("#composer-to", { timeout: 10000 });
  if (okAccountId !== null) await page.selectOption("#composer-account", okAccountId);
  await page.fill("#composer-to", "liting@acme.cn");
  await page.fill("#composer-subject", "证据：真实 SMTP 投递");
  await page.fill("#composer-body", "这封信由本地 SMTP sink 收下，用来证明 sent 路径与本地镜像。");
  await page.locator('[role="dialog"] button:has-text("发送")').click();
  await page.waitForTimeout(3000);
  const sentNotice = await page.locator(".test-result", { hasText: "已发送" }).count();
  const dialogGone = (await page.locator('[role="dialog"]').count()) === 0;
  record("send: 成功投递显示「已发送」并关闭弹层", sentNotice >= 1 && dialogGone, `notice=${sentNotice} closed=${dialogGone}`);
  record("smtp: 本地 sink 收到 DATA 字节", smtp.messages.length >= 1, `messages=${smtp.messages.length}`);
  const sentRaw = smtp.messages.at(-1) ?? "";
  record(
    "smtp: MIME 含 To/Subject/Message-ID",
    sentRaw.includes("To:") && sentRaw.includes("Subject:") && sentRaw.includes("Message-ID:"),
    `bytes=${sentRaw.length}`,
  );
  const sentOutbox = (await apiFetch("/api/outbox")).body?.items ?? [];
  record(
    "send: 发件箱出现 sent 记录",
    sentOutbox.some((item) => item.status === "sent"),
    JSON.stringify(sentOutbox.map((item) => [item.status, item.message?.subject]).slice(0, 5)),
  );
  await shot("10-send-sent.png");

  /* 3j) 端口不可达 → 服务端入队：UI 显示排队而不是失败 */
  await compose(offlineAccountId, "liting@acme.cn", "证据：不可达 SMTP 入队", "SMTP 端口不可达，服务端应入队而不是报失败。");
  await page.locator('[role="dialog"] button:has-text("发送")').click();
  await page.waitForTimeout(3000);
  const outboxAfter = (await apiFetch("/api/outbox")).body?.items ?? [];
  const queuedRow = outboxAfter.find((item) => item.message?.subject === "证据：不可达 SMTP 入队");
  // 契约：可重试失败 → POST /send 返回 queued；后台 worker 尝试后落 failed + 近期 nextAttemptAt（退避 ≥30s），
  // 与「不可重试」停在 365 天后的 failed 在 UI 上必须区分。
  const retryDueMs =
    queuedRow?.nextAttemptAt === null || queuedRow?.nextAttemptAt === undefined
      ? null
      : Date.parse(queuedRow.nextAttemptAt) - Date.now();
  const autoRetry = queuedRow !== undefined && queuedRow.status === "failed" && retryDueMs !== null && retryDueMs < 24 * 3600 * 1000;
  record(
    "send: 不可达 SMTP → 入队并安排自动重试（failed + 近期 nextAttemptAt）",
    autoRetry,
    `status=${queuedRow?.status ?? "无行"} attempts=${queuedRow?.attempts ?? "-"} retryDueSec=${retryDueMs === null ? "-" : Math.round(retryDueMs / 1000)} lastError=${(queuedRow?.lastError ?? "").slice(0, 60)}`,
  );
  const queuedNotice = await page.locator(".test-result", { hasText: "已加入发件箱" }).count();
  record("send: 入队后给出「已加入发件箱」提示", queuedNotice >= 1, `notice=${queuedNotice}`);
  await page.waitForTimeout(500);
  const autoRetryVisible = await page.locator(".mail-list", { hasText: "将自动重试" }).count();
  record("outbox: 自动重试行可见（与需手动重试区分）", autoRetryVisible >= 1, `matches=${autoRetryVisible}`);
  await shot("11-outbox-auto-retry.png");

  /* 3k) 侧栏文件夹联动 */
  await page.locator('aside [aria-label="文件夹"] .nav-item', { hasText: "归档" }).first().click();
  await page.waitForTimeout(900);
  const folderTab = await page.locator(".filter-chip.is-active", { hasText: "邮件 ·" }).textContent();
  record("folder: 侧栏切换文件夹联动列表", (folderTab ?? "").includes("归档"), `tab=${folderTab ?? ""}`);
  await shot("12-folder-archive.png");

  record("runtime: 无 pageerror", pageErrors.length === 0, pageErrors.join(" | ").slice(0, 300));
  const allowedConsole = /Failed to load resource|net::ERR|502|401/;
  const unexpected = consoleErrors.filter((text) => !allowedConsole.test(text));
  record(
    "runtime: 无未预期的 console error",
    unexpected.length === 0,
    `allowed=${consoleErrors.length - unexpected.length} unexpected=${unexpected.length} ${unexpected.slice(0, 2).join(" | ")}`,
  );

  /* 4) 空库：未配置账号的可见提示（AC-02 的收件箱侧） */
  await page.close();
  for (const server of servers.splice(0, 1)) server.kill("SIGTERM");
  await sleep(600);
  const dataB = join(RUNTIME, "data-b");
  await startServer(dataB);
  await apiFetch("/api/onboarding", { method: "PUT", body: JSON.stringify({ skipped: true }) });
  const emptyPage = await context.newPage();
  const emptyErrors = [];
  emptyPage.on("pageerror", (error) => emptyErrors.push(error.message));
  await emptyPage.goto(`${UI}/`, { waitUntil: "networkidle", timeout: 30000 });
  await emptyPage.waitForTimeout(1200);
  const emptyText = await emptyPage.evaluate(() => document.body.innerText);
  record("empty: 收件箱显示「还没有邮箱账号」", emptyText.includes("还没有邮箱账号"), emptyText.slice(0, 80));
  record("empty: 侧栏显示未配置提示", emptyText.includes("未配置"), emptyText.includes("未配置") ? "有" : "无");
  record("empty: 无 pageerror", emptyErrors.length === 0, emptyErrors.join(" | ").slice(0, 200));
  await emptyPage.screenshot({ path: join(EVIDENCE, "13-unconfigured.png") });
  await emptyPage.close();
} catch (error) {
  record("run: 未捕获异常", false, error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error));
} finally {
  try {
    await browserHolder.browser?.close();
  } catch {
    // ignore
  }
  for (const child of servers) {
    try {
      child.kill("SIGTERM");
    } catch {
      // ignore
    }
  }
}

const failed = results.filter((item) => !item.ok);
const report = {
  task: "T35 ui-mail",
  ranAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform} ${process.arch}`,
  viewport: "1440x960 @2x",
  gateCommands: [
    "npm run typecheck -w @mailcollect/ui",
    "npm run build",
  ],
  results,
  failed: failed.length,
};
writeFileSync(join(EVIDENCE, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${results.length - failed.length}/${results.length} passed → ${join(EVIDENCE, "report.json")}`);
process.exit(failed.length === 0 ? 0 : 1);
