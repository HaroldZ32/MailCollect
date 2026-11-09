import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { API_PREFIX } from "@mailcollect/shared";
import type { Store } from "@mailcollect/core";
import type { ServerServices } from "./services.js";
import { createEventBus } from "./services.js";
import { registerAccounts } from "./routes/accounts.js";
import { registerMail } from "./routes/mail.js";
import { registerRules } from "./routes/rules.js";
import { registerSend } from "./routes/send.js";
import type { RouteDeps } from "./routes/deps.js";
import { fail } from "./routes/errors.js";

export interface AppOptions {
  store: Store;
  services: ServerServices;
  token: string;
  version: string;
  /** Absolute path to the built UI; served in production. */
  uiDir?: string | undefined;
  /** Directory the server owns; Graph token caches are derived from it. */
  dataDir?: string | undefined;
  /** Extra origins allowed to call /api (dev only). */
  allowedOrigins?: string[];
}

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

/**
 * 组装 HTTP 应用。这里只保留：鉴权中间件、错误映射、SSE、子路由挂载与静态 UI。
 * 业务处理器在 `routes/<领域>.ts`，经 {@link RouteDeps} 拿依赖，彼此不互相 import。
 */
export function createApp(options: AppOptions): Hono {
  const { services, token, version } = options;
  const store = services.store ?? options.store;
  const events = services.events ?? createEventBus();
  const app = new Hono();

  const deps: RouteDeps = {
    store,
    services,
    events,
    version,
    dataDir: options.dataDir,
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
    let provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    // EventSource cannot set request headers, so the SSE route alone may carry
    // the token as a query parameter. The server binds to 127.0.0.1 by default
    // and the token is per-launch, so this stays a local trust boundary.
    if (!provided && c.req.path === `${API_PREFIX}/events`) {
      provided = c.req.query("token") ?? "";
    }
    if (!tokenMatches(token, provided)) {
      const { body, status } = fail("unauthorized", "缺少或错误的访问令牌", 401);
      return c.json(body, status as 401);
    }
    return next();
  });

  /* ------------------------------- 领域子路由 -------------------------------- */

  registerAccounts(app, deps);
  registerMail(app, deps);
  registerRules(app, deps);
  registerSend(app, deps);

  /* ----------------------------------- sse ---------------------------------- */

  app.get(`${API_PREFIX}/events`, (c) =>
    streamSSE(c, async (stream) => {
      const unsubscribe = events.subscribe((event) => {
        void stream.writeSSE({ event: event.type, data: JSON.stringify(event.data) });
      });
      await stream.writeSSE({ event: "ready", data: "{}" });
      await new Promise<void>((resolve) => {
        c.req.raw.signal.addEventListener("abort", () => resolve());
      });
      unsubscribe();
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
