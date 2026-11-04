import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto("http://localhost:4173", { waitUntil: "networkidle" });
await page.getByText("演示数据").first().waitFor({ timeout: 15000 });
await page.locator(".nav-item").filter({ hasText: "时间线" }).click();
await page.locator(".gantt_task_line").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(900);
const info = await page.evaluate(() => {
  const handles = [...document.querySelectorAll(".gantt_task_drag")].slice(0, 4).map((el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      cls: el.className,
      rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height },
      display: style.display,
      position: style.position,
      width: style.width,
      cursor: style.cursor,
      pointerEvents: style.pointerEvents,
      zIndex: style.zIndex,
    };
  });
  const bars = [...document.querySelectorAll(".gantt_task_line")].slice(0, 2).map((el) => {
    const rect = el.getBoundingClientRect();
    return { cls: el.className, x: rect.x, w: rect.width, html: el.innerHTML.slice(0, 300) };
  });
  return { handles, bars };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
