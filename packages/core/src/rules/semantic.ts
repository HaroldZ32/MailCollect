import { z } from "zod";
import type { SemanticLeaf } from "@mailcollect/shared";
import { LlmError, type LlmPort } from "../llm/port.js";
import { normalizeSemanticExpression } from "./ast.js";
import type { RuleEmail } from "./evaluate.js";

/**
 * 语义叶子求值（C6 / AC-20）。
 *
 * 设计约束：
 * - 一次模型调用只判一个叶子；结构化输出 `{ match: boolean }`，由 Zod 校验。
 * - 缓存键 = 邮件 id + 叶子表达式 + 提示词版本 + provider/model；四项任一变化即失效。
 * - 同一轮里跨规则共享：调用方（classify）先把所有启用法则的语义叶子去重，
 *   再调用 {@link SemanticEvaluator.evaluateAll}，因此调用数 ≤ 去重后的叶子数。
 * - 模型失败 → 叶子 false + 一条可读错误；**不缓存失败**，下一轮重试；
 *   永不向调用方抛错，同步管线不中断。
 */

/** 提示词版本；修改 system/user 模板时必须同步 +1（缓存随之失效）。 */
export const SEMANTIC_PROMPT_VERSION = "2026-11-09.1";

/** 默认塞进提示词的正文上限（字符），避免把超长邮件整封送进模型。 */
export const SEMANTIC_MAX_BODY_CHARS = 4000;

export const semanticAnswerSchema = z.object({
  match: z.boolean(),
});

export type SemanticAnswer = z.infer<typeof semanticAnswerSchema>;

export interface SemanticCacheEntry {
  readonly value: boolean;
  readonly promptVersion: string;
  readonly provider: string;
  readonly model: string;
  readonly updatedAt: string;
}

/** 可替换的叶子缓存（v1 默认进程内；持久化实现由 store 适配）。 */
export interface SemanticCache {
  get(key: string): SemanticCacheEntry | undefined | Promise<SemanticCacheEntry | undefined>;
  set(key: string, entry: SemanticCacheEntry): void | Promise<void>;
}

/** 进程内缓存：跨轮次、跨规则共享，进程重启后自然失效。 */
export class InMemorySemanticCache implements SemanticCache {
  readonly #entries = new Map<string, SemanticCacheEntry>();

  get(key: string): SemanticCacheEntry | undefined {
    return this.#entries.get(key);
  }

  set(key: string, entry: SemanticCacheEntry): void {
    this.#entries.set(key, entry);
  }

  clear(): void {
    this.#entries.clear();
  }

  get size(): number {
    return this.#entries.size;
  }
}

export interface SemanticFailure {
  readonly emailId: string;
  /** 归一化后的表达式（不含邮件正文）。 */
  readonly expr: string;
  /** LlmError.code；非 LlmError 时为 `unknown`。 */
  readonly code: string;
  /** 截断后的可读错误；不包含邮件正文或凭据。 */
  readonly message: string;
}

export interface SemanticRoundResult {
  /** 去重后的表达式 → 布尔结果；失败也为 false。 */
  readonly values: ReadonlyMap<string, boolean>;
  /** 本轮请求的唯一表达式数。 */
  readonly requested: number;
  /** 真正发起的模型调用数（缓存命中不计）。 */
  readonly calls: number;
  readonly cacheHits: number;
  readonly failures: readonly SemanticFailure[];
}

export interface SemanticEvaluatorOptions {
  readonly llm: LlmPort;
  readonly cache?: SemanticCache;
  readonly promptVersion?: string;
  readonly maxBodyChars?: number;
  readonly now?: () => Date;
  /**
   * 缓存键里的 provider 身份。`LlmConfig` 没有 provider 字段，缺省用
   * `protocol@baseUrl` 作为稳定身份；同一端点的 label/id 变化不会误失效。
   */
  readonly provider?: string;
}

