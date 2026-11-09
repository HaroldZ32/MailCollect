/**
 * 集成冒烟：真起一个服务进程，按真实 HTTP 契约跑一遍关键路径。
 * 用法：npm run smoke
 *
 * v1.1 追加：初始化向导、自动发现、分类/规则与重算、文件夹、邮件列表/详情/附件、
 * 发件与发件箱（含后台 worker 认领）。全程隔离：随机端口 + 临时数据目录 + 指向
 * 本机不可达端口的账号配置，不触达任何真实邮件服务器。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const dataDir = mkdtempSync(join(tmpdir(), "mailcollect-smoke-"));
const token = "smoke-token";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  results.push({ name, ok, detail: `${res.status}${ok ? "" : ` != ${expectStatus}`} ${text.slice(0, 160)}` });
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { res, text, body };
};

/** 语义断言：HTTP 状态之外，再核对响应体里必须成立的事实。 */
const check = (name, ok, detail) => {
  results.push({ name, ok: Boolean(ok), detail: ok ? "" : detail });
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
const llmCreate = await call("新增 LLM 配置", "/api/llm/configs", {
  method: "POST",
  body: JSON.stringify({
    label: "DeepSeek",
    protocol: "openai-compatible",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    apiKey: "sk-smoke",
  }),
}, 201);
check("LLM 配置创建返回 id", typeof llmCreate.body?.config?.id === "string", llmCreate.text.slice(0, 160));
const llmList = await call("列出 LLM 配置", "/api/llm/configs");
check("密钥不可回显", !llmList.text.includes("sk-smoke"), "响应里出现了 sk-smoke");
await call("任务列表", "/api/tasks");
await call("邮件列表", "/api/emails");

/* ------------------------------ 初始化向导（C1） ---------------------------- */

const onboarding0 = await call("读初始化状态", "/api/onboarding");
check(
  "初始状态：未完成且未跳过",
  onboarding0.body?.completed === false && onboarding0.body?.skipped === false,
  JSON.stringify(onboarding0.body),
);
const onboarding1 = await call("完成初始化向导", "/api/onboarding", {
  method: "PUT",
  body: JSON.stringify({ completed: true }),
});
check("初始化响应 completed=true", onboarding1.body?.completed === true, JSON.stringify(onboarding1.body));
const onboarding2 = await call("读回初始化状态", "/api/onboarding");
check("初始化状态已持久化", onboarding2.body?.completed === true, JSON.stringify(onboarding2.body));

/* ---------------------------- 分类与规则（C6/C7） --------------------------- */

const categories = await call("分类列表", "/api/categories");
const categoryItems = Array.isArray(categories.body?.items) ? categories.body.items : [];
const categoryIds = categoryItems.map((item) => item.id);
check(
  "种子分类已播种（AC-03）",
  categoryIds.includes("seed-category-personal") && categoryIds.includes("seed-category-broadcast"),
  `ids=${JSON.stringify(categoryIds)}`,
);

const rules = await call("规则列表", "/api/rules");
const ruleItems = Array.isArray(rules.body?.items) ? rules.body.items : [];
const ruleIds = ruleItems.map((item) => item.id);
check(
  "两条种子规则已播种（AC-03/AC-25）",
  ruleIds.includes("seed-rule-personal") && ruleIds.includes("seed-rule-broadcast"),
  `ids=${JSON.stringify(ruleIds)}`,
);
check(
  "每条规则都带条件树 tree",
  ruleItems.every((item) => item.tree !== undefined && item.tree !== null),
  "存在缺少 tree 的规则",
);

const recompute = await call("触发规则重算", "/api/rules/recompute", {
  method: "POST",
  body: JSON.stringify({}),
}, 202);
check("重算返回 jobId", typeof recompute.body?.jobId === "string" && recompute.body.jobId.length > 0, JSON.stringify(recompute.body));
if (typeof recompute.body?.jobId === "string") {
  await call("查询重算进度", `/api/rules/recompute/${recompute.body.jobId}`);
}
await call("重算作业不存在被拒", "/api/rules/recompute/no-such-job", {}, 404);

/* ------------------------------ 自动发现（C1） ------------------------------ */

const discoverGraph = await call("自动发现：Graph 走设备码", "/api/accounts/discover", {
  method: "POST",
  body: JSON.stringify({ email: "smoke@example.com", providerHint: "graph" }),
});
check(
  "Graph 发现返回 provider=graph",
  discoverGraph.body?.ok === true && discoverGraph.body?.provider === "graph",
  JSON.stringify(discoverGraph.body),
);
const discoverImap = await call("自动发现：IMAP 无标准发现协议", "/api/accounts/discover", {
  method: "POST",
  body: JSON.stringify({ email: "smoke@example.com", providerHint: "imap" }),
});
check(
  "IMAP 发现提示手工填写",
  discoverImap.body?.provider === "imap" && discoverImap.body?.ok === false,
  JSON.stringify(discoverImap.body),
);
await call("自动发现缺少 email 被拒", "/api/accounts/discover", {
  method: "POST",
  body: JSON.stringify({ providerHint: "imap" }),
}, 400);

/* ------------------------- 账号 + 文件夹（C2/C3） --------------------------- */

// 收件端指向 127.0.0.1:1：连接会立即被拒，不发真实流量，只覆盖「上游不可达」的错误路径。
const account = await call("新增 IMAP 账号", "/api/accounts", {
  method: "POST",
  body: JSON.stringify({
    provider: "imap",
    label: "Smoke",
    email: "smoke@example.com",
    secret: "smoke-imap-secret",
    config: {
      host: "127.0.0.1",
      port: "1",
      user: "smoke",
      smtpHost: "127.0.0.1",
      smtpPort: "1",
      smtpSecure: "false",
      smtpUser: "smoke",
    },
  }),
}, 201);
const accountId = account.body?.account?.id;
check("账号创建返回 id", typeof accountId === "string" && accountId.length > 0, account.text.slice(0, 160));
check("账号视图不回显 secret", !account.text.includes("smoke-imap-secret"), "账号响应里出现了 secret");

await call("文件夹缺少 accountId 被拒", "/api/folders", {}, 400);
await call("文件夹未知账号被拒", "/api/folders?accountId=no-such-account", {}, 404);
if (typeof accountId === "string") {
  // 本地 127.0.0.1:1 连接被拒 → 502 upstream_error，证明路由真的走到适配器。
  const folders = await call("读取文件夹（上游不可达）", `/api/folders?accountId=${encodeURIComponent(accountId)}`, {}, 502);
  check(
    "文件夹错误是脱敏的上游错误",
    folders.body?.error?.code === "upstream_error" && !folders.text.includes("smoke-imap-secret"),
    folders.text.slice(0, 200),
  );
}

/* ------------------------- 邮件列表 / 详情 / 附件（C4） -------------------- */

const messages = await call("邮件列表（默认收件箱）", "/api/messages?folder=INBOX&limit=10");
check(
  "邮件列表返回数组与游标字段",
  Array.isArray(messages.body?.items) && "nextCursor" in (messages.body ?? {}),
  JSON.stringify(messages.body)?.slice(0, 160),
);
if (typeof accountId === "string") {
  const filtered = await call(
    "邮件列表（账号 + 文件夹过滤）",
    `/api/messages?accountId=${encodeURIComponent(accountId)}&folder=INBOX&limit=5`,
  );
  check("过滤结果仍是数组", Array.isArray(filtered.body?.items), JSON.stringify(filtered.body)?.slice(0, 160));
}
await call("邮件详情不存在被拒", "/api/messages/no-such-message", {}, 404);
await call("附件列表不存在被拒", "/api/messages/no-such-message/attachments", {}, 404);
await call("附件下载不存在被拒", "/api/messages/no-such-message/attachments/no-such-attachment", {}, 404);

/* --------------------------- 发件与发件箱（C5/AC-12） --------------------- */

await call("草稿列表", `/api/drafts${typeof accountId === "string" ? `?accountId=${encodeURIComponent(accountId)}` : ""}`);
if (typeof accountId === "string") {
  const send = await call("发信入队（queueOnly）", "/api/send", {
    method: "POST",
    body: JSON.stringify({
      accountId,
      queueOnly: true,
      message: {
        mode: "new",
        to: ["rcpt@example.com"],
        cc: [],
        bcc: [],
        subject: "smoke 集成冒烟",
        bodyText: "这是一封冒烟测试邮件。",
        bodyHtml: null,
      },
    }),
  });
  check("发信返回 queued + outboxId", send.body?.status === "queued" && typeof send.body?.outboxId === "string", JSON.stringify(send.body));

  const outbox = await call("读取发件箱", `/api/outbox?accountId=${encodeURIComponent(accountId)}`);
  const outboxItems = Array.isArray(outbox.body?.items) ? outbox.body.items : [];
  check(
    "发件箱包含刚入队的行",
    typeof send.body?.outboxId === "string" && outboxItems.some((item) => item.id === send.body.outboxId),
    `ids=${JSON.stringify(outboxItems.map((item) => item.id))}`,
  );

  if (typeof send.body?.outboxId === "string") {
    // worker 会立刻认领（status=sending），SMTP 127.0.0.1:1 被拒后落 failed。
    // 等到终态（failed/sent）再断言，避免撞上 sending 的瞬时窗口。
    let claimed = null;
    for (let i = 0; i < 100; i += 1) {
      const probe = await fetch(`${base}/api/outbox?accountId=${encodeURIComponent(accountId)}`, {
        headers: { authorization: `Bearer ${ready.token}` },
      }).then((res) => res.json()).catch(() => null);
      const row = probe?.items?.find((item) => item.id === send.body.outboxId);
      if (row !== undefined && (row.status === "failed" || row.status === "sent")) {
        claimed = row;
        break;
      }
      await sleep(100);
    }
    check("worker 认领该行（10 秒内离开 queued）", claimed !== null, "该行一直停在 queued/sending");
    check(
      "投递失败落 failed 且文案脱敏",
      claimed !== null && claimed.status === "failed" && !JSON.stringify(claimed).includes("smoke-imap-secret"),
      JSON.stringify(claimed)?.slice(0, 200),
    );
  }

  const direct = await call("直接向发件箱入队", "/api/outbox", {
    method: "POST",
    body: JSON.stringify({
      accountId,
      message: {
        mode: "new",
        to: ["rcpt2@example.com"],
        cc: [],
        bcc: [],
        subject: "smoke outbox",
        bodyText: "直接入队。",
        bodyHtml: null,
      },
    }),
  });
  check("直接入队返回条目 id", typeof direct.body?.item?.id === "string", JSON.stringify(direct.body)?.slice(0, 160));
}

/* --------------------------------- 收尾 ----------------------------------- */

child.kill("SIGTERM");
rmSync(dataDir, { recursive: true, force: true });

let failures = 0;
for (const r of results) {
  if (!r.ok) failures += 1;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  ${r.ok ? "" : r.detail}`);
}
console.log(`\n${results.length - failures}/${results.length} 通过`);
process.exit(failures === 0 ? 0 : 1);
