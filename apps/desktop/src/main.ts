import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow, app, dialog, shell } from "electron";

/**
 * Desktop host.
 *
 * The desktop app is a THIN WINDOW over the same HTTP service the web build
 * uses. Nothing business-related lives here: the server owns IMAP, SQLite and
 * the LLM calls, so there is exactly one transport and one code path.
 *
 * dev  : Vite serves the UI on :5173 and proxies /api to the dev server (:8787)
 * prod : this process spawns the bundled server (Electron's own Node, no native
 *        module), reads its READY line, probes /api/health, then loads the URL.
 *
 * A packaged app has no terminal, so the server's stdout/stderr is appended to
 * `userData/server.log`; a startup failure shows that tail in a native dialog
 * instead of exiting silently.
 */

interface ReadyInfo {
  port: number;
  token: string;
}

const isDev = !app.isPackaged;
const LOG_MAX_BYTES = 2 * 1024 * 1024;
const OUTPUT_TAIL_LINES = 30;
const HEALTH_TIMEOUT_MS = 2_000;
const HEALTH_BUDGET_MS = 10_000;
const HEALTH_RETRY_DELAY_MS = 250;

let serverProcess: ChildProcess | null = null;
let server: ReadyInfo | null = null;
let logFd: number | null = null;
let logPath = "";
/** 服务端最近输出，启动失败时随原生错误框一起展示。 */
const outputTail: string[] = [];

function writeLog(chunk: string | Uint8Array): void {
  if (logFd === null) return;
  try {
    if (typeof chunk === "string") writeSync(logFd, chunk);
    else writeSync(logFd, chunk);
  } catch (error) {
    console.error("[server.log] 写入失败:", error);
    closeLog();
  }
}

function closeLog(): void {
  if (logFd === null) return;
  try {
    closeSync(logFd);
  } catch {
    // no-excuse-ok: catch —— 退出路径，关闭失败已无法补救。
  }
  logFd = null;
}

/** 打开（必要时先轮转）`userData/server.log`，并写入本次启动的头部。 */
function openServerLog(entry: string): void {
  const userData = app.getPath("userData");
  mkdirSync(userData, { recursive: true });
  const file = join(userData, "server.log");
  try {
    if (statSync(file).size > LOG_MAX_BYTES) {
      // Windows 的 rename 不会覆盖已有文件，先清掉上一份轮转日志。
      rmSync(`${file}.1`, { force: true });
      renameSync(file, `${file}.1`);
    }
  } catch {
    // no-excuse-ok: catch —— 文件不存在时无需轮转；轮转失败也不能阻断启动。
  }

  logFd = openSync(file, "a");
  logPath = file;
  writeLog(
    [
      "=== MailCollect desktop ===",
      `time: ${new Date().toISOString()}`,
      `version: ${app.getVersion()}`,
      `platform: ${process.platform} (${process.arch})`,
      `server: ${entry}`,
      "",
    ].join("\n"),
  );
}

/** stdout/stderr 同时落盘，并保留最后若干行给错误框。 */
function recordOutput(chunk: Buffer): void {
  writeLog(chunk);
  for (const line of chunk.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    outputTail.push(line);
  }
  while (outputTail.length > OUTPUT_TAIL_LINES) outputTail.shift();
}

const readReadyLine = (child: ChildProcess): Promise<ReadyInfo> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("本地服务启动超时（15s）")), 15_000);
    let buffer = "";

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      const line = buffer.split("\n").find((entry) => entry.startsWith("MAILCOLLECT_READY "));
      if (!line) return;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      try {
        resolve(JSON.parse(line.slice("MAILCOLLECT_READY ".length)) as ReadyInfo);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("READY 行解析失败"));
      }
    };

    child.stdout?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`本地服务退出，code=${String(code)}`));
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

