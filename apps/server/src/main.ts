import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { LlmConfig, ServerEvent, Task } from "@mailcollect/shared";
import { openStore } from "@mailcollect/core";
import { createMailSource } from "@mailcollect/core/mail";
import { createLlmPort } from "@mailcollect/core/llm";
import { processEmails, type PipelineDeps } from "@mailcollect/core/pipeline";
import { createApp } from "./app.js";
import { normalizeListId } from "./list-id.js";
import type { ServerServices } from "./services.js";

const VERSION = "0.1.0";

const env = process.env;
const isProduction = env["NODE_ENV"] === "production";

const dataDir = env["MAILCOLLECT_DATA_DIR"] ?? join(process.cwd(), ".data");
mkdirSync(dataDir, { recursive: true });

const port = Number(env["MAILCOLLECT_PORT"] ?? 8787);
const hostname = env["MAILCOLLECT_HOST"] ?? "127.0.0.1";
const uiDir = env["MAILCOLLECT_UI_DIR"];
const token =
  env["MAILCOLLECT_TOKEN"] ?? (isProduction ? randomUUID() : "dev-local-token");

/** Stable per-install id so a future sync backend can tell devices apart. */
const deviceId = ((): string => {
  const file = join(dataDir, "device-id");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const id = randomUUID();
  writeFileSync(file, `${id}\n`, { mode: 0o600 });
  return id;
})();

const store = await openStore(join(dataDir, "mailcollect.sqlite"), deviceId);

const progress = (
  accountId: string,
  phase: "connect" | "fetch" | "store" | "extract" | "done" | "error",
  fetched: number,
  stored: number,
  message?: string,
): ServerEvent => ({
  type: "sync",
  data: { accountId, phase, fetched, stored, ...(message ? { message } : {}) },
});

