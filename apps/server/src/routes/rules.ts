import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type {
  CategoryListResponse,
  CreateCategoryInput,
  CreateRuleInput,
  RawEmail,
  RecomputeProgress,
  RecomputeRequest,
  RecomputeResponse,
  ReorderRulesInput,
  RuleListResponse,
  RuleTree,
  ServerEvent,
  UpdateCategoryInput,
  UpdateRuleInput,
} from "@mailcollect/shared";
import {
  API_PREFIX,
  UNCATEGORIZED_ID,
  UNCATEGORIZED_NAME,
  validateRuleTree,
} from "@mailcollect/shared";
import type {
  ClassificationOptions,
  RuleEmail,
  SemanticEvaluator,
  Store,
} from "@mailcollect/core";
import { StoreError, classifyEmail, createSemanticEvaluator } from "@mailcollect/core";
import { createLlmPort } from "@mailcollect/core/llm";
import { fail, type ApiFailure } from "./errors.js";
import type { RouteDeps } from "./deps.js";

/**
 * v1.1 规则与分类（C6）的 HTTP 面。
 *
 * 端点契约见 `packages/shared/src/api.ts`：
 *   GET/POST /api/categories，PATCH/DELETE /api/categories/:id
 *   GET/POST /api/rules，PATCH/DELETE /api/rules/:id，POST /api/rules/reorder
 *   POST /api/rules/recompute，GET /api/rules/recompute/:jobId
 *
 * 几条不写在类型里的约定：
 * - **删除非空分类要二次确认**：没有 `?confirm=true` 时先回 409，消息里给出将连带删除的
 *   规则/标签数量；只有显式确认才执行（store 的级联删除本身已逐行入账）。
 * - **「未分类」是计算态**：不作为行存在，因此创建/改名到它、以它为规则目标、以它的 id
 *   修改/删除都回 400 —— 不是 404，因为“它不能存在”比“它不存在”更准确。
 * - **种子规则只由 store 建一次**：本模块只做只读呈现，绝不调用 `ensureSeedRules`；
 *   删除后不重播由 `meta.rules_seeded` 保证。
 * - **重算**：`services.rules`（{@link import("../services.js").RulesEnginePort}）注入时把
 *   作业交给引擎；未注入时用本模块的串行队列实现同一契约——后台重算、SSE 进度、
 *   重算期间其它路由照常可用。串行是刻意的：规则变更后排队的那一轮跑在新的规则快照上，
 *   保证“最后一轮重算结束时标签与当前规则一致”（AC-23）。
 *
 * 邮件级的“随带标签”与按分类筛选（ANY）由 server-mail 任务的 `/api/messages` 呈现；
 * 本模块负责标签的写入与 `classification`/`recompute` 事件，筛选语义由 store 的
 * `listEmailIdsByCategories` / `listEmailsInFolder(categoryIds)` 提供。
 */
