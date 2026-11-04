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

const rowIndexOf = async (title) =>
  page.locator(".gantt_grid_data .gantt_row").evaluateAll((nodes, needle) => nodes.findIndex((node) => (node.textContent ?? "").includes(needle)), title);
const rowTextOf = async (title) => {
  const row = page.locator(".gantt_grid_data .gantt_row").filter({ hasText: title }).first();
  return (await row.innerText()).replace(/\s+/g, " ");
};
const barOf = async (title) => {
  const index = await rowIndexOf(title);
  return { index, bar: page.locator(".gantt_task_line").nth(index) };
};

const TITLE = "确定合同评审会时间";
const before = await rowTextOf(TITLE);
const { bar } = await barOf(TITLE);
const box = await bar.boundingBox();
console.log("BEFORE", JSON.stringify({ before, index: await rowIndexOf(TITLE), box }));

const cx = box.x + box.width / 2;
const cy = box.y + box.height / 2;
await page.mouse.move(cx, cy);
await page.mouse.down();
await page.mouse.move(cx + 80, cy, { steps: 15 });
await page.mouse.up();
await page.waitForTimeout(1000);
const after = await rowTextOf(TITLE);
const afterIndex = await rowIndexOf(TITLE);
const afterBox = await (await barOf(TITLE)).bar.boundingBox();
console.log("AFTER_MOVE", JSON.stringify({ after, index: afterIndex, box: afterBox }));

// resize right edge
const target = (await barOf(TITLE)).bar;
const resizeBox = await target.boundingBox();
const edgeX = resizeBox.x + resizeBox.width - 2;
const edgeY = resizeBox.y + resizeBox.height / 2;
await page.mouse.move(edgeX, edgeY);
await page.mouse.down();
await page.mouse.move(edgeX + 70, edgeY, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(1000);
const afterResize = await rowTextOf(TITLE);
const afterResizeBox = await (await barOf(TITLE)).bar.boundingBox();
console.log("AFTER_RESIZE", JSON.stringify({ afterResize, widthBefore: resizeBox.width, widthAfter: afterResizeBox?.width }));
console.log("ERRORS", JSON.stringify(errors));
await browser.close();
