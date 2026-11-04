import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto("http://localhost:4173", { waitUntil: "networkidle" });
await page.getByText("演示数据").first().waitFor({ timeout: 15000 });
await page.locator(".nav-item").filter({ hasText: "时间线" }).click();
await page.locator(".gantt_task_line").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(900);
const bar = page.locator(".gantt_task_line.mc-bar--window").first();
const box = await bar.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.waitForTimeout(400);
const hover = await page.evaluate(() => {
  const line = document.querySelector(".gantt_task_line.mc-bar--window");
  const handles = [...(line?.querySelectorAll(".gantt_task_drag") ?? [])].map((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { cls: el.className, display: style.display, x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  });
  return { handles, cls: line?.className };
});
console.log("HOVER", JSON.stringify(hover, null, 2));
const right = hover.handles.find((h) => h.cls.includes("task_right"));
if (right && right.w > 0) {
  const hx = right.x + right.w / 2;
  const hy = right.y + right.h / 2;
  const before = await page.locator(".gantt_grid_data .gantt_row").filter({ hasText: "确定合同评审会时间" }).first().innerText();
  await page.mouse.move(hx, hy);
  await page.waitForTimeout(150);
  await page.mouse.down();
  await page.mouse.move(hx + 70, hy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const after = await page.locator(".gantt_grid_data .gantt_row").filter({ hasText: "确定合同评审会时间" }).first().innerText();
  const box2 = await page.locator(".gantt_task_line.mc-bar--window").first().boundingBox();
  console.log("RESIZE_RESULT", JSON.stringify({ before: before.replace(/\s+/g, " "), after: after.replace(/\s+/g, " "), wBefore: box.width, wAfter: box2?.width }));
} else {
  console.log("NO_VISIBLE_HANDLE");
}
await browser.close();
