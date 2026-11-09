#!/usr/bin/env node
/**
 * 面板稳定性压测（C8 / AC-29…AC-35）。
 *
 * 覆盖的 phase：
 *   bundle     生产 dist 里不得出现测试用 forceThrow 开关；test dist 里必须存在（AC-31）
 *   cold       冷启首屏 + 首次进入时间线（AC-32：≤1000ms）
 *   rotation   四面板 ×100 轮轮换（每轮 4 次切换）
 *   repro      known-repro-inbox-timeline：收件箱↔时间线连续 60 次（≥50）
 *   double     快速双击 20 次（同一 tick 连点三次，最终落在预期面板）
 *   hidden     时间线隐藏期间改窗口尺寸，再显示：甘特图必须恢复尺寸（防「空白甘特」）
 *   chunk      甘特 chunk 失败 → 面板错误卡；恢复网络后「重试加载」必须真正重新加载
 *   chunkloop  chunk 永久 404 → 第 2 次失败自动整页重载仅一次 → 之后出现「刷新页面」兜底
 *   rules      规则面板：可进入、与收件箱往返切换（AC-35；不依赖具体控件）
 *   onboarding 初始化向导：可进入、与收件箱往返切换（AC-35；不依赖具体控件）
 *   offline    API 全断 → 离线提示；恢复后「重新连接」回实时数据
 *   empty      空库：四面板均为空态、body 非空、无 pageerror
 *   forced     仅测试构建：面板级/根级 ErrorBoundary 渲染「重试」「回首页」并可恢复
 *   heavy      1000 条任务：拖拽 3 次 + 缩放 3 次，UI/API 500ms 内一致（HEAVY=0 关闭）
 *
 * 断言口径（逐次）：body 非空、恰好一个激活面板、壳层（.sidebar）仍在、无 pageerror/console error；
 * 每个 phase 结束统一 drain。失败：整页截图 + 非 0 退出码；无论成败都写 JSON 报告到 evidence/perf/。
 * 已知缺失端点：STRESS_ALLOW_404（逗号分隔）命中的 404 记为 known-missing，报告单列、不计失败。
 *
 * 用法（仓库根目录）：
 *   node scripts/panel-stress.mjs                     # 完整跑（会用 1000 条任务）
 *   STRESS_HEAVY=0 node scripts/panel-stress.mjs      # 跳过 1000 条任务
 *   STRESS_LABEL=red node scripts/panel-stress.mjs    # 自定义报告前缀
 *   STRESS_BUILD=1 …                                  # 强制重建 dist / dist-test
 *   STRESS_PHASES=rules,onboarding …                  # 只跑指定 phase（调试用）
 *
 * 机器上没装浏览器时：PLAYWRIGHT_BROWSERS_PATH=<dir> node scripts/panel-stress.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = process.cwd();
const OUT_DIR = join(ROOT, "evidence/perf");
const SHOT_DIR = join(OUT_DIR, "screenshots");
const RUN_DIR = join(OUT_DIR, ".stress-data");
const LABEL = process.env.STRESS_LABEL ?? "green";
const BUILD = process.env.STRESS_BUILD === "1";
const HEAVY = process.env.STRESS_HEAVY !== "0";
const ROTATION_ROUNDS = Number(process.env.STRESS_ROTATION_ROUNDS ?? 100);
const REPRO_ROUNDS = Number(process.env.STRESS_REPRO_ROUNDS ?? 60);
const DOUBLE_ROUNDS = Number(process.env.STRESS_DOUBLE_ROUNDS ?? 20);
const KNOWN_404 = (process.env.STRESS_ALLOW_404 ?? "").split(",").map((value) => value.trim()).filter(Boolean);
const PHASES = process.env.STRESS_PHASES === undefined ? null : new Set(process.env.STRESS_PHASES.split(","));
const TOKEN = "stress-token";
const TSX = join(ROOT, "node_modules/tsx/dist/cli.mjs");
const VITE = join(ROOT, "node_modules/vite/bin/vite.js");

const report = {
  label: LABEL,
  startedAt: new Date().toISOString(),
  env: {
    machine: { platform: platform(), release: release(), cpus: cpus().length, memoryGb: Number((totalmem() / 1024 ** 3).toFixed(1)) },
    node: process.version,
    browser: "playwright chromium (headless shell)",
    viewport: "1440x960",
    sampleCounts: { rotationSwitches: ROTATION_ROUNDS * 4, reproSwitches: REPRO_ROUNDS, doubleClicks: DOUBLE_ROUNDS },
    known404: KNOWN_404,
  },
  phases: {},
  failures: [],
  samples: [],
  knownMissing: [],
};

const servers = [];
const browsers = [];
const failures = report.failures;

function fail(phase, message, extra = {}) {
  failures.push({ phase, message, ...extra });
  console.error(`  ✗ [${phase}] ${message}`);
}

function recordTiming(name, ms) {
  report.samples.push({ name, ms: Number(ms.toFixed(2)) });
}

function statsOf(samples) {
  if (samples.length === 0) return { n: 0, p50: 0, p95: 0, max: 0, min: 0 };
  const sorted = samples.map((sample) => sample.ms).sort((left, right) => left - right);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { n: sorted.length, min: round(at(0)), p50: round(at(0.5)), p95: round(at(0.95)), max: round(at(1)) };
}

function round(value) {
  return Number(value.toFixed(2));
}

function spawnChecked(command, args, options, label) {
  const child = spawn(command, args, { cwd: ROOT, ...options });
  let text = "";
  child.stdout?.on("data", (chunk) => (text += chunk));
  child.stderr?.on("data", (chunk) => (text += chunk));
  return new Promise((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve(text) : reject(new Error(`${label} exit ${code}\n${text.slice(-2000)}`))));
  });
}

async function seed(demoDir) {
  rmSync(demoDir, { recursive: true, force: true });
  mkdirSync(demoDir, { recursive: true });
  await spawnChecked(
    process.execPath,
    [TSX, join(ROOT, "scripts/seed-demo.ts")],
    { env: { ...process.env, MAILCOLLECT_DATA_DIR: demoDir }, stdio: ["ignore", "pipe", "pipe"] },
    "seed-demo",
  );
}

async function seedHeavy(heavyDir) {
  rmSync(heavyDir, { recursive: true, force: true });
  mkdirSync(heavyDir, { recursive: true });
  await spawnChecked(
    process.execPath,
    [TSX, join(ROOT, "scripts/seed-demo.ts")],
    { env: { ...process.env, MAILCOLLECT_DATA_DIR: heavyDir }, stdio: ["ignore", "pipe", "pipe"] },
    "seed-demo(heavy)",
  );
  const seedFile = join(RUN_DIR, "seed-1000.ts");
  writeFileSync(
    seedFile,
    `import { openStore } from ${JSON.stringify(join(ROOT, "packages/core/src/index.ts"))};
const store = await openStore(${JSON.stringify(join(heavyDir, "mailcollect.sqlite"))}, "stress-heavy");
const profile = store.getProfile();
if (profile === null) throw new Error("profile missing");
const base = Date.parse("2026-11-09T02:00:00.000Z");
const hours = 60 * 60 * 1000;
const tasks = Array.from({ length: 1000 }, (_, index) => {
  const start = new Date(base + index * 2 * hours);
  const end = new Date(start.getTime() + 3 * hours);
  return {
    id: "heavy-" + index,
    userId: profile.id,
    title: "压测任务 " + index,
    detail: null,
    owner: "me",
    ownerName: profile.displayName,
    kind: "action",
    status: "confirmed",
    origin: "personal",
    confidence: 0.9,
    evidenceQuote: "压测",
    sourceEmailId: "e1",
    threadId: null,
    time: { phrase: null, dueAt: null, windowStart: start.toISOString(), windowEnd: end.toISOString(), timezone: "Asia/Shanghai", confidence: 0.9 },
    createdAt: new Date(base).toISOString(),
    updatedAt: new Date(base).toISOString(),
  };
});
store.insertTasks(tasks);
store.close();
console.log("seeded 1000 tasks");
`,
  );
  await spawnChecked(
    process.execPath,
    [TSX, seedFile],
    { env: { ...process.env, MAILCOLLECT_DATA_DIR: heavyDir }, stdio: ["ignore", "pipe", "pipe"] },
    "seed-1000",
  );
}

async function startServer(dataDir, uiDir) {
  const child = spawn(process.execPath, [TSX, join(ROOT, "apps/server/src/main.ts")], {
    cwd: ROOT,
    env: { ...process.env, MAILCOLLECT_PORT: "0", MAILCOLLECT_DATA_DIR: dataDir, MAILCOLLECT_UI_DIR: uiDir, MAILCOLLECT_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "pipe"],
  });
  servers.push(child);
  let text = "";
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server timeout\n${text.slice(-1500)}`)), 30000);
    child.stdout.on("data", (chunk) => {
      text += chunk;
      const line = text.split("\n").find((entry) => entry.startsWith("MAILCOLLECT_READY "));
      if (line) {
        clearTimeout(timer);
        resolve(JSON.parse(line.slice("MAILCOLLECT_READY ".length)));
      }
    });
    child.stderr.on("data", (chunk) => (text += chunk));
  });
  return { child, base: `http://127.0.0.1:${ready.port}` };
}

function buildUi(mode) {
  const buildArgs = mode === "test" ? ["build", "--mode", "test", "--outDir", "dist-test"] : ["build"];
  return spawnChecked(process.execPath, [VITE, ...buildArgs], { cwd: join(ROOT, "apps/ui"), stdio: ["ignore", "pipe", "pipe"] }, `vite build ${mode}`);
}

async function newPage(browser, options = {}) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  page.errors = [];
  page.knownMissing = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const where = message.location()?.url ?? "";
    if (where.includes("favicon")) return;
    if (KNOWN_404.some((prefix) => where.includes(prefix))) {
      page.knownMissing.push(`${message.text()} @ ${where}`);
      return;
    }
    page.errors.push(`console: ${message.text()} @ ${where}`);
  });
  page.on("pageerror", (error) => page.errors.push(`pageerror: ${error.message}`));
  await page.addInitScript((token) => localStorage.setItem("mailcollect.token", token), TOKEN);
  if (options.injected === true) {
    // Electron 外壳会注入 window.__MAILCOLLECT__；注入后健康检查失败走「离线」而不是演示数据。
    await page.addInitScript((token) => {
      window.__MAILCOLLECT__ = { apiBase: "", token };
    }, TOKEN);
  }
  if (options.routeChunkBlock !== undefined) {
    const pattern = options.routeChunkBlock;
    const state = { blocked: true };
    await page.route(pattern, async (route) => {
      if (state.blocked) await route.abort("failed");
      else await route.continue();
    });
    page.setChunkBlocked = (blocked) => {
      state.blocked = blocked;
    };
  }
  page.resetErrors = () => {
    page.errors = [];
    page.knownMissing = [];
  };
  return page;
}

/** 首次运行会按 C3 自动全屏向导；它盖住侧栏，进入任何面板前先退出它。 */
async function dismissWizard(page) {
  const wizard = page.locator('[data-testid="onboarding-wizard"]');
  if ((await wizard.count()) === 0) return;
  const close = page.locator('[aria-label="退出向导"]');
  if ((await close.count()) > 0) {
    await close.first().click({ timeout: 5000 }).catch(() => undefined);
  } else {
    await page.keyboard.press("Escape");
  }
  await page.waitForTimeout(200);
}

