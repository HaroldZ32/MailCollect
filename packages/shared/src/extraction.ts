import { z } from "zod";

/**
 * The ONLY shape an LLM is allowed to return. FROZEN CONTRACT.
 *
 * Design notes (do not "simplify" these away):
 * - `owner` is required: separating "assigned to me" from "assigned to someone
 *   else" and from "everyone" is the core product distinction.
 * - `timePhrase` is the literal phrase; the model must NOT do date arithmetic.
 *   Resolution happens deterministically in pipeline/time.ts.
 * - `evidenceQuote` must be verbatim so every TODO is auditable.
 */
export const extractionItemSchema = z.object({
  title: z.string().min(2).max(160).describe("一句话描述要做的事，祈使句"),
  detail: z.string().max(1200).nullish().describe("补充说明，没有就省略"),
  owner: z
    .enum(["me", "other", "unassigned", "everyone"])
    .describe("me=明确要求我本人做；other=要求别人；unassigned=没指定人；everyone=面向所有人"),
  ownerName: z.string().max(80).nullish().describe("owner=other 时的责任人姓名"),
  kind: z.enum(["action", "deadline", "window"]).describe("deadline=有硬截止；window=有起止时段"),
  timePhrase: z
    .string()
    .max(120)
    .nullish()
    .describe("原文里的时间短语，逐字摘抄，例如「周五下班前」。不要换算成日期"),
  evidenceQuote: z.string().min(2).max(400).describe("原文证据，逐字摘抄"),
  confidence: z.number().min(0).max(1),
});

export const extractionResultSchema = z.object({
  items: z.array(extractionItemSchema).max(12),
  /** Set when the model saw nothing actionable — distinct from a parse failure. */
  noTasks: z.boolean().default(false),
});

export type ExtractionItem = z.infer<typeof extractionItemSchema>;
export type ExtractionResult = z.infer<typeof extractionResultSchema>;

/** Repair prompt sent back when the first response fails validation. */
export const REPAIR_INSTRUCTION =
  "上一次输出未通过 JSON Schema 校验。只返回符合 schema 的 JSON 对象，不要 markdown 代码块，不要解释。";
