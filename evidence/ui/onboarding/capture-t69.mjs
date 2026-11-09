/**
 * T69 证据：设置页每账号签名 / 显示名编辑器（纯文本）。
 *
 * 前置（全新数据目录 + 静态托管 dist）：
 *   MAILCOLLECT_PORT=8901 MAILCOLLECT_TOKEN=dev-local-token \
 *   MAILCOLLECT_DATA_DIR=$(mktemp -d) MAILCOLLECT_UI_DIR="$PWD/apps/ui/dist" \
 *   node node_modules/tsx/dist/cli.mjs apps/server/src/main.ts &
 * 运行：HOME=<可写目录> SHOT_CHANNEL=msedge SHOT_BASE=http://127.0.0.1:8901 \
 *       node evidence/ui/onboarding/capture-t69.mjs
 *
 * 断言：预填 / maxLength 前端拦截（2000 / 200）/ 保存回读 / 刷新后重进预填 /
 *       清空写 null / 仅签名不影响「发信已配置」/ 密码框不回显。
 * 说明：为了验证 maxLength 真的拦住了「用户输入」，用 Playwright 的 insertText
 *       （走浏览器文本插入路径，等同粘贴），而不是 `fill()`（直接赋值可绕过 maxlength）。
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.env.SHOT_BASE || "http://127.0.0.1:8901";
const token = process.env.SHOT_TOKEN || "dev-local-token";
const dir = process.env.SHOT_DIR || "evidence/ui/onboarding";
mkdirSync(dir, { recursive: true });

const findings = [];
const errors = [];
const check = (name, ok, detail) => {
  findings.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` :: ${detail}`}`);
};

const api = async (path, init = {}) => {
  const response = await fetch(`${base}/api${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  return { status: response.status, json: text === "" ? null : JSON.parse(text) };
};

// 关掉自动全屏（已完成），本任务只测设置页；假密码只落在临时库里。
await api("/onboarding", { method: "PUT", body: JSON.stringify({ completed: true }) });

const listed = await api("/accounts");
let account = (listed.json?.items ?? []).find((item) => item.provider === "imap") ?? null;
if (account === null) {
  const created = await api("/accounts", {
    method: "POST",
    body: JSON.stringify({
      provider: "imap",
      label: "公司邮箱",
      email: "lisi@corp.example",
      config: { host: "imap.corp.example", port: "993", user: "lisi@corp.example", mailbox: "INBOX", tls: "true" },
      secret: "test-only-inbound-pw",
    }),
  });
  account = created.json?.account ?? null;
}
check("准备好一个无发信连接的 IMAP 账号", account !== null && account.send == null, `id=${account?.id}`);
const accountId = account.id;

const browser = await chromium.launch({
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
  ...(process.env.SHOT_CHANNEL === undefined ? {} : { channel: process.env.SHOT_CHANNEL }),
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 1.5 });
const page = await context.newPage();
const benign = [];
page.on("console", (message) => {
  if (message.type() !== "error") return;
  const source = message.location()?.url ?? "";
  if (source.includes("favicon")) {
    benign.push(`favicon @ ${source}`);
    return;
  }
  // 本脚本故意建了一个不存在的主机（imap.corp.example）当测试账号：
  // InboxPage 会去拉文件夹并得到 502，这是环境事实，不是签名编辑器的问题。
  if (source.includes("/api/folders")) {
    benign.push(`${message.text()} @ ${source}`);
    return;
  }
  errors.push(`console: ${message.text()} @ ${source}`);
});
page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

const shot = async (name) => {
  await page.screenshot({ path: `${dir}/${name}.png`, fullPage: true });
  console.log(`SHOT ${dir}/${name}.png`);
};
const openSettings = async () => {
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.click('.nav-item:has-text("设置")');
  await page.waitForTimeout(1200);
};
const openEditor = async () => {
  await page.locator('button:has-text("签名 / 发信"):visible').first().click();
  await page.waitForTimeout(400);
};
const rowText = () => page.locator(`.account-row:has-text("公司邮箱")`).innerText();

await openSettings();
const rowBefore = await rowText();
check("账号行有「签名 / 发信」入口", rowBefore.includes("签名 / 发信"));
check("仅签名未设置时「发信：未配置」不变", rowBefore.includes("发信：未配置（只收不发）"), rowBefore.replace(/\n/g, " | "));
check("账号行显示签名/显示名状态", rowBefore.includes("签名 未设置") && rowBefore.includes("显示名 账号地址"));
await shot("t69-01-account-row");

/* ---------------------------- 预填与前端长度拦截 ---------------------------- */
await openEditor();
const signatureField = page.locator('textarea[id$="-signature"]').first();
const displayNameField = page.locator('input[id$="-display-name"]').first();
const maxLengthAttr = await signatureField.getAttribute("maxlength");
check("签名输入框 maxLength = 2000（来自共享常量）", maxLengthAttr === "2000", `maxlength=${maxLengthAttr}`);
const dnMax = await displayNameField.getAttribute("maxlength");
check("显示名输入框 maxLength = 200", dnMax === "200", `maxlength=${dnMax}`);

