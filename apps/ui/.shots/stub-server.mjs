import { createServer } from "node:http";

const TOKEN = "sse-test-token";
const PORT = Number(process.env.STUB_PORT ?? 8787);
const ORIGIN = `http://127.0.0.1:${PORT}`;

const now = () => new Date().toISOString();
const taskSeed = () => ({
  id: "sse-task-1",
  userId: "user-stub",
  title: "来自 SSE 的既有任务",
  detail: null,
  owner: "me",
  ownerName: "张三",
  kind: "deadline",
  status: "confirmed",
  origin: "personal",
  confidence: 0.9,
  evidenceQuote: "这是一条桩任务",
  sourceEmailId: "sse-mail-1",
  threadId: null,
  time: {
    phrase: null,
    dueAt: new Date(Date.now() + 86_400_000).toISOString(),
    windowStart: null,
    windowEnd: null,
    timezone: "Asia/Shanghai",
    confidence: 0.8,
  },
  createdAt: now(),
  updatedAt: now(),
});

const emailSeed = () => ({
  id: "sse-mail-1",
  accountId: "acc-1",
  uid: "1",
  messageId: "<stub-1@example.com>",
  threadId: null,
  fromName: "Stub 发件人",
  fromEmail: "stub@example.com",
  to: ["me@example.com"],
  cc: [],
  subject: "SSE 测试邮件",
  sentAt: now(),
  bodyText: "桩服务返回的正文。",
  hasAttachments: false,
  headers: {},
  createdAt: now(),
});

const profileSeed = () => ({
  id: "profile-stub",
  displayName: "张三",
  aliases: ["张三"],
  emails: ["me@example.com"],
  timezone: "Asia/Shanghai",
  createdAt: now(),
  updatedAt: now(),
});

const accountSeed = () => ({
  id: "acc-1",
  provider: "imap",
  label: "Stub 邮箱",
  email: "me@example.com",
  enabled: true,
  hasSecret: true,
  lastSyncAt: now(),
  createdAt: now(),
});

const graphAccountSeed = () => ({
  id: "acc-graph",
  provider: "graph",
  label: "Stub Outlook",
  email: "outlook@example.com",
  enabled: true,
  hasSecret: true,
  lastSyncAt: null,
  createdAt: now(),
});

let profile = profileSeed();
let tasks = [taskSeed()];
const accounts = [accountSeed(), graphAccountSeed()];
const clients = new Set();
const stats = {
  connections: 0,
  taskFetches: 0,
  emailFetches: 0,
  eventRequests: 0,
  accountsFetches: 0,
  loginRequests: 0,
  lastLoginAccountId: null,
  accountCreates: 0,
  lastAccountCreate: null,
};

const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
};

const readBody = async (req) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw.trim() === "") return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};

const authorized = (req, url) => {
  if (url.pathname === "/api/health") return true;
  if (url.pathname === "/api/events" && url.searchParams.get("token") === TOKEN) return true;
  return (req.headers.authorization ?? "") === `Bearer ${TOKEN}`;
};

