import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { BrowserWindow, app, shell } from "electron";

/**
 * Desktop host.
 *
 * The desktop app is a THIN WINDOW over the same HTTP service the web build
 * uses. Nothing business-related lives here: the server owns IMAP, SQLite and
 * the LLM calls, so there is exactly one transport and one code path.
 *
 * dev  : Vite serves the UI on :5173 and proxies /api to the dev server (:8787)
 * prod : this process spawns the bundled server (Electron's own Node, no native
 *        module), reads its READY line, then loads the URL it printed.
 */

interface ReadyInfo {
  port: number;
  token: string;
}

const isDev = !app.isPackaged;
let serverProcess: ChildProcess | null = null;
let server: ReadyInfo | null = null;

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
  });

async function startServer(): Promise<ReadyInfo> {
  const entry = join(app.getAppPath(), "dist-electron", "server.mjs");
  const child = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      MAILCOLLECT_DATA_DIR: join(app.getPath("userData"), "data"),
      MAILCOLLECT_UI_DIR: join(app.getAppPath(), "ui"),
      MAILCOLLECT_PORT: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess = child;
  child.stderr?.on("data", (chunk: Buffer) => {
    console.error("[server]", chunk.toString("utf8").trim());
  });
  return readReadyLine(child);
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

app.whenReady().then(async () => {
  try {
    if (isDev) {
      const devUrl = process.env["MAILCOLLECT_DEV_URL"] ?? "http://127.0.0.1:5173";
      const devToken = process.env["MAILCOLLECT_DEV_TOKEN"] ?? "dev-local-token";
      createWindow(devUrl, devToken);
    } else {
      server = await startServer();
      createWindow(`http://127.0.0.1:${server.port}`, server.token);
    }
  } catch (error) {
    console.error("窗口创建失败:", error);
    app.quit();
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

app.on("quit", () => {
  serverProcess?.kill();
  serverProcess = null;
});
