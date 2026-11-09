/**
 * T66 证据：修 T31 的两条 Medium。
 *  A 完成后再重开向导 → 必须回到三步向导的第一步（同会话、不刷新页面）
 *  B 向导写入后 → 侧栏/设置页立刻一致（无「未设置档案」「还缺：用户档案」）
 *
 * 前置（与 capture.mjs 相同的空数据目录启动方式）：
 *   MAILCOLLECT_PORT=8787 MAILCOLLECT_TOKEN=dev-local-token \
 *   MAILCOLLECT_DATA_DIR=$(mktemp -d) node node_modules/tsx/dist/cli.mjs apps/server/src/main.ts &
 *   (cd apps/ui && npx vite --host 127.0.0.1 --port 5173 --strictPort) &
 * 运行：HOME=<可写目录> SHOT_CHANNEL=msedge node evidence/ui/onboarding/capture-t66.mjs
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.env.SHOT_BASE || "http://127.0.0.1:5173";
const token = process.env.SHOT_TOKEN || "dev-local-token";
const dir = process.env.SHOT_DIR || "evidence/ui/onboarding";
mkdirSync(dir, { recursive: true });

const findings = [];
const errors = [];
const check = (name, ok, detail) => {
  findings.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` :: ${detail}`}`);
};

// 干净起点：未完成、未跳过（服务端状态）
const reset = await fetch(`${base}/api/onboarding`, {
  method: "PUT",
  headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ completed: false, skipped: false }),
});
check("复位初始化状态", reset.status === 200, `HTTP ${reset.status}`);

const browser = await chromium.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  ...(process.env.SHOT_CHANNEL === undefined ? {} : { channel: process.env.SHOT_CHANNEL }),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1.5 });
const page = await context.newPage();
let navigations = 0;
page.on("framenavigated", (frame) => {
  if (frame === page.mainFrame()) navigations += 1;
});
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const source = message.location()?.url ?? "";
  if (source.includes("favicon")) return;
  errors.push(`console: ${message.text()} @ ${source}`);
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

const shot = async (name) => {
  await page.screenshot({ path: `${dir}/${name}.png` });
  console.log(`SHOT ${dir}/${name}.png`);
};
const sidebarText = () => page.locator(".sidebar").innerText();
const bodyText = () => page.evaluate(() => document.body.innerText);

await page.goto(`${base}/`, { waitUntil: "networkidle" });
await page.waitForSelector('[data-testid="onboarding-wizard"]', { timeout: 15000 });

/* --------------------------- 走完三步（档案 + 两次跳过） --------------------------- */
await page.fill("#wizard-name", "李四");
await page.fill('input[aria-label="新增邮箱"]', "lisi@corp.example");
await page.press('input[aria-label="新增邮箱"]', "Enter");
await page.click('button:has-text("保存并继续")');
await page.waitForTimeout(1200);
await page.click('button:has-text("跳过这一步")');
await page.waitForTimeout(400);
await page.click('button:has-text("跳过这一步")');
await page.waitForSelector("text=初始化完成", { timeout: 15000 });
await page.click('button:has-text("进入收件箱")');
await page.waitForTimeout(1500);

/* ------------------------------ B：壳层/侧栏立刻一致 ------------------------------ */
const sideA = await sidebarText();
check("B 完成后侧栏不再显示「未设置档案」", !sideA.includes("未设置档案"), sideA.split("\n").slice(-3).join(" | "));
check("B 完成后侧栏显示新档案名", sideA.includes("李四"));
check("B 完成后侧栏「未配置」不再含档案", !/未配置：[^\n]*档案/.test(sideA), sideA.split("\n").find((line) => line.includes("未配置")) ?? "无未配置行");
await shot("t66-01-after-complete-sidebar");

await page.click('.nav-item:has-text("设置")');
await page.waitForTimeout(1000);
const settingsA = await bodyText();
const missingLine = settingsA.split("\n").find((line) => line.includes("还缺：")) ?? "";
check("B 设置页未配置提示不再含用户档案", missingLine !== "" && !missingLine.includes("用户档案"), missingLine);
check("B 设置页旧 profile 卡已显示新名字", settingsA.includes("李四"));
check("B 设置页初始化状态已完成", settingsA.includes("已完成"));
await shot("t66-02-settings-consistent");

/* ----------------------- A：设置页重开向导 → 回到第 1/3 步 ----------------------- */
await page.click('button:has-text("重新打开初始化向导")');
await page.waitForSelector('[data-testid="onboarding-wizard"]', { timeout: 10000 });
await page.waitForTimeout(600);
const reopenText = await bodyText();
check("A 设置页重开 → 显示第 1 / 3 步", reopenText.includes("第 1 / 3 步"), reopenText.split("\n")[0]);
check("A 重开后不再停在「初始化完成」终结页", !reopenText.includes("种子规则只在首次初始化时创建一次"));
await shot("t66-03-reopen-step1-from-settings");

/* -------------------- A：侧栏「初始化」重开 → 同样回到第 1/3 步 -------------------- */
await page.click('.dialog-backdrop button[aria-label="退出向导"]');
await page.waitForTimeout(800);
await page.click('.nav-item:has-text("初始化")');
await page.waitForSelector('[data-testid="onboarding-wizard"]', { timeout: 10000 });
await page.waitForTimeout(600);
const reopenSidebar = await bodyText();
check("A 侧栏重开 → 显示第 1 / 3 步", reopenSidebar.includes("第 1 / 3 步"));
await shot("t66-04-reopen-step1-from-sidebar");

/* --------------------- 中途退出再进不丢输入（重置只在结束页生效） --------------------- */
// 向导是全屏 modal，侧栏在浮层下不可点：模拟用户先「退出向导」再点侧栏「初始化」。
await page.fill("#wizard-name", "王五");
await page.click('.dialog-backdrop button[aria-label="退出向导"]');
await page.waitForTimeout(800);
await page.click('.nav-item:has-text("初始化")');
await page.waitForSelector('[data-testid="onboarding-wizard"]', { timeout: 10000 });
await page.waitForTimeout(800);
const midRunName = await page.inputValue("#wizard-name");
check("A 未完成时切面板回来保留输入（不被重置）", midRunName === "王五", midRunName);

check("全程未发生页面级跳转（同会话验证）", navigations === 1, `navigations=${navigations}`);

await browser.close();

const failed = findings.filter((finding) => !finding.ok).length;
console.log(`\nSUMMARY checks=${findings.length} failed=${failed} consoleErrors=${errors.length} navigations=${navigations}`);
for (const error of errors.slice(0, 8)) console.log(`  ${error}`);
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
