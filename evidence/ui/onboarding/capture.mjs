/**
 * T31 证据采集：初始化向导的「完成 / 跳过 / 重开」三条路径 + 设置页发信字段。
 *
 * 前置（本脚本不负责起服务）：
 *   MAILCOLLECT_PORT=8787 MAILCOLLECT_TOKEN=dev-local-token \
 *   MAILCOLLECT_DATA_DIR=$(mktemp -d) node node_modules/tsx/dist/cli.mjs apps/server/src/main.ts
 *   (cd apps/ui && npx vite --host 127.0.0.1 --port 5173 --strictPort)
 * 运行：
 *   node evidence/ui/onboarding/capture.mjs
 *
 * 输出：evidence/ui/onboarding/*.png + 控制台断言；任一 console/pageerror 非零退出。
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.env.SHOT_BASE || "http://127.0.0.1:5173";
const token = process.env.SHOT_TOKEN || "dev-local-token";
const dir = process.env.SHOT_DIR || "evidence/ui/onboarding";
mkdirSync(dir, { recursive: true });

const errors = [];
const benign = [];
const findings = [];

const api = (path, init = {}) =>
  fetch(`${base}/api${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });

const check = (name, ok, detail) => {
  findings.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` :: ${detail}`}`);
  return ok;
};

// 默认用 Playwright 自带 Chromium；本机 HOME 只读、内置 Chromium 未安装，
// 可用 SHOT_CHANNEL=msedge 指定系统 Edge（同为 Chromium 内核）。
const browser = await chromium.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  ...(process.env.SHOT_CHANNEL === undefined ? {} : { channel: process.env.SHOT_CHANNEL }),
});
const viewport = { width: 1440, height: 960 };

const newPage = async (context) => {
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // index.html 没有声明 favicon，Chromium 会自动请求 /favicon.ico 并得到 404；
    // 这是浏览器行为而不是应用错误（index.html 不在本任务写域内）。
    const location = message.location();
    const source = location === undefined ? "" : (location.url ?? "");
    if (message.text().includes("favicon") || source.includes("favicon")) {
      benign.push(`${message.text()} @ ${source}`);
      return;
    }
    errors.push(`console: ${message.text()} @ ${source}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  return page;
};

const shot = async (page, name) => {
  await page.screenshot({ path: `${dir}/${name}.png` });
  console.log(`SHOT ${dir}/${name}.png`);
};

const resetOnboarding = async () => {
  const res = await api("/onboarding", {
    method: "PUT",
    body: JSON.stringify({ completed: false, skipped: false }),
  });
  return res.json();
};

/* ------------------------- 路径 A：完整走完三步并完成 ------------------------- */

await resetOnboarding();

const ctxA = await browser.newContext({ viewport, deviceScaleFactor: 1.5 });
const pageA = await newPage(ctxA);
await pageA.goto(`${base}/`, { waitUntil: "networkidle" });

