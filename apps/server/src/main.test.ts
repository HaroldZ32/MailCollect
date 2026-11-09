import { rmSync } from "node:fs";
import type { Category, Rule, RawEmail, ServerEvent, UserProfile } from "@mailcollect/shared";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerServices } from "./services.js";

/**
 * `apps/server/src/main.ts` 的抽取接线回归（T59）。
 *
 * 背景：T18 评审发现 `ProcessOutcome.reminders` 没有消费方——同日同文哈希这条
 * 确定性后处理分支（无规则命中、categoryIds 为空）既不打标签、不发 SSE，端到端
 * 看起来就是「未分类」，v1 的群发提醒卡片消失。
 *
 * 测试策略：mock 掉与本次接线无关的外设（store/邮件/LLM/serve/app 构造），
 * 但保留**真实**的 `processEmails`（含分类后的确定性后处理）与真实 `classifyEmail`，
 * 从 main.ts 的 `services.extract` 入口驱动，断言 store 写入与 SSE 事件。
 */

const mocks = vi.hoisted(() => {
  const dataDir = `${process.cwd()}/.tmp-main-extract-test-${process.pid}`;
  process.env["MAILCOLLECT_DATA_DIR"] = dataDir;

  const llmConfig = {
    id: "mock-llm",
    label: "mock",
    protocol: "openai-compatible" as const,
    baseUrl: "http://127.0.0.1:9/v1",
    model: "mock-model",
    apiKeyRef: null,
    temperature: 0,
    maxTokens: 16,
    timeoutMs: 1_000,
    isDefault: true,
  };
  const llmPort = {
    config: llmConfig,
    structured: vi.fn(async () => {
      throw new Error("群发批次不应进入 LLM 抽取");
    }),
    ping: vi.fn(async () => ({ ok: true, latencyMs: 1, detail: "mock" })),
  };

  const store = {
    driver: "node:sqlite",
    getProfile: vi.fn(),
    getLlmWithKey: vi.fn(),
    listRules: vi.fn<() => Rule[]>(() => []),
    listCategories: vi.fn<() => Category[]>(() => []),
    replaceTagsForEmail: vi.fn(),
    listTagsForEmail: vi.fn(() => []),
    getEmailState: vi.fn(() => null),
    emailsPendingExtraction: vi.fn<() => RawEmail[]>(() => []),
    insertTasks: vi.fn(() => []),
    markExtracted: vi.fn(),
    close: vi.fn(),
  };

  return {
    dataDir,
    llmConfig,
    llmPort,
    store,
    outbox: { kick: vi.fn(), stop: vi.fn(async () => {}), drain: vi.fn(async () => ({ sent: 0, failed: 0 })) },
    createApp: vi.fn((_options?: unknown) => ({ fetch: vi.fn() })),
    serve: vi.fn(),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
  };
});

vi.mock("@mailcollect/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@mailcollect/core")>();
  return { ...actual, openStore: vi.fn(async () => mocks.store) };
});
vi.mock("@mailcollect/core/mail", () => ({ createMailSource: vi.fn(), mailSourceFactory: vi.fn() }));
vi.mock("@mailcollect/core/llm", () => ({
  createLlmPort: vi.fn(() => mocks.llmPort),
}));
vi.mock("@hono/node-server", () => ({ serve: mocks.serve }));
vi.mock("./app.js", () => ({ createApp: mocks.createApp }));
vi.mock("./routes/send.js", () => ({ createOutboxWorker: vi.fn(() => mocks.outbox) }));

// 导入即执行 main.ts 的启动逻辑（openStore/serve/app 均已 mock，不会真起服务）。
import "./main.js";

const createAppOptions = mocks.createApp.mock.calls[0]?.[0] as
  | { services: ServerServices }
  | undefined;

if (createAppOptions === undefined) {
  throw new Error("main.ts 没有调用 createApp：模块级 mock 未生效");
}

const services = createAppOptions.services;

const PROFILE: UserProfile = {
  id: "user-main-test",
  displayName: "张三",
  aliases: ["San Zhang"],
  emails: ["me@corp.example.com"],
  timezone: "Asia/Shanghai",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const BROADCAST_CATEGORY: Category = {
  id: "seed-category-broadcast",
  name: "群发/通知",
  enterTodo: false,
  broadcast: true,
};

const SAME_BODY = "系统通知：本周六 22:00 起停机维护两小时。";

const BROADCAST_RULE: Rule = {
  id: "seed-rule-broadcast",
  name: "群发/通知",
  categoryId: BROADCAST_CATEGORY.id,
  tree: { kind: "field", field: "listId", op: "exists" },
  enabled: true,
  order: 1,
};

function rawEmail(id: string, body: string, sentAt: string): RawEmail {
  return {
    id,
    accountId: "account-1",
    uid: `uid-${id}`,
    messageId: `<${id}@example.com>`,
    threadId: `thread-${id}`,
    fromName: "通知",
    fromEmail: "notice@corp.example.com",
    to: ["me@corp.example.com"],
    cc: [],
    subject: "系统维护通知",
    sentAt,
    bodyText: body,
    hasAttachments: false,
    headers: {},
    createdAt: sentAt,
  };
}

function prepare(categories: Category[], emails: RawEmail[]): void {
  mocks.store.getProfile.mockReturnValue(PROFILE);
  mocks.store.getLlmWithKey.mockReturnValue({ config: mocks.llmConfig, apiKey: "sk-test" });
  mocks.store.listRules.mockReturnValue([]);
  mocks.store.listCategories.mockReturnValue(categories);
  mocks.store.emailsPendingExtraction.mockReturnValue(emails);
  mocks.store.insertTasks.mockReturnValue([]);
  mocks.store.getEmailState.mockReturnValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  mocks.warn.mockRestore();
  rmSync(mocks.dataDir, { recursive: true, force: true });
});

