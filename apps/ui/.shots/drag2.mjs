import { chromium } from "playwright";
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
await page.goto("http://localhost:4173", { waitUntil: "networkidle" });
await page.getByText("演示数据").first().waitFor({ timeout: 15000 });
await page.locator(".nav-item").filter({ hasText: "时间线" }).click();
await page.locator(".gantt_task_line").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(900);

const TITLE = "确定合同评审会时间";
const row = () => page.locator(".gantt_grid_data .gantt_row").filter({ hasText: TITLE }).first();
const rowText = async () => (await row().innerText()).replace(/\s+/g, " ");
const bar = async () => {
  const index = await page.locator(".gantt_grid_data .gantt_row").evaluateAll((nodes, needle) => nodes.findIndex((n) => (n.textContent ?? "").includes(needle)), TITLE);
  return page.locator(".gantt_task_line").nth(index);
};

const before = await rowText();
const box = await (await bar()).boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2, { steps: 15 });
await page.mouse.up();
await page.waitForTimeout(900);
const afterMove = await rowText();
const movedBox = await (await bar()).boundingBox();
console.log("MOVE", JSON.stringify({ before, afterMove, dx: Math.round(movedBox.x - box.x), w: Math.round(movedBox.width) }));

// hover the right edge, then resize
const edge = await (await bar()).boundingBox();
await page.mouse.move(edge.x + edge.width - 4, edge.y + edge.height / 2);
await page.waitForTimeout(250);
const dragHandles = await page.locator(".gantt_task_drag").count();
await page.mouse.down();
await page.mouse.move(edge.x + edge.width - 4 + 70, edge.y + edge.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(900);
const afterResize = await rowText();
const resizedBox = await (await bar()).boundingBox();
console.log("RESIZE", JSON.stringify({ afterResize, handles: dragHandles, wBefore: Math.round(edge.width), wAfter: Math.round(resizedBox.width) }));
console.log("ERRORS", JSON.stringify(errors));
await browser.close();