const autoOpened = await pageA
  .waitForSelector('[data-testid="onboarding-wizard"]', { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
check("AC-01 首次启动自动全屏向导", autoOpened);
await shot(pageA, "01-complete-step1-autofullscreen");

await pageA.fill("#wizard-name", "张三");
await pageA.fill('input[aria-label="新增邮箱"]', "zhangsan@corp.example");
await pageA.press('input[aria-label="新增邮箱"]', "Enter");
await pageA.click('button:has-text("保存并继续")');
await pageA.waitForTimeout(1200);
await shot(pageA, "02-complete-step2-account");

await pageA.click('button:has-text("跳过这一步")');
await pageA.waitForTimeout(400);
await shot(pageA, "03-complete-step3-llm");

// 第③步「跳过这一步」= 完成：写 completed 标记并进入种子规则页。
await pageA.click('button:has-text("跳过这一步")');
const seedScreen = await pageA
  .waitForSelector("text=初始化完成", { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
check("AC-03 完成后进入种子规则页", seedScreen);
await pageA.waitForTimeout(800);
await shot(pageA, "04-complete-seed-rules");

const seedNames = await pageA.$$eval(".task-title", (nodes) => nodes.map((node) => node.textContent ?? ""));
check(
  "AC-03 种子规则两条（点名给我 / 群发通知）",
  seedNames.length === 2 &&
    seedNames.includes("点名给我") &&
    seedNames.some((name) => name.replace("/", "") === "群发通知"),
  JSON.stringify(seedNames),
);

const confirmButtons = await pageA.locator('button:has-text("确认保留")').count();
for (let index = 0; index < confirmButtons; index += 1) {
  await pageA.locator('button:has-text("确认保留")').nth(index).click();
}
await shot(pageA, "05-complete-seeds-confirmed");

await pageA.click('button:has-text("进入收件箱")');
await pageA.waitForTimeout(1200);
await shot(pageA, "06-complete-inbox");

const stateA = await (await api("/onboarding")).json();
check("AC-01 完成标记持久化", stateA.completed === true, JSON.stringify(stateA));

const rulesA = await (await api("/rules")).json();
const seedRuleIds = rulesA.items.map((item) => item.id).filter((id) => id.startsWith("seed-rule-"));
check("AC-03 API 返回两条种子规则", seedRuleIds.length === 2, JSON.stringify(seedRuleIds));

// 设置页：已完成状态 + 旧 profile 只读卡 + 重开入口
await pageA.click('.nav-item:has-text("设置")');
await pageA.waitForTimeout(1000);
await shot(pageA, "07-complete-settings");
const settingsText = await pageA.evaluate(() => document.body.innerText);
check(
  "C3 设置页展示「重新打开初始化向导」入口",
  settingsText.includes("重新打开初始化向导"),
);
check("C3 设置页展示已完成状态", settingsText.includes("已完成"));
check("C3 设置页旧 profile 只读卡", settingsText.includes("旧 profile（只读）"));
check(
  "C3 设置页展示未配置联动（LLM 未配置）",
  settingsText.includes("LLM 供应商") && settingsText.includes("还缺："),
);

// 账号表单：Exchange（EWS）与发信字段
// InboxPage 的空态里也有一个「设置页添加账号」按钮（keep-alive 面板，隐藏但存在），
// 只点当前可见的那个，避免命中隐藏元素。
await pageA.locator('button:has-text("添加账号"):visible').first().click();
await pageA.waitForTimeout(300);
await pageA.selectOption("#account-provider", "ews");
await pageA.waitForTimeout(300);
await shot(pageA, "08-settings-ews-send-fields");
const formText = await pageA.evaluate(() => document.body.innerText);
check("C4 账号表单提供 EWS 端点与认证方式", formText.includes("EWS 端点") && formText.includes("认证方式"));
check("C5 账号表单提供 SMTP 发信字段", formText.includes("SMTP 服务器") && formText.includes("SMTP 密码"));

// IMAP/POP3 的收信字段（服务器/端口/用户名/密码）必须仍在表单里；
// EWS 只显示 ewsUrl，不显示空的端口输入。
await pageA.selectOption("#account-provider", "imap");
await pageA.waitForTimeout(300);
await shot(pageA, "08b-settings-imap-receive-fields");
const imapForm = await pageA.evaluate(() => document.body.innerText);
check(
  "收信字段仍在 IMAP 表单（服务器/端口/用户名/密码）",
  ["服务器", "端口", "用户名", "密码 / 应用专用密码"].every((label) => imapForm.includes(label)),
);
await pageA.selectOption("#account-provider", "ews");
await pageA.waitForTimeout(300);
const ewsFormHasPort = await pageA.evaluate(() => document.querySelector("#account-port") !== null);
check("EWS 不渲染空的端口输入（改显示 EWS 端点）", ewsFormHasPort === false);

const passwordInputs = await pageA.$$eval('input[type="password"]', (nodes) =>
  nodes.map((node) => ({ id: node.id, value: node.value })),
);
check(
  "C2 密码类输入框类型为 password 且不回显",
  passwordInputs.every((node) => node.value === ""),
  JSON.stringify(passwordInputs.map((node) => node.id)),
);

await ctxA.close();

/* --------------------------- 路径 B：全部跳过进入收件箱 --------------------------- */

await resetOnboarding();

const ctxB = await browser.newContext({ viewport, deviceScaleFactor: 1.5 });
const pageB = await newPage(ctxB);
await pageB.goto(`${base}/`, { waitUntil: "networkidle" });
const autoOpenedB = await pageB
  .waitForSelector('[data-testid="onboarding-wizard"]', { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
check("AC-01 重置后再次自动全屏（新会话）", autoOpenedB);

await pageB.click('button:has-text("跳过全部")');
await pageB.waitForTimeout(1500);
const skipText = await pageB.evaluate(() => document.body.innerText);
check("AC-02 全部跳过后 body 非空", skipText.trim().length > 0);
check("AC-02 跳过后不再显示全屏向导", !skipText.includes("第 1 / 3 步"));
check("AC-02 侧栏出现未配置提示", skipText.includes("未配置："));
await shot(pageB, "09-skip-inbox");

const stateB = await (await api("/onboarding")).json();
check("AC-01 跳过标记持久化", stateB.skipped === true, JSON.stringify(stateB));

// 刷新页面：已跳过 → 不再自动全屏（AC-01）
await pageB.reload({ waitUntil: "networkidle" });
await pageB.waitForTimeout(1500);
const afterReload = await pageB.evaluate(() => document.body.innerText);
check("AC-01 重启（刷新）后不再自动全屏", !afterReload.includes("第 1 / 3 步"));
await shot(pageB, "10-skip-reload-no-fullscreen");

/* ------------------------- 路径 C：从设置页重新打开向导 ------------------------- */

await pageB.click('.nav-item:has-text("设置")');
await pageB.waitForTimeout(1000);
await shot(pageB, "11-reopen-settings-before");
await pageB.click('button:has-text("重新打开初始化向导")');
const reopened = await pageB
  .waitForSelector('[data-testid="onboarding-wizard"]', { timeout: 10000 })
  .then(() => true)
  .catch(() => false);
check("C3 设置页可重新打开向导", reopened);
await pageB.waitForTimeout(600);
await shot(pageB, "12-reopen-wizard");

await ctxB.close();
await browser.close();

/* ---------------------------------- 汇总 ---------------------------------- */

const failed = findings.filter((finding) => !finding.ok);
console.log(
  `\nSUMMARY checks=${findings.length} failed=${failed.length} consoleErrors=${errors.length} benignFavicon404=${benign.length}`,
);
for (const error of errors.slice(0, 10)) console.log(`  ${error}`);
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