const broadcast = (type, data) => {
  const frame = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
  return clients.size;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", ORIGIN);

  if (url.pathname.startsWith("/control/")) {
    if (url.pathname === "/control/stats") return json(res, 200, { ...stats, clients: clients.size, tasks: tasks.length });
    if (url.pathname === "/control/emit" && req.method === "POST") {
      const body = await readBody(req);
      if (body.type === "task" && body.data) {
        const incoming = body.data;
        const index = tasks.findIndex((task) => task.id === incoming.id);
        if (index === -1) tasks = [...tasks, incoming];
        else tasks[index] = incoming;
      }
      const delivered = broadcast(String(body.type), body.data);
      return json(res, 200, { ok: true, delivered });
    }
    if (url.pathname === "/control/drop" && req.method === "POST") {
      let dropped = 0;
      for (const client of clients) {
        client.end();
        dropped += 1;
      }
      clients.clear();
      return json(res, 200, { dropped });
    }
    return json(res, 404, { error: { code: "not_found", message: "no such control" } });
  }

  if (!authorized(req, url)) {
    return json(res, 401, { error: { code: "unauthorized", message: "缺少或错误的访问令牌" } });
  }

  if (url.pathname === "/api/health") {
    return json(res, 200, { ok: true, version: "stub", dbPath: "stub", hasProfile: true, accountCount: 1 });
  }
  if (url.pathname === "/api/profile" && req.method === "GET") {
    return json(res, 200, { profile });
  }
  if (url.pathname === "/api/profile" && req.method === "PUT") {
    const input = await readBody(req);
    profile = { ...profile, ...input, updatedAt: now() };
    return json(res, 200, { profile });
  }
  if (url.pathname === "/api/accounts" && req.method === "GET") {
    stats.accountsFetches += 1;
    return json(res, 200, { items: accounts });
  }
  if (url.pathname === "/api/accounts" && req.method === "POST") {
    const input = await readBody(req);
    const config = input.config ?? {};
    stats.accountCreates += 1;
    stats.lastAccountCreate = { provider: input.provider ?? null, config };
    if (input.provider === "graph" && (typeof config.clientId !== "string" || config.clientId.trim() === "")) {
      return json(res, 400, {
        error: { code: "invalid_input", message: "Graph 账号需要 clientId（在你自己的 Azure 应用注册里获取）" },
      });
    }
    if (input.provider === "graph" && config.clientId === "bad-client-id") {
      return json(res, 400, {
        error: { code: "invalid_input", message: "Graph clientId 无效（stub 拒绝）" },
      });
    }
    const account = { ...accountSeed(), id: `acc-${Date.now()}`, label: input.label ?? "新账号", email: input.email ?? "", provider: input.provider ?? "imap" };
    accounts.push(account);
    return json(res, 201, { account });
  }
  if (url.pathname.startsWith("/api/accounts/") && req.method === "DELETE") {
    return json(res, 200, { ok: true });
  }
  if (url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/login") && req.method === "POST") {
    stats.loginRequests += 1;
    stats.lastLoginAccountId = url.pathname.split("/").at(-2) ?? null;
    return json(res, 202, { ok: true });
  }
  if (url.pathname.startsWith("/api/accounts/") && url.pathname.endsWith("/verify")) {
    return json(res, 200, { ok: true, detail: "桩服务：验证通过" });
  }
  if (url.pathname === "/api/emails") {
    stats.emailFetches += 1;
    return json(res, 200, { items: [emailSeed()], nextCursor: null });
  }
  if (url.pathname.startsWith("/api/emails/")) {
    return json(res, 200, { email: emailSeed(), verdict: null, listId: "stub-list.example" });
  }
  if (url.pathname === "/api/tasks" && req.method === "GET") {
    stats.taskFetches += 1;
    const counts = { candidate: 0, confirmed: 0, dismissed: 0, done: 0 };
    for (const task of tasks) counts[task.status] += 1;
    return json(res, 200, { items: tasks, counts });
  }
  if (url.pathname.startsWith("/api/tasks/") && req.method === "PATCH") {
    const id = url.pathname.split("/").at(-1);
    const patch = await readBody(req);
    const index = tasks.findIndex((task) => task.id === id);
    if (index === -1) return json(res, 404, { error: { code: "not_found", message: "task not found" } });
    tasks[index] = { ...tasks[index], ...patch, updatedAt: now() };
    broadcast("task", tasks[index]);
    return json(res, 200, { task: tasks[index] });
  }
  if (url.pathname === "/api/tasks/bulk" && req.method === "POST") {
    const input = await readBody(req);
    stats.lastBulkListId = input.listId ?? null;
    stats.lastBulkDecision = input.decision ?? null;
    stats.lastBulkIds = input.ids ?? [];
    const status = input.decision === "confirm" ? "confirmed" : "dismissed";
    const updated = [];
    tasks = tasks.map((task) => {
      if (!(input.ids ?? []).includes(task.id)) return task;
      const next = { ...task, status, updatedAt: now() };
      updated.push(next);
      return next;
    });
    for (const task of updated) broadcast("task", task);
    return json(res, 200, { items: updated });
  }
  if (url.pathname === "/api/llm/configs" && req.method === "GET") {
    return json(res, 200, { items: [] });
  }
  if (url.pathname === "/api/llm/configs" && req.method === "POST") {
    const input = await readBody(req);
    return json(res, 201, {
      config: {
        id: `llm-${Date.now()}`,
        label: input.label ?? "stub",
        protocol: input.protocol ?? "openai-compatible",
        baseUrl: input.baseUrl ?? "",
        model: input.model ?? "",
        hasKey: typeof input.apiKey === "string" && input.apiKey !== "",
        isDefault: input.isDefault === true,
      },
    });
  }
  if (url.pathname.startsWith("/api/llm/configs/")) {
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/api/llm/test") {
    return json(res, 200, { ok: true, latencyMs: 7, detail: "桩服务：连接成功" });
  }
  if (url.pathname === "/api/sync") {
    return json(res, 200, { jobId: "stub-sync" });
  }
  if (url.pathname === "/api/extract") {
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/api/events") {
    stats.eventRequests += 1;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    clients.add(res);
    stats.connections += 1;
    req.on("close", () => {
      clients.delete(res);
    });
    return;
  }

  return json(res, 404, { error: { code: "not_found", message: `no route ${url.pathname}` } });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`STUB_READY http://127.0.0.1:${PORT} token=${TOKEN}`);
});