await signatureField.click();
await page.keyboard.insertText("x".repeat(2100));
await page.waitForTimeout(300);
const typedLength = await signatureField.inputValue().then((value) => value.length);
const counterText = await page.locator('.field-hint:has-text("/ 2000")').first().innerText();
check("输入 2100 字符被前端拦在 2000", typedLength === 2000, `value.length=${typedLength}`);
check("字符计数提示与上限一致", counterText.includes("2000 / 2000"), counterText);
await shot("t69-02-maxlength-2000");

/* --------------------------------- 保存 --------------------------------- */
const savedSignature = "——\n李四\nlisi@corp.example";
await signatureField.fill(savedSignature);
await displayNameField.fill("李四（公司）");
await page.locator('button:has-text("保存发信设置")').first().click();
await page.waitForTimeout(1500);
const savedRow = await rowText();
check("保存后仍显示「发信：未配置」（仅签名不算配好连接）", savedRow.includes("发信：未配置（只收不发）"), savedRow.replace(/\n/g, " | "));
check("保存后账号行显示签名已设置", savedRow.includes(`签名 ${savedSignature.length} 字`), `期望 签名 ${savedSignature.length} 字`);
check("保存后账号行显示显示名", savedRow.includes("李四（公司）"));
await shot("t69-03-saved");

const afterSave = await api(`/accounts`);
const savedView = (afterSave.json?.items ?? []).find((item) => item.id === accountId);
check("服务端读回 signature", savedView?.signature === savedSignature, JSON.stringify(savedView?.signature));
check("服务端读回 displayName", savedView?.displayName === "李四（公司）", JSON.stringify(savedView?.displayName));
check("仅身份字段时 send 仍为 null", savedView?.send == null, JSON.stringify(savedView?.send));

/* ------------------------- 刷新后重进页面能预填 ------------------------- */
await openSettings();
await openEditor();
const prefilledSignature = await page.locator('textarea[id$="-signature"]').first().inputValue();
const prefilledDisplayName = await page.locator('input[id$="-display-name"]').first().inputValue();
check("重进页面后签名预填", prefilledSignature === savedSignature, JSON.stringify(prefilledSignature));
check("重进页面后显示名预填", prefilledDisplayName === "李四（公司）", JSON.stringify(prefilledDisplayName));
await shot("t69-04-prefilled-after-reload");

/* ------------------------------ 密码不回显 ------------------------------ */
const passwordInputs = await page.$$eval('input[type="password"]', (nodes) =>
  nodes.map((node) => ({ id: node.id, value: node.value })),
);
check(
  "密码类输入框不回显（含账号密码 / SMTP 密码）",
  passwordInputs.every((node) => node.value === ""),
  JSON.stringify(passwordInputs.map((node) => node.id)),
);

/* ---------------------------- 清空 → 读回 null ---------------------------- */
await page.locator('textarea[id$="-signature"]').first().fill("");
await page.locator('input[id$="-display-name"]').first().fill("");
await page.locator('button:has-text("保存发信设置")').first().click();
await page.waitForTimeout(1500);
const clearedView = (await api("/accounts")).json?.items?.find((item) => item.id === accountId);
check("清空后服务端 signature 读回 null", clearedView?.signature === null, JSON.stringify(clearedView?.signature));
check("清空后服务端 displayName 读回 null", clearedView?.displayName === null, JSON.stringify(clearedView?.displayName));
const clearedRow = await rowText();
check("清空后账号行回到「签名 未设置 / 显示名 账号地址」", clearedRow.includes("签名 未设置") && clearedRow.includes("显示名 账号地址"), clearedRow.replace(/\n/g, " | "));
await shot("t69-05-cleared-null");

await browser.close();
const failed = findings.filter((finding) => !finding.ok).length;
console.log(
  `\nSUMMARY checks=${findings.length} failed=${failed} consoleErrors=${errors.length} benignEnv=${benign.length}`,
);
for (const error of errors.slice(0, 8)) console.log(`  ${error}`);
process.exit(failed === 0 && errors.length === 0 ? 0 : 1);
