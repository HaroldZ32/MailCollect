import { randomUUID } from "node:crypto";
import type {
  RawEmail,
  Task,
  TaskKind,
  TaskOwner,
  TaskStatus,
  TaskTime,
  UserProfile,
} from "@mailcollect/shared";
import { extractionResultSchema, type ExtractionItem } from "@mailcollect/shared";
import type { LlmUsage } from "../llm/port.js";
import {
  SAME_DAY_BODY_SIGNAL,
  countSameDayDuplicateBodies,
  isSameDayDuplicate,
} from "./postprocess.js";
import { cleanBody } from "./strip.js";
import { resolveTaskTime } from "./time.js";
import type { ClassificationGate, PipelineDeps } from "./types.js";

/** 单个抽取结果 + 流水线附加的确定性字段。 */
export interface ExtractedTask {
  sourceEmailId: string;
  threadId: string | null;
  title: string;
  detail: string | null;
  owner: TaskOwner;
  ownerName: string | null;
  kind: TaskKind;
  evidenceQuote: string;
  confidence: number;
  time: TaskTime | null;
  /** evidenceQuote 是否逐字出现在该邮件正文中。 */
  evidenceVerified: boolean;
}

/** 只进提醒卡片、不送 LLM 抽取的邮件（broadcast 分类或确定性同日同文后处理）。 */
export interface BroadcastReminder {
  emailId: string;
  /** 命中的分类 id（仅确定性后处理命中时可能为空）。 */
  categoryIds: readonly string[];
  /** 审计信号：`rule:<规则 id>` 与 `deterministic:same-day-body-hash`。 */
  signals: readonly string[];
}

/** 未进入 LLM 抽取的原因（C7 的三种准入去向 + 空邮件）。 */
export type SkipReason = "broadcast" | "not_enter_todo" | "uncategorized" | "empty_message";

export interface ExtractOptions {
  /** 每个线程每次送进模型的最大正文字符数，默认 12000。 */
  maxCharsPerChunk?: number;
  maxRepairs?: number;
  signal?: AbortSignal;
}

export interface ExtractOutcome {
  tasks: ExtractedTask[];
  /** 群发分类（含确定性后处理）的邮件，只用于提醒卡片。 */
  reminders: BroadcastReminder[];
  /** 未进入 LLM 的邮件与原因，调用方据此给抽取队列打标记。 */
  skipped: Array<{ emailId: string; reason: SkipReason }>;
  /** LLM 调用次数（每个线程分块一次）。 */
  calls: number;
  usage: LlmUsage | null;
  repaired: boolean;
  latencyMs: number;
}

/** 服务端入口的返回形状（已附加 Task 的确定性字段）。 */
export interface ProcessOutcome {
  tasks: Task[];
  reminders: BroadcastReminder[];
  skipped: ExtractOutcome["skipped"];
}

const DEFAULT_MAX_CHARS = 12_000;

type GateOutcome = "extract" | "broadcast" | "not_enter_todo" | "uncategorized";

interface GateDecision {
  outcome: GateOutcome;
  /** 判为群发时的审计信号。 */
  signals: string[];
}

/**
 * 邮件级准入（C7）——R3/R4 删除后唯一的闸门：
 * - 命中 `enterTodo=true` 且非 broadcast 的分类 → 进入 LLM 抽取；
 * - 命中 broadcast 分类，或分类后被确定性后处理判为「同日同文」→ 只进提醒卡片；
 * - 其它命中（分类未开 enterTodo）→ 不抽取；
 * - 无命中（「未分类」）→ 不抽取、不标群发。
 */
function decideGate(
  classification: ClassificationGate,
  sameDayDuplicate: boolean,
): GateDecision {
  const ruleSignals = (classification.matches ?? []).map((match) => `rule:${match.ruleId}`);
  if (classification.broadcast || sameDayDuplicate) {
    return {
      outcome: "broadcast",
      signals: [...ruleSignals, ...(sameDayDuplicate ? [SAME_DAY_BODY_SIGNAL] : [])],
    };
  }
  if (classification.enterTodo) return { outcome: "extract", signals: ruleSignals };
  if (classification.uncategorized) return { outcome: "uncategorized", signals: [] };
  return { outcome: "not_enter_todo", signals: ruleSignals };
}

