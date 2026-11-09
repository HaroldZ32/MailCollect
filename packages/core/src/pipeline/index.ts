/**
 * 抽取流水线对外表面。
 *
 * 依赖方向：本目录只依赖 `@mailcollect/shared` 与 `../llm`，
 * 绝不 import `../store/**`（落库由调用方负责）。
 */
export * from "./types.js";
export * from "./strip.js";
export * from "./postprocess.js";
export * from "./time.js";
export * from "./extract.js";