export function registerRules(app: Hono, deps: RouteDeps): void {
  const { store } = deps;
  const engine = deps.services.rules;
  const emit = (event: ServerEvent): void => deps.events.emit(event);

  /* ----------------------------- recompute state ---------------------------- */

  const jobs = new Map<string, RecomputeProgress>();
  interface QueuedJob {
    readonly progress: RecomputeProgress;
    readonly input: RecomputeRequest;
    readonly auto: boolean;
  }
  const queue: QueuedJob[] = [];
  let pumping = false;
  let autoQueued = false;
  let semanticCache: { readonly identity: string; readonly evaluator: SemanticEvaluator } | null =
    null;

  /* -------------------------------- categories ------------------------------- */

  app.get(
    `${API_PREFIX}/categories`,
    guarded((c) => {
      const body: CategoryListResponse = { items: store.listCategories() };
      return c.json(body);
    }),
  );

  app.post(
    `${API_PREFIX}/categories`,
    guarded(async (c) => {
      const parsed = await parseBody(c, createCategorySchema);
      if (!parsed.ok) return jsonFailure(c, parsed.failure);
      const input: CreateCategoryInput = parsed.value;
      const category = store.createCategory(input);
      scheduleRecompute();
      return c.json({ category }, 201);
    }),
  );

  app.patch(
    `${API_PREFIX}/categories/:id`,
    guarded(async (c) => {
      const id = c.req.param("id") ?? "";
      if (id === UNCATEGORIZED_ID) return jsonFailure(c, uncategorizedReadonly());
      const parsed = await parseBody(c, updateCategorySchema);
      if (!parsed.ok) return jsonFailure(c, parsed.failure);
      const patch: UpdateCategoryInput = parsed.value;
      const category = store.updateCategory(id, patch);
      if (category === null) return jsonFailure(c, fail("not_found", "分类不存在", 404));
      scheduleRecompute();
      return c.json({ category });
    }),
  );

  app.delete(
    `${API_PREFIX}/categories/:id`,
    guarded((c) => {
      const id = c.req.param("id") ?? "";
      if (id === UNCATEGORIZED_ID) return jsonFailure(c, uncategorizedReadonly());
      const category = store.getCategory(id);
      if (category === null) return jsonFailure(c, fail("not_found", "分类不存在", 404));

      const rules = store.listRules().filter((rule) => rule.categoryId === id);
      const taggedEmails = store.listEmailIdsByCategories([id]).length;
      const confirmed = c.req.query("confirm") === "true" || c.req.query("confirm") === "1";
      if (!confirmed && (rules.length > 0 || taggedEmails > 0)) {
        return jsonFailure(
          c,
          fail(
            "invalid_input",
            `删除分类「${category.name}」会连带删除 ${rules.length} 条规则与 ${taggedEmails} 封邮件的标签；请带 confirm=true 二次确认`,
            409,
          ),
        );
      }

      store.deleteCategory(id);
      // 级联删掉的是该分类的规则/标签；其余规则对这批邮件可能仍有命中，重算一次收敛。
      scheduleRecompute();
      return c.json({ ok: true });
    }),
  );

  /* ----------------------------------- rules --------------------------------- */

  app.get(
    `${API_PREFIX}/rules`,
    guarded((c) => {
      const body: RuleListResponse = { items: store.listRules() };
      return c.json(body);
    }),
  );

  app.post(
    `${API_PREFIX}/rules`,
    guarded(async (c) => {
      const parsed = await parseBody(c, createRuleSchema);
      if (!parsed.ok) return jsonFailure(c, parsed.failure);
      const body = parsed.value;
      if (body.categoryId === UNCATEGORIZED_ID) return jsonFailure(c, uncategorizedTarget());
      if (body.tree === undefined) {
        return jsonFailure(c, fail("invalid_input", "条件树（tree）必填", 400));
      }
      const tree = parseTree(body.tree);
      if (!tree.ok) return jsonFailure(c, tree.failure);

      const input: CreateRuleInput = {
        name: body.name,
        categoryId: body.categoryId,
        tree: tree.value,
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.order === undefined ? {} : { order: body.order }),
      };
      const rule = store.createRule(input);
      scheduleRecompute();
      return c.json({ rule }, 201);
    }),
  );

  app.patch(
    `${API_PREFIX}/rules/:id`,
    guarded(async (c) => {
      const parsed = await parseBody(c, updateRuleSchema);
      if (!parsed.ok) return jsonFailure(c, parsed.failure);
      const body = parsed.value;

      const patch: UpdateRuleInput = {};
      if (body.name !== undefined) patch.name = body.name;
      if (body.categoryId !== undefined) {
        if (body.categoryId === UNCATEGORIZED_ID) return jsonFailure(c, uncategorizedTarget());
        patch.categoryId = body.categoryId;
      }
      if (body.tree !== undefined) {
        const tree = parseTree(body.tree);
        if (!tree.ok) return jsonFailure(c, tree.failure);
        patch.tree = tree.value;
      }
      if (body.enabled !== undefined) patch.enabled = body.enabled;
      if (body.order !== undefined) patch.order = body.order;

      const rule = store.updateRule(c.req.param("id") ?? "", patch);
      if (rule === null) return jsonFailure(c, fail("not_found", "规则不存在", 404));
      scheduleRecompute();
      return c.json({ rule });
    }),
  );

  app.delete(
    `${API_PREFIX}/rules/:id`,
    guarded((c) => {
      const removed = store.deleteRule(c.req.param("id") ?? "");
      if (!removed) return jsonFailure(c, fail("not_found", "规则不存在", 404));
      scheduleRecompute();
      return c.json({ ok: true });
    }),
  );

  app.post(
    `${API_PREFIX}/rules/reorder`,
    guarded(async (c) => {
      const parsed = await parseBody(c, reorderSchema);
      if (!parsed.ok) return jsonFailure(c, parsed.failure);
      const input: ReorderRulesInput = parsed.value;
      // 顺序只影响展示/求值顺序以及「同分类多条规则命中时保留哪条 ruleId」，
      // 所以排完序也重算一次，标签上的 ruleId 立刻与展示顺序一致。
      const items = store.reorderRules(input.ids);
      scheduleRecompute();
      return c.json({ items });
    }),
  );

  /* --------------------------------- recompute ------------------------------- */

  app.post(
    `${API_PREFIX}/rules/recompute`,
    guarded(async (c) => {
      const parsed = await parseBody(c, recomputeSchema);
      if (!parsed.ok) return jsonFailure(c, parsed.failure);
      const input: RecomputeRequest = parsed.value ?? {};
      const response = engine ? await engine.startRecompute(input, emit) : enqueue(input, false);
      return c.json(response, 202);
    }),
  );

  app.get(
    `${API_PREFIX}/rules/recompute/:jobId`,
    guarded((c) => {
      const progress = readProgress(c.req.param("jobId") ?? "");
      if (progress === null) return jsonFailure(c, fail("not_found", "重算作业不存在", 404));
      return c.json(progress);
    }),
  );

  /* ------------------------------- job engine -------------------------------- */

  /** 排队一轮重算并立刻返回 jobId；真正的处理在事件循环里串行进行。 */
  function enqueue(input: RecomputeRequest, auto: boolean): RecomputeResponse {
    const progress: RecomputeProgress = {
      jobId: `recompute-${randomUUID()}`,
      done: 0,
      total: 0,
      finished: false,
    };
    queue.push({ progress, input, auto });
    publish(progress);
    pruneJobs();
    // 下一轮事件循环再启动：HTTP 响应先回去，收集目标邮件不会拖慢这次写请求。
    setImmediate(() => {
      void pump();
    });
    return { jobId: progress.jobId };
  }

  /**
   * 规则/分类变更后的后台重算（C6 触发条件）。
   * 已有一轮 auto 在排队时不再叠加：正在跑的那一轮用旧快照，紧随其后的这一轮用新快照。
   */
  function scheduleRecompute(): void {
    if (engine) {
      void engine.startRecompute({}, emit).catch((error: unknown) => {
        emitFailure(error);
      });
      return;
    }
    if (autoQueued) return;
    autoQueued = true;
    enqueue({}, true);
  }

  /** 串行泵：一轮结束才启动下一轮，保证最后完成的那一轮看到的是最新规则。 */
  async function pump(): Promise<void> {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const job = queue.shift();
        if (job === undefined) break;
        if (job.auto) autoQueued = false;
        try {
          await runJob(job.progress, job.input);
        } catch (error) {
          emitFailure(error);
        } finally {
          job.progress.finished = true;
          publish(job.progress);
          pruneJobs();
        }
      }
    } finally {
      pumping = false;
    }
  }

  async function runJob(progress: RecomputeProgress, input: RecomputeRequest): Promise<void> {
    const emails = collectTargetEmails(store, input);
    progress.total = emails.length;
    publish(progress);

    const rules = store.listRules();
    const categories = store.listCategories();
    const profile = store.getProfile();
    const options: ClassificationOptions = {
      userEmails: profile?.emails ?? [],
      semantic: semanticEvaluator(),
      ...(profile?.timezone ? { timezone: profile.timezone } : {}),
    };

    for (const email of emails) {
      try {
        const result = await classifyEmail(toRuleEmail(store, email), rules, categories, options);
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
      } catch (error) {
        // 单封失败不打断整轮；下一轮重算会重试。
        emitFailure(error);
      }
      progress.done += 1;
      publish(progress);
      if (progress.done % 20 === 0) await yieldToEventLoop();
    }
  }

  /**
   * 当前 LLM 配置对应的语义求值器；未配置 LLM 时返回 null（语义叶子按 false 处理，
   * 字段规则照常工作）。provider/model 变化时重建，缓存键由 core 负责失效。
   */
  function semanticEvaluator(): SemanticEvaluator | null {
    const llm = store.getLlmWithKey();
    if (llm === null) return null;
    const identity = [llm.config.id, llm.config.protocol, llm.config.baseUrl, llm.config.model].join(
      "\u0000",
    );
    if (semanticCache?.identity === identity) return semanticCache.evaluator;
    const factory = deps.services.llm ?? createLlmPort;
    try {
      semanticCache = {
        identity,
        evaluator: createSemanticEvaluator({ llm: factory(llm.config, llm.apiKey) }),
      };
    } catch (error) {
      emitFailure(error);
      semanticCache = null;
      return null;
    }
    return semanticCache.evaluator;
  }

  function readProgress(jobId: string): RecomputeProgress | null {
    const local = jobs.get(jobId);
    if (local !== undefined) return snapshot(local);
    return engine?.progress(jobId) ?? null;
  }

  function publish(progress: RecomputeProgress): void {
    jobs.set(progress.jobId, progress);
    emit({ type: "recompute", data: snapshot(progress) });
  }

  function pruneJobs(): void {
    while (jobs.size > 32) {
      let removed = false;
      for (const [id, job] of jobs) {
        if (!job.finished) continue;
        jobs.delete(id);
        removed = true;
        break;
      }
      if (!removed) return;
    }
  }

  function emitFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    emit({ type: "error", data: { message } });
  }
}