/**
 * 批量抽取：先按分类闸门筛邮件，再按线程分组、线程内按字符预算切块。
 *
 * 「同日同文」是整批视野的确定性后处理（C6：不作为单封条件），因此
 * 只有批量入口能看到它；只持有单封邮件的调用方走 {@link processEmail} 时
 * 永远没有这个信号（v1 以来的已知边界）。
 */
export async function extractTasks(
  emails: readonly RawEmail[],
  deps: PipelineDeps,
  options: ExtractOptions = {},
): Promise<ExtractOutcome> {
  const startedAt = Date.now();
  const maxChars = options.maxCharsPerChunk ?? DEFAULT_MAX_CHARS;
  const skipped: Array<{ emailId: string; reason: SkipReason }> = [];
  const reminders: BroadcastReminder[] = [];
  const admitted: RawEmail[] = [];
  const duplicateBodies = countSameDayDuplicateBodies(emails, deps.profile.timezone);

  // 1) 分类闸门：每封邮件一次（语义叶子由调用方的分类端口内部求值）。
  for (const email of emails) {
    const classification = await deps.classify(email);
    const decision = decideGate(
      classification,
      isSameDayDuplicate(duplicateBodies.get(email.id)),
    );
    if (decision.outcome === "extract") {
      admitted.push(email);
      continue;
    }
    if (decision.outcome === "broadcast") {
      reminders.push({
        emailId: email.id,
        categoryIds: classification.categoryIds,
        signals: decision.signals,
      });
    }
    skipped.push({ emailId: email.id, reason: decision.outcome });
  }

  // 2) 只渲染准入邮件；空邮件在闸门之后单独记 empty_message。
  const threads: RenderedEmail[][] = [];
  for (const thread of groupByThread(admitted)) {
    const rendered: RenderedEmail[] = [];
    for (const email of thread) {
      const body = cleanBody(email.bodyText ?? "");
      if (body.trim() === "" && email.subject.trim() === "") {
        skipped.push({ emailId: email.id, reason: "empty_message" });
        continue;
      }
      rendered.push(renderEmail(email, body, maxChars));
    }
    if (rendered.length > 0) threads.push(rendered);
  }

  // 3) LLM 抽取（每个线程分块一次，绝不跨线程混请求）。
  const tasks: ExtractedTask[] = [];
  const seen = new Set<string>();
  let calls = 0;
  let usage: LlmUsage | null = null;
  let repaired = false;

  for (const thread of threads) {
    for (const chunk of chunkThread(thread, maxChars)) {
      const result = await deps.llm.structured(extractionResultSchema, {
        system: SYSTEM_PROMPT,
        user: buildUserPrompt(chunk, deps.profile),
        ...(options.maxRepairs === undefined ? {} : { maxRepairs: options.maxRepairs }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      calls += 1;
      if (result.usage) {
        usage = usage
          ? {
              promptTokens: usage.promptTokens + result.usage.promptTokens,
              completionTokens: usage.completionTokens + result.usage.completionTokens,
            }
          : result.usage;
      }
      repaired = repaired || result.repaired;

      for (const item of result.value.items) {
        const extracted = toExtractedTask(item, chunk, deps);
        if (!extracted) continue;
        const dedupeKey = `${extracted.sourceEmailId}|${extracted.title}|${extracted.evidenceQuote}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        tasks.push(extracted);
      }
    }
  }

  return {
    tasks,
    reminders,
    skipped,
    calls,
    usage,
    repaired,
    latencyMs: Date.now() - startedAt,
  };
}

/**
 * 服务端单封入口（集成契约）。闸门语义与批量入口一致，但看不见「同日同文」的
 * 同伴邮件；持有抽取队列的调用方应使用 {@link processEmails}。
 */
export async function processEmail(
  deps: PipelineDeps,
  email: RawEmail,
): Promise<ProcessOutcome> {
  return toProcessOutcome(await extractTasks([email], deps), deps.profile);
}

/**
 * Batch entry point — same per-email semantics as {@link processEmail}, but the
 * whole set reaches `extractTasks` at once, which is the ONLY way the
 * deterministic "same body, same day" post-processing can see its siblings.
 */
export async function processEmails(
  deps: PipelineDeps,
  emails: readonly RawEmail[],
): Promise<ProcessOutcome> {
  return toProcessOutcome(await extractTasks(emails, deps), deps.profile);
}

function toProcessOutcome(outcome: ExtractOutcome, profile: UserProfile): ProcessOutcome {
  const now = new Date().toISOString();
  return {
    tasks: outcome.tasks.map((task) => toTask(task, profile, now)),
    reminders: outcome.reminders,
    skipped: outcome.skipped,
  };
}

export function groupByThread(emails: readonly RawEmail[]): RawEmail[][] {
  const groups = new Map<string, RawEmail[]>();
  for (const email of emails) {
    const key = email.threadId?.trim() || email.messageId?.trim() || email.id;
    const bucket = groups.get(key);
    if (bucket) bucket.push(email);
    else groups.set(key, [email]);
  }
  // 线程内按邮件 Date 头排序：时间短语的锚点是「发出这句话的那一封」。
  for (const bucket of groups.values()) {
    bucket.sort((left, right) => compareSentAt(left, right));
  }
  return [...groups.values()];
}

function compareSentAt(left: RawEmail, right: RawEmail): number {
  const leftAt = Date.parse(left.sentAt);
  const rightAt = Date.parse(right.sentAt);
  const safeLeft = Number.isNaN(leftAt) ? 0 : leftAt;
  const safeRight = Number.isNaN(rightAt) ? 0 : rightAt;
  return safeLeft - safeRight || left.id.localeCompare(right.id);
}

interface RenderedEmail {
  email: RawEmail;
  body: string;
  text: string;
}

function renderEmail(email: RawEmail, body: string, maxChars: number): RenderedEmail {
  const clipped = body.length > maxChars ? `${body.slice(0, maxChars)}\n…(正文已截断)` : body;
  const sender = email.fromName?.trim()
    ? `${email.fromName.trim()} <${email.fromEmail}>`
    : email.fromEmail;
  const text = [
    `## 邮件 ${email.id}`,
    `线程: ${email.threadId ?? email.id}`,
    `发件人: ${sender}`,
    `收件人: ${email.to.join(", ") || "(无)"}`,
    `抄送: ${email.cc.join(", ") || "(无)"}`,
    `日期: ${email.sentAt}`,
    `主题: ${email.subject || "(无主题)"}`,
    "正文:",
    clipped || "(正文为空)",
  ].join("\n");
  return { email, body: clipped, text };
}

function chunkThread(rendered: readonly RenderedEmail[], maxChars: number): RenderedEmail[][] {
  const chunks: RenderedEmail[][] = [];
  let current: RenderedEmail[] = [];
  let size = 0;
  for (const item of rendered) {
    const cost = item.text.length + 2;
    if (current.length > 0 && size + cost > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

const SYSTEM_PROMPT = `你是「MailCollect」的邮件待办抽取引擎。唯一输出是一个 JSON 对象，不要 markdown 代码块，不要解释。

输出 schema：
{"items":[{"title":"一句话祈使句，2-160 字","detail":"补充说明或 null","owner":"me|other|unassigned|everyone","ownerName":"owner=other 时的责任人，否则 null","kind":"action|deadline|window","timePhrase":"原文时间短语，逐字摘抄；没有就 null","evidenceQuote":"原文中连续出现的一句话，逐字摘抄","confidence":0到1}],"noTasks":false}

判定规则：
1. owner：
   - me：明确点名用户本人（姓名/别名/邮箱），或直接要求用户本人去做。
   - other：明确要求别人做，ownerName 必须填。
   - unassigned：没有指定责任人。
   - everyone：面向所有收件人的通用通知/要求，没有点名个人。
2. 时间：只把原文里的时间短语抄进 timePhrase，绝对不要换算日期、不要补全、不要猜。
   - kind=deadline：有硬截止（如「周五前提交」）。
   - kind=window：有起止时段（如「下周一至周三」）。
   - 没有时间信息：kind=action，timePhrase=null。
3. evidenceQuote 必须是正文里逐字出现的一句话，不能改写、不能拼接，用于审计。
4. 没有可执行事项时返回 {"items":[],"noTasks":true}。
5. 寒暄、签名、引用历史都不算待办。`;

function buildUserPrompt(chunk: readonly RenderedEmail[], profile: UserProfile): string {
  const header = [
    "# 用户档案",
    `姓名: ${profile.displayName}`,
    `姓名变体: ${profile.aliases.join("、") || "(无)"}`,
    `邮箱: ${profile.emails.join("、") || "(无)"}`,
    `时区: ${profile.timezone}`,
    "",
    `# 本批邮件（同一线程，按时间顺序，共 ${chunk.length} 封）`,
  ];
  return [...header, ...chunk.map((item) => `\n${item.text}`)].join("\n");
}

function toExtractedTask(
  item: ExtractionItem,
  chunk: readonly RenderedEmail[],
  deps: PipelineDeps,
): ExtractedTask | null {
  const located = locateEvidence(item.evidenceQuote, chunk);
  if (!located) return null;
  const time = resolveTaskTime({
    phrase: item.timePhrase ?? null,
    kind: item.kind,
    referenceDate: located.email.sentAt,
    timezone: deps.profile.timezone,
  });
  return {
    sourceEmailId: located.email.id,
    threadId: located.email.threadId,
    title: item.title.trim(),
    detail: item.detail?.trim() ? item.detail.trim() : null,
    owner: item.owner,
    ownerName: item.ownerName?.trim() ? item.ownerName.trim() : null,
    kind: deriveKind(time),
    evidenceQuote: item.evidenceQuote.trim(),
    confidence: item.confidence,
    time,
    evidenceVerified: located.verified,
  };
}

/**
 * kind 由解析结果决定，而不是模型自称：
 * 有区间 → window；有截止 → deadline；两者都没有 → action。
 */
function deriveKind(time: TaskTime | null): TaskKind {
  if (time?.windowStart && time?.windowEnd) return "window";
  if (time?.dueAt) return "deadline";
  return "action";
}

interface LocatedEvidence {
  email: RawEmail;
  body: string;
  verified: boolean;
}

function locateEvidence(
  quote: string,
  chunk: readonly RenderedEmail[],
): LocatedEvidence | null {
  const fallback = chunk[chunk.length - 1];
  if (!fallback) return null;
  const needle = normalizeForMatch(quote);
  if (needle !== "") {
    for (const candidate of chunk) {
      if (normalizeForMatch(candidate.body).includes(needle)) {
        return { ...toLocated(candidate), verified: true };
      }
    }
    // 宽松匹配：忽略引号与省略号，容忍模型轻微改写。
    const looseNeedle = stripPunctuation(needle);
    if (looseNeedle.length >= 4) {
      for (const candidate of chunk) {
        if (stripPunctuation(normalizeForMatch(candidate.body)).includes(looseNeedle)) {
          return { ...toLocated(candidate), verified: true };
        }
      }
    }
  }
  // 证据找不到时仍保留条目（不丢信息），标记未验证，挂在线程最后一封上。
  return { ...toLocated(fallback), verified: false };
}

function toLocated(candidate: RenderedEmail): LocatedEvidence {
  return { email: candidate.email, body: candidate.body, verified: false };
}

function normalizeForMatch(text: string): string {
  return text.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function stripPunctuation(text: string): string {
  return text.replace(/[「」『』“”"'‘’…、，。！？：；,.!?:;\s]/g, "");
}

function toTask(extracted: ExtractedTask, profile: UserProfile, now: string): Task {
  return {
    id: randomUUID(),
    userId: profile.id,
    title: extracted.title,
    detail: extracted.detail,
    owner: extracted.owner,
    ownerName: extracted.ownerName,
    kind: extracted.kind,
    status: deriveStatus(extracted.owner),
    // 只有非群发邮件能通过分类闸门进入抽取，任务来源因此恒为 personal。
    origin: "personal",
    confidence: extracted.confidence,
    evidenceQuote: extracted.evidenceQuote,
    sourceEmailId: extracted.sourceEmailId,
    threadId: extracted.threadId,
    time: extracted.time,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 任务级语义（C7）：owner 只用于展示/过滤与状态映射，不再参与邮件级准入。
 * 闸门已保证进入抽取的邮件非群发，因此 owner=me → confirmed，其余 → candidate，
 * 与 v1 的可观察行为一致。
 */
function deriveStatus(owner: TaskOwner): TaskStatus {
  return owner === "me" ? "confirmed" : "candidate";
}
