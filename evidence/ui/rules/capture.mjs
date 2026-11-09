/**
 * T33 证据采集：规则面板 / 树形条件编辑器 / 分类管理。
 *
 * 前置（本脚本不负责起服务；会清空/重建非种子数据，只对一次性数据目录运行）：
 *   MAILCOLLECT_PORT=8787 MAILCOLLECT_TOKEN=dev-local-token \
 *   MAILCOLLECT_DATA_DIR=$(mktemp -d) node node_modules/tsx/dist/cli.mjs apps/server/src/main.ts
 *   (cd apps/ui && npx vite --host 127.0.0.1 --port 5173 --strictPort)
 *   # 先写入档案（触发「点名给我」种子）与 onboarding 完成标记：
 *   curl -X PUT -H 'authorization: Bearer dev-local-token' -H 'content-type: application/json' \
 *     -d '{"displayName":"张三","aliases":["San Zhang"],"emails":["zhangsan@corp.example"],"timezone":"Asia/Shanghai"}' \
 *     http://127.0.0.1:8787/api/profile
 *   curl -X PUT -H 'authorization: Bearer dev-local-token' -H 'content-type: application/json' \
 *     -d '{"completed":true}' http://127.0.0.1:8787/api/onboarding
 *
 * 运行（Playwright 浏览器缓存在仓库 .cache/ 下）：
 *   PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright" node evidence/ui/rules/capture.mjs
 *
 * 输出：evidence/ui/rules/*.png + PASS/FAIL 断言；任一断言失败、页面白屏或
 * 非“故意失败”页面出现 console/pageerror 即非零退出。
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const base = process.env.SHOT_BASE || "http://127.0.0.1:5173";
const token = process.env.SHOT_TOKEN || "dev-local-token";
const dir = process.env.SHOT_DIR || "evidence/ui/rules";
mkdirSync(dir, { recursive: true });

const findings = [];
const consoleErrors = [];

const check = (name, ok, detail) => {
  findings.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail === undefined ? "" : ` :: ${detail}`}`);
  return ok;
};

const api = async (path, init = {}) => {
  const response = await fetch(`${base}/api${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text === "" ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body };
};

const listRules = async () => (await api("/rules")).body.items;
const listCategories = async () => (await api("/categories")).body.items;

const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const viewport = { width: 1440, height: 1000 };

const newPage = async (context, label) => {
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`[${label}] console: ${message.text()}`);
  });
  page.on("pageerror", (error) => consoleErrors.push(`[${label}] pageerror: ${error.message}`));
  return page;
};

const shot = async (page, name) => {
  await page.screenshot({ path: `${dir}/${name}.png` });
  console.log(`SHOT ${dir}/${name}.png`);
};

const openRules = async (page) => {
  await page.goto(`${base}/`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  await page.locator('button[title="规则与分类"]').click();
  await page.waitForSelector('[data-testid="rules-page"]', { timeout: 15000 });
  await page.waitForTimeout(500);
};

/* ------------------------- 0. 清理上一次证据产生的数据 ------------------------- */

const initialCategories = await listCategories();
const initialRules = await listRules();
const seedCategories = initialCategories.filter((category) => category.id.startsWith("seed-category-"));
const seedRules = initialRules.filter((rule) => rule.id.startsWith("seed-rule-"));
if (seedCategories.length < 2 || seedRules.length < 2) {
  console.error(
    "需要一次性的干净数据目录（本脚本的空态阶段会删除种子分类/规则，删除后服务端不会重播）。" +
      " 请用新的 MAILCOLLECT_DATA_DIR 重启服务，并按头部注释写入档案与 onboarding。",
  );
  process.exit(2);
}

for (const rule of initialRules) {
  if (rule.id.startsWith("seed-rule-")) continue;
  await api(`/rules/${encodeURIComponent(rule.id)}`, { method: "DELETE" });
}
for (const category of await listCategories()) {
  if (category.id.startsWith("seed-category-")) continue;
  await api(`/categories/${encodeURIComponent(category.id)}?confirm=true`, { method: "DELETE" });
}

/* ------------------------------ 1. 列表总览 ------------------------------ */

const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1.5 });
const page = await newPage(ctx, "desktop");
await openRules(page);

