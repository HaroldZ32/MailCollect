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
  evidenceQuote: "T7 验证任务",
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
await page.locator(".nav-item").filter({ hasText: "待办" }).click();
await page.waitForTimeout(400);

const statNum = async (label) =>
  page.locator(".stat").filter({ hasText: label }).locator(".stat-num").innerText();
const titleCount = async (title) => page.locator(".task-title").filter({ hasText: title }).count();

// H2: owner=other candidate must be invisible and not counted
await emit("task", { ...taskBase, id: "t7-other-candidate", title: "他人候选任务", status: "candidate", owner: "other" });
await page.waitForTimeout(500);
check("owner=other 候选不出现", (await titleCount("他人候选任务")) === 0);
check("owner=other 候选不计入待确认", (await statNum("待确认")) === "0", await statNum("待确认"));

// H2: owner=other confirmed must be invisible and not counted
await emit("task", {
  ...taskBase,
  id: "t7-other-confirmed",
  title: "他人确认任务",
  status: "confirmed",
  owner: "other",
  kind: "deadline",
  time: { phrase: null, dueAt: new Date(Date.now() + 86_400_000).toISOString(), windowStart: null, windowEnd: null, timezone: "Asia/Shanghai", confidence: 0.6 },
});
await page.waitForTimeout(500);
check("owner=other 确认任务不出现", (await titleCount("他人确认任务")) === 0);
check("owner=other 不计入已确认", (await statNum("已确认")) === "1", await statNum("已确认"));

// allowed owner=unassigned candidate is actionable
await emit("task", { ...taskBase, id: "t7-unassigned-candidate", title: "未指派候选任务", status: "candidate", owner: "unassigned" });
await page.waitForTimeout(500);
check("owner=unassigned 候选出现", (await titleCount("未指派候选任务")) === 1);
check("owner=unassigned 计入待确认", (await statNum("待确认")) === "1", await statNum("待确认"));
const addButtons = await page
  .locator(".task-card")
  .filter({ hasText: "未指派候选任务" })
  .locator("button")
  .filter({ hasText: "加入待办" })
  .count();
check("owner=unassigned 卡片有「加入待办」", addButtons === 1, `buttons=${addButtons}`);

// same email broadcast candidate owned by other is not offered either
await emit("task", {
  ...taskBase,
  id: "t7-other-broadcast",
  title: "他人群发候选",
  status: "candidate",
  owner: "other",
  origin: "broadcast",
});
await page.waitForTimeout(500);
check("owner=other 群发候选不出现", (await titleCount("他人群发候选")) === 0);
check("owner=other 群发不生成提醒卡", (await page.locator(".broadcast-card").count()) === 0);

// H2: timeline excludes owner=other
await page.locator(".nav-item").filter({ hasText: "时间线" }).click();
await page.locator(".gantt_task_line").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(800);
const gridText = (await page.locator(".gantt_grid_data").innerText()).replace(/\s+/g, " ");
check("时间线不显示 owner=other", !gridText.includes("他人确认任务"));
check("时间线显示 owner=me", gridText.includes("来自 SSE 的既有任务"));

// H5: every preset must use the implemented protocol
await page.locator(".nav-item").filter({ hasText: "设置" }).click();
await page.waitForTimeout(500);
const presetCount = await page.locator(".preset").count();
const presets = [];
for (let index = 0; index < presetCount; index += 1) {
  const preset = page.locator(".preset").nth(index);
  await preset.click();
  await page.waitForTimeout(120);
  presets.push({
    name: (await preset.locator(".preset-name").innerText()).trim(),
    protocol: await page.locator("#llm-protocol").inputValue(),
    label: await page.locator("#llm-label").inputValue(),
    baseUrl: await page.locator("#llm-base").inputValue(),
  });
}
check(
  "所有预设都用 openai-compatible",
  presets.length > 0 && presets.every((preset) => preset.protocol === "openai-compatible"),
  presets.map((preset) => `${preset.name}=${preset.protocol}`).join(", "),
);
const claude = presets.find((preset) => preset.name.includes("Claude"));
check(
  "Claude 预设指向 Anthropic OpenAI 兼容层",
  claude !== undefined && claude.baseUrl === "https://api.anthropic.com/v1" && claude.label.includes("兼容层"),
  JSON.stringify(claude),
);
const nativeDisabled = await page
  .locator('#llm-protocol option[value="anthropic-messages"]')
  .evaluate((element) => element instanceof HTMLOptionElement && element.disabled);
check("原生 Anthropic 协议在 UI 中禁用", nativeDisabled === true, String(nativeDisabled));

check("无页面异常", pageErrors.length === 0, pageErrors[0]);

console.log(results.join("\n"));
console.log("PRESETS", JSON.stringify(presets));
console.log("RESULT", results.every((line) => line.startsWith("PASS")) ? "ALL_PASS" : "HAS_FAIL");
await browser.close();