async function startServer(): Promise<ReadyInfo> {
  const entry = join(app.getAppPath(), "dist-electron", "server.mjs");
  openServerLog(entry);
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      MAILCOLLECT_VERSION: app.getVersion(),
      MAILCOLLECT_DATA_DIR: join(app.getPath("userData"), "data"),
      MAILCOLLECT_UI_DIR: join(app.getAppPath(), "ui"),
      MAILCOLLECT_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess = child;
  child.stdout?.on("data", recordOutput);
  child.stderr?.on("data", recordOutput);
  child.once("exit", (code, signal) => {
    writeLog(`\n[desktop] 服务端退出 code=${String(code)} signal=${String(signal)}\n`);
    serverProcess = null;
  });
  return readReadyLine(child);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isHealthy = (body: unknown): boolean =>
  typeof body === "object" && body !== null && "ok" in body && body.ok === true;

/**
 * READY 只代表端口已监听；再用 /api/health 确认 HTTP 与 SQLite 真的可用，
 * 否则窗口会显示一个永远连不上的「本地服务未连接」。
 */
async function waitForHealth(port: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/api/health`;
  const deadline = Date.now() + HEALTH_BUDGET_MS;
  let lastFailure = "未收到响应";

  while (Date.now() < deadline) {
    if (serverProcess === null) throw new Error("本地服务在通过健康检查前退出");
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
      if (response.ok) {
        const body: unknown = await response.json();
        if (isHealthy(body)) return;
        lastFailure = "响应中没有 ok=true";
      } else {
        lastFailure = `HTTP ${response.status}`;
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
    await sleep(HEALTH_RETRY_DELAY_MS);
  }

  throw new Error(`健康检查在 ${HEALTH_BUDGET_MS / 1000}s 内未通过：${lastFailure}`);
}

function createWindow(baseUrl: string, token: string): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: "#EEF5FD",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: join(app.getAppPath(), "dist-electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      additionalArguments: [`--mc-api-base=${baseUrl}`, `--mc-token=${token}`],
    },
  });

  window.once("ready-to-show", () => window.show());
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  void window.loadURL(baseUrl);
}

/** 启动失败必须留下现场：原生错误框 + 日志路径，然后退出。 */
function failStartup(step: string, error: unknown): void {
  const summary = "MailCollect 启动失败：本地服务不可用，应用即将退出。";
  const detail = error instanceof Error ? error.message : String(error);
  const tail = outputTail.length === 0 ? "(服务端没有输出)" : outputTail.join("\n");
  const report = [
    summary,
    "",
    `失败步骤：${step}`,
    `错误信息：${detail}`,
    `日志文件：${logPath === "" ? "（日志未能创建）" : logPath}`,
    "",
    `--- 服务端最后 ${OUTPUT_TAIL_LINES} 行输出 ---`,
    tail,
  ].join("\n");

  console.error(report);
  dialog.showErrorBox("MailCollect 启动失败", report);
  app.quit();
}

async function startProduction(): Promise<boolean> {
  let step = "启动本地服务";
  try {
    server = await startServer();
    step = "后端健康检查";
    await waitForHealth(server.port);
    step = "创建窗口";
    createWindow(`http://127.0.0.1:${server.port}`, server.token);
  } catch (error) {
    failStartup(step, error);
    return false;
  }

  return true;
}

app.whenReady().then(async () => {
  if (isDev) {
    const devUrl = process.env["MAILCOLLECT_DEV_URL"] ?? "http://127.0.0.1:5173";
    const devToken = process.env["MAILCOLLECT_DEV_TOKEN"] ?? "dev-local-token";
    createWindow(devUrl, devToken);
  } else if (!(await startProduction())) {
    return;
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      if (isDev) createWindow(process.env["MAILCOLLECT_DEV_URL"] ?? "http://127.0.0.1:5173", "dev-local-token");
      else if (server) createWindow(`http://127.0.0.1:${server.port}/`, server.token);
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

const stopServer = (): void => {
  if (serverProcess !== null) {
    serverProcess.kill();
    serverProcess = null;
  }
};

app.on("before-quit", () => {
  stopServer();
  closeLog();
});

app.on("will-quit", () => {
  stopServer();
  closeLog();
});
