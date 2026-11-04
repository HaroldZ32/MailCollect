import { chromium } from "playwright";

const BASE = "http://localhost:4173";
const STUB = "http://127.0.0.1:8787";
const TOKEN = "sse-test-token";

const results = [];
const check = (name, ok, detail) => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` :: ${detail}`}`);
};
const emit = (type, data) =>
  fetch(`${STUB}/control/emit`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type, data }),
  }).then((response) => response.json());

const taskBase = {
  userId: "user-stub",
  detail: null,
  ownerName: null,
  kind: "action",
  origin: "personal",
  confidence: 0.7,
  evidenceQuote: "T9 验证任务",
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
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.getByText("已连接服务").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(700);

const statNum = async (label) =>
  page.locator(".stat").filter({ hasText: label }).locator(".stat-num").innerText();
const titleCount = async (title) => page.locator(".task-title").filter({ hasText: title }).count();
const navBadge = async () => {
  const badge = page.locator(".nav-badge");
  return (await badge.count()) === 0 ? null : (await badge.first().innerText()).trim();
};

await page.locator(".nav-item").filter({ hasText: "待办" }).click();
await page.waitForTimeout(400);
check("基线待确认为 0", (await statNum("待确认")) === "0", await statNum("待确认"));
check("基线侧栏无徽标", (await navBadge()) === null);

// owner=everyone 的候选：命中「所有人都要做，包括我」→ 可见、可操作、计数 +1
await emit("task", {
  ...taskBase,
  id: "t9-everyone-candidate",
  title: "全员候选任务",
  status: "candidate",
  owner: "everyone",
});
await page.waitForTimeout(600);
check("owner=everyone 候选可见", (await titleCount("全员候选任务")) === 1);
check("owner=everyone 计数 +1", (await statNum("待确认")) === "1", await statNum("待确认"));
check("owner=everyone 侧栏徽标同步", (await navBadge()) === "1", String(await navBadge()));
const sectionChip = (await page.locator(".section-head .chip--warning").first().innerText()).trim();
check("待确认分区计数与统计一致", sectionChip === "1 条", sectionChip);
const actionCount = await page
  .locator(".task-card")
  .filter({ hasText: "全员候选任务" })
  .locator("button")
  .filter({ hasText: "加入待办" })
  .count();
check("owner=everyone 可操作（有加入待办）", actionCount === 1, `buttons=${actionCount}`);

// owner=other 的候选：仍然不打扰
await emit("task", {
  ...taskBase,
  id: "t9-other-candidate",
  title: "他人候选任务",
  status: "candidate",
  owner: "other",
});
await page.waitForTimeout(600);
check("owner=other 候选不可见", (await titleCount("他人候选任务")) === 0);
check("owner=other 计数不变", (await statNum("待确认")) === "1", await statNum("待确认"));
check("owner=other 侧栏徽标不变", (await navBadge()) === "1", String(await navBadge()));

// 点「加入待办」：everyone 候选可以转入已确认
await page
  .locator(".task-card")
  .filter({ hasText: "全员候选任务" })
  .locator("button")
  .filter({ hasText: "加入待办" })
  .click();
await page.waitForTimeout(700);
const stillCandidate = await page
  .locator(".task-card--candidate")
  .filter({ hasText: "全员候选任务" })
  .count();
check("everyone 候选加入待办后离开待确认", stillCandidate === 0, `candidateCards=${stillCandidate}`);
const movedConfirmed = await page
  .locator(".task-card")
  .filter({ hasText: "全员候选任务" })
  .count();
check("everyone 候选转入已确认卡片", movedConfirmed >= 1, `cards=${movedConfirmed}`);
check("everyone 候选加入后待确认归零", (await statNum("待确认")) === "0", await statNum("待确认"));
check("everyone 候选加入后已确认 +1", (await statNum("已确认")) === "2", await statNum("已确认"));
check("待确认归零后侧栏徽标消失", (await navBadge()) === null);

// 时间线同样只排除 other
await emit("task", {
  ...taskBase,
  id: "t9-everyone-timed",
  title: "全员到期任务",
  status: "confirmed",
  owner: "everyone",
  kind: "deadline",
  time: {
    phrase: null,
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    windowStart: null,
    windowEnd: null,
    timezone: "Asia/Shanghai",
    confidence: 0.6,
  },
});
await emit("task", {
  ...taskBase,
  id: "t9-other-timed",
  title: "他人到期任务",
  status: "confirmed",
  owner: "other",
  kind: "deadline",
  time: {
    phrase: null,
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    windowStart: null,
    windowEnd: null,
    timezone: "Asia/Shanghai",
    confidence: 0.6,
  },
});
await page.waitForTimeout(500);
await page.locator(".nav-item").filter({ hasText: "时间线" }).click();
await page.locator(".gantt_task_line").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(900);
const gridText = (await page.locator(".gantt_grid_data").innerText()).replace(/\s+/g, " ");
check("时间线显示 owner=everyone", gridText.includes("全员到期任务"));
check("时间线不显示 owner=other", !gridText.includes("他人到期任务"));

check("无页面异常", pageErrors.length === 0, pageErrors[0]);

console.log(results.join("\n"));
console.log("RESULT", results.every((line) => line.startsWith("PASS")) ? "ALL_PASS" : "HAS_FAIL");
await browser.close();
