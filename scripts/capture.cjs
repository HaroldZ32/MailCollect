/**
 * 用 Electron 自带渲染引擎截图，不需要装 Playwright/Chromium。
 * 用法：CAPTURE_URL=http://127.0.0.1:4173/ CAPTURE_OUT=evidence/ui/home.png \
 *        ./node_modules/.bin/electron --no-sandbox scripts/capture.cjs
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const url = process.env.CAPTURE_URL || "http://127.0.0.1:4173/";
const out = path.resolve(process.env.CAPTURE_OUT || "evidence/ui/home.png");
const width = Number(process.env.CAPTURE_WIDTH || 1440);
const height = Number(process.env.CAPTURE_HEIGHT || 960);
const waitMs = Number(process.env.CAPTURE_WAIT || 2600);

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width,
      height,
      show: false,
      backgroundColor: "#EEF5FD",
      webPreferences: { offscreen: true, contextIsolation: true, nodeIntegration: false },
    });
    await win.loadURL(url);
    await new Promise((r) => setTimeout(r, waitMs));
    const image = await win.webContents.capturePage();
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, image.toPNG());
    const size = image.getSize();
    console.log(`CAPTURE_OK ${out} ${size.width}x${size.height} ${image.toPNG().length}B`);
  } catch (error) {
    console.log(`CAPTURE_FAIL ${error.message}`);
    process.exitCode = 1;
  }
  app.quit();
});
