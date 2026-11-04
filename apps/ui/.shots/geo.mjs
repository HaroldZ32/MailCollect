import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto("http://localhost:4173", { waitUntil: "networkidle" });
await page.locator(".nav-item").filter({ hasText: "时间线" }).click();
await page.locator(".gantt_task_line").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(1200);
const info = await page.evaluate(() => {
  const rect = (el) => el?.getBoundingClientRect().toJSON() ?? null;
  const lines = [...document.querySelectorAll(".gantt_scale_line")].map((line) => ({
    cells: [...line.children].map((cell) => ({ text: cell.textContent, ...rect(cell) })),
  }));
  return {
    canvas: rect(document.querySelector(".gantt-canvas")),
    dataArea: rect(document.querySelector(".gantt_data_area")),
    taskArea: rect(document.querySelector(".gantt_task")),
    scaleArea: rect(document.querySelector(".gantt_task_scale")),
    grid: rect(document.querySelector(".gantt_grid")),
    scaleLines: lines,
    bars: [...document.querySelectorAll(".gantt_task_line")].map((bar) => ({
      cls: bar.className,
      inline: bar.getAttribute("style"),
      ...rect(bar),
    })),
    pins: [...document.querySelectorAll(".gantt-due-pin")].map((pin) => ({
      id: pin.getAttribute("data-due-id"),
      inline: pin.getAttribute("style"),
      ...rect(pin),
    })),
    today: (() => {
      const line = document.querySelector(".gantt-today-line");
      return { inline: line?.getAttribute("style") ?? null, ...rect(line) };
    })(),
    todayExpected: (() => {
      const cells = [...document.querySelectorAll(".gantt_scale_line")].at(-1)?.children ?? [];
      const target = [...cells].find((cell) => cell.textContent === "11-02");
      if (!target) return null;
      const r = target.getBoundingClientRect();
      return { left: r.left + (2 / 7) * r.width, width: r.width, cellLeft: r.left };
    })(),
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
