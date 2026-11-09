import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { FolderRole, LlmConfig, MailProvider, RawEmail, ServerEvent } from "@mailcollect/shared";
import {
  classifyEmail,
  createSemanticEvaluator,
  openStore,
  projectRuleEmail,
  type RuleEmail,
} from "@mailcollect/core";
import { createMailSource, mailSourceFactory, type FolderInfo, type MailSource } from "@mailcollect/core/mail";
import { createLlmPort } from "@mailcollect/core/llm";
import { processEmails, type PipelineDeps } from "@mailcollect/core/pipeline";
import { createApp } from "./app.js";
import { runDeviceLogin } from "./login-flow.js";
import { createOutboxWorker } from "./routes/send.js";
import { createEventBus, type ServerServices } from "./services.js";

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

/**
 * 进程内唯一事件总线：app 的 SSE 与后台 worker 的 `send` 事件必须同一条总线，
 * 否则重启后的投递状态到不了已连接的 UI。
 */
const events = createEventBus();

/**
 * 离线发件队列 worker（C5 / AC-12）。构造时 `recoverOutbox()` 把上一进程残留的
 * `sending` 行拉回 `queued`；启动时再 `kick()` 扫一遍到期行（重启恢复）。
 * 适配器工厂与读信/附件共用同一个 `mailSourceFactory`，不造第二套。
 */
const outbox = createOutboxWorker({
  store,
  mailSource: mailSourceFactory,
  emit: events.emit,
});

/**
 * 规则引擎的邮件投影（与 `routes/rules.ts` 的重算路径保持一致）。
 * v1.1（C7）：同步抽取与后台重算共用同一份字段投影，避免两套求值语义。
 */
/**
 * 规则求值投影（C6）。`date.which="received"` 与附件叶子需要 `raw_email` 的
 * 元数据列；测试替身若只实现旧 surface（没有该读缝），按「元数据未知」处理
 * （求值器对缺失字段判 false），而不是让整个抽取路径崩掉。
 */
const toRuleEmail = (email: RawEmail): RuleEmail => {
  const state = store.getEmailState(email.id);
  const extras = typeof store.getEmailExtras === "function" ? store.getEmailExtras(email.id) : null;
  return projectRuleEmail(email, state, extras);
};

/**
 * 同步后补齐规则需要的附件元数据：只对**新插入且带附件**的邮件调用适配器的
 * `getMessage`（name/mime/size，不下载也不保存字节），单封失败保持「元数据未知」，
 * 不打断整轮同步。接收时间来自 `FetchResult.receivedAtByUid`（T64 契约），
 * 不经过这里，也绝不用 `sentAt` 顶替。
 */
const enrichEmailMetadata = async (
  source: MailSource,
  emails: readonly RawEmail[],
  folderId: string | null,
): Promise<void> => {
  if (!source.getMessage) return;
  for (const email of emails) {
    if (!email.hasAttachments) continue;
    try {
      const body = await source.getMessage({ id: email.uid, folderId });
      const attachments = body.attachments
        .filter((attachment) => !attachment.inline)
        .map((attachment) => ({
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          size: attachment.size,
        }));
      store.setEmailExtras(email.id, { attachments });
    } catch {
      // no-excuse-ok: catch —— 单封元数据失败只让该封的附件叶子判 false（C6）。
    }
  }
};

/** 同步哪些角色；`other` 是用户自建文件夹，暂不在本轮范围内。 */
const SYNC_FOLDER_ROLES: readonly FolderRole[] = [
  "inbox",
  "sent",
  "drafts",
  "trash",
  "archive",
  "junk",
];

/** 只有这两个适配器真正支持 `fetch({ folderId })`（见 `mail/types.ts` 的契约）。 */
const FOLDER_SCOPED_FETCH: ReadonlySet<MailProvider> = new Set(["imap", "graph"]);