function clampMessage(message: string, limit = 300): string {
  const compact = message.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}…`;
}

/** 缓存键；四段用 NUL 分隔，避免拼接歧义。 */
export function semanticCacheKey(input: {
  emailId: string;
  expr: string;
  promptVersion: string;
  provider: string;
  model: string;
}): string {
  return [
    input.emailId,
    normalizeSemanticExpression(input.expr),
    input.promptVersion,
    input.provider,
    input.model,
  ].join("\u0000");
}

const SYSTEM_PROMPT = [
  "你是邮件分类判定器。",
  "给你一封邮件的元数据与正文摘录，以及一条自然语言条件；判断这封邮件是否满足该条件。",
  "只依据给出的内容判断，不要脑补；无法判断时按不满足处理。",
  '只输出 JSON：{"match": true} 或 {"match": false}。',
].join("\n");

function buildUserPrompt(email: RuleEmail, expr: string, maxBodyChars: number): string {
  const body = email.bodyText.replace(/\s+/g, " ").trim();
  const excerpt = body.length <= maxBodyChars ? body : `${body.slice(0, maxBodyChars)}…`;
  const lines = [
    `发件人：${email.fromName ?? ""} <${email.fromEmail}>`,
    `收件人：${email.to.join("; ")}`,
  ];
  if (email.cc.length > 0) lines.push(`抄送：${email.cc.join("; ")}`);
  lines.push(`主题：${email.subject}`, `时间：${email.sentAt}`, "", "正文：", excerpt, "", `条件：${expr}`);
  return lines.join("\n");
}

function toFailure(emailId: string, expr: string, error: unknown): SemanticFailure {
  if (error instanceof LlmError) {
    return { emailId, expr, code: error.code, message: clampMessage(error.message) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { emailId, expr, code: "unknown", message: clampMessage(message) };
}

/**
 * 语义叶子求值器。一个实例持有一份缓存（默认进程内），
 * 同轮去重由 {@link evaluateAll} 保证，跨轮命中由缓存保证。
 */
export class SemanticEvaluator {
  readonly #llm: LlmPort;
  readonly #cache: SemanticCache;
  readonly #promptVersion: string;
  readonly #maxBodyChars: number;
  readonly #now: () => Date;
  readonly #provider: string;

  constructor(options: SemanticEvaluatorOptions) {
    this.#llm = options.llm;
    this.#cache = options.cache ?? new InMemorySemanticCache();
    this.#promptVersion = options.promptVersion ?? SEMANTIC_PROMPT_VERSION;
    this.#maxBodyChars = options.maxBodyChars ?? SEMANTIC_MAX_BODY_CHARS;
    this.#now = options.now ?? (() => new Date());
    this.#provider = options.provider ?? `${options.llm.config.protocol}@${options.llm.config.baseUrl}`;
  }

  get promptVersion(): string {
    return this.#promptVersion;
  }

  get provider(): string {
    return this.#provider;
  }

  get model(): string {
    return this.#llm.config.model;
  }

  /** 缓存键（导出便于存储层实现持久化缓存时复用同一约定）。 */
  cacheKey(emailId: string, expr: string): string {
    return semanticCacheKey({
      emailId,
      expr,
      promptVersion: this.#promptVersion,
      provider: this.#provider,
      model: this.model,
    });
  }

  /** 单个表达式求值；绝不在模型失败时抛错。 */
  async evaluate(email: RuleEmail, expr: string): Promise<boolean> {
    const round = await this.evaluateAll(email, [expr]);
    return round.values.get(normalizeSemanticExpression(expr)) ?? false;
  }

  /**
   * 批量求值一轮：先去重，再逐条查缓存；缓存未命中才调用模型。
   * 失败的表达式不进缓存，下一轮自动重试。
   */
  async evaluateAll(email: RuleEmail, expressions: readonly string[]): Promise<SemanticRoundResult> {
    const unique: string[] = [];
    const seen = new Set<string>();
    for (const raw of expressions) {
      const expr = normalizeSemanticExpression(raw);
      if (expr === "" || seen.has(expr)) continue;
      seen.add(expr);
      unique.push(expr);
    }

    const values = new Map<string, boolean>();
    const failures: SemanticFailure[] = [];
    const misses: string[] = [];
    let cacheHits = 0;

    for (const expr of unique) {
      const entry = await this.#cache.get(this.cacheKey(email.id, expr));
      if (entry !== undefined) {
        values.set(expr, entry.value);
        cacheHits += 1;
      } else {
        misses.push(expr);
      }
    }

    let calls = 0;
    for (const expr of misses) {
      calls += 1;
      try {
        const result = await this.#llm.structured(semanticAnswerSchema, {
          system: SYSTEM_PROMPT,
          user: buildUserPrompt(email, expr, this.#maxBodyChars),
        });
        values.set(expr, result.value.match);
        await this.#cache.set(this.cacheKey(email.id, expr), {
          value: result.value.match,
          promptVersion: this.#promptVersion,
          provider: this.#provider,
          model: this.model,
          updatedAt: this.#now().toISOString(),
        });
      } catch (error) {
        // 失败叶子判 false，且不写缓存 —— 下一轮重试。
        values.set(expr, false);
        failures.push(toFailure(email.id, expr, error));
      }
    }

    return {
      values,
      requested: unique.length,
      calls,
      cacheHits,
      failures,
    };
  }
}

/** 便捷构造。 */
export function createSemanticEvaluator(options: SemanticEvaluatorOptions): SemanticEvaluator {
  return new SemanticEvaluator(options);
}

/** 便于测试/适配器把 `SemanticLeaf` 转成表达式。 */
export function expressionOf(leaf: SemanticLeaf): string {
  return normalizeSemanticExpression(leaf.expr);
}