/* --------------------------------- helpers --------------------------------- */

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ApiFailure };
type RouteHandler = (c: Context) => Response | Promise<Response>;

const createCategorySchema = z.object({
  name: z.string(),
  enterTodo: z.boolean(),
  broadcast: z.boolean(),
});

const updateCategorySchema = z.object({
  name: z.string().optional(),
  enterTodo: z.boolean().optional(),
  broadcast: z.boolean().optional(),
});

const createRuleSchema = z.object({
  name: z.string(),
  categoryId: z.string(),
  tree: z.unknown(),
  enabled: z.boolean().optional(),
  order: z.number().int().nonnegative().optional(),
});

const updateRuleSchema = z.object({
  name: z.string().optional(),
  categoryId: z.string().optional(),
  tree: z.unknown().optional(),
  enabled: z.boolean().optional(),
  order: z.number().int().nonnegative().optional(),
});

const reorderSchema = z.object({ ids: z.array(z.string()) });

/** 空 body 也合法：`{}` 等价于“重算全部已存邮件”。 */
const recomputeSchema = z
  .object({
    accountId: z.string().optional(),
    emailIds: z.array(z.string()).optional(),
  })
  .optional();

const jsonFailure = (c: Context, failure: ApiFailure): Response =>
  c.json(failure.body, failure.status as ContentfulStatusCode);