const listText = await page.evaluate(() => document.body.innerText);
check("列表：规则与分类两块都渲染", listText.includes("规则") && listText.includes("分类"));
check(
  "列表：种子规则可见（点名给我 / 群发/通知）",
  listText.includes("点名给我") && listText.includes("群发/通知"),
);
check("列表：「未分类」只读行可见", listText.includes("未分类") && listText.includes("只读"));
check("列表：每条规则显示条件摘要", listText.includes("整词匹配") && listText.includes("List-Id"));
check(
  "「未分类」没有任何可编辑/删除入口",
  (await page.locator('[data-testid="category-uncategorized"] button').count()) === 0,
);
await shot(page, "01-rules-list");

await page.click('[data-testid="category-add"]');
await page.waitForSelector('[data-testid="category-name"]');
await page.waitForTimeout(250);
await shot(page, "01b-category-form");
await page.keyboard.press("Escape");
await page.waitForTimeout(250);

/* ---------------------- 1c. 分类 CRUD（走 UI 表单） ---------------------- */

await page.click('[data-testid="category-add"]');
await page.fill('[data-testid="category-name"]', "项目邮件");
await page.locator('[data-testid="rules-modal"] input[type="checkbox"]').nth(1).check();
await shot(page, "01c-category-form-filled");
await page.click('[data-testid="category-save"]');
await page.waitForTimeout(1200);
const createdCategory = (await listCategories()).find((category) => category.name === "项目邮件");
check(
  "UI 新建分类 + 两个开关落库",
  createdCategory !== undefined && createdCategory.enterTodo === true && createdCategory.broadcast === true,
);

await page.click('[data-testid="category-add"]');
await page.fill('[data-testid="category-name"]', "项目邮件");
await page.click('[data-testid="category-save"]');
await page.waitForTimeout(400);
const duplicateText = await page.locator('[data-testid="rules-modal"]').innerText();
check("重名分类被拦下（表单内可见提示）", duplicateText.includes("已存在同名分类"));
await shot(page, "01d-category-duplicate");
await page.keyboard.press("Escape");
await page.waitForTimeout(250);

await page.click('button[aria-label="编辑分类「项目邮件」"]');
await page.waitForSelector('[data-testid="category-name"]');
await page.fill('[data-testid="category-name"]', "项目邮件（改）");
await page.locator('[data-testid="rules-modal"] input[type="checkbox"]').nth(1).uncheck();
await page.click('[data-testid="category-save"]');
await page.waitForTimeout(1200);
const editedCategory = (await listCategories()).find((category) => category.name === "项目邮件（改）");
check(
  "UI 编辑分类（改名 + 开关）落库",
  editedCategory !== undefined && editedCategory.broadcast === false,
);

if (editedCategory !== undefined) {
  await page
    .locator(`[data-testid="category-row-${editedCategory.id}"] input[type="checkbox"]`)
    .nth(1)
    .click();
  await page.waitForTimeout(900);
  check(
    "行内「群发提醒」开关落库",
    (await listCategories()).find((category) => category.id === editedCategory.id)?.broadcast === true,
  );

  await page.click(`[data-testid="category-delete-${editedCategory.id}"]`);
  await page.waitForTimeout(900);
  check(
    "空分类从 UI 直接删除（无需 409 确认）",
    !(await listCategories()).some((category) => category.id === editedCategory.id),
  );
}

/* --------------------------- 2. 树形条件编辑器 --------------------------- */

await page.click('[data-testid="rule-add"]');
await page.waitForSelector('[data-testid="rules-modal"]');
await page.waitForTimeout(300);

check(
  "规则目标下拉不提供「未分类」",
  !(await page.locator('[data-testid="rule-category"]').innerText()).includes("未分类"),
);
check(
  "编辑器默认深度 0 / 8",
  (await page.locator('[data-testid="tree-depth"]').innerText()).includes("0 / 8"),
);
await shot(page, "02-editor-default");

// 根叶子 → 「或」括号
await page.locator('[data-testid="root-wrap"] button:has-text("包成「或」括号")').click();
await page.waitForTimeout(150);

// 根「或」分组内追加一个「与」嵌套分组（children.1）
await page.locator('[data-tree-path=""] button:has-text("与分组")').click();
await page.waitForTimeout(150);
// 「与」分组内追加语义条件与「否定」
await page.locator('[data-tree-path="children.1"] button:has-text("语义条件")').click();
await page.waitForTimeout(150);
await page.locator('[data-tree-path="children.1"] button:has-text("否定")').click();
await page.waitForTimeout(250);

