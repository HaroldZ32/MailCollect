import { chromium } from "playwright";

const BASE = process.env.SHOT_BASE || "http://localhost:4173";
const STUB = "http://127.0.0.1:8787";
const TOKEN = "sse-test-token";
const dir = "apps/ui/.shots";

const results = [];
const check = (name, ok, detail) => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` :: ${detail}`}`);
};
const stats = () => fetch(`${STUB}/control/stats`).then((response) => response.json());
const emit = (type, data) =>
  fetch(`${STUB}/control/emit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, data }),
  }).then((response) => response.json());

const newTask = {
  id: "sse-task-2",
  userId: "user-stub",
  title: "SSE 推送的新任务",
  detail: null,
  owner: "me",
  ownerName: "张三",
  kind: "action",
  status: "confirmed",
  origin: "personal",
  confidence: 0.88,
  evidenceQuote: "来自 SSE 推送",
  sourceEmailId: "sse-mail-1",
  threadId: null,
  time: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await context.addInitScript((token) => {
  window.localStorage.setItem("mailcollect.token", token);
}, TOKEN);
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
const eventRequests = [];
const emailRequests = [];
page.on("console", (message) => consoleMessages.push(`${message.type()}: ${message.text()}`));
page.on("pageerror", (error) => pageErrors.push(error.message));
page.on("request", (request) => {
  if (request.url().includes("/api/events")) eventRequests.push(request.url());
  if (request.url().includes("/api/emails")) emailRequests.push(request.url());
});

await page.goto(BASE, { waitUntil: "networkidle" });
await page.getByText("已连接服务").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(900);
const initialStats = await stats();
check("实时事件流已建立", initialStats.connections >= 1, JSON.stringify(initialStats));
check("收件箱加载桩数据", (await page.locator(".mail-item").count()) === 1, `items=${await page.locator(".mail-item").count()}`);

await page.locator(".nav-item").filter({ hasText: "待办" }).click();
await page.waitForTimeout(400);

await emit("task", newTask);
await page.waitForTimeout(500);
check("task 事件插入新任务", (await page.locator(".task-title").filter({ hasText: "SSE 推送的新任务" }).count()) === 1);
await page.screenshot({ path: `${dir}/09-sse-task.png` });

await emit("task", { ...newTask, title: "SSE 推送后已更新", status: "done" });
await page.waitForTimeout(500);
const updatedCount = await page.locator(".task-title").filter({ hasText: "SSE 推送后已更新" }).count();
const oldCount = await page.locator(".task-title").filter({ hasText: "SSE 推送的新任务" }).count();
check("task 事件就地更新任务", updatedCount === 1 && oldCount === 0, `new=${updatedCount} old=${oldCount}`);
const doneStat = await page.locator(".stat").filter({ hasText: "已完成" }).locator(".stat-num").innerText();
check("task 事件驱动统计更新", doneStat === "1", `已完成=${doneStat}`);

await emit("extract", { done: 3, total: 10 });
await page.waitForTimeout(400);
check(
  "extract 事件显示抽取进度",
  (await page.locator(".live-chip").filter({ hasText: "抽取 3/10" }).count()) === 1,
);

await emit("sync", { accountId: "acc-1", phase: "fetch", fetched: 5, stored: 3 });
await page.waitForTimeout(400);
check(
  "sync 事件显示同步进度",
  (await page.locator(".live-chip").filter({ hasText: "同步 · 拉取中 3/5" }).count()) === 1,
);

await emit("error", { message: "桩服务：上游超时" });
await page.waitForTimeout(400);
const banner = page.locator(".stream-banner");
check(
  "error 事件出现可关闭错误条",
  (await banner.count()) === 1 && (await banner.innerText()).includes("上游超时"),
);
await page.screenshot({ path: `${dir}/10-sse-error.png` });
await page.locator(".stream-banner-close").click();
await page.waitForTimeout(300);
check("错误条可关闭", (await page.locator(".stream-banner").count()) === 0);

await page.locator(".nav-item").filter({ hasText: "收件箱" }).click();
await page.waitForTimeout(600);
const beforeDrop = await stats();
await fetch(`${STUB}/control/drop`, { method: "POST" });
await page.waitForTimeout(2800);
const afterDrop = await stats();
check(
  "断线后指数退避重连",
  afterDrop.connections >= beforeDrop.connections + 1,
  `${beforeDrop.connections} -> ${afterDrop.connections}`,
);
check(
  "重连后补拉 /api/tasks",
  afterDrop.taskFetches > beforeDrop.taskFetches,
  `${beforeDrop.taskFetches} -> ${afterDrop.taskFetches}`,
);
check(
  "重连后补拉 /api/emails",
  afterDrop.emailFetches > beforeDrop.emailFetches || emailRequests.length > 1,
  `stats ${beforeDrop.emailFetches} -> ${afterDrop.emailFetches}, pageRequests=${emailRequests.length}`,
);

const bodyText = await page.locator("body").innerText();
check("令牌不进入 UI 文案", !bodyText.includes(TOKEN));
const tokenInConsole = consoleMessages.filter((message) => message.includes(TOKEN));
check("令牌不进入 console", tokenInConsole.length === 0, tokenInConsole[0]);
check("无页面异常", pageErrors.length === 0, pageErrors[0]);

const demoContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const demoPage = await demoContext.newPage();
const demoEventRequests = [];
demoPage.on("request", (request) => {
  if (request.url().includes("/api/events")) demoEventRequests.push(request.url());
});
await demoContext.route("**/api/health", (route) =>
  route.fulfill({ status: 502, contentType: "text/plain", body: "bad gateway" }),
);
await demoPage.goto(BASE, { waitUntil: "networkidle" });
await demoPage.getByText("演示数据").first().waitFor({ timeout: 20000 });
await demoPage.waitForTimeout(900);
check("演示模式不建 EventSource", demoEventRequests.length === 0, `requests=${demoEventRequests.length}`);
const demoBody = await demoPage.locator("body").innerText();
check("演示模式提示可见", demoBody.includes("演示数据"));
await demoContext.close();

console.log(results.join("\n"));
console.log("RESULT", results.every((line) => line.startsWith("PASS")) ? "ALL_PASS" : "HAS_FAIL");
await browser.close();
