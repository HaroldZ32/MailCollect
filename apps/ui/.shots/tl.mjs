import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 700 } });
await page.goto("http://localhost:4173", { waitUntil: "networkidle" });
await page.getByText("演示数据").first().waitFor({ timeout: 15000 });
await page.locator(".nav-item").filter({ hasText: "时间线" }).click();
await page.locator(".gantt_task_line").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(1200);
await page.screenshot({ path: "apps/ui/.shots/08-timeline-final.png" });
const check = await page.evaluate(() => {
  const dueBar = document.querySelector(".gantt_task_line.mc-bar--due");
  const dot = document.querySelector(".gantt-due-pin-dot");
  const style = dueBar ? getComputedStyle(dueBar) : null;
  const dotStyle = dot ? getComputedStyle(dot) : null;
  return {
    dueBar: dueBar ? { h: dueBar.getBoundingClientRect().height, border: style.borderStyle, shadow: style.boxShadow } : null,
    dot: dot ? { w: dot.getBoundingClientRect().width, border: dotStyle.borderTopWidth, shadow: dotStyle.boxShadow } : null,
  };
});
console.log("STYLE_CHECK", JSON.stringify(check));
await browser.close();
