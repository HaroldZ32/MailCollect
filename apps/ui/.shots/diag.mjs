import { chromium } from "playwright";
const base = process.env.SHOT_BASE || "http://localhost:4173";
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const logs = [];
page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
page.on("pageerror", (e) => logs.push(`pageerror: ${e.stack ?? e.message}`));
await page.goto(base, { waitUntil: "networkidle" });
await page.locator(".nav-item").filter({ hasText: "时间线" }).click();
await page.waitForTimeout(6000);
const info = await page.evaluate(() => {
  const host = document.querySelector(".gantt-host");
  const canvas = document.querySelector(".gantt-canvas");
  const card = document.querySelector(".timeline-card");
  const pageEl = document.querySelector(".page");
  const scroll = document.querySelector(".page-scroll");
  return {
    bodyText: document.body.innerText.slice(0, 500),
    hasGanttContainer: Boolean(document.querySelector(".gantt_container")),
    hostRect: host?.getBoundingClientRect().toJSON() ?? null,
    canvasRect: canvas?.getBoundingClientRect().toJSON() ?? null,
    cardRect: card?.getBoundingClientRect().toJSON() ?? null,
    pageRect: pageEl?.getBoundingClientRect().toJSON() ?? null,
    scrollRect: scroll?.getBoundingClientRect().toJSON() ?? null,
    canvasHtml: canvas?.innerHTML.slice(0, 1200) ?? null,
    taskLines: document.querySelectorAll(".gantt_task_line").length,
    rows: document.querySelectorAll(".gantt_row").length,
  };
});
console.log(JSON.stringify(info, null, 2));
console.log("LOGS", JSON.stringify(logs.slice(0, 20), null, 2));
await page.screenshot({ path: "apps/ui/.shots/diag-timeline.png" });
await browser.close();
