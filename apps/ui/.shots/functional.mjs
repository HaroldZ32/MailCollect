import { chromium } from "playwright";

const base = process.env.SHOT_BASE || "http://localhost:4173";
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

const results = [];
const check = (name, ok, detail) => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` :: ${detail}`}`);
};

const nav = async (label) => {
  await page.locator(".nav-item").filter({ hasText: label }).click();
  await page.waitForTimeout(500);
};

await page.goto(base, { waitUntil: "networkidle" });
await page.getByText("演示数据").first().waitFor({ timeout: 15000 });

// ---- inbox: detail + search + account filter
const mailCount = await page.locator(".mail-item").count();
check("收件箱列出 8 封邮件", mailCount === 8, `count=${mailCount}`);
await page.locator(".mail-item").first().click();
await page.locator(".mail-body").waitFor({ timeout: 5000 });
const body = await page.locator(".mail-body").innerText();
check("点击邮件显示正文", body.includes("Q4"), `len=${body.length}`);

await page.locator(".search input").fill("GitHub");
await page.waitForTimeout(400);
const filtered = await page.locator(".mail-item").count();
check("搜索 GitHub 命中 1 封", filtered === 1, `count=${filtered}`);
await page.locator(".search input").fill("");
await page.waitForTimeout(300);
await page.locator(".filter-chip").filter({ hasText: "Outlook 个人号" }).click();
await page.waitForTimeout(400);
const accountFiltered = await page.locator(".mail-item").count();
check("账号筛选 Outlook 命中 2 封", accountFiltered === 2, `count=${accountFiltered}`);
await page.locator(".filter-chip").filter({ hasText: "全部账号" }).click();

// ---- tasks: broadcast decision
await nav("待办");
const broadcastBefore = await page.locator(".broadcast-card").count();
const confirmedBefore = await page.locator(".section-head .chip--accent").first().innerText();
await page.locator(".broadcast-card").first().locator("button", { hasText: "加入待办" }).click();
await page.waitForTimeout(700);
const broadcastAfter = await page.locator(".broadcast-card").count();
const confirmedAfter = await page.locator(".section-head .chip--accent").first().innerText();
check(
  "群发卡片点加入待办后消失",
  broadcastBefore === 2 && broadcastAfter === 1,
  `${broadcastBefore} -> ${broadcastAfter}`,
);
check("已确认数量 +1", confirmedBefore !== confirmedAfter, `${confirmedBefore} -> ${confirmedAfter}`);

// ---- timeline: drag + resize + zoom
await nav("时间线");
await page.locator(".gantt_task_line").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(800);

const gridText = async () => (await page.locator(".gantt_grid_data").innerText()).replace(/\s+/g, " ");
const rowText = async (index) => (await page.locator(".gantt_grid_data .gantt_row").nth(index).innerText()).replace(/\s+/g, " ");

const beforeRow = await rowText(2);
const firstWindow = page.locator(".gantt_task_line.mc-bar--window").first();
const box = await firstWindow.boundingBox();
check("时间线存在窗口条", box !== null, box === null ? "none" : `w=${Math.round(box.width)}`);
if (box !== null) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 70, cy, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const afterRow = await rowText(2);
  check("拖拽窗口条改期", beforeRow !== afterRow, `${beforeRow} -> ${afterRow}`);
  const moved = await page.locator(".gantt_task_line.mc-bar--window").first().boundingBox();
  check("拖拽后条位置右移", moved !== null && moved.x > box.x + 30, moved === null ? "none" : `${Math.round(box.x)} -> ${Math.round(moved.x)}`);
}

const target = page.locator(".gantt_task_line.mc-bar--window").first();
const beforeResize = await rowText(2);
const resizeBox = await target.boundingBox();
if (resizeBox !== null) {
  const edgeX = resizeBox.x + resizeBox.width - 2;
  const edgeY = resizeBox.y + resizeBox.height / 2;
  await page.mouse.move(edgeX, edgeY);
  await page.mouse.down();
  await page.mouse.move(edgeX + 60, edgeY, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(900);
  const afterResize = await rowText(2);
  const widened = await target.boundingBox();
  check(
    "拖右手柄改时长",
    afterResize !== beforeResize,
    `${beforeResize} -> ${afterResize} w=${widened === null ? "?" : Math.round(widened.width)}`,
  );
}

const todayVisibleBefore = await page.locator(".gantt-today-line").isVisible();
await page.locator(".segmented button", { hasText: "月" }).click();
await page.waitForTimeout(700);
const monthCells = await page.locator(".gantt_scale_line").last().locator(".gantt_scale_cell").allInnerTexts();
const todayVisibleMonth = await page.locator(".gantt-today-line").isVisible();
check("切换到月视图", monthCells.some((text) => text.includes("11月")), monthCells.join(","));
check("今日线在月视图仍可见", todayVisibleBefore && todayVisibleMonth, `${todayVisibleBefore}/${todayVisibleMonth}`);
await page.locator(".segmented button", { hasText: "日" }).click();
await page.waitForTimeout(700);
const dayCells = await page.locator(".gantt_scale_line").last().locator(".gantt_scale_cell").allInnerTexts();
check("切换到日视图", dayCells.length >= 10, `cells=${dayCells.length}`);
await page.locator(".segmented button", { hasText: "周" }).click();
await page.waitForTimeout(500);
const duePins = await page.locator(".gantt-due-pin").evaluateAll((nodes) =>
  nodes.filter((node) => getComputedStyle(node).display !== "none").length,
);
check("到期点可见", duePins === 4, `pins=${duePins}`);

// ---- settings
await nav("设置");
const beforeLlmRows = await page.locator(".llm-list .account-row").count();
await page.locator(".preset").filter({ hasText: "Ollama 本地" }).click();
const baseUrlValue = await page.locator("#llm-base").inputValue();
check("预设回填 baseURL", baseUrlValue.includes("11434"), baseUrlValue);
await page.locator("button", { hasText: "保存供应商" }).click();
await page.waitForTimeout(700);
const afterLlmRows = await page.locator(".llm-list .account-row").count();
check("保存供应商后列表 +1", afterLlmRows === beforeLlmRows + 1, `${beforeLlmRows} -> ${afterLlmRows}`);
await page.locator("button", { hasText: "测试连接" }).click();
await page.waitForTimeout(900);
const testText = await page.locator(".test-result").last().innerText();
check("测试连接给出结果", testText.includes("演示数据") || testText.includes("连接"), testText.slice(0, 60));

const beforeAccounts = await page.locator(".account-list .account-row").count();
await page.locator("button", { hasText: "添加账号" }).click();
await page.locator("#account-email").fill("demo@example.com");
await page.locator("#account-label").fill("演示账号");
await page.locator("#account-host").fill("imap.example.com");
await page.locator("#account-secret").fill("not-a-real-secret");
await page.locator("button", { hasText: "保存账号" }).click();
await page.waitForTimeout(700);
const afterAccounts = await page.locator(".account-list .account-row").count();
check("添加账号后列表 +1", afterAccounts === beforeAccounts + 1, `${beforeAccounts} -> ${afterAccounts}`);

const nameValue = await page.locator("#profile-name").inputValue();
check("档案回填姓名", nameValue === "张三", nameValue);

// ---- narrow reflow
await page.setViewportSize({ width: 390, height: 844 });
await nav("收件箱");
const narrow = await page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
}));
check("390px 无横向滚动", narrow.scrollWidth <= narrow.clientWidth, JSON.stringify(narrow));

console.log(results.join("\n"));
console.log("ERRORS", JSON.stringify(errors.filter((e) => !e.includes("502")).slice(0, 10)));
console.log("RESULT", results.every((line) => line.startsWith("PASS")) ? "ALL_PASS" : "HAS_FAIL");
await browser.close();
