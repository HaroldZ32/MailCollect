/**
 * 按侧边栏文字点击导航后截图（界面用的是应用内状态导航，不是 URL 路由）。
 * 用法：SHOT_BASE=http://127.0.0.1:4174 SHOT_NAV="待办,时间线,设置" node scripts/shot-nav.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const base = process.env.SHOT_BASE || "http://127.0.0.1:4174";
const labels = (process.env.SHOT_NAV || "待办,时间线,设置").split(",").map((s) => s.trim()).filter(Boolean);
const dir = process.env.SHOT_DIR || "evidence/ui";
const width = Number(process.env.SHOT_WIDTH || 1440);
const height = Number(process.env.SHOT_HEIGHT || 960);

mkdirSync(dir, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

await page.goto(base, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForTimeout(1500);

let failures = 0;
for (const label of labels) {
  const file = join(dir, `${label}.png`);
  try {
    const target = page.getByText(label, { exact: true }).first();
    await target.click({ timeout: 8000 });
    await page.waitForTimeout(1800);
    const text = await page.evaluate(() => document.body.innerText.slice(0, 300));
    await page.screenshot({ path: file });
    console.log(`SHOT OK ${file} (${label})`);
    if (process.env.SHOT_DUMP === "1") console.log(`  text: ${text.replace(/\n+/g, " | ").slice(0, 200)}`);
  } catch (error) {
    failures += 1;
    console.log(`SHOT FAIL ${label}: ${error.message.split("\n")[0]}`);
  }
}
for (const e of errors.slice(0, 8)) console.log(`  console.error: ${e}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