describe("services.extract — 群发提醒标签（T59）", () => {
  it("同日同文且无规则命中 → 第一/第二封都被补打群发分类标签，并发 classification SSE", async () => {
    const emails = [
      rawEmail("dup-a", SAME_BODY, "2026-11-04T09:00:00+08:00"),
      rawEmail("dup-b", SAME_BODY, "2026-11-04T15:00:00+08:00"),
    ];
    prepare([BROADCAST_CATEGORY], emails);

    const events: ServerEvent[] = [];
    const result = await services.extract((event) => events.push(event));

    expect(result).toEqual({ done: 2, total: 2 });
    for (const id of ["dup-a", "dup-b"]) {
      expect(mocks.store.replaceTagsForEmail).toHaveBeenCalledWith(id, [
        { categoryId: BROADCAST_CATEGORY.id, ruleId: null },
      ]);
    }

    const broadcastEvents = events.filter(
      (event): event is Extract<ServerEvent, { type: "classification" }> =>
        event.type === "classification" &&
        event.data.categoryIds.includes(BROADCAST_CATEGORY.id),
    );
    expect(broadcastEvents.map((event) => event.data.emailId).sort()).toEqual([
      "dup-a",
      "dup-b",
    ]);
    // 群发邮件不产生任务。
    expect(mocks.store.insertTasks).toHaveBeenCalledWith([]);
  });

  it("规则命中的群发邮件路径不变：只保留分类阶段的 ruleId 标签，不重复补标", async () => {
    const email: RawEmail = {
      ...rawEmail("list-1", "本周产品更新：新增规则分类。", "2026-11-04T09:00:00+08:00"),
      headers: { "List-Id": "<news.vendor.example.com>" },
    };
    prepare([BROADCAST_CATEGORY], [email]);
    mocks.store.listRules.mockReturnValue([BROADCAST_RULE]);

    const events: ServerEvent[] = [];
    await services.extract((event) => events.push(event));

    // 分类阶段写入真实规则标签（带 ruleId）。
    expect(mocks.store.replaceTagsForEmail).toHaveBeenCalledWith("list-1", [
      { categoryId: BROADCAST_CATEGORY.id, ruleId: BROADCAST_RULE.id },
    ]);
    // 没有 ruleId=null 的兜底补标：规则命中的群发路径不被改写。
    const fallbackWrites = mocks.store.replaceTagsForEmail.mock.calls.filter(
      (call) =>
        call[0] === "list-1" &&
        Array.isArray(call[1]) &&
        call[1].some((hit: { ruleId?: string | null }) => hit?.ruleId === null),
    );
    expect(fallbackWrites).toEqual([]);
    // 该邮件只有分类阶段那一条 classification 事件。
    expect(
      events.filter(
        (event) => event.type === "classification" && event.data.emailId === "list-1",
      ),
    ).toHaveLength(1);
  });

  it("群发分类被删除/改写 → 不抛错、不补标签、无带分类的 SSE，只 log 一条", async () => {
    const emails = [
      rawEmail("dup-c", SAME_BODY, "2026-11-04T09:00:00+08:00"),
      rawEmail("dup-d", SAME_BODY, "2026-11-04T15:00:00+08:00"),
    ];
    prepare([{ id: "cat-regular", name: "普通分类", enterTodo: false, broadcast: false }], emails);

    const events: ServerEvent[] = [];
    const result = await services.extract((event) => events.push(event));

    expect(result).toEqual({ done: 2, total: 2 });
    // 分类阶段写入的只有「未分类」的空标签；没有任何 broadcast 补标。
    for (const id of ["dup-c", "dup-d"]) {
      const callsForEmail = mocks.store.replaceTagsForEmail.mock.calls.filter(
        (call) => call[0] === id,
      );
      expect(callsForEmail.length).toBeGreaterThan(0);
      for (const call of callsForEmail) expect(call[1]).toEqual([]);
    }
    expect(
      events.filter(
        (event) => event.type === "classification" && event.data.categoryIds.length > 0,
      ),
    ).toEqual([]);
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });
});
