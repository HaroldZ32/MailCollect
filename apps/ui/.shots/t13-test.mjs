import { chromium } from "playwright";

const BASE = "http://localhost:4173";
const STUB = "http://127.0.0.1:8787";
const TOKEN = "sse-test-token";
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";
const CLIENT_ID_2 = "99999999-8888-7777-6666-555555555555";

const results = [];
const check = (name, ok, detail) => {
  results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` :: ${detail}`}`);
};
const stats = () => fetch(`${STUB}/control/stats`).then((response) => response.json());

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await context.addInitScript((token) => {
  window.localStorage.setItem("mailcollect.token", token);
}, TOKEN);
const page = await context.newPage();
const pageErrors = [];
page.on("pageerror", (error) => pageErrors.push(error.message));

const accountRows = () => page.locator(".account-list .account-row");
const formError = () => page.locator(".alias-editor .test-result.is-error");
const openForm = async () => {
  await page.locator("button").filter({ hasText: "添加账号" }).click();
  await page.waitForTimeout(250);
};
const submit = async () => {
  await page.locator("button").filter({ hasText: "保存账号" }).click();
  await page.waitForTimeout(700);
};

await page.goto(BASE, { waitUntil: "networkidle" });
await page.getByText("已连接服务").first().waitFor({ timeout: 20000 });
await page.waitForTimeout(800);
await page.locator(".nav-item").filter({ hasText: "设置" }).click();
await page.waitForTimeout(500);

const baselineRows = await accountRows().count();
check("基线账号数", baselineRows === 2, `rows=${baselineRows}`);

// 选 Microsoft Graph → 显示 Client ID / 租户，隐藏密码与 IMAP 字段
await openForm();
await page.locator("#account-provider").selectOption("graph");
await page.waitForTimeout(250);
check("Graph 模式显示 Client ID", (await page.locator("#account-client-id").count()) === 1);
check("Graph 模式显示租户字段", (await page.locator("#account-tenant").count()) === 1);
check("租户占位符为 common", (await page.locator("#account-tenant").getAttribute("placeholder")) === "common");
check("Graph 模式隐藏密码/密钥字段", (await page.locator("#account-secret").count()) === 0);
check("Graph 模式隐藏 IMAP 服务器字段", (await page.locator("#account-host").count()) === 0);
check("Graph 模式隐藏端口字段", (await page.locator("#account-port").count()) === 0);
const helpLink = page.locator('a[href="https://portal.azure.com"]');
check(
  "帮助区有 Azure 门户外链（新窗口）",
  (await helpLink.count()) === 1 && (await helpLink.getAttribute("target")) === "_blank",
);
const helpText = await page.locator(".form-row").filter({ has: page.locator("#account-client-id") }).innerText();
check(
  "Client ID 帮助文案包含 Azure 应用注册说明",
  helpText.includes("Azure 门户") && helpText.includes("应用程序(客户端) ID"),
  helpText.replace(/\s+/g, " ").slice(0, 120),
);

// 不填 clientId → 本地拦截，不发请求
await page.locator("#account-email").fill("graph-user@example.com");
await submit();
const beforeCreates = (await stats()).accountCreates;
const localError = await formError().innerText();
check("clientId 为空时本地拦截", localError.includes("clientId"), localError);
check("本地拦截不向服务端发请求", beforeCreates === 0, `accountCreates=${beforeCreates}`);

// 填写 clientId → 请求体带 config.clientId，且无 cachePath
await page.locator("#account-client-id").fill(CLIENT_ID);
await submit();
const createStats = await stats();
const createdConfig = createStats.lastAccountCreate?.config ?? {};
check("提交命中 POST /api/accounts", createStats.accountCreates === 1, `creates=${createStats.accountCreates}`);
check("请求体 config.clientId 正确", createdConfig.clientId === CLIENT_ID, String(createdConfig.clientId));
check("请求体不含 cachePath", !("cachePath" in createdConfig), Object.keys(createdConfig).join(","));
check("租户为空时不传 tenant", !("tenant" in createdConfig), Object.keys(createdConfig).join(","));
check("保存成功后表单关闭", (await page.locator("#account-client-id").count()) === 0);
check("保存成功后账号 +1", (await accountRows().count()) === baselineRows + 1, `rows=${await accountRows().count()}`);

// 后端 400：detail 原样展示在表单里
await openForm();
await page.locator("#account-provider").selectOption("graph");
await page.waitForTimeout(200);
await page.locator("#account-email").fill("bad-graph@example.com");
await page.locator("#account-client-id").fill("bad-client-id");
await submit();
const serverError = await formError().innerText();
check("后端 400 detail 展示在表单内", serverError.includes("stub 拒绝"), serverError);
check("后端 400 后表单保持打开", (await page.locator("#account-client-id").count()) === 1);
check("后端 400 不新增账号", (await accountRows().count()) === baselineRows + 1, `rows=${await accountRows().count()}`);

// 租户可选，填了要进 config
await page.locator("#account-client-id").fill(CLIENT_ID_2);
await page.locator("#account-tenant").fill("contoso.onmicrosoft.com");
await submit();
const tenantStats = await stats();
const tenantConfig = tenantStats.lastAccountCreate?.config ?? {};
check("租户填写后进入 config.tenant", tenantConfig.tenant === "contoso.onmicrosoft.com", String(tenantConfig.tenant));
check("仍不含 cachePath", !("cachePath" in tenantConfig), Object.keys(tenantConfig).join(","));
check("保存租户后账号再 +1", (await accountRows().count()) === baselineRows + 2, `rows=${await accountRows().count()}`);

// 切回 IMAP：密码字段回来、Graph 字段消失
await openForm();
await page.locator("#account-provider").selectOption("imap");
await page.waitForTimeout(200);
check("IMAP 模式隐藏 Client ID", (await page.locator("#account-client-id").count()) === 0);
check("IMAP 模式显示密码字段", (await page.locator("#account-secret").count()) === 1);
check("IMAP 模式显示服务器字段", (await page.locator("#account-host").count()) === 1);

check("无页面异常", pageErrors.length === 0, pageErrors[0]);

// 演示模式：字段照常可填，不建真账号，不假装成功
const demoContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const demoPage = await demoContext.newPage();
await demoContext.route("**/api/health", (route) =>
  route.fulfill({ status: 502, contentType: "text/plain", body: "bad gateway" }),
);
await demoPage.goto(BASE, { waitUntil: "networkidle" });
await demoPage.getByText("演示数据").first().waitFor({ timeout: 20000 });
await demoPage.locator(".nav-item").filter({ hasText: "设置" }).click();
await demoPage.waitForTimeout(500);
const demoRows = () => demoPage.locator(".account-list .account-row");
const demoBaseline = await demoRows().count();
await demoPage.locator("button").filter({ hasText: "添加账号" }).click();
await demoPage.waitForTimeout(250);
await demoPage.locator("#account-provider").selectOption("graph");
await demoPage.waitForTimeout(200);
check("演示模式显示 Client ID 字段", (await demoPage.locator("#account-client-id").count()) === 1);
check("演示模式隐藏密码字段", (await demoPage.locator("#account-secret").count()) === 0);
await demoPage.locator("#account-email").fill("demo-graph@example.com");
await demoPage.locator("button").filter({ hasText: "保存账号" }).click();
await demoPage.waitForTimeout(400);
check(
  "演示模式同样本地校验 clientId",
  (await demoPage.locator(".alias-editor .test-result.is-error").innerText()).includes("clientId"),
);
check("演示模式校验失败不新增账号", (await demoRows().count()) === demoBaseline, `rows=${await demoRows().count()}`);
await demoPage.locator("#account-client-id").fill(CLIENT_ID);
await demoPage.locator("button").filter({ hasText: "保存账号" }).click();
await demoPage.waitForTimeout(500);
check("演示模式可保存（本地会话）", (await demoRows().count()) === demoBaseline + 1, `rows=${await demoRows().count()}`);
check(
  "演示模式明确标注演示数据",
  (await demoPage.locator(".toast").innerText()).includes("演示数据"),
  await demoPage.locator(".toast").innerText(),
);
await demoContext.close();

console.log(results.join("\n"));
console.log("RESULT", results.every((line) => line.startsWith("PASS")) ? "ALL_PASS" : "HAS_FAIL");
await browser.close();