async function clickNav(page, label) {
  await dismissWizard(page);
  const button = page.locator(".nav-item", { hasText: label });
  await button.click();
  await page.waitForTimeout(30);
}

/** 把初始化状态置为「已跳过」，避免每个 phase 都被自动全屏向导挡住；向导本身由 onboarding phase 显式访问。 */
async function markOnboardingSkipped(base) {
  try {
    const response = await fetch(`${base}/api/onboarding`, {
      method: "PUT",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ skipped: true }),
    });
    if (!response.ok) console.log(`  · 初始化状态写入失败 (${response.status})，将依赖自动退出向导`);
  } catch (error) {
    console.log(`  · 初始化状态写入异常：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 在页面内点击并计时到下一帧（含 React 提交与一次绘制），返回毫秒。 */
async function clickAndMeasure(page, label, id) {
  return page.evaluate(
    async ({ label, id }) => {
      const buttons = [...document.querySelectorAll(".nav-item")];
      const button = buttons.find((element) => element.textContent?.includes(label));
      if (button === undefined) throw new Error(`nav not found: ${label}`);
      const start = performance.now();
      button.click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const active = [...document.querySelectorAll('[data-panel-slot][data-active="true"]')].map((element) => element.getAttribute("data-panel-slot"));
      if (active.length !== 1 || active[0] !== id) throw new Error(`active=${JSON.stringify(active)} expected=${id}`);
      return performance.now() - start;
    },
    { label, id },
  );
}

async function invariant(page, phase, expectedId, screenshotName) {
  const state = await page.evaluate(() => {
    const active = [...document.querySelectorAll('[data-panel-slot][data-active="true"]')].map((element) => element.getAttribute("data-panel-slot"));
    return {
      active,
      text: document.body.innerText.trim().length,
      sidebar: document.querySelectorAll(".sidebar").length,
      rootChildren: document.getElementById("root")?.childElementCount ?? -1,
      errorCards: document.querySelectorAll("[data-error-scope]").length,
      chunkCards: document.querySelectorAll("[data-timeline-error]").length,
    };
  });
  const problems = [];
  if (state.active.length !== 1) problems.push(`active slots=${JSON.stringify(state.active)}`);
  if (expectedId !== null && state.active[0] !== expectedId) problems.push(`active=${state.active[0]} expected=${expectedId}`);
  if (state.text === 0) problems.push("body 是空的（白屏）");
  if (state.sidebar !== 1) problems.push(`sidebar=${state.sidebar}`);
  if (state.rootChildren < 1) problems.push("root 没有子节点（整树被卸载）");
  if (state.errorCards !== 0) problems.push(`出现错误卡=${state.errorCards}`);
  if (state.chunkCards !== 0) problems.push(`出现 chunk 错误卡=${state.chunkCards}`);
  if (problems.length > 0) {
    const path = join(SHOT_DIR, `${LABEL}-${phase}-${screenshotName}.png`);
    await page.screenshot({ path, fullPage: true });
    fail(phase, `${screenshotName}: ${problems.join("; ")}（截图 ${path}）`);
    return false;
  }
  return true;
}

function drainErrors(page, phase, allow = []) {
  const unexpected = page.errors.filter((error) => !allow.some((fragment) => error.includes(fragment)));
  if (unexpected.length > 0) {
    fail(phase, `console/pageerror: ${unexpected.slice(0, 3).join(" | ")}`);
    page.errors = [];
    return false;
  }
  page.errors = [];
  if (page.knownMissing.length > 0) {
    report.knownMissing.push(...page.knownMissing.slice(0, 1));
    page.knownMissing = [];
  }
  return true;
}

async function runPhase(phase, fn) {
  if (PHASES !== null && !PHASES.has(phase)) {
    console.log(`\n⏭ ${phase}（按 STRESS_PHASES 跳过）`);
    return;
  }
  const started = Date.now();
  console.log(`\n▶ ${phase}`);
  report.phases[phase] = { ...(report.phases[phase] ?? {}) };
  try {
    await fn();
  } catch (error) {
    fail(phase, `异常: ${error instanceof Error ? error.message : String(error)}`);
  }
  report.phases[phase] = {
    ...(report.phases[phase] ?? {}),
    ms: Date.now() - started,
    failures: failures.filter((entry) => entry.phase === phase).length,
  };
}

async function waitForGantt(page, timeout = 15000) {
  await page.waitForFunction(
    () => {
      const data = document.querySelector(".gantt_data_area");
      const grid = document.querySelector(".gantt_grid");
      return data instanceof HTMLElement && grid !== null && data.getBoundingClientRect().width > 0;
    },
    { timeout },
  );
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(SHOT_DIR, { recursive: true });
  mkdirSync(RUN_DIR, { recursive: true });

  const prodUi = process.env.STRESS_UI_DIR === undefined ? join(ROOT, "apps/ui/dist") : join(ROOT, process.env.STRESS_UI_DIR);
  const testUi = join(ROOT, "apps/ui/dist-test");
  if (BUILD || !existsSync(join(prodUi, "index.html"))) {
    console.log("· 构建生产 UI …");
    await buildUi("prod");
  }
  if (!existsSync(join(testUi, "index.html"))) {
    console.log("· 构建仅测试 UI …");
    await buildUi("test");
  }

  const demoDir = join(RUN_DIR, `${LABEL}-demo`);
  await seed(demoDir);
  const mainServer = await startServer(demoDir, prodUi);
  await markOnboardingSkipped(mainServer.base);

  const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  browsers.push(browser);

  await runPhase("bundle", async () => {
    const scan = (dir) => {
      if (!existsSync(dir)) return { files: 0, hits: 0 };
      let files = 0;
      let hits = 0;
      for (const name of readdirSync(dir)) {
        if (!name.endsWith(".js")) continue;
        files += 1;
        if (readFileSync(join(dir, name), "utf8").includes("forceThrow")) hits += 1;
      }
      return { files, hits };
    };
    const prod = scan(join(prodUi, "assets"));
    const test = scan(join(testUi, "assets"));
    report.phases.bundle = { prod, test };
    if (prod.files === 0) fail("bundle", `生产 dist 没有可扫描的 JS（${join(prodUi, "assets")}）`);
    else if (prod.hits > 0) fail("bundle", `生产构建仍含 forceThrow 开关（${prod.hits} 个文件；AC-31 要求生产不可达）`);
    else console.log(`  · 生产构建 ${prod.files} 个 JS，forceThrow 命中 0`);
    if (test.hits === 0) fail("bundle", "测试构建里没有 forceThrow 开关，forced phase 无法验证");
    else console.log(`  · 测试构建 ${test.files} 个 JS，forceThrow 命中 ${test.hits}`);
  });

  /* ------------------------------- cold + rotation ------------------------------- */
  await runPhase("cold", async () => {
    const page = await newPage(browser);
    const started = Date.now();
    await page.goto(`${mainServer.base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sidebar", { timeout: 20000 });
    report.phases.cold.bootMs = Date.now() - started;
    recordTiming("cold-boot", report.phases.cold.bootMs);
    // 首次运行会按 C3 自动全屏初始化向导：冷启落点允许 inbox 或 onboarding，只要求恰好一个面板。
    await page.waitForTimeout(350);
    const initial = await page.evaluate(() =>
      [...document.querySelectorAll('[data-panel-slot][data-active="true"]')].map((element) => element.getAttribute("data-panel-slot")),
    );
    report.phases.cold.initialPanel = initial[0] ?? null;
    await invariant(page, "cold", initial[0] ?? null, "boot");
    if (report.phases.cold.bootMs > 3000) fail("cold", `冷启首屏 ${report.phases.cold.bootMs}ms > 3000ms`);

    const firstVisit = Date.now();
    await clickNav(page, "时间线");
    await waitForGantt(page);
    const coldTimelineMs = Date.now() - firstVisit;
    report.phases.cold.timelineFirstPaintMs = coldTimelineMs;
    recordTiming("cold-timeline-first-paint", coldTimelineMs);
    if (coldTimelineMs > 1000) fail("cold", `首次时间线 ${coldTimelineMs}ms > 1000ms（AC-32）`);
    drainErrors(page, "cold");
    await page.close();
  });

  await runPhase("rotation", async () => {
    const page = await newPage(browser);
    await page.goto(`${mainServer.base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sidebar");
    const order = [
      { id: "inbox", label: "收件箱" },
      { id: "tasks", label: "待办" },
      { id: "timeline", label: "时间线" },
      { id: "settings", label: "设置" },
    ];
    const timings = [];
    for (let round = 0; round < ROTATION_ROUNDS; round += 1) {
      for (const entry of order) {
        const ms = await clickAndMeasure(page, entry.label, entry.id);
        timings.push(ms);
        recordTiming(`rotation:${entry.id}`, ms);
        const ok = await invariant(page, `rotation[${round}]`, entry.id, `${entry.id}-r${round}`);
        if (!ok) {
          report.phases.rotation = { ...(report.phases.rotation ?? {}), firstFailureRound: round };
          return;
        }
      }
      if (round === 0 || (round + 1) % 25 === 0) console.log(`  · 第 ${round + 1}/${ROTATION_ROUNDS} 轮 ok`);
    }
    const stats = statsOf(timings.map((ms) => ({ ms })));
    report.phases.rotation.timing = stats;
    console.log(`  · 切换 ${timings.length} 次 p50=${stats.p50} p95=${stats.p95} max=${stats.max}ms`);
    if (stats.p95 > 200) fail("rotation", `热切换 p95=${stats.p95}ms > 200ms（AC-32）`);
    if (stats.max > 500) fail("rotation", `热切换 max=${stats.max}ms > 500ms（AC-32）`);
    drainErrors(page, "rotation");
    await page.close();
  });

  await runPhase("repro", async () => {
    const page = await newPage(browser);
    await page.goto(`${mainServer.base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sidebar");
    await clickNav(page, "时间线");
    await waitForGantt(page);
    const timings = [];
    for (let index = 0; index < REPRO_ROUNDS; index += 1) {
      const toTimeline = index % 2 === 0;
      const entry = toTimeline ? { id: "timeline", label: "时间线" } : { id: "inbox", label: "收件箱" };
      const ms = await clickAndMeasure(page, entry.label, entry.id);
      timings.push(ms);
      recordTiming(`repro:${entry.id}`, ms);
      const ok = await invariant(page, `repro[${index}]`, entry.id, `${entry.id}-n${index}`);
      if (!ok) return;
      if (toTimeline) {
        const gantt = await page.evaluate(() => {
          const data = document.querySelector(".gantt_data_area");
          return data instanceof HTMLElement ? data.getBoundingClientRect().width : 0;
        });
        if (gantt <= 0) {
          const path = join(SHOT_DIR, `${LABEL}-repro-${index}-blank-gantt.png`);
          await page.screenshot({ path, fullPage: true });
          fail("repro", `第 ${index} 次回到时间线：甘特图宽度=0（截图 ${path}）`);
          return;
        }
      }
      if (index % 20 === 0) console.log(`  · ${index + 1}/${REPRO_ROUNDS} ok`);
    }
    const stats = statsOf(timings.map((ms) => ({ ms })));
    report.phases.repro.timing = stats;
    console.log(`  · ${REPRO_ROUNDS} 次切换 p50=${stats.p50} p95=${stats.p95} max=${stats.max}ms`);
    drainErrors(page, "repro");
    await page.close();
  });

  await runPhase("double", async () => {
    const page = await newPage(browser);
    await page.goto(`${mainServer.base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sidebar");
    await clickNav(page, "时间线");
    await waitForGantt(page);
    for (let index = 0; index < DOUBLE_ROUNDS; index += 1) {
      const target = index % 2 === 0 ? "inbox" : "timeline";
      const result = await page.evaluate((target) => {
        const find = (label) => [...document.querySelectorAll(".nav-item")].find((element) => element.textContent?.includes(label));
        const first = target === "inbox" ? find("收件箱") : find("时间线");
        const second = target === "inbox" ? find("时间线") : find("收件箱");
        if (first === undefined || second === undefined) throw new Error("nav missing");
        first.click();
        second.click();
        first.click();
        return true;
      }, target);
      if (!result) fail("double", "双击脚本失败");
      await page.waitForTimeout(60);
      const ok = await invariant(page, `double[${index}]`, target, `${target}-d${index}`);
      if (!ok) return;
    }
    drainErrors(page, "double");
    await page.close();
  });

  await runPhase("hidden", async () => {
    const page = await newPage(browser);
    await page.goto(`${mainServer.base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sidebar");
    await clickNav(page, "时间线");
    await waitForGantt(page);
    await clickNav(page, "收件箱");
    await page.waitForTimeout(120);
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.waitForTimeout(200);
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.waitForTimeout(200);
    await clickNav(page, "时间线");
    await waitForGantt(page);
    const state = await page.evaluate(() => {
      const data = document.querySelector(".gantt_data_area");
      return {
        width: data instanceof HTMLElement ? data.getBoundingClientRect().width : 0,
        bars: document.querySelectorAll(".gantt_task_line").length,
      };
    });
    report.phases.hidden.width = state.width;
    report.phases.hidden.bars = state.bars;
    if (state.width <= 0) fail("hidden", "隐藏→显示后 gantt_data_area 宽度仍为 0（空白甘特）");
    if (state.bars === 0) fail("hidden", "隐藏→显示后没有任何任务条（空白甘特）");
    await invariant(page, "hidden", "timeline", "restored");
    drainErrors(page, "hidden");
    await page.close();
  });

  await runPhase("rules", async () => {
    const page = await newPage(browser);
    await page.goto(`${mainServer.base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sidebar", { timeout: 20000 });
    // 首次运行可能自动全屏向导：先回收件箱，保证从稳定状态出发。
    await clickNav(page, "收件箱").catch(() => undefined);
    await clickNav(page, "规则");
    await page.waitForTimeout(500);
    const opened = await invariant(page, "rules", "rules", "open");
    if (!opened) return;
    for (let index = 0; index < 10; index += 1) {
      const entry = index % 2 === 0 ? { id: "inbox", label: "收件箱" } : { id: "rules", label: "规则" };
      await clickAndMeasure(page, entry.label, entry.id);
      const ok = await invariant(page, `rules[${index}]`, entry.id, `${entry.id}-n${index}`);
      if (!ok) return;
    }
    console.log("  · 规则面板往返 10 次 ok");
    drainErrors(page, "rules");
    await page.close();
  });

  await runPhase("onboarding", async () => {
    const page = await newPage(browser);
    await page.goto(`${mainServer.base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sidebar", { timeout: 20000 });
    for (let index = 0; index < 5; index += 1) {
      await clickNav(page, "初始化");
      await page.waitForSelector('[data-testid="onboarding-wizard"]', { timeout: 15000 });
      const opened = await invariant(page, `onboarding[${index}]`, "onboarding", `open-${index}`);
      if (!opened) return;
      // 只断言「向导能打开、壳层还在、无报错」；具体控件属于 T31 的写域，不在此依赖。
      const close = page.locator('[aria-label="退出向导"]');
      if ((await close.count()) === 0) {
        fail("onboarding", "向导没有可用的退出入口，无法验证回到收件箱");
        return;
      }
      await close.first().click();
      await page.waitForTimeout(300);
      const back = await invariant(page, `onboarding-back[${index}]`, "inbox", `back-${index}`);
      if (!back) return;
    }
    console.log("  · 初始化向导打开/退出往返 5 次 ok");
    drainErrors(page, "onboarding");
    await page.close();
  });

  await runPhase("chunk", async () => {
    const page = await newPage(browser, { routeChunkBlock: "**/GanttChart-*.js" });
    await page.goto(`${mainServer.base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sidebar");
    await clickNav(page, "时间线");
    await page.waitForTimeout(700);
    const blocked = await page.evaluate(() => ({
      text: document.body.innerText.trim().length,
      sidebar: document.querySelectorAll(".sidebar").length,
      chunkCard: document.querySelectorAll("[data-timeline-error]").length,
      boundaryCard: document.querySelectorAll("[data-error-scope]").length,
      gantt: document.querySelectorAll(".gantt_grid").length,
    }));
    if (blocked.text === 0 || blocked.sidebar !== 1) fail("chunk", `chunk 失败时壳层不保活: ${JSON.stringify(blocked)}`);
    if (blocked.chunkCard + blocked.boundaryCard === 0) fail("chunk", "chunk 失败时没有错误卡");
    if (blocked.gantt > 0) fail("chunk", "chunk 被阻断却渲染出了甘特图");
    await page.setChunkBlocked(false);
    const retry = page.locator("button", { hasText: /重试/ });
    if ((await retry.count()) === 0) {
      fail("chunk", "chunk 失败后没有「重试」按钮，无法恢复");
    } else {
      await retry.first().click();
      try {
        await waitForGantt(page, 10000);
        console.log("  · 恢复网络后重试成功重新加载 chunk");
      } catch {
        fail("chunk", "恢复网络后点「重试」仍加载不出甘特图（React.lazy 缓存了被拒绝的 Promise）");
      }
    }
    await invariant(page, "chunk", "timeline", "after-retry").catch(() => undefined);
    drainErrors(page, "chunk", ["Failed to load resource", "Failed to fetch dynamically imported module", "渲染失败"]);
    await page.close();
  });

  await runPhase("chunkloop", async () => {
    const page = await newPage(browser, { routeChunkBlock: "**/GanttChart-*.js" });
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });
    await page.goto(`${mainServer.base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sidebar", { timeout: 20000 });
    navigations = 1;
    await clickNav(page, "时间线");
    await page.waitForSelector("[data-timeline-error=chunk]", { timeout: 15000 });
    const first = await page.evaluate(() => ({
      failures: document.querySelector("[data-timeline-error=chunk]")?.getAttribute("data-chunk-failures"),
      refresh: [...document.querySelectorAll("button")].some((button) => button.innerText.includes("刷新页面")),
      home: [...document.querySelectorAll("button")].some((button) => button.innerText.includes("回首页")),
      reloadedFlag: sessionStorage.getItem("mailcollect.gantt-chunk-auto-reloaded"),
    }));
    if (first.failures !== "1") fail("chunkloop", `第 1 次失败计数=${first.failures}（期望 1）`);
    if (first.refresh) fail("chunkloop", "第 1 次失败就出现「刷新页面」，阈值没生效");
    if (!first.home) fail("chunkloop", "chunk 错误卡没有「回首页」（C8）");
    if (first.reloadedFlag !== null) fail("chunkloop", "第 1 次失败就写了自动重载标记");

    // 第 2 次失败：会话内自动整页重载恰好一次。
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }),
      page.locator("button", { hasText: /重试加载/ }).click(),
    ]);
    await page.waitForSelector(".sidebar", { timeout: 20000 });
    const afterReload = await page.evaluate(() => ({
      flag: sessionStorage.getItem("mailcollect.gantt-chunk-auto-reloaded"),
    }));
    if (navigations !== 2) fail("chunkloop", `自动重载次数异常：导航计数=${navigations}（期望 2）`);
    if (afterReload.flag !== "1") fail("chunkloop", "自动重载后没有写 sessionStorage 守卫标记");
    console.log("  · 第 2 次失败触发自动整页重载一次（守卫已写）");

    // 再次失败：守卫生效，不再自动重载，必须出现「刷新页面」兜底。
    await clickNav(page, "时间线");
    await page.waitForSelector("[data-timeline-error=chunk]", { timeout: 15000 });
    await page.locator("button", { hasText: /重试加载/ }).click();
    await page.waitForTimeout(900);
    const second = await page.evaluate(() => ({
      failures: document.querySelector("[data-timeline-error=chunk]")?.getAttribute("data-chunk-failures"),
      refresh: [...document.querySelectorAll("button")].some((button) => button.innerText.includes("刷新页面")),
      home: [...document.querySelectorAll("button")].some((button) => button.innerText.includes("回首页")),
    }));
    if (navigations !== 2) fail("chunkloop", `守卫失效：第 3 次失败又自动导航（计数=${navigations}）`);
    if (second.failures !== "2") fail("chunkloop", `第 2 次失败计数=${second.failures}（期望 2）`);
    if (!second.refresh) fail("chunkloop", "第 2 次失败后没有出现「刷新页面」兜底，用户会卡死在无效重试");
    if (!second.home) fail("chunkloop", "chunk 错误卡缺少「回首页」");
    await page.screenshot({ path: join(SHOT_DIR, `${LABEL}-chunkloop-fallback.png`), fullPage: true });

    // 恢复网络后「刷新页面」必须拿到可用入口并加载出甘特图。
    await page.setChunkBlocked(false);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }),
      page.locator("button", { hasText: /刷新页面/ }).click(),
    ]);
    await page.waitForSelector(".sidebar", { timeout: 20000 });
    await clickNav(page, "时间线");
    try {
      await waitForGantt(page, 15000);
      console.log("  · 恢复网络后「刷新页面」拿回可用入口");
    } catch {
      fail("chunkloop", "恢复网络后「刷新页面」仍加载不出甘特图");
    }
    drainErrors(page, "chunkloop", ["Failed to load resource", "Failed to fetch dynamically imported module", "渲染失败"]);
    await page.close();
  });

  await runPhase("offline", async () => {
    const page = await newPage(browser, { injected: true });
    await page.route("**/api/**", (route) => route.abort("failed"));
    await page.goto(`${mainServer.base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const offline = await page.evaluate(() => ({
      text: document.body.innerText.trim().length,
      sidebar: document.querySelectorAll(".sidebar").length,
      rootChildren: document.getElementById("root")?.childElementCount ?? -1,
      body: document.body.innerText.slice(0, 80),
    }));
    if (offline.text === 0) fail("offline", "断网时 body 为空（白屏）");
    if (offline.rootChildren < 1) fail("offline", "断网时 root 没有子节点");
    if (!offline.body.includes("本地服务未连接")) fail("offline", `断网时没有离线提示: ${JSON.stringify(offline.body)}`);
    await page.screenshot({ path: join(SHOT_DIR, `${LABEL}-offline.png`), fullPage: true });
    console.log(`  · 离线界面: ${JSON.stringify(offline.body)}`);
    await page.unroute("**/api/**");
    const reconnect = page.locator("button", { hasText: /重新连接/ });
    if ((await reconnect.count()) > 0) {
      await reconnect.first().click();
      await page.waitForSelector(".sidebar", { timeout: 15000 }).catch(() => undefined);
      const recovered = await page.evaluate(() => ({
        sidebar: document.querySelectorAll(".sidebar").length,
        text: document.body.innerText.trim().length,
      }));
      if (recovered.sidebar !== 1 || recovered.text === 0) fail("offline", `恢复网络后没有回到实时界面: ${JSON.stringify(recovered)}`);
      else console.log("  · 恢复网络后「重新连接」回到实时界面");
    } else {
      fail("offline", "离线界面没有「重新连接」按钮");
    }
    drainErrors(page, "offline", ["Failed to load resource", "net::ERR_FAILED"]);
    await page.close();
  });

  await runPhase("empty", async () => {
    const emptyDir = join(RUN_DIR, `${LABEL}-empty`);
    rmSync(emptyDir, { recursive: true, force: true });
    mkdirSync(emptyDir, { recursive: true });
    const emptyServer = await startServer(emptyDir, prodUi);
    await markOnboardingSkipped(emptyServer.base);
    const page = await newPage(browser);
    await page.goto(`${emptyServer.base}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sidebar", { timeout: 20000 });
    for (const entry of [
      { id: "inbox", label: "收件箱" },
      { id: "tasks", label: "待办" },
      { id: "timeline", label: "时间线" },
      { id: "settings", label: "设置" },
    ]) {
      await clickNav(page, entry.label);
      await page.waitForTimeout(250);
      const ok = await invariant(page, "empty", entry.id, entry.id);
      if (!ok) return;
    }
    await invariant(page, "empty", "settings", "final");
    drainErrors(page, "empty");
    await page.close();
  });

  await runPhase("forced", async () => {
    const testServer = await startServer(demoDir, testUi);
    const page = await newPage(browser);
    await page.goto(`${testServer.base}/?forceThrow=timeline`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sidebar", { timeout: 20000 });
    await clickNav(page, "时间线");
    await page.waitForTimeout(500);
    const panelState = await page.evaluate(() => ({
      sidebar: document.querySelectorAll(".sidebar").length,
      panelCard: document.querySelectorAll("[data-error-scope=panel]").length,
      buttons: [...document.querySelectorAll("button")].map((button) => button.innerText.trim()).filter((text) => text === "重试" || text === "回首页"),
    }));
    if (panelState.panelCard !== 1) fail("forced", `面板级错误卡未出现: ${JSON.stringify(panelState)}`);
    if (panelState.sidebar !== 1) fail("forced", "面板级错误卡出现时壳层被卸载");
    if (panelState.buttons.length !== 2) fail("forced", "面板级错误卡缺少「重试」「回首页」");
    const retry = page.locator("button", { hasText: /^重试$/ });
    if ((await retry.count()) > 0) {
      await retry.first().click();
      try {
        await waitForGantt(page, 10000);
        console.log("  · 面板级「重试」恢复了时间线");
      } catch {
        fail("forced", "面板级「重试」后时间线没有恢复");
      }
    }
    await page.goto(`${testServer.base}/?forceThrow=timeline`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".sidebar");
    await clickNav(page, "时间线");
    await page.waitForTimeout(400);
    const home = page.locator("button", { hasText: /^回首页$/ });
    if ((await home.count()) > 0) {
      await home.first().click();
      await page.waitForTimeout(400);
      await invariant(page, "forced", "inbox", "home");
    } else {
      fail("forced", "面板级错误卡缺少「回首页」");
    }
    await page.goto(`${testServer.base}/?forceThrow=root`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(900);
    const rootState = await page.evaluate(() => ({
      rootCard: document.querySelectorAll("[data-error-scope=root]").length,
      rootChildren: document.getElementById("root")?.childElementCount ?? -1,
      buttons: [...document.querySelectorAll("button")].map((button) => button.innerText.trim()).filter((text) => text === "重试" || text === "回首页"),
    }));
    if (rootState.rootCard !== 1) fail("forced", `根级错误卡未出现: ${JSON.stringify(rootState)}`);
    if (rootState.rootChildren < 1) fail("forced", "根级错误卡时 #root 被卸载");
    if (rootState.buttons.length !== 2) fail("forced", "根级错误卡缺少「重试」「回首页」");
    const rootRetry = page.locator("button", { hasText: /^重试$/ });
    if ((await rootRetry.count()) > 0) {
      await rootRetry.first().click();
      await page.waitForSelector(".sidebar", { timeout: 15000 });
      console.log("  · 根级「重试」恢复了应用");
    }
    drainErrors(page, "forced", ["forced render error", "渲染失败", "The above error occurred"]);
    await page.close();
  });

  if (HEAVY) {
    await runPhase("heavy", async () => {
      const heavyDir = join(RUN_DIR, `${LABEL}-heavy`);
      await seedHeavy(heavyDir);
      const heavyServer = await startServer(heavyDir, prodUi);
      await markOnboardingSkipped(heavyServer.base);
      const page = await newPage(browser);
      const started = Date.now();
      await page.goto(`${heavyServer.base}/`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".sidebar", { timeout: 30000 });
      await clickNav(page, "时间线");
      await waitForGantt(page, 30000);
      const firstPaint = Date.now() - started;
      report.phases.heavy.coldTimelineMs = firstPaint;
      recordTiming("heavy-1000-cold-timeline", firstPaint);
      console.log(`  · 1000 条任务首次进入时间线 ${firstPaint}ms`);
      if (firstPaint > 1000) fail("heavy", `1000 条任务冷启时间线 ${firstPaint}ms > 1000ms（AC-32）`);

      const api = async (path, init) => {
        const response = await fetch(`${heavyServer.base}${path}`, {
          ...init,
          headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init?.headers ?? {}) },
        });
        return response.json();
      };
      const tasksBefore = await api("/api/tasks");
      report.phases.heavy.apiTasks = tasksBefore.items.length;
      if (tasksBefore.items.length < 1000) fail("heavy", `API 只返回 ${tasksBefore.items.length} 条任务（期望 1000）`);
      const barCount = await page.evaluate(() => document.querySelectorAll(".gantt_task_line").length);
      report.phases.heavy.bars = barCount;
      // dhtmlx 只渲染当前视口的行，条数少于 1000 属于虚拟滚动的正常表现，仅记录。
      console.log(`  · 视口内任务条 ${barCount} 个，API 返回 ${tasksBefore.items.length} 条`);

      // 3 次拖拽：在当前视口选一条可见任务条，500ms 内 /api/tasks 必须反映新的时间窗。
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const picked = await page.evaluate(() => {
          const bars = [...document.querySelectorAll(".gantt_task_line")];
          const bar = bars.find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.width > 2 && rect.height > 4;
          });
          if (bar === undefined) return null;
          bar.scrollIntoView({ block: "center" });
          const rect = bar.getBoundingClientRect();
          // 抓条的左三分之一：右边缘是 resize 手柄，点它会是「改时长」而不是「改期」。
          return {
            id: bar.getAttribute("task_id") ?? bar.getAttribute("data-task-id"),
            x: rect.x + Math.min(rect.width / 3, 10),
            y: rect.y + rect.height / 2,
          };
        });
        if (picked === null || picked.id === null) {
          fail("heavy", "当前视口没有可拖拽的任务条");
          break;
        }
        await page.mouse.move(picked.x, picked.y);
        await page.mouse.down();
        await page.mouse.move(picked.x + 60, picked.y, { steps: 10 });
        await page.mouse.up();
        const startedDrag = Date.now();
        let consistent = false;
        for (let poll = 0; poll < 10; poll += 1) {
          const after = await api("/api/tasks");
          const previous = tasksBefore.items.find((task) => task.id === picked.id);
          const current = after.items.find((task) => task.id === picked.id);
          if (previous !== undefined && current !== undefined && JSON.stringify(previous.time) !== JSON.stringify(current.time)) {
            consistent = true;
            break;
          }
          await page.waitForTimeout(50);
        }
        const elapsed = Date.now() - startedDrag;
        recordTiming("heavy-drag-roundtrip", elapsed);
        if (!consistent) fail("heavy", `第 ${attempt + 1} 次拖拽后 API 没有变化（task=${picked.id}）`);
        if (elapsed > 500) fail("heavy", `第 ${attempt + 1} 次拖拽 API 往返 ${elapsed}ms > 500ms`);
        else console.log(`  · 拖拽 ${attempt + 1}/3 ok (${elapsed}ms)`);
        tasksBefore.items = (await api("/api/tasks")).items;
      }

      // 3 次缩放：日/周/月切换，每次 500ms 内刻度列宽必须变化。
      for (const label of ["日", "周", "月"]) {
        const startedZoom = Date.now();
        const before = await page.evaluate(() => document.querySelector(".gantt_scale_cell")?.getBoundingClientRect().width ?? 0);
        await page.locator(".segmented button", { hasText: label }).click();
        await page.waitForTimeout(120);
        const after = await page.evaluate(() => document.querySelector(".gantt_scale_cell")?.getBoundingClientRect().width ?? 0);
        const elapsed = Date.now() - startedZoom;
        recordTiming("heavy-zoom", elapsed);
        if (after === 0) fail("heavy", `缩放「${label}」后刻度丢失`);
        else if (before === after) fail("heavy", `缩放「${label}」后刻度列宽未变化（before=${before} after=${after}）`);
        if (elapsed > 500) fail("heavy", `缩放「${label}」耗时 ${elapsed}ms > 500ms`);
      }

      await invariant(page, "heavy", "timeline", "final");
      drainErrors(page, "heavy");
      await page.close();
    });
  }

  /* ------------------------------- 汇总 ------------------------------- */
  for (const browser of browsers) await browser.close().catch(() => undefined);
  for (const server of servers) server.kill("SIGTERM");

  const hot = report.samples.filter(
    (sample) => sample.name.startsWith("rotation:") || sample.name.startsWith("repro:"),
  );
  report.summary = {
    hotSwitch: statsOf(hot),
    coldBootMs: report.phases.cold?.bootMs ?? null,
    coldTimelineFirstPaintMs: report.phases.cold?.timelineFirstPaintMs ?? null,
    failures: failures.length,
    passed: failures.length === 0,
  };
  report.finishedAt = new Date().toISOString();
  const reportPath = join(OUT_DIR, `panel-stress-${LABEL}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  console.log(`\n${failures.length === 0 ? "✔ PASS" : "✖ FAIL"} 报告: ${reportPath}`);
  if (failures.length > 0) {
    for (const failure of failures.slice(0, 20)) console.log(`  - [${failure.phase}] ${failure.message}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

try {
  await main();
} catch (error) {
  fail("harness", error instanceof Error ? error.stack ?? error.message : String(error));
  for (const server of servers) server.kill("SIGTERM");
  const reportPath = join(OUT_DIR, `panel-stress-${LABEL}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.error(`✖ harness failed; 报告: ${reportPath}`);
  process.exit(1);
}
