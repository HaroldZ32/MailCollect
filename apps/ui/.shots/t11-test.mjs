import { chromium } from "playwright";

const BASE = "http://localhost:4173";
const STUB = "http://127.0.0.1:8787";
const TOKEN = "sse-test-token";
const GRAPH_ACCOUNT = "acc-graph";

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
await page.waitForTimeout(900);
await page.locator(".nav-item").filter({ hasText: "设置" }).click();
await page.waitForTimeout(500);

const graphRow = page.locator(".account-row").filter({ hasText: "Stub Outlook" });
const imapRow = page.locator(".account-row").filter({ hasText: "Stub 邮箱" });
check(
  "Graph 账号按钮文案为「登录 Microsoft」",
  (await graphRow.locator("button").filter({ hasText: "登录 Microsoft" }).count()) === 1,
);
check(
  "IMAP 账号按钮仍为「验证」",
  (await imapRow.locator("button").filter({ hasText: "验证" }).count()) === 1 &&
    (await imapRow.locator("button").filter({ hasText: "登录 Microsoft" }).count()) === 0,
);

// 发起设备码登录
await graphRow.locator("button").filter({ hasText: "登录 Microsoft" }).click();
await page.locator(".dialog-card").waitFor({ timeout: 5000 });
check("点击后弹出设备码对话框", await page.locator(".dialog-card").isVisible());
check(
  "对话框先展示请求中状态",
  (await page.locator(".dialog-loading").innerText()).includes("正在向 Microsoft 申请设备码"),
);
const loginStats = await stats();
check("POST /login 命中桩服务", loginStats.loginRequests === 1, `loginRequests=${loginStats.loginRequests}`);

// device-code 事件 → 码与链接、倒计时、等待提示
await emit("device-code", {
  accountId: GRAPH_ACCOUNT,
  userCode: "ABCD-EFGH",
  verificationUri: "https://microsoft.com/devicelogin",
  message: "打开验证页面并输入下面的代码",
  expiresInSeconds: 300,
});
await page.waitForTimeout(500);
check("设备码可见", (await page.locator(".device-code-value").innerText()).trim() === "ABCD-EFGH");
check(
  "验证链接可见且可点击",
  (await page.locator(".device-link a").getAttribute("href")) === "https://microsoft.com/devicelogin",
);
const countdown = (await page.locator(".device-countdown").innerText()).replace(/\s+/g, " ").trim();
check("到期倒计时可见", /剩余 \d+:\d{2}/.test(countdown), countdown);
check("有「已自动等待」提示", (await page.locator(".device-waiting").innerText()).includes("已自动等待"));

// device-login 失败 → 不关闭、展示错误、可重试
await emit("device-login", {
  accountId: GRAPH_ACCOUNT,
  ok: false,
  detail: "AADSTS70000: 用户取消授权",
});
await page.waitForTimeout(500);
check("失败事件后对话框不关闭", await page.locator(".dialog-card").isVisible());
check("失败详情展示在对话框内", (await page.locator(".dialog-card").innerText()).includes("AADSTS70000"));
check(
  "失败后出现重试按钮",
  (await page.locator(".dialog-card button").filter({ hasText: "重新发起" }).count()) === 1,
);

// 重试 → 再次 POST /login，新码生效
await page.locator(".dialog-card button").filter({ hasText: "重新发起" }).click();
await page.waitForTimeout(500);
const retryStats = await stats();
check("重试再次 POST /login", retryStats.loginRequests === 2, `loginRequests=${retryStats.loginRequests}`);
check(
  "重试回到请求中状态",
  (await page.locator(".dialog-loading").innerText()).includes("申请设备码"),
);
await emit("device-code", {
  accountId: GRAPH_ACCOUNT,
  userCode: "WXYZ-1234",
  verificationUri: "https://microsoft.com/devicelogin",
  message: "重新登录",
  expiresInSeconds: 300,
});
await page.waitForTimeout(400);
check("重试后展示新设备码", (await page.locator(".device-code-value").innerText()).trim() === "WXYZ-1234");

// device-login 成功 → 关闭、刷新账号、标记已登录
const beforeAccounts = (await stats()).accountsFetches;
await emit("device-login", { accountId: GRAPH_ACCOUNT, ok: true, detail: "Microsoft 登录成功" });
await page.waitForTimeout(1000);
check("成功事件后对话框关闭", (await page.locator(".dialog-card").count()) === 0);
const afterAccounts = (await stats()).accountsFetches;
check("成功事件后刷新账号列表", afterAccounts > beforeAccounts, `${beforeAccounts} -> ${afterAccounts}`);
check(
  "Graph 账号标记「已登录」",
  (await graphRow.locator(".chip").filter({ hasText: "已登录" }).count()) === 1,
);

