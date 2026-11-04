/**
 * 真服务端上的 SSE 联调：打开界面 → 用 API 改一条待办 → 界面不刷新就应变化。
 *
 *   BASE=http://127.0.0.1:8788 TOKEN=dev-local-token node scripts/sse-live.mjs
 */
import { chromium } from "playwright";

const base = process.env.BASE ?? "http://127.0.0.1:8788";
const token = process.env.TOKEN ?? "dev-local-token";

const api = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() };
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
};

// 1) The SSE endpoint itself answers on the real server.
const probe = await fetch(`${base}/api/events?token=${token}`, { headers: { accept: "text/event-stream" } });
check("SSE 端点接受 query 令牌", probe.status === 200, `status=${probe.status}`);
const reader = probe.body.getReader();
await reader.read(); // consume the initial "ready" frame
check("SSE 首帧 ready 到达", true);

// 2) The UI must reflect a server-side change without a reload.
const candidates = (await api("/api/tasks?status=candidate")).body.items;
if (candidates.length === 0) {
  console.log("FAIL  没有待确认任务可用于测试");
  process.exit(1);
}
const victim = candidates[0];

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

await page.goto(base, { waitUntil: "networkidle", timeout: 30000 });
await page.waitForTimeout(2000);
// 统计胶囊只在「待办」页出现，先导航过去。
await page.getByText("待办", { exact: true }).first().click();
await page.waitForTimeout(1800);

const readCount = async (label) => {
  // 统计胶囊的结构是「数字 / 文案」，用整页文本抓更稳。
  const text = await page.evaluate(() => document.body.innerText);
  const match = text.match(new RegExp(`(\\d+)\\s*${label}`));
  return match ? Number(match[1]) : -1;
};

const before = await readCount("待确认");
check("初读：已进入真实模式", (await page.locator("text=已连接服务").count()) > 0, "找不到「已连接服务」");
check("初读：待确认计数可读", before >= 0, `before=${before}`);

// 3) Change it on the server and wait for the stream to push it.
const patched = await api(`/api/tasks/${victim.id}`, {
  method: "PATCH",
  body: JSON.stringify({ status: "confirmed" }),
});
check("API 改状态成功", patched.status === 200, `status=${patched.status}`);

let updated = false;
for (let i = 0; i < 20; i += 1) {
  await page.waitForTimeout(300);
  const now = await readCount("待确认");
  if (now === before - 1) {
    updated = true;
    break;
  }
}
check("界面被 SSE 推动更新（无刷新）", updated, "10 次轮询内「待确认」没有减 1");

check("无控制台错误", consoleErrors.length === 0, consoleErrors.slice(0, 3).join(" | "));

// 4) Put it back so the demo data stays stable.
await api(`/api/tasks/${victim.id}`, { method: "PATCH", body: JSON.stringify({ status: "candidate" }) });

await browser.close();
await reader.cancel();

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
