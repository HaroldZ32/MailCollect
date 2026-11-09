import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import type {
  Category,
  LlmConfig,
  RawEmail,
  RecomputeProgress,
  RecomputeResponse,
  Rule,
  RuleTree,
  ServerEvent,
} from "@mailcollect/shared";
import {
  SEED_CATEGORY_BROADCAST_ID,
  SEED_CATEGORY_BROADCAST_NAME,
  SEED_RULE_BROADCAST_ID,
  UNCATEGORIZED_ID,
} from "@mailcollect/shared";
import type { LlmPort, LlmResult, StructuredRequest } from "@mailcollect/core/llm";
import { openStore, type Store } from "@mailcollect/core";
import { createApp } from "../app.js";
import { createEventBus } from "../services.js";
import type { EventBus, RulesEnginePort, ServerServices } from "../services.js";

/**
 * server-rules 的端点测试：分类/规则 CRUD、AST 校验、后台重算与 SSE、
 * 以及标签写在 store 上的可查询结果。
 *
 * 全部走真实 store（临时目录里的 SQLite fixture）+ 假 LlmPort；不连网络、不连真实邮箱。
 * 重算期间「其它接口可用」用被 hold 住的假 LLM 制造在途作业来证明。
 */

const TOKEN = "rules-token";
const ACCOUNT_EMAIL = "me@corp.com";

const LLM_CONFIG: LlmConfig = {
  id: "llm-fake",
  label: "fake",
  protocol: "openai-compatible",
  baseUrl: "https://llm.example.com/v1",
  model: "fake-model",
  apiKeyRef: "stored",
  temperature: 0,
  maxTokens: 512,
  timeoutMs: 1_000,
  isDefault: true,
};

interface FakeLlm {
  readonly port: LlmPort;
  readonly calls: StructuredRequest[];
  setAnswer(value: boolean): void;
  hold(): void;
  release(): void;
}

/** 假 LlmPort：记录提示词，答案可切换；`hold()` 能把一次重算卡在模型调用上。 */
const createFakeLlm = (answer: boolean): FakeLlm => {
  const calls: StructuredRequest[] = [];
  const state: { answer: boolean } = { answer };
  let gate: { readonly promise: Promise<void>; readonly release: () => void } | null = null;
  const port: LlmPort = {
    config: LLM_CONFIG,
    async structured<T>(schema: ZodType<T>, request: StructuredRequest): Promise<LlmResult<T>> {
      calls.push(request);
      const pending = gate;
      if (pending !== null) await pending.promise;
      const value = schema.parse({ match: state.answer });
      return {
        value,
        raw: JSON.stringify({ match: state.answer }),
        usage: null,
        repaired: false,
        latencyMs: 1,
      };
    },
    async ping() {
      return { ok: true, latencyMs: 1, detail: "fake" };
    },
  };
  return {
    port,
    calls,
    setAnswer(value) {
      state.answer = value;
    },
    hold() {
      let release: () => void = () => undefined;
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      gate = { promise, release };
    },
    release() {
      const pending = gate;
      gate = null;
      pending?.release();
    },
  };
};

const buildServices = (events: EventBus, llm: LlmPort): ServerServices => ({
  verifyAccount: async () => ({ ok: true, detail: "OK" }),
  loginAccount: async () => undefined,
  syncAccount: async () => undefined,
  extract: async () => ({ done: 0, total: 0 }),
  testLlm: async () => ({ ok: true, latencyMs: 1, detail: "fake" }),
  startBackground: () => undefined,
  stopBackground: async () => undefined,
  events,
  llm: () => llm,
});

let dir: string;
let store: Store;
let events: EventBus;
let fake: FakeLlm;
let app: ReturnType<typeof createApp>;
let accountId: string;

