/**
 * 用 Playwright 的无头 Chromium 截图，并抓取页面控制台错误。
 * 用法：
 *   SHOT_BASE=http://127.0.0.1:4173 SHOT_ROUTES="/,/tasks,/timeline,/settings" \
 *   SHOT_DIR=evidence/ui node scripts/shot.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const base = process.env.SHOT_BASE || "http://127.0.0.1:4173";
const routes = (process.env.SHOT_ROUTES || "/").split(",").map((r) => r.trim()).filter(Boolean);
const dir = process.env.SHOT_DIR || "evidence/ui";
const width = Number(process.env.SHOT_WIDTH || 1440);
const height = Number(process.env.SHOT_HEIGHT || 960);

mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
let failures = 0;

for (const route of routes) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));

  const url = `${base}${route === "/" ? "/" : route}`;
  const name = route === "/" ? "home" : route.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
  const file = join(dir, `${name}.png`);

  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(1800);
    const title = await page.title();
    const text = await page.evaluate(() => document.body.innerText.slice(0, 400));
    await page.screenshot({ path: file });
    const blank = text.trim().length === 0;
    if (blank) failures += 1;
    console.log(
      `SHOT ${blank ? "EMPTY" : "OK"} ${file} title="${title}" errors=${errors.length}`,
    );
    if (blank) console.log("  body 是空的 —— 页面可能白屏");
    for (const error of errors.slice(0, 5)) console.log(`  console.error: ${error}`);
  } catch (error) {
    failures += 1;
    console.log(`SHOT FAIL ${url}: ${error.message}`);
  } finally {
    await page.close();
  }
}

await browser.close();
process.exit(failures === 0 ? 0 : 1);
