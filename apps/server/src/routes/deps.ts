import type { Store } from "@mailcollect/core";
import type { EventBus, ServerServices } from "../services.js";

/**
 * 每个子路由注册函数拿到的依赖集合。
 *
 * 由 app.ts 组装一次并传下去：子路由之间不互相 import，也不自己读环境变量。
 * 需要新能力时先给 {@link ServerServices} 加可选端口，再从这里暴露，依赖方向始终
 * 是 `routes → services`，不出现反向边。
 */
export interface RouteDeps {
  readonly store: Store;
  readonly services: ServerServices;
  /** 进程内事件总线；app.ts 把订阅接到 SSE，路由只管 publish。 */
  readonly events: EventBus;
  /** 构建版本号，`GET /api/health` 原样返回。 */
  readonly version: string;
  /** 服务端自有的数据目录（Graph token cache 等由它派生）。 */
  readonly dataDir?: string | undefined;
}
