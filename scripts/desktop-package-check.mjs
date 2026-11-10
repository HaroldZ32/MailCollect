#!/usr/bin/env node
/**
 * 打包产物冒烟检查：直接读 electron-builder 产出的 app.asar，证明真正会随
 * 安装包发布的 server.mjs 能启动、SQL 资产齐全、API 路径不会被 SPA 兜底吃掉。
 *
 * 背景：单元测试跑的是源码，两个只会在 app.asar 里发作的问题它看不见——
 *   1. schema-v11.sql 没被复制进包，服务一启动就 ENOENT；
 *   2. 渲染进程拼出 //api/*，静态托管回 index.html，前端 response.json() 抛错。
 *
 * 用法：node scripts/desktop-package-check.mjs --asar <path-to-app.asar>
 * 退出码：0 = 全部通过；1 = 断言失败（产物坏了）；2 = --asar 缺失或文件不存在。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const USAGE = "node scripts/desktop-package-check.mjs --asar <path-to-app.asar>";
const DIST_ELECTRON = "dist-electron";
const READY_PREFIX = "MAILCOLLECT_READY ";
const READY_TIMEOUT_MS = 20_000;
const HTTP_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 3_000;
const MAX_CAPTURE = 64 * 1024;
const REQUIRED_SQL_ASSETS = ["schema.sql", "schema-v11.sql"];
const VERSION_SENTINEL = "0.0.0-package-check";

const checks = [];
const skips = [];

const recordCheck = (name, ok, detail = "") => {
  checks.push({ name, ok: Boolean(ok), detail });
  if (!ok) {
    console.log(`FAIL  ${name}`);
    if (detail) {
      for (const line of detail.split("\n")) console.log(`      ${line}`);
    }
    return;
  }
  console.log(`PASS  ${name}${detail ? `  (${detail})` : ""}`);
};

const recordSkip = (name, reason) => {
  skips.push({ name, reason });
  console.log(`SKIP  ${name}  — ${reason}`);
};

const dieUsage = (message) => {
  console.error(`ERROR  ${message}`);
  console.error(`Usage: ${USAGE}`);
  process.exit(2);
};

const preview = (text, max = 200) => {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return "<empty>";
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const asNumber = (value) => (typeof value === "number" ? value : Number(value));

function parseArgs(argv) {
  let asar = "";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--asar") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) dieUsage("--asar needs a path");
      asar = value;
      index += 1;
    } else if (arg.startsWith("--asar=")) {
      asar = arg.slice("--asar=".length);
    } else if (arg === "--help" || arg === "-h") {
      console.log(`Usage: ${USAGE}`);
      process.exit(0);
    } else {
      dieUsage(`unknown argument: ${arg}`);
    }
  }
  if (asar === "") dieUsage("missing required --asar <path-to-app.asar>");
  return resolve(asar);
}

/** asar 布局：offset 12 的 uint32 是 header 字节数；JSON 从 16 开始；数据区从 16 + headerSize 开始。 */
function readAsar(asarPath) {
  const buffer = readFileSync(asarPath);
  if (buffer.length < 16) throw new Error(`file is only ${buffer.length} bytes, too short for an asar header`);
  const headerSize = buffer.readUInt32LE(12);
  const dataStart = 16 + headerSize;
  if (headerSize === 0 || dataStart > buffer.length) {
    throw new Error(`asar header size ${headerSize} does not fit in a ${buffer.length}-byte file`);
  }
  let header;
  try {
    header = JSON.parse(buffer.subarray(16, dataStart).toString("utf8").replace(/\0+$/, ""));
  } catch (cause) {
    throw new Error(`asar header is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  if (header === null || typeof header !== "object" || typeof header.files !== "object") {
    throw new Error("asar header has no files map");
  }
  return { buffer, headerSize, dataStart, header };
}

function walkFiles(node, prefix, out = new Map()) {
  const children = node !== null && typeof node === "object" ? node.files : undefined;
  if (children === null || typeof children !== "object") return out;
  for (const [name, entry] of Object.entries(children)) {
    const entryPath = prefix === "" ? name : `${prefix}/${name}`;
    if (entry !== null && typeof entry === "object" && entry.files !== undefined) {
      walkFiles(entry, entryPath, out);
    } else if (entry !== null && typeof entry === "object") {
      out.set(entryPath, entry);
    }
  }
  return out;
}

/** electron-builder 写出的 offset 可能是字符串（integrity 版本），统一转成数字。 */
function extractEntry(asar, files, entryPath) {
  const entry = files.get(entryPath);
  if (entry === undefined) throw new Error(`${entryPath} is missing from app.asar`);
  if (entry.files !== undefined) throw new Error(`${entryPath} is a directory, not a file`);
  if (entry.link !== undefined) throw new Error(`${entryPath} is an asar link, not an inline file`);
  const size = asNumber(entry.size);
  const offset = asNumber(entry.offset);
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error(`${entryPath} has an invalid size/offset in the asar header`);
  }
  const start = asar.dataStart + offset;
  const end = start + size;
  if (end > asar.buffer.length) {
    throw new Error(`${entryPath} points past the end of app.asar (${start} + ${size} > ${asar.buffer.length})`);
  }
  return asar.buffer.subarray(start, end);
}

/**
 * electron-builder 把 linux-unpacked 放在 release/ 下，所以 app.asar 向上三层就是
 * apps/desktop/，构建输出 dist-electron/ 在它旁边。找不到时只校验基线清单，
 * 不猜路径。
 */
function discoverBuildSql(asarPath) {
  const dir = resolve(dirname(asarPath), "..", "..", "..", DIST_ELECTRON);
  if (!existsSync(dir)) return { dir, names: [] };
  try {
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort();
    return { dir, names };
  } catch {
    return { dir, names: [] };
  }
}

function waitForReady(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    let output = "";
    let settled = false;
    let timer = null;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };

    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > MAX_CAPTURE) output = output.slice(-MAX_CAPTURE);
      const match = output.match(/MAILCOLLECT_READY (\{[^\n]*\})/);
      if (match === null) return;
      try {
        const ready = JSON.parse(match[1]);
        if (typeof ready?.port !== "number") throw new Error("READY payload has no numeric port");
        finish(null, ready);
      } catch (cause) {
        finish(
          new Error(
            `could not parse the ${READY_PREFIX.trim()} line: ${cause instanceof Error ? cause.message : String(cause)}\n` +
              `--- captured output ---\n${output}`,
          ),
        );
      }
    };

    const onExit = (code, signal) => {
      finish(
        new Error(
          `server exited before READY (code=${String(code)}, signal=${String(signal)})\n` +
            `--- captured output ---\n${output}`,
        ),
      );
    };

    const onError = (error) => {
      finish(new Error(`could not spawn the packaged server: ${error.message}\n--- captured output ---\n${output}`));
    };

    timer = setTimeout(() => {
      finish(
        new Error(
          `timed out after ${READY_TIMEOUT_MS} ms waiting for READY\n` +
            `--- captured output ---\n${output}`,
        ),
      );
    }, READY_TIMEOUT_MS);

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function httpGet(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text,
    json,
  };
}

async function stopServer(child) {
  if (child === null || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  let timer = null;
  const timedOut = new Promise((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), STOP_TIMEOUT_MS);
  });
  child.kill("SIGTERM");
  const outcome = await Promise.race([exited.then(() => "exit"), timedOut]);
  if (timer !== null) clearTimeout(timer);
  if (outcome === "timeout" && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      exited,
      new Promise((resolveExit) => {
        setTimeout(resolveExit, 1_000);
      }),
    ]);
  }
}

function cleanupTemp(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch (error) {
    console.warn(`WARN  could not remove temp dir ${dir}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const asarPath = parseArgs(process.argv.slice(2));

  let asarStat;
  try {
    asarStat = statSync(asarPath);
  } catch {
    dieUsage(`packaged artifact not found: ${asarPath}`);
  }
  if (!asarStat.isFile()) dieUsage(`packaged artifact is not a file: ${asarPath}`);

  let child = null;
  let tempDir = null;

  try {
    const asar = readAsar(asarPath);
    const sha256 = createHash("sha256").update(asar.buffer).digest("hex");
    console.log(`asar:   ${asarPath}`);
    console.log(`size:   ${asar.buffer.length} bytes`);
    console.log(`sha256: ${sha256}`);
    console.log(`header: ${asar.headerSize} bytes · file data starts at ${asar.dataStart}\n`);

    const files = walkFiles(asar.header, "");
    const serverEntry = files.get(`${DIST_ELECTRON}/server.mjs`);
    recordCheck(
      `${DIST_ELECTRON}/server.mjs is packaged`,
      serverEntry !== undefined,
      serverEntry === undefined ? "missing from app.asar" : `${asNumber(serverEntry.size)} bytes`,
    );

    // 基线两项必查；构建输出里还有别的 *.sql 时也一并要求在 asar 里出现。
    const buildSql = discoverBuildSql(asarPath);
    const requiredSql = new Set(REQUIRED_SQL_ASSETS);
    for (const name of buildSql.names) requiredSql.add(name);

    const missingSql = [];
    for (const name of requiredSql) {
      const entryPath = `${DIST_ELECTRON}/${name}`;
      const entry = files.get(entryPath);
      if (entry === undefined) {
        missingSql.push(name);
        recordCheck(
          `${entryPath} is packaged`,
          false,
          `${name} is missing from app.asar — the packaged server reads it at runtime`,
        );
      } else {
        recordCheck(`${entryPath} is packaged`, true, `${asNumber(entry.size)} bytes`);
      }
    }

    const packagedSql = [...files.keys()].filter((entryPath) => {
      if (!entryPath.startsWith(`${DIST_ELECTRON}/`) || !entryPath.endsWith(".sql")) return false;
      return !entryPath.slice(DIST_ELECTRON.length + 1).includes("/");
    });
    console.log(
      `INFO  SQL assets inside app.asar: ${
        packagedSql.map((entryPath) => entryPath.slice(DIST_ELECTRON.length + 1)).join(", ") || "<none>"
      }`,
    );
    if (buildSql.names.length > 0) {
      console.log(`INFO  SQL assets in build output (${buildSql.dir}): ${buildSql.names.join(", ")}`);
    } else {
      console.log(`INFO  build output ${DIST_ELECTRON}/ not found next to the asar; checked the baseline SQL list only`);
    }
    console.log("");

    const canBoot =
      serverEntry !== undefined && !missingSql.includes("schema.sql") && !missingSql.includes("schema-v11.sql");
    if (!canBoot) {
      recordSkip("packaged server boots", "required packaged assets are missing");
      recordSkip("GET /api/health", "server not started");
      recordSkip("GET //api/health", "server not started");
      recordSkip('GET /api/health version is not hardcoded "0.1.0"', "server not started");
      return;
    }

    tempDir = mkdtempSync(join(tmpdir(), "mailcollect-package-check-"));
    const serverPath = join(tempDir, DIST_ELECTRON, "server.mjs");
    mkdirSync(dirname(serverPath), { recursive: true });

    try {
      writeFileSync(serverPath, extractEntry(asar, files, `${DIST_ELECTRON}/server.mjs`));
      for (const entryPath of packagedSql) {
        const relative = entryPath.slice(DIST_ELECTRON.length + 1);
        writeFileSync(join(tempDir, DIST_ELECTRON, relative), extractEntry(asar, files, entryPath));
      }
    } catch (cause) {
      recordCheck(
        "packaged assets extract from app.asar",
        false,
        cause instanceof Error ? cause.message : String(cause),
      );
      recordSkip("packaged server boots", "extraction failed");
      recordSkip("GET /api/health", "server not started");
      recordSkip("GET //api/health", "server not started");
      recordSkip('GET /api/health version is not hardcoded "0.1.0"', "server not started");
      return;
    }
    recordCheck(
      "packaged assets extract from app.asar",
      true,
      `${1 + packagedSql.length} file(s) written to the temp dir`,
    );

    // 必须放一份 index.html：如果 //api/* 的守卫回退，SPA fallback 会返回 HTML，
    // 这条断言才有意义（空 ui 目录会让缺失守卫也“碰巧”404）。
    mkdirSync(join(tempDir, "ui"), { recursive: true });
    writeFileSync(
      join(tempDir, "ui", "index.html"),
      '<!doctype html><meta charset="utf-8"><title>MailCollect package check</title>\n',
    );
    mkdirSync(join(tempDir, "data"), { recursive: true });

    // 桌面端通过 MAILCOLLECT_VERSION 注入 app.getVersion()。只有打包后的 server
    // 真的读这个变量时才做版本断言，否则按契约跳过并说明。
    const supportsVersionOverride = readFileSync(serverPath, "utf8").includes("MAILCOLLECT_VERSION");
    const env = {
      ...process.env,
      MAILCOLLECT_DATA_DIR: join(tempDir, "data"),
      MAILCOLLECT_PORT: "0",
      MAILCOLLECT_UI_DIR: join(tempDir, "ui"),
      // 固定的一次性本地令牌，避免把 READY 行里的随机令牌打进日志。
      MAILCOLLECT_TOKEN: "package-check-token",
    };
    if (supportsVersionOverride) env.MAILCOLLECT_VERSION = VERSION_SENTINEL;

    const startedAt = Date.now();
    child = spawn(process.execPath, [serverPath], {
      cwd: tempDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let ready;
    try {
      ready = await waitForReady(child);
    } catch (cause) {
      recordCheck("packaged server boots", false, cause instanceof Error ? cause.message : String(cause));
      recordSkip("GET /api/health", "server did not become ready");
      recordSkip("GET //api/health", "server did not become ready");
      recordSkip('GET /api/health version is not hardcoded "0.1.0"', "server did not become ready");
      return;
    }
    // READY 之后不再解析输出，但继续排空管道，避免服务端写日志时被管道缓冲卡住。
    child.stdout?.resume();
    child.stderr?.resume();
    recordCheck(
      "packaged server boots",
      true,
      `${READY_PREFIX.trim()} on port ${ready.port} in ${Date.now() - startedAt} ms`,
    );

    const base = `http://127.0.0.1:${ready.port}`;

    let health = null;
    try {
      health = await httpGet(`${base}/api/health`);
    } catch (cause) {
      recordCheck("GET /api/health returns HTTP 200", false, `request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      recordSkip("GET /api/health content-type is JSON", "health request failed");
      recordSkip("GET /api/health body is JSON with ok:true", "health request failed");
      recordSkip('GET /api/health version is not hardcoded "0.1.0"', "health request failed");
    }

    if (health !== null) {
      recordCheck(
        "GET /api/health returns HTTP 200",
        health.status === 200,
        `status=${health.status}, body=${preview(health.text)}`,
      );
      recordCheck(
        "GET /api/health content-type is JSON",
        health.contentType.toLowerCase().includes("application/json"),
        `content-type=${health.contentType || "<missing>"}`,
      );
      recordCheck(
        "GET /api/health body is JSON with ok:true",
        health.json !== null && health.json?.ok === true,
        `body=${preview(health.text)}`,
      );

      if (!supportsVersionOverride) {
        recordSkip(
          'GET /api/health version is not hardcoded "0.1.0"',
          "packaged server has no MAILCOLLECT_VERSION env override; sub-check skipped",
        );
      } else if (health.json === null || typeof health.json !== "object") {
        recordSkip('GET /api/health version is not hardcoded "0.1.0"', "health body was not JSON");
      } else {
        recordCheck(
          'GET /api/health version is not hardcoded "0.1.0"',
          health.json.version === VERSION_SENTINEL,
          `version=${JSON.stringify(health.json.version)}, expected ${JSON.stringify(VERSION_SENTINEL)}`,
        );
      }
    }

    let doubleSlash = null;
    try {
      doubleSlash = await httpGet(`${base}//api/health`);
    } catch (cause) {
      recordCheck("GET //api/health returns HTTP 404", false, `request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
      recordSkip("GET //api/health does not serve HTML", "double-slash request failed");
      recordSkip("GET //api/health body parses as JSON", "double-slash request failed");
    }

    if (doubleSlash !== null) {
      recordCheck(
        "GET //api/health returns HTTP 404",
        doubleSlash.status === 404,
        `status=${doubleSlash.status}, body=${preview(doubleSlash.text)}`,
      );
      recordCheck(
        "GET //api/health does not serve HTML",
        !doubleSlash.contentType.toLowerCase().includes("text/html"),
        `content-type=${doubleSlash.contentType || "<missing>"}`,
      );
      recordCheck(
        "GET //api/health body parses as JSON",
        doubleSlash.json !== null,
        `body=${preview(doubleSlash.text)}`,
      );
    }
  } finally {
    await stopServer(child);
    if (tempDir !== null) cleanupTemp(tempDir);
  }
}

try {
  await main();
} catch (cause) {
  recordCheck(
    "checker completed without an unexpected error",
    false,
    cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
  );
}

const failed = checks.filter((check) => !check.ok);
const passed = checks.length - failed.length;

console.log("");
if (checks.length === 0 || failed.length > 0) {
  console.log(
    `FAIL  packaged artifact smoke check: ${failed.length} of ${checks.length} checks failed${
      skips.length > 0 ? ` (${skips.length} skipped)` : ""
    }`,
  );
  for (const failure of failed) {
    console.log(`      - ${failure.name}${failure.detail ? `: ${preview(failure.detail, 300)}` : ""}`);
  }
  process.exit(1);
}

console.log(
  `PASS  packaged artifact smoke check: ${passed}/${checks.length} checks passed${
    skips.length > 0 ? ` (${skips.length} skipped)` : ""
  }`,
);
process.exit(0);