// 关闭对话框不泄漏定时器，且可重新发起
await graphRow.locator("button").filter({ hasText: "登录 Microsoft" }).click();
await page.locator(".dialog-card").waitFor({ timeout: 5000 });
await emit("device-code", {
  accountId: GRAPH_ACCOUNT,
  userCode: "CLOSE-ME",
  verificationUri: "https://microsoft.com/devicelogin",
  message: "",
  expiresInSeconds: 120,
});
await page.waitForTimeout(400);
await page.locator(".dialog-card button").filter({ hasText: "关闭" }).click();
await page.waitForTimeout(1300);
check("关闭后对话框消失", (await page.locator(".dialog-card").count()) === 0);
check("关闭后无页面异常（定时器已清理）", pageErrors.length === 0, pageErrors[0]);

await graphRow.locator("button").filter({ hasText: "登录 Microsoft" }).click();
await page.locator(".dialog-card").waitFor({ timeout: 5000 });
check("关闭后可以重新发起登录", await page.locator(".dialog-card").isVisible());

// 到期倒计时：验证码过期后提示并允许重新发起
await emit("device-code", {
  accountId: GRAPH_ACCOUNT,
  userCode: "EXPIRE-ME",
  verificationUri: "https://microsoft.com/devicelogin",
  message: "",
  expiresInSeconds: 2,
});
await page.waitForTimeout(2600);
check(
  "倒计时到 0 显示已过期",
  (await page.locator(".device-countdown").innerText()).includes("验证码已过期"),
  await page.locator(".device-countdown").innerText(),
);
check(
  "过期后可重新发起",
  (await page.locator(".dialog-card button").filter({ hasText: "重新发起" }).count()) === 1,
);
await page.locator(".dialog-card button").filter({ hasText: "关闭" }).click();
await page.waitForTimeout(300);
check("关闭过期对话框", (await page.locator(".dialog-card").count()) === 0);

// SSE 未连接：按钮给出明确提示，不弹框
const noSseContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await noSseContext.addInitScript((token) => {
  window.localStorage.setItem("mailcollect.token", token);
}, TOKEN);
const noSsePage = await noSseContext.newPage();
await noSsePage.route("**/api/events*", (route) => route.abort());
await noSsePage.goto(BASE, { waitUntil: "networkidle" });
await noSsePage.getByText("已连接服务").first().waitFor({ timeout: 20000 });
await noSsePage.locator(".nav-item").filter({ hasText: "设置" }).click();
await noSsePage.waitForTimeout(600);
await noSsePage.locator(".account-row").filter({ hasText: "Stub Outlook" }).locator("button").filter({ hasText: "登录 Microsoft" }).click();
await noSsePage.waitForTimeout(500);
const noSseToast = await noSsePage.locator(".toast").innerText();
check("SSE 未连接时点击给出「需要连接服务端」提示", noSseToast.includes("需要连接服务端"), noSseToast);
check("SSE 未连接时不弹设备码框", (await noSsePage.locator(".dialog-card").count()) === 0);
await noSseContext.close();

// 演示模式：明确提示需要连接服务端，不假装成功
const demoContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const demoPage = await demoContext.newPage();
await demoContext.route("**/api/health", (route) =>
  route.fulfill({ status: 502, contentType: "text/plain", body: "bad gateway" }),
);
await demoPage.goto(BASE, { waitUntil: "networkidle" });
await demoPage.getByText("演示数据").first().waitFor({ timeout: 20000 });
await demoPage.locator(".nav-item").filter({ hasText: "设置" }).click();
await demoPage.waitForTimeout(500);
const demoGraphRow = demoPage.locator(".account-row").filter({ hasText: "Outlook 个人号" });
await demoGraphRow.locator("button").filter({ hasText: "登录 Microsoft" }).click();
await demoPage.waitForTimeout(500);
const toastText = await demoPage.locator(".toast").innerText();
check("演示模式点击给出「需要连接服务端」提示", toastText.includes("需要连接服务端"), toastText);
check("演示模式不弹设备码框", (await demoPage.locator(".dialog-card").count()) === 0);
check(
  "演示模式设置页展示不可用说明",
  (await demoPage.locator(".settings-note").filter({ hasText: "Microsoft 设备码登录需要服务端" }).count()) === 1,
);
await demoContext.close();

check("主流程无页面异常", pageErrors.length === 0, pageErrors[0]);

console.log(results.join("\n"));
console.log("RESULT", results.every((line) => line.startsWith("PASS")) ? "ALL_PASS" : "HAS_FAIL");
await browser.close();