const email = (overrides: Partial<RawEmail> & Pick<RawEmail, "id" | "uid" | "subject">): RawEmail => ({
  accountId,
  messageId: `<${overrides.id}@example.com>`,
  threadId: null,
  fromName: "李雷",
  fromEmail: "lilei@corp.com",
  to: [ACCOUNT_EMAIL],
  cc: [],
  sentAt: "2026-11-02T09:00:00.000Z",
  bodyText: "正文",
  hasAttachments: false,
  headers: {},
  createdAt: "2026-11-02T09:00:01.000Z",
  ...overrides,
});

const call = (path: string, init: RequestInit = {}): Promise<Response> => {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${TOKEN}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return Promise.resolve(app.request(path, { ...init, headers }));
};

const sendJson = (path: string, method: string, body: unknown): Promise<Response> =>
  call(path, { method, body: JSON.stringify(body) });

const readJson = async <T>(response: Response): Promise<T> => (await response.json()) as T;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const waitFor = async (predicate: () => boolean, label: string): Promise<void> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await sleep(5);
  }
  throw new Error(`等待超时：${label}`);
};

const waitForJob = async (jobId: string): Promise<RecomputeProgress> => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await call(`/api/rules/recompute/${encodeURIComponent(jobId)}`);
    expect(response.status).toBe(200);
    const progress = await readJson<RecomputeProgress>(response);
    if (progress.finished) return progress;
    await sleep(5);
  }
  throw new Error(`重算作业 ${jobId} 未在 2s 内结束`);
};

/** 手动重算并等到真正结束：串行队列保证它结束时此前排队的自动重算也都完成了。 */
const drainRecompute = async (): Promise<RecomputeProgress> => {
  const response = await sendJson("/api/rules/recompute", "POST", {});
  expect(response.status).toBe(202);
  const { jobId } = await readJson<RecomputeResponse>(response);
  return waitForJob(jobId);
};

const createCategory = async (
  name: string,
  enterTodo = true,
  broadcast = false,
): Promise<Category> => {
  const response = await sendJson("/api/categories", "POST", { name, enterTodo, broadcast });
  expect(response.status).toBe(201);
  return (await readJson<{ category: Category }>(response)).category;
};

const createRule = async (name: string, categoryId: string, tree: RuleTree): Promise<Rule> => {
  const response = await sendJson("/api/rules", "POST", { name, categoryId, tree });
  expect(response.status).toBe(201);
  return (await readJson<{ rule: Rule }>(response)).rule;
};

const subjectContains = (value: string): RuleTree => ({
  kind: "field",
  field: "subject",
  op: "contains",
  value,
});

const bodyContains = (value: string): RuleTree => ({
  kind: "field",
  field: "body",
  op: "contains",
  value,
});

const semanticTree = (expr: string): RuleTree => ({ kind: "semantic", expr });

const nestedNot = (depth: number): RuleTree => {
  let tree: RuleTree = subjectContains("x");
  for (let index = 0; index < depth; index += 1) tree = { kind: "not", child: tree };
  return tree;
};

const nextFinished = (): Promise<RecomputeProgress> =>
  new Promise((resolve) => {
    const off = events.subscribe((event) => {
      if (event.type !== "recompute") return;
      if (!event.data.finished) return;
      off();
      resolve(event.data);
    });
  });