check(
  "编辑器渲染出 与 / 或 / 非 与括号分组",
  (await page.locator('[data-tree-kind="and"]').count()) > 0 &&
    (await page.locator('[data-tree-kind="or"]').count()) > 0 &&
    (await page.locator('[data-tree-kind="not"]').count()) > 0,
);

await page.fill('[data-testid="rule-name"]', "账单与催缴");
const categoriesEarly = await listCategories();
const personalEarly = categoriesEarly.find((category) => category.name === "点名给我");
if (personalEarly !== undefined) {
  await page.selectOption('[data-testid="rule-category"]', personalEarly.id);
}
await page.fill('[data-tree-path="children.0"] input[aria-label^="值"]', "账单");
await page.fill('[data-tree-path="children.1.children.0"] input[aria-label^="值"]', "发票");
await page.fill('[data-tree-path="children.1.children.1"] textarea', "正文在催我本周提交报告");

// wholeWord 必须作为操作符可选，并给出词边界说明
const notLeaf = page.locator('[data-tree-path="children.1.children.2.child"]');
check(
  "操作符下拉提供整词匹配（wholeWord）",
  (await notLeaf.locator('select[aria-label="操作符"] option[value="wholeWord"]').count()) === 1,
);
await notLeaf.locator('select[aria-label="操作符"]').selectOption("wholeWord");
await notLeaf.locator('input[aria-label^="值"]').fill("Li");
await page.waitForTimeout(250);

const formulaBefore = await page.locator('[data-testid="tree-formula"]').innerText();
check(
  "表达式预览包含括号、且、或、非与整词匹配",
  formulaBefore.includes("(") &&
    formulaBefore.includes("且") &&
    formulaBefore.includes("或") &&
    formulaBefore.includes("非(") &&
    formulaBefore.includes("整词匹配"),
  formulaBefore,
);
check(
  "整词匹配的词边界说明可见",
  (await page.locator('[data-testid="rule-tree-editor"]').innerText()).includes("Li 不命中 Lion"),
);
await shot(page, "03-editor-tree");

/* --------------------------- 3. 非法输入提示 --------------------------- */

await page.fill('[data-tree-path="children.0"] input[aria-label^="值"]', "");
await page.fill('[data-tree-path="children.1.children.1"] textarea', "");
await page.click('[data-testid="rule-save"]');
await page.waitForSelector('[data-testid="rule-error"]');
await page.waitForSelector('[data-testid="tree-issues"]');
const invalidText = await page.evaluate(() => document.body.innerText);
check("非法输入：保存被拦下并给出整体提示", invalidText.includes("条件树有 2 个问题"));
check("非法输入：叶子旁显示类型错误", invalidText.includes("值的类型或内容不合法"));
check("非法输入：语义叶子旁显示空表达式错误", invalidText.includes("语义条件至少需要 2 个字"));
check("非法输入：问题汇总清单可见", (await page.locator('[data-testid="tree-issues"]').count()) === 1);
await shot(page, "04-editor-invalid");
await page.locator('[data-testid="rule-error"]').scrollIntoViewIfNeeded();
await page.waitForTimeout(250);
await shot(page, "04b-editor-invalid-summary");

/* ------------------------ 4. 保存 + API 往返一致 ------------------------ */

await page.fill('[data-tree-path="children.0"] input[aria-label^="值"]', "账单");
await page.fill('[data-tree-path="children.1.children.1"] textarea', "正文在催我本周提交报告");

const categories = await listCategories();
const personalCategory = categories.find((category) => category.name === "点名给我");
if (personalCategory !== undefined) {
  await page.selectOption('[data-testid="rule-category"]', personalCategory.id);
}

await page.click('[data-testid="rule-save"]');
await page.waitForSelector('[data-testid="rules-toast"]', { timeout: 10000 });
const toastText = await page.locator('[data-testid="rules-toast"]').innerText();
check("保存成功提示可见", toastText.includes("已保存规则"), toastText);
await page.waitForTimeout(900);
await shot(page, "05-saved-toast");

const savedRules = await listRules();
const saved = savedRules.find((rule) => rule.name === "账单与催缴");
check("API 里出现新规则", saved !== undefined);

