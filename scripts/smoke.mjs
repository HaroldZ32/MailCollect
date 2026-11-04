/**
 * 集成冒烟：真起一个服务进程，按真实 HTTP 契约跑一遍关键路径。
 * 用法：npm run smoke
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dataDir = mkdtempSync(join(tmpdir(), "mailcollect-smoke-"));
const token = "smoke-token";

const child = spawn(
  process.execPath,
  [join(root, "node_modules", "tsx", "dist", "cli.mjs"), join(root, "apps", "server", "src", "main.ts")],
  {
    cwd: root,
    env: {
      ...process.env,
      MAILCOLLECT_PORT: "0",
      MAILCOLLECT_TOKEN: token,
      MAILCOLLECT_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

const ready = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`服务启动超时\n${stderr}`)), 20000);
  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    const line = buf.split("\n").find((l) => l.startsWith("MAILCOLLECT_READY "));
    if (!line) return;
    clearTimeout(timer);
    resolve(JSON.parse(line.slice("MAILCOLLECT_READY ".length)));
  });
  child.once("exit", (code) => reject(new Error(`服务退出 code=${code}\n${stderr}`)));
});

const base = `http://127.0.0.1:${ready.port}`;
const results = [];
const call = async (name, path, init = {}, expectStatus = 200, anonymous = false) => {
  const headers = new Headers(init.headers);
  if (!anonymous) headers.set("authorization", `Bearer ${ready.token}`);
  if (init.body) headers.set("content-type", "application/json");
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  const ok = res.status === expectStatus;
  results.push({ name, ok, detail: `${res.status}${ok ? "" : ` != ${expectStatus}`} ${text.slice(0, 120)}` });
  return { res, text };
};

await call("health 无需令牌", "/api/health");
await call("未授权被拒", "/api/profile", {}, 401, true);
await call("写入档案", "/api/profile", {
  method: "PUT",
  body: JSON.stringify({
    displayName: "张三",
    aliases: ["San Zhang"],
    emails: ["me@corp.com"],
    timezone: "Asia/Shanghai",
  }),
});
await call("读回档案", "/api/profile");
await call("新增 LLM 配置", "/api/llm/configs", {
  method: "POST",
  body: JSON.stringify({
    label: "DeepSeek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKey: "sk-smoke",
  }),
}, 201);
const llmList = await call("列出 LLM 配置", "/api/llm/configs");
if (llmList.text.includes("sk-smoke")) {
  results.push({ name: "密钥不可回显", ok: false, detail: "响应里出现了 sk-smoke" });
}
await call("任务列表", "/api/tasks");
await call("邮件列表", "/api/emails");

child.kill("SIGTERM");
rmSync(dataDir, { recursive: true, force: true });

let failures = 0;
for (const r of results) {
  if (!r.ok) failures += 1;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.ok ? "" : r.detail}`);
}
console.log(`\n${results.length - failures}/${results.length} 通过`);
process.exit(failures === 0 ? 0 : 1);