/** 默认范围同步落哪个文件夹：优先服务器报告的 Inbox id，否则用协议通用路径。 */
const inboxFolderPath = (folders: readonly FolderInfo[]): string =>
  folders.find((folder) => folder.role === "inbox")?.id ?? "INBOX";

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

    const source = createMailSource({
      id: loaded.account.id,
      provider: loaded.account.provider,
      email: loaded.account.email,
      config: loaded.account.config,
      secret: loaded.secret,
    });

    // The wiring lives in login-flow.ts so it has a real regression test — an
    // inline version stayed green under a mutation that reintroduced the bug.
    await runDeviceLogin(source, accountId, emit);
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
    const failures: string[] = [];

    /**
     * 单个文件夹失败不能打断整体同步（C5：多文件夹是正常形态）。
     * 失败同时以 SSE `sync`/`error` 事件上报，成功写入继续落 change_log。
     */
    const noteFailure = (scope: string, error: unknown): void => {
      const detail = error instanceof Error ? error.message : "未知错误";
      failures.push(`${scope}：${detail}`);
      emit(progress(accountId, "error", fetched, stored, `${scope}：${detail}`));
    };

    emit(progress(accountId, "connect", 0, 0));

    try {
      // 1) 文件夹快照：侧栏与「按文件夹」列表都读它；空列表不清空已有快照。
      let folders: readonly FolderInfo[] = [];
      if (source.listFolders) {
        try {
          folders = await source.listFolders();
          if (folders.length > 0) {
            store.replaceFolders(
              accountId,
              folders.map((folder) => ({
                accountId,
                path: folder.id,
                role: folder.role,
                unread: folder.unreadCount,
              })),
            );
          }
        } catch (error) {
          noteFailure("文件夹列表", error);
        }
      }

      // 2) 逐文件夹增量。只有支持 `fetch({folderId})` 的协议（IMAP/Graph）才按
      //    文件夹拉；POP3/EWS 忽略 folderId，若也循环会把同一封邮件重复写成多个
      //    文件夹的行，因此它们只做「默认范围」一次。
      const folderScoped = FOLDER_SCOPED_FETCH.has(loaded.account.provider);
      const targets: { readonly folderId: string | null; readonly folder: string }[] =
        folderScoped && folders.length > 0
          ? folders
              .filter((folder) => SYNC_FOLDER_ROLES.includes(folder.role))
              .map((folder) => ({ folderId: folder.id, folder: folder.id }))
          : [];
      const plan =
        targets.length > 0 ? targets : [{ folderId: null, folder: inboxFolderPath(folders) }];

      for (const target of plan) {
        const scope = target.folderId === null ? "默认范围" : target.folder;
        try {
          let cursor = options.full
            ? undefined
            : target.folderId === null
              ? (store.getCursor(accountId) ?? undefined)
              : (store.getFolderCursor(accountId, target.folderId) ?? undefined);
          let hasMore = true;
          let guard = 0;

          while (hasMore && guard < 200) {
            guard += 1;
            const result = await source.fetch({
              since: cursor,
              limit: 50,
              ...(target.folderId === null ? {} : { folderId: target.folderId }),
              onProgress: (n) => emit(progress(accountId, "fetch", fetched + n, stored)),
            });

            // 同步即落文件夹：`/api/messages?folder=…` 与分类/未读都依赖这一列。
            const { inserted, ids: insertedIds } = store.upsertEmails(
              result.emails,
              target.folder,
            );
            if (inserted > 0) {
              const fresh = new Set(insertedIds);
              await enrichEmailMetadata(
                source,
                result.emails.filter((email) => fresh.has(email.id)),
                target.folderId,
              );
            }
            // 服务器接收时间（T64 契约）：只写适配器真的给出的那几封。
            // 没有条目就省略（不写 null），保留已有值；POP3 永远没有这个信息。
            const receivedAtByUid = result.receivedAtByUid;
            if (receivedAtByUid !== undefined) {
              store.applyReceivedAt(result.emails, receivedAtByUid);
            }
            fetched += result.emails.length;
            stored += inserted;
            emit(progress(accountId, "store", fetched, stored));

            if (result.cursor) {
              if (target.folderId === null) store.setCursor(accountId, result.cursor.value);
              else store.setFolderCursor(accountId, target.folderId, result.cursor.value);
              cursor = result.cursor;
            } else {
              cursor = undefined;
            }
            hasMore = result.hasMore;
          }
        } catch (error) {
          noteFailure(scope, error);
        }
      }

      store.markSynced(accountId, new Date().toISOString());
      const suffix = failures.length > 0 ? `；${failures.length} 个范围失败` : "";
      emit(progress(accountId, "done", fetched, stored, `新增 ${stored} 封${suffix}`));
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

    // v1.1（C7）：邮件级准入完全由「规则→分类」决定（R3/R4 已删除）。
    // 规则/分类每轮读一次；语义叶子与抽取共用同一个 LLM 端口。
    const rules = store.listRules();
    const categories = store.listCategories();
    const port = createLlmPort(llm.config, llm.apiKey);
    const semantic = createSemanticEvaluator({ llm: port });
    const deps: PipelineDeps = {
      llm: port,
      profile,
      classify: async (email) => {
        const result = await classifyEmail(toRuleEmail(email), rules, categories, {
          userEmails: profile.emails,
          timezone: profile.timezone,
          semantic,
        });
        store.replaceTagsForEmail(
          email.id,
          result.matches.map((match) => ({ categoryId: match.categoryId, ruleId: match.ruleId })),
        );
        emit({
          type: "classification",
          data: {
            emailId: email.id,
            accountId: email.accountId,
            categoryIds: [...result.categoryIds],
          },
        });
        return result;
      },
    };

    const pending = store.emailsPendingExtraction(50);
    const total = pending.length;
    if (total === 0) return { done: 0, total: 0 };

    // Batch, not one-by-one: the deterministic "same body, same day"
    // post-processing needs the whole set in view.
    const { tasks, skipped, reminders } = await processEmails(deps, pending);

    // 群发邮件不产生任务（C7）：规则命中的群发在分类阶段已打标签；
    // 同日同文这条确定性后处理分支没有规则命中（categoryIds 为空），
    // 需要在这里补打「群发/通知」这类 broadcast 分类的标签，否则端到端看起来
    // 就是「未分类」，v1 的群发提醒卡片会消失。补标后复用 classification SSE。
    const byId = new Map(pending.map((email) => [email.id, email]));
    const broadcastCategories = categories.filter((category) => category.broadcast);
    const fallbackBroadcast = broadcastCategories[0] ?? null;
    const broadcastCategoryIds = new Set(broadcastCategories.map((category) => category.id));
    let untaggedReminders = 0;

    for (const reminder of reminders) {
      // 规则命中的群发邮件已带 broadcast 标签：路径不变。
      if (reminder.categoryIds.some((categoryId) => broadcastCategoryIds.has(categoryId))) {
        continue;
      }
      if (fallbackBroadcast === null) {
        // 用户删掉/改写了群发分类：不报错，下一轮重算会按新规则重评。
        untaggedReminders += 1;
        continue;
      }
      store.replaceTagsForEmail(reminder.emailId, [
        { categoryId: fallbackBroadcast.id, ruleId: null },
      ]);
      emit({
        type: "classification",
        data: {
          emailId: reminder.emailId,
          accountId: byId.get(reminder.emailId)?.accountId ?? "",
          categoryIds: [fallbackBroadcast.id],
        },
      });
    }

    if (untaggedReminders > 0) {
      console.warn(
        `[extract] ${untaggedReminders} 封群发邮件没有可用的 broadcast 分类，跳过打标；规则/分类变更后重算会自动重评。`,
      );
    }

    const inserted = store.insertTasks(tasks);
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
    // 启动即恢复离线发件队列：重启后继续投递 queued/failed 行（AC-12）。
    // 同步仍由用户显式触发，不会在后台偷偷联网或花 LLM 配额。
    outbox.kick();
  },

  async stopBackground() {
    // 等在飞的一轮投递结束，避免把行留在 `sending`（重启时会被 recover 拉回）。
    await outbox.stop();
  },

  /* ------------------------------ v1.1 依赖槽位 ----------------------------- */
  events,
  mailSource: mailSourceFactory,
  outbox,
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
