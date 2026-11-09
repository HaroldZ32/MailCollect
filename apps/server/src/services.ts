import type { Store } from "@mailcollect/core";
import type { MailSourceFactory } from "@mailcollect/core/mail";
import type { LlmPortFactory } from "@mailcollect/core/llm";
import type { RecomputeProgress, RecomputeRequest, ServerEvent } from "@mailcollect/shared";

/**
 * 进程内事件总线（SSE 的唯一来源）。
 *
 * 路由模块只 publish；app.ts 的 `/api/events` 是唯一的订阅者。
 * 一个坏掉的 SSE 消费者不能让同步/抽取失败，所以分发是逐监听器隔离的。
 */
export interface EventBus {
  emit(event: ServerEvent): void;
  subscribe(listener: (event: ServerEvent) => void): () => void;
}

export function createEventBus(): EventBus {
  const listeners = new Set<(event: ServerEvent) => void>();
  return {
    emit(event) {
      for (const listener of listeners) {
        try {
          listener(event);
        } catch {
          // 一个坏掉的 SSE 消费者不能让同步运行失败。
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * 规则引擎端口：实现在 `packages/core/src/rules`，由 rules-engine 任务提供。
 *
 * 作业状态归引擎所有（先建 job 再逐封处理），路由只负责把 jobId 返回给 UI、
 * 在 `GET /api/rules/recompute/:jobId` 时读进度。
 */
export interface RulesEnginePort {
  /** 启动后台重算并立即返回 jobId；`emit` 用于推 classification / recompute 事件。 */
  startRecompute(
    input: RecomputeRequest,
    emit: (event: ServerEvent) => void,
  ): Promise<{ jobId: string }>;
  /** 已知作业的当前进度；未知作业返回 null。 */
  progress(jobId: string): RecomputeProgress | null;
}

/**
 * 离线发件队列的后台循环端口：实现在发送任务一侧。
 * `kick` 必须是同步唤醒（立即返回），请求线程不等待实际投递。
 */
export interface OutboxWorkerPort {
  kick(): void;
  stop(): Promise<void>;
}

/**
 * The capabilities the HTTP layer needs but does not implement itself.
 * main.ts wires the real mail / LLM / pipeline implementations in, which keeps
 * this file free of provider-specific imports and makes it unit-testable.
 *
 * v1.1 起同时声明可选的依赖槽位：路由模块只认这些端口，不直接 import
 * 适配器/引擎/后台 worker。全部可选，因此既有调用方（只给方法表）不需要改动。
 */
export interface ServerServices {
  verifyAccount(accountId: string): Promise<{ ok: boolean; detail: string }>;
  /**
   * Interactive login (Microsoft Graph device code). Returns immediately; the
   * device code and the outcome arrive as SSE events.
   */
  loginAccount(accountId: string, emit: (event: ServerEvent) => void): Promise<void>;
  syncAccount(
    accountId: string,
    options: { full: boolean },
    emit: (event: ServerEvent) => void,
  ): Promise<void>;
  extract(emit: (event: ServerEvent) => void): Promise<{ done: number; total: number }>;
  testLlm(input: {
    protocol: "openai-compatible" | "anthropic-messages";
    baseUrl: string;
    model: string;
    apiKey?: string;
  }): Promise<{ ok: boolean; latencyMs: number; detail: string }>;
  /** Called once at boot; implementations may start polling or IDLE watchers. */
  startBackground(): void;
  stopBackground(): Promise<void>;

  /* ------------------------------ v1.1 DI slots ----------------------------- */

  /**
   * 持久化存储。app.ts 优先使用它，未注入时回退到 `AppOptions.store`
   * （既有调用方与测试只传 AppOptions，不需要改签名）。
   */
  readonly store?: Store;
  /** 显式注入时 app.ts 用它做 SSE，而不是自建总线。 */
  readonly events?: EventBus;
  /** 账号 → 适配器的工厂（IMAP/POP3/Graph/EWS 统一形状）。 */
  readonly mailSource?: MailSourceFactory;
  /** LLM 端口工厂（`createLlmPort` 的形状）。 */
  readonly llm?: LlmPortFactory;
  /** 规则引擎（分类/重算）。 */
  readonly rules?: RulesEnginePort;
  /** 离线发件队列的后台循环。 */
  readonly outbox?: OutboxWorkerPort;
}