const tagsOf = (emailId: string): string[] =>
  store
    .listTagsForEmail(emailId)
    .map((tag) => tag.categoryId)
    .sort();

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "mailcollect-rules-"));
  store = await openStore(join(dir, "db.sqlite"), "device-rules");
  accountId = store.createAccount({
    provider: "imap",
    label: "测试邮箱",
    email: ACCOUNT_EMAIL,
    config: { host: "imap.corp.com" },
    secret: "app-password",
  }).id;
  store.upsertEmails([
    email({
      id: "e1",
      uid: "1",
      subject: "请张三周五前提交报告",
      bodyText: "张三，请在周五下班前把季度报告发我。",
    }),
    email({
      id: "e2",
      uid: "2",
      fromName: "公告",
      fromEmail: "news@lists.example.com",
      subject: "本周公告",
      bodyText: "周会安排见附件。",
      sentAt: "2026-11-03T09:00:00.000Z",
      headers: { "List-Id": "<announce.example.com>" },
    }),
    email({
      id: "e3",
      uid: "3",
      fromName: "王五",
      fromEmail: "wangwu@partner.com",
      subject: "项目 X 进度",
      bodyText: "项目 X 的进度在催，请尽快回复。",
      sentAt: "2026-11-04T09:00:00.000Z",
    }),
  ]);
  store.upsertLlmConfig({
    label: "fake",
    protocol: "openai-compatible",
    baseUrl: LLM_CONFIG.baseUrl,
    model: LLM_CONFIG.model,
    apiKey: "sk-test",
    isDefault: true,
  });
  fake = createFakeLlm(true);
  events = createEventBus();
  app = createApp({ store, services: buildServices(events, fake.port), token: TOKEN, version: "test" });
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("categories api", () => {
  it("presents the store-seeded category/rule once and never re-seeds them over HTTP", async () => {
    const first = await call("/api/categories");
    expect(first.status).toBe(200);
    const categories = await readJson<{ items: Category[] }>(first);
    const seed = categories.items.find((category) => category.id === SEED_CATEGORY_BROADCAST_ID);
    expect(seed?.name).toBe(SEED_CATEGORY_BROADCAST_NAME);
    expect(seed?.broadcast).toBe(true);
    expect(seed?.enterTodo).toBe(false);

    const rules = await readJson<{ items: Rule[] }>(await call("/api/rules"));
    expect(rules.items.some((rule) => rule.id === SEED_RULE_BROADCAST_ID)).toBe(true);

    // 接口只是只读呈现；删掉种子规则后即使再次迁移（重启路径）也不重播。
    expect((await call(`/api/rules/${SEED_RULE_BROADCAST_ID}`, { method: "DELETE" })).status).toBe(
      200,
    );
    store.migrate();
    const after = await readJson<{ items: Rule[] }>(await call("/api/rules"));
    expect(after.items.some((rule) => rule.id === SEED_RULE_BROADCAST_ID)).toBe(false);
    expect(store.getCategory(SEED_CATEGORY_BROADCAST_ID)).not.toBeNull();

    const again = await readJson<{ items: Category[] }>(await call("/api/categories"));
    expect(again.items).toHaveLength(categories.items.length);

    await drainRecompute();
  });

  it("creates, renames and toggles categories while enforcing uniqueness and 未分类", async () => {
    const created = await sendJson("/api/categories", "POST", {
      name: " 工作 ",
      enterTodo: true,
      broadcast: false,
    });
    expect(created.status).toBe(201);
    const category = (await readJson<{ category: Category }>(created)).category;
    expect(category.name).toBe("工作");
    expect(category.enterTodo).toBe(true);
    expect(category.broadcast).toBe(false);

    const duplicate = await sendJson("/api/categories", "POST", {
      name: "工作",
      enterTodo: true,
      broadcast: false,
    });
    expect(duplicate.status).toBe(409);
    expect((await readJson<{ error: { code: string } }>(duplicate)).error.code).toBe("invalid_input");

    const reserved = await sendJson("/api/categories", "POST", {
      name: "未分类",
      enterTodo: true,
      broadcast: false,
    });
    expect(reserved.status).toBe(400);

    const missingFlags = await sendJson("/api/categories", "POST", { name: "只有名字" });
    expect(missingFlags.status).toBe(400);

    const emptyName = await sendJson("/api/categories", "POST", {
      name: "   ",
      enterTodo: true,
      broadcast: false,
    });
    expect(emptyName.status).toBe(400);

    const renamed = await call(`/api/categories/${category.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "项目", broadcast: true }),
    });
    expect(renamed.status).toBe(200);
    const patched = (await readJson<{ category: Category }>(renamed)).category;
    expect(patched.name).toBe("项目");
    expect(patched.broadcast).toBe(true);

    const clash = await call(`/api/categories/${category.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: SEED_CATEGORY_BROADCAST_NAME }),
    });
    expect(clash.status).toBe(409);

    const toReserved = await call(`/api/categories/${category.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "未分类" }),
    });
    expect(toReserved.status).toBe(400);

    expect((await call("/api/categories/nope", { method: "PATCH", body: "{}" })).status).toBe(404);
    expect(
      (await call(`/api/categories/${UNCATEGORIZED_ID}`, { method: "PATCH", body: "{}" })).status,
    ).toBe(400);

    await drainRecompute();
  });

  it("requires a second confirmation before deleting a non-empty category and cascades its rules", async () => {
    const empty = await createCategory("空分类", false, false);
    expect((await call(`/api/categories/${empty.id}`, { method: "DELETE" })).status).toBe(200);

    const category = await createCategory("报告", true, false);
    const rule = await createRule("报告规则", category.id, subjectContains("报告"));
    const progress = await drainRecompute();
    expect(progress.total).toBe(3);
    expect(tagsOf("e1")).toContain(category.id);

    const unconfirmed = await call(`/api/categories/${category.id}`, { method: "DELETE" });
    expect(unconfirmed.status).toBe(409);
    const refusal = await readJson<{ error: { code: string; message: string } }>(unconfirmed);
    expect(refusal.error.code).toBe("invalid_input");
    expect(refusal.error.message).toContain("confirm=true");
    expect(refusal.error.message).toContain("1 条规则");
    expect(store.getCategory(category.id)).not.toBeNull();
    expect(store.getRule(rule.id)).not.toBeNull();

    const confirmed = await call(`/api/categories/${category.id}?confirm=true`, { method: "DELETE" });
    expect(confirmed.status).toBe(200);
    expect(store.getCategory(category.id)).toBeNull();
    expect(store.getRule(rule.id)).toBeNull();
    expect(tagsOf("e1")).not.toContain(category.id);

    expect((await call(`/api/categories/${UNCATEGORIZED_ID}`, { method: "DELETE" })).status).toBe(
      400,
    );
    expect((await call("/api/categories/nope", { method: "DELETE" })).status).toBe(404);

    await drainRecompute();
  });
});

describe("rules api", () => {
  it("rejects an invalid AST with typed 400s and accepts the depth-8 boundary", async () => {
    const category = await createCategory("规则目标", true, false);

    const tooDeep = await sendJson("/api/rules", "POST", {
      name: "太深",
      categoryId: category.id,
      tree: nestedNot(9),
    });
    expect(tooDeep.status).toBe(400);
    expect((await readJson<{ error: { message: string } }>(tooDeep)).error.message).toContain(
      "depth_exceeded",
    );

    const badLeaf = await sendJson("/api/rules", "POST", {
      name: "非法叶子",
      categoryId: category.id,
      tree: { kind: "field", field: "subject", op: "gt", value: 3 },
    });
    expect(badLeaf.status).toBe(400);
    expect((await readJson<{ error: { message: string } }>(badLeaf)).error.message).toContain(
      "operator_not_allowed",
    );

    const missingTree = await sendJson("/api/rules", "POST", {
      name: "没有树",
      categoryId: category.id,
    });
    expect(missingTree.status).toBe(400);

    const missingCategory = await sendJson("/api/rules", "POST", {
      name: "目标不存在",
      categoryId: "nope",
      tree: subjectContains("报告"),
    });
    expect(missingCategory.status).toBe(404);

    const reservedTarget = await sendJson("/api/rules", "POST", {
      name: "指向未分类",
      categoryId: UNCATEGORIZED_ID,
      tree: subjectContains("报告"),
    });
    expect(reservedTarget.status).toBe(400);

    const emptyName = await sendJson("/api/rules", "POST", {
      name: "   ",
      categoryId: category.id,
      tree: subjectContains("报告"),
    });
    expect(emptyName.status).toBe(400);

    // 边界：深度恰好 8 合法。
    const depth8 = await createRule("深度八", category.id, nestedNot(8));
    expect(depth8.tree).toBeDefined();

    const badPatch = await call(`/api/rules/${depth8.id}`, {
      method: "PATCH",
      body: JSON.stringify({ tree: nestedNot(9) }),
    });
    expect(badPatch.status).toBe(400);
    expect((await readJson<{ error: { message: string } }>(badPatch)).error.message).toContain(
      "depth_exceeded",
    );

    expect((await call("/api/rules/nope", { method: "PATCH", body: "{}" })).status).toBe(404);

    await drainRecompute();
  });

  it("creates, toggles, reorders and deletes rules", async () => {
    const category = await createCategory("排序目标", true, false);
    const first = await createRule("第一条", category.id, subjectContains("请"));
    const second = await createRule("第二条", category.id, bodyContains("项目"));

    const list = await readJson<{ items: Rule[] }>(await call("/api/rules"));
    expect(list.items.find((rule) => rule.id === first.id)?.order).toBeLessThan(
      list.items.find((rule) => rule.id === second.id)?.order ?? -1,
    );

    const disabled = await call(`/api/rules/${first.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    expect((await readJson<{ rule: Rule }>(disabled)).rule.enabled).toBe(false);

    const reordered = await sendJson("/api/rules/reorder", "POST", {
      ids: [second.id, first.id],
    });
    expect(reordered.status).toBe(200);
    const items = (await readJson<{ items: Rule[] }>(reordered)).items;
    const position = (id: string): number => items.findIndex((rule) => rule.id === id);
    expect(position(second.id)).toBeLessThan(position(first.id));

    const unknownReorder = await sendJson("/api/rules/reorder", "POST", { ids: ["nope"] });
    expect(unknownReorder.status).toBe(404);

    expect((await call(`/api/rules/${second.id}`, { method: "DELETE" })).status).toBe(200);
    const after = await readJson<{ items: Rule[] }>(await call("/api/rules"));
    expect(after.items.some((rule) => rule.id === second.id)).toBe(false);
    expect((await call(`/api/rules/${second.id}`, { method: "DELETE" })).status).toBe(404);

    await drainRecompute();
  });
});