/** 路由边界：把 store 的类型化错误映射成冻结的 API 错误形状，其余错误继续上抛。 */
const guarded =
  (handler: RouteHandler): RouteHandler =>
  async (c) => {
    try {
      return await handler(c);
    } catch (error) {
      const failure = storeFailure(error);
      if (failure === null) throw error;
      return jsonFailure(c, failure);
    }
  };

const storeFailure = (error: unknown): ApiFailure | null => {
  if (!(error instanceof StoreError)) return null;
  switch (error.code) {
    case "not_found":
      return fail("not_found", error.message, 404);
    case "conflict":
      return fail("invalid_input", error.message, 409);
    case "invalid":
      return fail("invalid_input", error.message, 400);
    case "state":
      return fail("internal", error.message, 500);
    default: {
      const exhaustive: never = error.code;
      return fail("internal", `未知的存储错误：${String(exhaustive)}`, 500);
    }
  }
};

const uncategorizedReadonly = (): ApiFailure =>
  fail("invalid_input", `「${UNCATEGORIZED_NAME}」是计算态，不能创建、修改或删除`, 400);

const uncategorizedTarget = (): ApiFailure =>
  fail("invalid_input", `「${UNCATEGORIZED_NAME}」是计算态，不能作为规则的目标分类`, 400);

