import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import type {
  AccountView,
  ApiErrorBody,
  CreateAccountInput,
  EmailListResponse,
  HealthResponse,
  LlmTestInput,
  LlmConfigInput,
  ServerEvent,
  SyncChangesResponse,
  TaskListResponse,
  UpdateTaskInput,
  UpsertProfileInput,
} from "@mailcollect/shared";
import { API_PREFIX } from "@mailcollect/shared";
import type { Store } from "@mailcollect/core";
import type { ServerServices } from "./services.js";

export interface AppOptions {
  store: Store;
  services: ServerServices;
  token: string;
  version: string;
  /** Absolute path to the built UI; served in production. */
  uiDir?: string | undefined;
  /** Extra origins allowed to call /api (dev only). */
  allowedOrigins?: string[];
}

const fail = (code: ApiErrorBody["error"]["code"], message: string, status: number) =>
  ({ body: { error: { code, message } } as ApiErrorBody, status }) as const;

const tokenMatches = (expected: string, provided: string): boolean => {
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

export function createApp(options: AppOptions): Hono {
  const { store, services, token, version } = options;
  const app = new Hono();
  const listeners = new Set<(event: ServerEvent) => void>();

  const emit = (event: ServerEvent): void => {
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // A broken SSE consumer must never break a sync run.
      }
    }
  };

  app.use(
    `${API_PREFIX}/*`,
    cors({
      origin: (origin) => (options.allowedOrigins?.includes(origin) ? origin : null),
      allowHeaders: ["Authorization", "Content-Type"],
      allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    }),
  );

  app.use(`${API_PREFIX}/*`, async (c, next) => {
    if (c.req.path === `${API_PREFIX}/health`) return next();
    const header = c.req.header("authorization") ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!tokenMatches(token, provided)) {
      const { body, status } = fail("unauthorized", "缺少或错误的访问令牌", 401);
      return c.json(body, status as 401);
    }
    return next();
  });

  /* ---------------------------------- health --------------------------------- */

  app.get(`${API_PREFIX}/health`, (c) => {
    const body: HealthResponse = {
      ok: true,
      version,
      dbPath: "sqlite",
      hasProfile: store.getProfile() !== null,
      accountCount: store.listAccounts().length,
    };
    return c.json(body);
  });

  /* --------------------------------- profile -------------------------------- */

  app.get(`${API_PREFIX}/profile`, (c) => c.json({ profile: store.getProfile() }));

  app.put(`${API_PREFIX}/profile`, async (c) => {
    const input = (await c.req.json()) as UpsertProfileInput;
    if (!input?.displayName?.trim()) {
      const { body, status } = fail("invalid_input", "姓名必填", 400);
      return c.json(body, status as 400);
    }
    const profile = store.upsertProfile({
      displayName: input.displayName.trim(),
      aliases: Array.isArray(input.aliases) ? input.aliases : [],
      emails: Array.isArray(input.emails) ? input.emails : [],
      timezone: input.timezone || "Asia/Shanghai",
    });
    return c.json({ profile });
  });

  /* -------------------------------- accounts -------------------------------- */

  const toView = (account: ReturnType<Store["listAccounts"]>[number]): AccountView => {
    const withSecret = store.getAccountWithSecret(account.id);
    return {
      id: account.id,
      provider: account.provider,
      label: account.label,
      email: account.email,
      enabled: account.enabled,
      hasSecret: Boolean(withSecret?.secret),
      lastSyncAt: null,
      createdAt: account.createdAt,
    };
  };

  app.get(`${API_PREFIX}/accounts`, (c) =>
    c.json({ items: store.listAccounts().map(toView) }),
  );

  app.post(`${API_PREFIX}/accounts`, async (c) => {
    const input = (await c.req.json()) as CreateAccountInput;
    if (!input?.provider || !input.email) {
      const { body, status } = fail("invalid_input", "provider 与 email 必填", 400);
      return c.json(body, status as 400);
    }
    const account = store.createAccount({
      provider: input.provider,
      label: input.label || input.email,
      email: input.email,
      config: input.config ?? {},
      secret: input.secret ?? "",
    });
    return c.json({ account: toView(account) }, 201);
  });

  app.delete(`${API_PREFIX}/accounts/:id`, (c) => {
    const ok = store.deleteAccount(c.req.param("id"));
    if (!ok) {
      const { body, status } = fail("not_found", "账号不存在", 404);
      return c.json(body, status as 404);
    }
    return c.json({ ok: true });
  });

  app.post(`${API_PREFIX}/accounts/:id/verify`, async (c) => {
    const result = await services.verifyAccount(c.req.param("id"));
    return c.json(result, result.ok ? 200 : 400);
  });

  /* --------------------------------- emails --------------------------------- */

  app.get(`${API_PREFIX}/emails`, (c) => {
    const url = c.req.query();
    const body: EmailListResponse = store.listEmails({
      accountId: url.accountId,
      limit: url.limit ? Number(url.limit) : undefined,
      cursor: url.cursor,
      search: url.search,
    });
    return c.json(body);
  });

  app.get(`${API_PREFIX}/emails/:id`, (c) => {
    const email = store.getEmail(c.req.param("id"));
    if (!email) {
      const { body, status } = fail("not_found", "邮件不存在", 404);
      return c.json(body, status as 404);
    }
    return c.json({ email, verdict: store.getBroadcastVerdict(email.id) });
  });

  /* ---------------------------------- tasks --------------------------------- */

  app.get(`${API_PREFIX}/tasks`, (c) => {
    const url = c.req.query();
    const items = store.listTasks({
      ...(url.status ? { status: url.status as TaskListResponse["items"][number]["status"] } : {}),
      ...(url.from ? { from: url.from } : {}),
      ...(url.to ? { to: url.to } : {}),
      ...(url.includeBroadcast === "false" ? { includeBroadcast: false } : {}),
    });
    const body: TaskListResponse = { items, counts: store.taskCounts() };
    return c.json(body);
  });

  app.patch(`${API_PREFIX}/tasks/:id`, async (c) => {
    const patch = (await c.req.json()) as UpdateTaskInput;
    const task = store.updateTask(c.req.param("id"), patch);
    if (!task) {
      const { body, status } = fail("not_found", "待办不存在", 404);
      return c.json(body, status as 404);
    }
    emit({ type: "task", data: task });
    return c.json({ task });
  });

  app.post(`${API_PREFIX}/tasks/bulk`, async (c) => {
    const input = (await c.req.json()) as {
      ids: string[];
      decision: "confirm" | "dismiss";
      listId?: string | null;
    };
    const status = input.decision === "confirm" ? "confirmed" : "dismissed";
    const updated = store.setTasksStatus(input.ids ?? [], status);
    if (input.listId) {
      store.setBroadcastDecision(input.listId, input.decision === "confirm" ? "always_task" : "always_ignore");
    }
    for (const task of updated) emit({ type: "task", data: task });
    return c.json({ items: updated });
  });

  /* ----------------------------------- llm ---------------------------------- */

  app.post(`${API_PREFIX}/llm/test`, async (c) => {
    const input = (await c.req.json()) as LlmTestInput;
    const result = await services.testLlm(input);
    return c.json(result);
  });

  app.get(`${API_PREFIX}/llm/configs`, (c) => c.json({ items: store.listLlmConfigs() }));

  app.post(`${API_PREFIX}/llm/configs`, async (c) => {
    const input = (await c.req.json()) as LlmConfigInput;
    if (!input?.baseUrl || !input.model) {
      const { body, status } = fail("invalid_input", "baseUrl 与 model 必填", 400);
      return c.json(body, status as 400);
    }
    const config = store.upsertLlmConfig(input);
    return c.json({ config }, 201);
  });

  app.post(`${API_PREFIX}/llm/configs/:id/default`, (c) => {
    const ok = store.setDefaultLlmConfig(c.req.param("id"));
    if (!ok) {
      const { body, status } = fail("not_found", "配置不存在", 404);
      return c.json(body, status as 404);
    }
    return c.json({ ok: true });
  });

  app.delete(`${API_PREFIX}/llm/configs/:id`, (c) => {
    const ok = store.deleteLlmConfig(c.req.param("id"));
    if (!ok) {
      const { body, status } = fail("not_found", "配置不存在", 404);
      return c.json(body, status as 404);
    }
    return c.json({ ok: true });
  });

  /* ----------------------------------- sync --------------------------------- */

  app.post(`${API_PREFIX}/sync`, async (c) => {
    const input = (await c.req.json()) as { accountId: string; full?: boolean };
    if (!store.getAccountWithSecret(input.accountId)) {
      const { body, status } = fail("not_found", "账号不存在", 404);
      return c.json(body, status as 404);
    }
    void services
      .syncAccount(input.accountId, { full: input.full === true }, emit)
      .catch((error: unknown) => {
        emit({
          type: "error",
          data: { message: error instanceof Error ? error.message : "同步失败" },
        });
      });
    return c.json({ jobId: `sync-${input.accountId}-${Date.now()}` });
  });

  app.post(`${API_PREFIX}/extract`, async (c) => {
    void services.extract(emit).catch((error: unknown) => {
      emit({
        type: "error",
        data: { message: error instanceof Error ? error.message : "抽取失败" },
      });
    });
    return c.json({ ok: true });
  });

  /* ------------------------- cloud-sync seam (R7) --------------------------- */

  app.get(`${API_PREFIX}/sync/changes`, (c) => {
    const since = Number(c.req.query("since") ?? "0");
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "500"), 1), 2000);
    const body: SyncChangesResponse = {
      head: store.head(),
      items: store.changes(Number.isFinite(since) ? since : 0, limit),
    };
    return c.json(body);
  });

  /* ----------------------------------- sse ---------------------------------- */

  app.get(`${API_PREFIX}/events`, (c) =>
    streamSSE(c, async (stream) => {
      const listener = (event: ServerEvent): void => {
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
      };
      listeners.add(listener);
      await stream.writeSSE({ event: "ready", data: "{}" });
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener("abort", () => resolve());
      });
      listeners.delete(listener);
    }),
  );

  /* ------------------------------- static UI -------------------------------- */

  if (options.uiDir) {
    const uiDir = options.uiDir;
    app.get("*", async (c, next) => {
      const urlPath = c.req.path === "/" ? "/index.html" : c.req.path;
      const resolved = normalize(join(uiDir, urlPath));
      if (!resolved.startsWith(normalize(uiDir))) return next();
      try {
        const data = await readFile(resolved);
        const ext = resolved.slice(resolved.lastIndexOf("."));
        return c.body(new Uint8Array(data), 200, {
          "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        });
      } catch {
        // SPA fallback
        try {
          const html = await readFile(join(uiDir, "index.html"));
          return c.body(new Uint8Array(html), 200, { "content-type": CONTENT_TYPES[".html"]! });
        } catch {
          return next();
        }
      }
    });
  }

  app.notFound((c) => {
    const { body, status } = fail("not_found", "接口不存在", 404);
    return c.json(body, status as 404);
  });

  return app;
}
