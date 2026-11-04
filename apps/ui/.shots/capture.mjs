import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const base = process.env.SHOT_BASE || "http://localhost:4173";
const dir = process.env.SHOT_DIR || "apps/ui/.shots";
mkdirSync(dir, { recursive: true });

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const errors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") errors.push(msg.text());
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

const shot = async (name) => {
  await page.screenshot({ path: join(dir, `${name}.png`) });
  console.log("SHOT", name);
};

await page.goto(base, { waitUntil: "networkidle" });
await page.getByText("演示数据").first().waitFor({ timeout: 15000 });
await shot("01-inbox-empty");

await page.locator(".mail-item").first().click();
await page.locator(".mail-body").waitFor({ timeout: 5000 });
await page.waitForTimeout(300);
await shot("02-inbox-detail");

await page.locator(".nav-item").filter({ hasText: "待办" }).click();
await page.waitForTimeout(600);
await shot("03-tasks");

await page.locator(".nav-item").filter({ hasText: "时间线" }).click();
await page.locator(".gantt_task_line").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(1200);
const metrics = await page.evaluate(() => {
  const text = (selector) => document.querySelector(selector)?.textContent ?? null;
  return {
    bars: document.querySelectorAll(".gantt_task_line").length,
    windowBars: document.querySelectorAll(".gantt_task_line.mc-bar--window").length,
    dueBars: document.querySelectorAll(".gantt_task_line.mc-bar--due").length,
    dueDots: document.querySelectorAll(".mc-due-dot").length,
    links: document.querySelectorAll(".gantt_task_link").length,
    todayMarkers: document.querySelectorAll(".mc-today-marker").length,
    markerText: text(".gantt_marker_content"),
    rows: document.querySelectorAll(".gantt_row").length,
    gridTasks: Array.from(document.querySelectorAll(".gantt_tree_content")).map((node) => node.textContent),
  };
});
console.log("GANTT_METRICS", JSON.stringify(metrics));
await shot("04-timeline");

await page.locator(".nav-item").filter({ hasText: "设置" }).click();
await page.waitForTimeout(600);
await shot("05-settings");
await page.locator(".page-scroll").evaluate((node) => {
  node.scrollTop = node.scrollHeight;
});
await page.waitForTimeout(400);
await shot("06-settings-bottom");

await page.setViewportSize({ width: 390, height: 844 });
await page.locator(".nav-item").filter({ hasText: "收件箱" }).click();
await page.waitForTimeout(500);
const narrow = await page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}));
console.log("NARROW", JSON.stringify(narrow));
await shot("07-narrow-inbox");

console.log("ERRORS", JSON.stringify(errors.slice(0, 12)));
await browser.close();
