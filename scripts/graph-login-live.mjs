/**
 * 真服务端上的 Graph 登录事件链验证：
 * 打开 SSE → POST /api/accounts/:id/login → 期待 device-code / device-login 事件。
 * 没有 Azure 应用注册时，MSAL 会在构造期报错，这正好验证错误路径也走 SSE。
 *
 *   BASE=http://127.0.0.1:8789 TOKEN=... node scripts/graph-login-live.mjs
 */
const base = process.env.BASE ?? "http://127.0.0.1:8789";
const token = process.env.TOKEN ?? "dev-local-token";
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  ${detail}`}`);
};

const api = async (path, init = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
};

// Create a graph account through the real API: no secret to paste (device-code
// flow), clientId required. This also pins the empty-secret fix (B2).
const created = await api("/api/accounts", {
  method: "POST",
  body: JSON.stringify({
    provider: "graph",
    label: "Outlook 测试",
    email: `graph-${Date.now()}@outlook.com`,
    config: { clientId: "00000000-0000-0000-0000-000000000000", tenant: "common" },
    secret: "",
  }),
});
check("新建 graph 账号（空 secret）返回 201", created.status === 201, `status=${created.status} ${JSON.stringify(created.body)}`);

const missingClient = await api("/api/accounts", {
  method: "POST",
  body: JSON.stringify({ provider: "graph", label: "坏账号", email: "bad@outlook.com", config: {}, secret: "" }),
});
check("缺 clientId 被 400 拦下", missingClient.status === 400, `status=${missingClient.status}`);

const listed = await api("/api/accounts");
check("列表不因空 secret 而 500", listed.status === 200, `status=${listed.status}`);
const graph = listed.body.items.find((a) => a.id === created.body?.account?.id);
check("新账号出现在列表里", Boolean(graph));
if (!graph) process.exit(1);

// Subscribe BEFORE triggering, otherwise the events can be missed.
const stream = await fetch(`${base}/api/events?token=${token}`, { headers: { accept: "text/event-stream" } });
check("SSE 已连接", stream.status === 200, `status=${stream.status}`);
const reader = stream.body.getReader();
const decoder = new TextDecoder();
let buffer = "";
const events = [];

const pump = (async () => {
  while (events.length < 2) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const name = /^event: (.+)$/m.exec(raw)?.[1];
      const data = /^data: (.+)$/m.exec(raw)?.[1];
      if (name && name !== "ready") {
        events.push({ name, data: data ? JSON.parse(data) : null });
      }
    }
  }
})();

const login = await api(`/api/accounts/${graph.id}/login`, { method: "POST" });
check("POST /login 返回 202", login.status === 202, `status=${login.status}`);

await Promise.race([pump, new Promise((r) => setTimeout(r, 20000))]);
await reader.cancel().catch(() => {});

const deviceCode = events.find((e) => e.name === "device-code");
const deviceLogin = events.find((e) => e.name === "device-login");
check("收到 device-code 或 device-login 事件", Boolean(deviceCode || deviceLogin),
  `events=${JSON.stringify(events.map((e) => e.name))}`);
if (deviceCode) {
  check("device-code 载荷含 userCode/verificationUri",
    Boolean(deviceCode.data?.userCode && deviceCode.data?.verificationUri));
}
if (deviceLogin) {
  check("device-login 载荷含 ok/detail", typeof deviceLogin.data?.ok === "boolean");
  console.log(`      实际结果: ok=${deviceLogin.data.ok} detail=${String(deviceLogin.data.detail).slice(0, 120)}`);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed === 0 ? 0 : 1);
