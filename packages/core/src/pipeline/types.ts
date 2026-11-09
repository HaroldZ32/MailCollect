import type { RawEmail, UserProfile } from "@mailcollect/shared";
import type { LlmPort } from "../llm/port.js";

/**
 * 分类闸门的结构投影（C6 / C7）。
 *
 * 规则引擎（`../rules` 的 `ClassificationResult`）在结构上满足本接口，
 * 但 pipeline 刻意不 import 规则实现：邮件级准入只认下面几个字段，
 * 类别元数据（enterTodo/broadcast）由调用方在分类时已经求值完成。
 */
export interface ClassificationMatch {
  readonly ruleId: string;
  readonly ruleName: string;
  readonly categoryId: string;
}

export interface ClassificationGate {
  readonly emailId: string;
  readonly enterTodo: boolean;
  readonly broadcast: boolean;
  readonly uncategorized: boolean;
  readonly categoryIds: readonly string[];
  /** 命中的规则（按求值顺序）；用于群发提醒的来源展示与审计。 */
  readonly matches?: readonly ClassificationMatch[];
}

/**
 * 分类端口：调用方（server）负责接规则引擎 `classifyEmail`，
 * 并自己持有完整分类结果（落标签 / SSE）；pipeline 只消费闸门字段。
 */
export type ClassifyPort = (email: RawEmail) => ClassificationGate | Promise<ClassificationGate>;

/**
 * 流水线的全部外部依赖。
 *
 * 存储层刻意不在这里：调用方（server）负责落库，本包只做纯计算，
 * 因此 `pipeline/**` 不允许 import `../store/**`。
 *
 * v1.1（C7）：R3 姓名匹配与 R4 确定性群发判定已删除；邮件级准入的唯一来源是
 * {@link PipelineDeps.classify} 返回的分类闸门。
 */
export interface PipelineDeps {
  llm: LlmPort;
  profile: UserProfile;
  classify: ClassifyPort;
}