const parseBody = async <T>(c: Context, schema: z.ZodType<T>): Promise<Parsed<T>> => {
  const raw = await c.req.text();
  if (raw.trim() === "") {
    const parsedEmpty = schema.safeParse(undefined);
    if (parsedEmpty.success) return { ok: true, value: parsedEmpty.data };
    return { ok: false, failure: fail("invalid_input", "请求体不能为空", 400) };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, failure: fail("invalid_input", "请求体不是合法 JSON", 400) };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join(".") || "body"}: ${issue.message}`)
      .join("; ");
    return { ok: false, failure: fail("invalid_input", `请求体不合法：${detail}`, 400) };
  }
  return { ok: true, value: parsed.data };
};

const parseTree = (input: unknown): Parsed<RuleTree> => {
  const result = validateRuleTree(input);
  if (result.ok) return { ok: true, value: result.tree };
  const detail = result.issues
    .map((issue) => `${issue.path === "" ? "root" : issue.path}:${issue.code}`)
    .join(", ");
  return { ok: false, failure: fail("invalid_input", `条件树不合法（${detail}）`, 400) };
};

/** 重算目标：显式 emailIds 优先；否则按 accountId 过滤，分页读出全部已存邮件。 */
const collectTargetEmails = (store: Store, input: RecomputeRequest): RawEmail[] => {
  const emailIds = input.emailIds === undefined ? null : [...new Set(input.emailIds)];
  if (emailIds !== null) {
    const targets: RawEmail[] = [];
    for (const id of emailIds) {
      const email = store.getEmail(id);
      if (email === null) continue;
      if (input.accountId !== undefined && email.accountId !== input.accountId) continue;
      targets.push(email);
    }
    return targets;
  }

  const emails: RawEmail[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = store.listEmails({
      limit: 200,
      ...(input.accountId === undefined ? {} : { accountId: input.accountId }),
      ...(cursor === null ? {} : { cursor }),
    });
    emails.push(...page.items);
    cursor = page.nextCursor;
    if (cursor === null) break;
  }
  return emails;
};

const toRuleEmail = (store: Store, email: RawEmail): RuleEmail => {
  const state = store.getEmailState(email.id);
  return {
    id: email.id,
    accountId: email.accountId,
    fromName: email.fromName,
    fromEmail: email.fromEmail,
    to: email.to,
    cc: email.cc,
    subject: email.subject,
    bodyText: email.bodyText,
    sentAt: email.sentAt,
    headers: email.headers,
    hasAttachments: email.hasAttachments,
    ...(state === null ? {} : { folder: state.folder, isRead: state.isRead }),
  };
};

const snapshot = (progress: RecomputeProgress): RecomputeProgress => ({
  jobId: progress.jobId,
  done: progress.done,
  total: progress.total,
  finished: progress.finished,
});

/** 让出事件循环：纯字段规则一轮可能很密，其它路由必须仍能立刻响应。 */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });
