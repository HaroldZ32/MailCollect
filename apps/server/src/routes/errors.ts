import type { ApiErrorBody } from "@mailcollect/shared";

/**
 * 一个已经映射好的 API 错误。
 *
 * 路由层只负责构造 `body + status`，真正的响应写出与兜底 404 留在 app.ts，
 * 这样错误码表只在这里维护一份，子路由不会各自发明形状。
 */
export interface ApiFailure {
  readonly body: ApiErrorBody;
  readonly status: number;
}

export const fail = (
  code: ApiErrorBody["error"]["code"],
  message: string,
  status: number,
): ApiFailure => ({ body: { error: { code, message } }, status });
