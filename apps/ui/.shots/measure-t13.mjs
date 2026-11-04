import { chromium } from "playwright";
const token = "sse-test-token";
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
await context.addInitScript((t) => { window.localStorage.setItem("mailcollect.token", t); }, token);
const page = await context.newPage();
await page.goto("http://localhost:4173", { waitUntil: "networkidle" });
await page.getByText("已连接服务").first().waitFor({ timeout: 20000 });
await page.locator(".nav-item").filter({ hasText: "设置" }).click();
await page.waitForTimeout(400);
await page.locator("button").filter({ hasText: "添加账号" }).click();
await page.waitForTimeout(200);
await page.locator("#account-provider").selectOption("graph");
await page.waitForTimeout(300);
const info = await page.evaluate(() => {
  const rect = (selector) => {
    const el = document.querySelector(selector);
    return el ? el.getBoundingClientRect().toJSON() : null;
  };
  const cards = [...document.querySelectorAll(".settings .glass-card")].map((el) => el.getBoundingClientRect().toJSON());
  const grid = document.querySelector("#account-client-id")?.closest(".form-grid");
  const gridRect = grid?.getBoundingClientRect();
  const cells = grid ? [...grid.children].map((el) => ({ cls: el.className, ...el.getBoundingClientRect().toJSON() })) : [];
  return {
    docScrollWidth: document.documentElement.scrollWidth,
    docClientWidth: document.documentElement.clientWidth,
    settings: rect(".settings"),
    cards,
    grid: gridRect?.toJSON() ?? null,
    gridColumns: grid ? getComputedStyle(grid).gridTemplateColumns : null,
    cells,
  };
});
console.log(JSON.stringify(info, null, 2));
await browser.close();
