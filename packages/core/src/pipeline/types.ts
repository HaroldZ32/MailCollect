import type { UserProfile } from "@mailcollect/shared";
import type { LlmPort } from "../llm/port.js";

/**
 * 流水线的全部外部依赖。
 *
 * 存储层刻意不在这里：调用方（server）负责落库，本包只做纯计算，
 * 因此 `pipeline/**` 不允许 import `../store/**`。
 */
export interface PipelineDeps {
  llm: LlmPort;
  profile: UserProfile;
}