const services: ServerServices = {
  async verifyAccount(accountId) {
    const loaded = store.getAccountWithSecret(accountId);
    if (!loaded) return { ok: false, detail: "账号不存在" };
    const source = createMailSource({
      id: loaded.account.id,
      provider: loaded.account.provider,
      email: loaded.account.email,
      config: loaded.account.config,
      secret: loaded.secret,
    });
    try {
      return await source.verify();
    } finally {
      await source.close();
    }
  },

  async loginAccount(accountId, emit) {
    const loaded = store.getAccountWithSecret(accountId);
    if (!loaded) throw new Error("账号不存在");

    const source = createMailSource(
      {
        id: loaded.account.id,
        provider: loaded.account.provider,
        email: loaded.account.email,
        config: loaded.account.config,
        secret: loaded.secret,
      },
      {
        onDeviceCode: (notice) =>
          emit({ type: "device-code", data: { accountId, ...notice } }),
      },
    );

    try {
      if (typeof source.login !== "function") {
        emit({
          type: "device-login",
          data: { accountId, ok: false, detail: "该邮箱类型不支持交互式登录，请用「验证」" },
        });
        return;
      }
      // The callback MUST be passed here: the adapter always hands its own
      // wrapper to the auth layer, which shadows the constructor-time callback.
      // Guard the payload too — the adapter can invoke it before a code exists
      // (e.g. MSAL rejects the client first), and an empty code would open a
      // useless dialog in the UI.
      const result = await source.login((notice) => {
        if (!notice?.userCode || !notice.verificationUri) return;
        emit({ type: "device-code", data: { accountId, ...notice } });
      });
      emit({
        type: "device-login",
        data: { accountId, ok: result.ok, detail: result.detail },
      });
    } finally {
      await source.close();
    }
  },

  async syncAccount(accountId, options, emit) {
    const loaded = store.getAccountWithSecret(accountId);
    if (!loaded) throw new Error("账号不存在");

    const source = createMailSource({
      id: loaded.account.id,
      provider: loaded.account.provider,
      email: loaded.account.email,
      config: loaded.account.config,
      secret: loaded.secret,
    });

    let fetched = 0;
    let stored = 0;
    emit(progress(accountId, "connect", 0, 0));

    try {
      let cursor = options.full ? undefined : (store.getCursor(accountId) ?? undefined);
      let hasMore = true;
      let guard = 0;

      while (hasMore && guard < 200) {
        guard += 1;
        const result = await source.fetch({
          since: cursor,
          limit: 50,
          onProgress: (n) => emit(progress(accountId, "fetch", fetched + n, stored)),
        });

        const { inserted } = store.upsertEmails(result.emails);
        fetched += result.emails.length;
        stored += inserted;
        emit(progress(accountId, "store", fetched, stored));

        if (result.cursor) {
          store.setCursor(accountId, result.cursor.value);
          cursor = result.cursor;
        } else {
          cursor = undefined;
        }
        hasMore = result.hasMore;
      }

      store.markSynced(accountId, new Date().toISOString());
      emit(progress(accountId, "done", fetched, stored, `新增 ${stored} 封`));
    } catch (error) {
      emit(
        progress(
          accountId,
          "error",
          fetched,
          stored,
          error instanceof Error ? error.message : "同步失败",
        ),
      );
      throw error;
    } finally {
      await source.close();
    }
  },

  async extract(emit) {
    const profile = store.getProfile();
    if (!profile) throw new Error("请先在设置里填写姓名与邮箱别名");

    const llm = store.getLlmWithKey();
    if (!llm) throw new Error("请先在设置里添加一个 LLM 供应商");

    const deps: PipelineDeps = { llm: createLlmPort(llm.config, llm.apiKey), profile };
    const pending = store.emailsPendingExtraction(50);
    const total = pending.length;
    if (total === 0) return { done: 0, total: 0 };

    // Batch, not one-by-one: the "same body, same day" broadcast signal (R4)
    // needs the whole set in view. A per-email loop can never see it.
    const { verdicts, tasks, skipped } = await processEmails(deps, pending);

    for (const [emailId, verdict] of verdicts) {
      store.setBroadcastVerdict(emailId, verdict);
    }

    const byId = new Map(pending.map((email) => [email.id, email]));
    const routed: Task[] = tasks.map((task) => {
      const email = byId.get(task.sourceEmailId);
      const listId = email ? normalizeListId(email.headers["list-id"]) : null;
      const decision = listId ? store.getBroadcastDecision(listId) : null;
      if (!decision) return task;
      return { ...task, status: decision === "always_task" ? "confirmed" : "dismissed" };
    });

    const inserted = store.insertTasks(routed);
    for (const task of inserted) emit({ type: "task", data: task });

    const skippedIds = new Set(skipped.map((item) => item.emailId));
    for (const email of pending) {
      // Skipped messages are marked too, otherwise they would clog the queue head.
      store.markExtracted(email.id, skippedIds.has(email.id) ? "skipped" : null);
    }

    emit({ type: "extract", data: { done: total, total } });
    return { done: total, total };
  },

  async testLlm(input) {
    const config: LlmConfig = {
      id: "probe",
      label: "probe",
      protocol: input.protocol,
      baseUrl: input.baseUrl,
      model: input.model,
      apiKeyRef: null,
      temperature: 0.2,
      maxTokens: 512,
      timeoutMs: 20_000,
      isDefault: false,
    };
    return createLlmPort(config, input.apiKey ?? null).ping();
  },

  startBackground() {
    // Deliberately empty for v1: syncing is user-triggered so nothing hits the
    // network (or a metered LLM) without an explicit click.
  },

  async stopBackground() {
    // Nothing to stop yet.
  },
};

const app = createApp({
  store,
  services,
  token,
  version: VERSION,
  uiDir,
  dataDir,
  allowedOrigins: ["http://127.0.0.1:5173", "http://localhost:5173"],
});

services.startBackground();

serve({ fetch: app.fetch, port, hostname }, (info) => {
  // The desktop shell parses this exact line to learn the port and token.
  console.log(`MAILCOLLECT_READY ${JSON.stringify({ port: info.port, token })}`);
  console.log(`MailCollect ${VERSION} · http://${hostname}:${info.port}`);
  console.log(`data: ${dataDir} · sqlite driver: ${store.driver}`);
});

const shutdown = (): void => {
  void services.stopBackground().finally(() => {
    store.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