const treeOk = (tree) => {
  if (tree === null || typeof tree !== "object") return false;
  if (tree.kind !== "or" || !Array.isArray(tree.children) || tree.children.length !== 2) return false;
  const first = tree.children[0];
  const group = tree.children[1];
  if (first?.kind !== "field" || first.value !== "账单") return false;
  if (group?.kind !== "and" || !Array.isArray(group.children) || group.children.length !== 3) return false;
  const [leaf, semantic, not] = group.children;
  return (
    leaf?.kind === "field" &&
    leaf.value === "发票" &&
    semantic?.kind === "semantic" &&
    semantic.expr === "正文在催我本周提交报告" &&
    not?.kind === "not" &&
    not.child?.kind === "field" &&
    not.child.op === "wholeWord" &&
    not.child.value === "Li"
  );
};
check("保存后 API 往返一致（结构性深比较）", saved !== undefined && treeOk(saved.tree), saved === undefined ? "missing" : JSON.stringify(saved.tree));
check("目标分类往返一致", saved?.categoryId === personalCategory?.id);

if (saved !== undefined) {
  await page.click(`[data-testid="rule-edit-${saved.id}"]`);
  await page.waitForSelector('[data-testid="rules-modal"]');
  await page.waitForTimeout(300);
  const formulaAfter = await page.locator('[data-testid="tree-formula"]').innerText();
  check("重新打开编辑器：公式与保存前一致", formulaAfter === formulaBefore, formulaAfter);
  await shot(page, "06-editor-reopen-roundtrip");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

/* ------------------------ 5. 深度上限 8（可达 + 拒绝） ------------------------ */

const nestedTree = (levels) => {
  let tree = { kind: "field", field: "subject", op: "contains", value: "深度测试" };
  for (let index = 0; index < levels; index += 1) {
    tree = { kind: "and", children: [tree] };
  }
  return tree;
};

const depth8 = await api("/rules", {
  method: "POST",
  body: JSON.stringify({
    name: "深度测试 · 8 层",
    categoryId: (await listCategories())[0].id,
    tree: nestedTree(8),
  }),
});
check("服务端接受深度 8 的条件树", depth8.status === 201, String(depth8.status));

const depth9 = await api("/rules", {
  method: "POST",
  body: JSON.stringify({
    name: "深度测试 · 9 层",
    categoryId: (await listCategories())[0].id,
    tree: nestedTree(9),
  }),
});
check(
  "服务端拒绝深度 9（depth_exceeded）",
  depth9.status === 400 && JSON.stringify(depth9.body).includes("depth_exceeded"),
  JSON.stringify(depth9.body),
);

if (depth8.body?.rule !== undefined) {
  await openRules(page);
  const depthRuleId = depth8.body.rule.id;
  await page.click(`[data-testid="rule-edit-${depthRuleId}"]`);
  await page.waitForSelector('[data-testid="rules-modal"]');
  await page.waitForTimeout(300);
  check(
    "编辑器显示深度 8 / 8",
    (await page.locator('[data-testid="tree-depth"]').innerText()).includes("8 / 8"),
  );
  const deepestPath = Array.from({ length: 7 }, () => "children.0").join(".");
  const deepestGroup = page.locator(`[data-tree-path="${deepestPath}"]`);
  check("深度 8 的分组「与分组」按钮被禁用", await deepestGroup.locator('button:has-text("与分组")').isDisabled());
  check("深度 8 的分组「否定」按钮被禁用", await deepestGroup.locator('button:has-text("否定")').isDisabled());
  check(
    "深度 8 的分组「非」按钮被禁用",
    await deepestGroup.locator('.segmented[aria-label="分组逻辑"] button').last().isDisabled(),
  );
  await deepestGroup.locator('button:has-text("与分组")').scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  check(
    "深度上限提示可见",
    (await page.locator('[data-testid="rule-tree-editor"]').innerText()).includes("已达最大嵌套深度 8"),
  );
  await shot(page, "07-depth-limit");
  await page.locator("text=已达最大嵌套深度 8").first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await shot(page, "07b-depth-limit-hint");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
}

/* ---------------------- 6. 规则启停 / 排序 / 拖拽 ---------------------- */

if (saved !== undefined) {
  const ruleRow = page.locator(`[data-testid="rule-row-${saved.id}"]`);
  await ruleRow.locator('input[type="checkbox"]').click();
  await page.waitForTimeout(900);
  const afterToggle = (await listRules()).find((rule) => rule.id === saved.id);
  check("UI 启停开关写入服务端（enabled=false）", afterToggle?.enabled === false);
  await page.locator(`[data-testid="rule-row-${saved.id}"] input[type="checkbox"]`).click();
  await page.waitForTimeout(900);
  const afterToggleBack = (await listRules()).find((rule) => rule.id === saved.id);
  check("再次点击恢复 enabled=true", afterToggleBack?.enabled === true);

  const beforeOrder = (await listRules()).map((rule) => rule.id);
  const savedIndex = beforeOrder.indexOf(saved.id);
  if (savedIndex > 0) {
    await page.locator(`[data-testid="rule-row-${saved.id}"] button[aria-label*="上移"]`).click();
    await page.waitForTimeout(900);
    const afterOrder = (await listRules()).map((rule) => rule.id);
    check("上移按钮调用 reorder 并持久化", afterOrder[savedIndex - 1] === saved.id, JSON.stringify(afterOrder));
  }

  const dragSource = page.locator(`[data-testid="rule-row-${saved.id}"]`);
  const dragTarget = page.locator('[data-testid="rule-list"] > li').first();
  const targetTestId = await dragTarget.getAttribute("data-testid");
  if (targetTestId !== null && !targetTestId.endsWith(saved.id)) {
    await dragSource.dragTo(dragTarget);
    await page.waitForTimeout(1100);
    const draggedOrder = (await listRules()).map((rule) => rule.id);
    check("拖拽排序写入服务端", draggedOrder[0] === saved.id, JSON.stringify(draggedOrder));
  }
}

/* ------------------ 6b. 重新计算按钮 + 删除规则确认 ------------------ */

await page.click('[data-testid="rule-recompute"]');
await page.waitForSelector('[data-testid="recompute-banner"]', { timeout: 10000 });
const finished = await page
  .waitForFunction(
    () => document.querySelector('[data-testid="recompute-banner"]')?.textContent?.includes("标签重算完成") === true,
    { timeout: 15000 },
  )
  .then(() => true)
  .catch(() => false);
check("「重新计算标签」触发后台重算并显示完成进度", finished);
// 等指针/动画状态稳定，避免把拖拽后的瞬时焦点环拍进证据。
await page.mouse.move(700, 500);
await page.waitForTimeout(500);
await shot(page, "06b-recompute-banner");

const seededCategory = (await listCategories())[0];
const toDelete = await api("/rules", {
  method: "POST",
  body: JSON.stringify({
    name: "待删除规则",
    categoryId: seededCategory.id,
    tree: { kind: "field", field: "subject", op: "contains", value: "临时" },
  }),
});
if (toDelete.status === 201) {
  await openRules(page);
  await page.click(`[data-testid="rule-delete-${toDelete.body.rule.id}"]`);
  await page.waitForSelector('[data-testid="rule-delete-confirm"]');
  await shot(page, "06c-rule-delete-confirm");
  await page.click('[data-testid="rule-delete-confirm"]');
  await page.waitForTimeout(1200);
  check("UI 删除规则（二次确认后生效）", !(await listRules()).some((rule) => rule.id === toDelete.body.rule.id));
}

/* ------------------- 7. 分类：删除二次确认（409 原文） ------------------- */

const tempCategory = await api("/categories", {
  method: "POST",
  body: JSON.stringify({ name: "临时分类", enterTodo: false, broadcast: false }),
});
const tempCategoryId = tempCategory.body?.category?.id;
if (typeof tempCategoryId === "string") {
  await api("/rules", {
    method: "POST",
    body: JSON.stringify({
      name: "临时规则",
      categoryId: tempCategoryId,
      tree: { kind: "field", field: "subject", op: "contains", value: "临时" },
    }),
  });

  await openRules(page);
  await page.click(`[data-testid="category-delete-${tempCategoryId}"]`);
  await page.waitForSelector('[data-testid="category-delete-warning"]');
  const warning = await page.locator('[data-testid="category-delete-warning"]').innerText();
  check(
    "删除确认框展示服务端 409 原文（含连带数量）",
    warning.includes("连带删除 1 条规则") && warning.includes("封邮件"),
    warning,
  );
  await shot(page, "08-category-delete-confirm");

  await page.click('[data-testid="category-delete-cancel"]');
  await page.waitForTimeout(400);
  check(
    "取消删除后分类仍在（未写入）",
    (await listCategories()).some((category) => category.id === tempCategoryId),
  );

  await page.click(`[data-testid="category-delete-${tempCategoryId}"]`);
  await page.waitForSelector('[data-testid="category-delete-confirm"]');
  await page.click('[data-testid="category-delete-confirm"]');
  await page.waitForTimeout(1200);
  check(
    "确认后分类被删除",
    !(await listCategories()).some((category) => category.id === tempCategoryId),
  );
  check(
    "确认后其规则被连带删除",
    !(await listRules()).some((rule) => rule.name === "临时规则"),
  );
  await shot(page, "09-category-deleted");
}

/* --------------------------- 8. 窄屏响应式 --------------------------- */

const narrowCtx = await browser.newContext({ viewport: { width: 820, height: 1000 }, deviceScaleFactor: 1.5 });
const narrowPage = await newPage(narrowCtx, "narrow");
await openRules(narrowPage);
await shot(narrowPage, "10-narrow-list");
if (saved !== undefined) {
  await narrowPage.click(`[data-testid="rule-edit-${saved.id}"]`);
  await narrowPage.waitForSelector('[data-testid="rules-modal"]');
  await narrowPage.waitForTimeout(300);
  await shot(narrowPage, "11-narrow-editor");
}
await narrowCtx.close();

const phoneCtx = await browser.newContext({ viewport: { width: 560, height: 1000 }, deviceScaleFactor: 1.5 });
const phonePage = await newPage(phoneCtx, "phone");
await openRules(phonePage);
await shot(phonePage, "12-phone-list");
const phoneText = await phonePage.evaluate(() => document.body.innerText);
check("560px 下规则页仍有可见内容（不白屏）", phoneText.includes("规则") && phoneText.includes("分类"));
await phoneCtx.close();

/* ---------------------------- 9. 空态文案 ---------------------------- */

for (const rule of await listRules()) {
  await api(`/rules/${encodeURIComponent(rule.id)}`, { method: "DELETE" });
}
await openRules(page);
const emptyRulesText = await page.evaluate(() => document.body.innerText);
check("空态：无规则时给出可见文案", emptyRulesText.includes("还没有规则"));
await shot(page, "13-empty-rules");

for (const category of await listCategories()) {
  await api(`/categories/${encodeURIComponent(category.id)}?confirm=true`, { method: "DELETE" });
}
await openRules(page);
const emptyAllText = await page.evaluate(() => document.body.innerText);
check("空态：无分类时给出可见文案", emptyAllText.includes("还没有分类"));
check("空态：「未分类」只读说明仍在", emptyAllText.includes("计算态"));
await shot(page, "14-empty-categories");

/* ------------------------- 10. 加载错误态文案 ------------------------- */

const errorCtx = await browser.newContext({ viewport, deviceScaleFactor: 1.5 });
const errorPage = await newPage(errorCtx, "error-state");
await errorPage.route("**/api/rules", (route) =>
  route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: { code: "internal", message: "模拟失败：规则服务不可用" } }),
  }),
);
await errorPage.goto(`${base}/`, { waitUntil: "networkidle" });
await errorPage.waitForTimeout(500);
await errorPage.locator('button[title="规则与分类"]').click();
await errorPage.waitForSelector('[data-testid="rules-retry"]', { timeout: 10000 });
const errorText = await errorPage.evaluate(() => document.body.innerText);
check("错误态：可见失败原因与重试按钮", errorText.includes("规则加载失败") && errorText.includes("模拟失败"));
await shot(errorPage, "15-error-state");
await errorCtx.close();

/* --------------------------------- 汇总 --------------------------------- */

await ctx.close();
await browser.close();

// 两类“预期内”的浏览器日志：
// - 错误态页面故意制造 500；
// - 删除非空分类的第一次不带 confirm 的请求必然 409（服务端契约要求用它拿连带数量），
//   浏览器会给每条 4xx 资源记一条 console error。除这两类外必须为零。
const expectedPatterns = [/^\[error-state\]/, /409 \(Conflict\)/];
const unexpectedErrors = consoleErrors.filter(
  (line) => !expectedPatterns.some((pattern) => pattern.test(line)),
);
const failed = findings.filter((finding) => !finding.ok);
console.log(
  `\nSUMMARY checks=${findings.length} failed=${failed.length} consoleErrors=${unexpectedErrors.length} (error-state expected: ${consoleErrors.length - unexpectedErrors.length})`,
);
for (const error of unexpectedErrors.slice(0, 10)) console.log(`  ${error}`);
process.exit(failed.length === 0 && unexpectedErrors.length === 0 ? 0 : 1);