describe("recompute", () => {
  it("tags stored mail in the background, streams progress over SSE and is idempotent", async () => {
    const reports = await createCategory("报告", true, false);
    const chase = await createCategory("催办", true, true);
    const urgent = await createCategory("紧急", false, true);
    await createRule("报告规则", reports.id, subjectContains("报告"));
    await createRule("催办规则", chase.id, bodyContains("项目"));
    await createRule("紧急规则", urgent.id, subjectContains("请"));

    const seen: ServerEvent[] = [];
    const off = events.subscribe((event) => {
      seen.push(event);
    });
    const started = await sendJson("/api/rules/recompute", "POST", {});
    expect(started.status).toBe(202);
    const { jobId } = await readJson<RecomputeResponse>(started);
    expect(jobId).toMatch(/^recompute-/);
    try {
      const progress = await waitForJob(jobId);
      expect(progress).toMatchObject({ jobId, done: 3, total: 3, finished: true });
      // 全是字段叶子 → 一轮重算 0 次模型调用。
      expect(fake.calls).toHaveLength(0);
    } finally {
      off();
    }

    const progressEvents = seen.filter(
      (event): event is Extract<ServerEvent, { type: "recompute" }> =>
        event.type === "recompute" && event.data.jobId === jobId,
    );
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(progressEvents.some((event) => event.data.finished)).toBe(true);
    expect(progressEvents.map((event) => event.data.done)).toEqual(
      [...progressEvents.map((event) => event.data.done)].sort((left, right) => left - right),
    );

    const classification = seen.filter(
      (event): event is Extract<ServerEvent, { type: "classification" }> =>
        event.type === "classification",
    );
    // 自动重算也会发分类事件；串行队列保证最后一轮（手动 job）的事件是最终结论。
    const e1Event = classification.filter((event) => event.data.emailId === "e1").at(-1);
    expect(e1Event?.data.categoryIds.slice().sort()).toEqual([reports.id, urgent.id].sort());

    // 多标签 + 不短路：一封邮件同时命中两个分类，各自带自己的开关。
    expect(tagsOf("e1")).toEqual([reports.id, urgent.id].sort());
    const categories = (await readJson<{ items: Category[] }>(await call("/api/categories"))).items;
    expect(categories.find((item) => item.id === chase.id)?.broadcast).toBe(true);
    expect(categories.find((item) => item.id === urgent.id)?.enterTodo).toBe(false);

    // 种子规则同样参与分类：List-Id 邮件落到「群发/通知」。
    expect(tagsOf("e2")).toEqual([SEED_CATEGORY_BROADCAST_ID]);

    // 邮件列表的筛选缝（server-mail 的 /api/messages 使用同一组 store 查询）：ANY 语义。
    expect(store.listEmailIdsByCategories([reports.id])).toEqual(["e1"]);
    expect(store.listEmailIdsByCategories([reports.id, chase.id]).sort()).toEqual(["e1", "e3"]);
    expect(store.listEmailIdsByCategories([reports.id, chase.id, SEED_CATEGORY_BROADCAST_ID]).sort()).toEqual(
      ["e1", "e2", "e3"],
    );

    const before = store
      .listTagsForEmails(["e1", "e2", "e3"])
      .map((tag) => tag.id)
      .sort();
    const secondRun = await drainRecompute();
    expect(secondRun.finished).toBe(true);
    const after = store
      .listTagsForEmails(["e1", "e2", "e3"])
      .map((tag) => tag.id)
      .sort();
    expect(after).toEqual(before);
  });

  it("scopes a recompute to one account and accepts an empty request body", async () => {
    const otherAccount = store.createAccount({
      provider: "imap",
      label: "另一个邮箱",
      email: "other@corp.com",
      config: { host: "imap.other.com" },
      secret: "",
    }).id;
    store.upsertEmails([
      email({
        id: "e4",
        uid: "4",
        accountId: otherAccount,
        subject: "另一个账号的邮件",
        bodyText: "这封只属于另一个账号。",
      }),
    ]);

    const scoped = await sendJson("/api/rules/recompute", "POST", { accountId: otherAccount });
    expect(scoped.status).toBe(202);
    const { jobId } = await readJson<RecomputeResponse>(scoped);
    expect((await waitForJob(jobId)).total).toBe(1);

    // 空 body 也接受：等价于重算全部已存邮件（4 封）。
    const emptyBody = await call("/api/rules/recompute", { method: "POST" });
    expect(emptyBody.status).toBe(202);
    const emptyJob = await readJson<RecomputeResponse>(emptyBody);
    expect((await waitForJob(emptyJob.jobId)).total).toBe(4);
  });

  it("evaluates semantic leaves through the configured model, deduplicated by expression", async () => {
    const semanticCategory = store.createCategory({
      name: "语义",
      enterTodo: true,
      broadcast: false,
    });
    store.createRule({
      name: "语义规则 A",
      categoryId: semanticCategory.id,
      tree: semanticTree("正文在催进度"),
    });
    store.createRule({
      name: "语义规则 B",
      categoryId: semanticCategory.id,
      tree: semanticTree("正文在催进度"),
    });

    const started = await sendJson("/api/rules/recompute", "POST", { emailIds: ["e1"] });
    expect(started.status).toBe(202);
    const { jobId } = await readJson<RecomputeResponse>(started);
    const progress = await waitForJob(jobId);
    expect(progress.total).toBe(1);

    // 两条规则共用同一个表达式 → 一轮只调用一次模型。
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.user).toContain("正文在催进度");
    expect(tagsOf("e1")).toContain(semanticCategory.id);

    // 模型判 false 时不打标签（同一表达式对另一封邮件重新求值）。
    fake.setAnswer(false);
    const second = await sendJson("/api/rules/recompute", "POST", { emailIds: ["e2"] });
    const secondJob = await readJson<RecomputeResponse>(second);
    await waitForJob(secondJob.jobId);
    expect(tagsOf("e2")).not.toContain(semanticCategory.id);
  });

  it("keeps other endpoints responsive while a recompute is in flight", async () => {
    const semanticCategory = store.createCategory({
      name: "慢语义",
      enterTodo: true,
      broadcast: false,
    });
    store.createRule({
      name: "慢语义规则",
      categoryId: semanticCategory.id,
      tree: semanticTree("正文在催进度"),
    });

    fake.hold();
    try {
      const started = await sendJson("/api/rules/recompute", "POST", {});
      expect(started.status).toBe(202);
      const { jobId } = await readJson<RecomputeResponse>(started);

      await waitFor(() => fake.calls.length === 1, "作业已经卡在模型调用上");
      const inFlight = await readJson<RecomputeProgress>(
        await call(`/api/rules/recompute/${jobId}`),
      );
      expect(inFlight).toMatchObject({ jobId, done: 0, total: 3, finished: false });

      // 重算在途时其它接口照常响应（这是 AC-23 的“重算期间 UI 可用”端点侧证据）。
      expect((await call("/api/categories")).status).toBe(200);
      expect((await call("/api/rules")).status).toBe(200);
    } finally {
      fake.release();
    }

    const finished = await drainRecompute();
    expect(finished.finished).toBe(true);
  });

  it("auto-recomputes after a rule is disabled or re-enabled (AC-23)", async () => {
    const category = await createCategory("自动重算", true, false);
    const rule = await createRule("自动规则", category.id, subjectContains("报告"));
    await drainRecompute();
    expect(tagsOf("e1")).toContain(category.id);

    const disableFinished = nextFinished();
    const disabled = await call(`/api/rules/${rule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(disabled.status).toBe(200);
    await disableFinished;
    expect(tagsOf("e1")).not.toContain(category.id);

    const enableFinished = nextFinished();
    const enabled = await call(`/api/rules/${rule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    await enableFinished;
    expect(tagsOf("e1")).toContain(category.id);

    expect((await call("/api/rules/recompute/nope")).status).toBe(404);
  });

  it("delegates to the injected rules engine port when one is present", async () => {
    const progress: RecomputeProgress = {
      jobId: "engine-job",
      done: 1,
      total: 2,
      finished: false,
    };
    const received: unknown[] = [];
    const engine: RulesEnginePort = {
      async startRecompute(input) {
        received.push(input);
        return { jobId: "engine-job" };
      },
      progress(jobId) {
        return jobId === "engine-job" ? progress : null;
      },
    };
    const engineApp = createApp({
      store,
      services: { ...buildServices(events, fake.port), rules: engine },
      token: TOKEN,
      version: "test",
    });
    const headers = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

    const accepted = await engineApp.request("/api/rules/recompute", {
      method: "POST",
      headers,
      body: JSON.stringify({ accountId: "acct-1" }),
    });
    expect(accepted.status).toBe(202);
    expect(await readJson<RecomputeResponse>(accepted)).toEqual({ jobId: "engine-job" });
    expect(received).toEqual([{ accountId: "acct-1" }]);

    const status = await engineApp.request("/api/rules/recompute/engine-job", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(status.status).toBe(200);
    expect(await readJson<RecomputeProgress>(status)).toEqual(progress);

    const missing = await engineApp.request("/api/rules/recompute/other", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(missing.status).toBe(404);
  });
});
