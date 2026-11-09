import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { GlassCard } from "./GlassCard";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";

/**
 * 渲染兜底（C8）：根级与面板级各一处。
 * - `scope="root"`：全屏错误卡，挂在 #root 之下，`App` 的根节点不会被卸载；
 * - `scope="panel"`：只替换出错面板的内容，其余面板继续可用。
 * 错误卡固定提供「重试」与「回首页」；回首页在面板级调用 `onHome`（切换页面），
 * 根级没有可用的导航 state，回退到重新加载根路径。
 */
export type ErrorBoundaryScope = "root" | "panel";

/** 测试专用强制抛错目标（AC-31）。 */
export type ForcedErrorTarget = "root" | "timeline";

const FORCE_THROW_PARAM = "forceThrow";

/**
 * 仅测试/开发构建可达的强制抛错开关（AC-31）。
 *
 * 触发方式：`/?forceThrow=root|timeline`。
 * - 生产构建里 `import.meta.env.MODE === "production"` 且 `import.meta.env.DEV === false`，
 *   函数在第一行直接返回，抛错分支不可达（panel-stress 会断言 dist 里没有该路径）。
 * - 抛错前消费掉查询参数，避免用户点「重试」后立刻再次抛错、永远恢复不了。
 */
export function maybeForceThrow(target: ForcedErrorTarget): void {
  if (!(import.meta.env.MODE === "test" || import.meta.env.DEV)) return;

  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return;
  }
  if (url.searchParams.get(FORCE_THROW_PARAM) !== target) return;
  throw new Error(`[test-only] forced render error: ${target}`);
}

/**
 * 仅测试/开发构建可达：清掉强制抛错参数。
 * 「重试」「回首页」先清参数再重渲染，否则会立刻再次抛错、永远恢复不了（AC-31）。
 */
export function clearForcedError(): void {
  if (!(import.meta.env.MODE === "test" || import.meta.env.DEV)) return;

  let url: URL;
  try {
    url = new URL(window.location.href);
  } catch {
    return;
  }
  if (!url.searchParams.has(FORCE_THROW_PARAM)) return;
  url.searchParams.delete(FORCE_THROW_PARAM);
  window.history.replaceState(null, "", url.toString());
}

export interface ErrorBoundaryProps {
  readonly children: ReactNode;
  readonly scope?: ErrorBoundaryScope;
  /** 面板级标题，用于告诉用户哪块内容失败。 */
  readonly title?: string;
  /** 重试前调用（例如清理外部状态）；组件自身会清空错误状态后重渲染。 */
  readonly onReset?: () => void;
  /** 「回首页」回调；缺省时根级重新加载 `/`。 */
  readonly onHome?: () => void;
}

interface ErrorBoundaryState {
  readonly error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // 只记录渲染栈，不输出邮件内容或凭据。
    console.error("[MailCollect] 渲染失败", error, info.componentStack);
  }

  private readonly retry = (): void => {
    clearForcedError();
    this.setState({ error: null });
    this.props.onReset?.();
  };

  private readonly goHome = (): void => {
    clearForcedError();
    this.setState({ error: null });
    if (this.props.onHome !== undefined) {
      this.props.onHome();
      return;
    }
    window.location.assign("/");
  };

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    const panel = this.props.scope === "panel";
    const title = this.props.title ?? (panel ? "该面板渲染失败" : "界面渲染失败");
    const text = panel
      ? `其余面板仍可正常使用。可以点「重试」重新渲染${this.props.title === undefined ? "该面板" : `「${this.props.title}」`}，或回到收件箱。`
      : "应用根节点仍在，不会白屏。可以点「重试」重新渲染，或重新加载回到首页。";
    const card = (
      <GlassCard className={panel ? undefined : "boot-card"}>
        <EmptyState
          icon="alert"
          tone="iris"
          title={title}
          text={text}
          action={
            <div className="form-actions" style={{ justifyContent: "center" }}>
              <button type="button" className="btn" onClick={this.retry}>
                <Icon name="refresh" size={14} />
                重试
              </button>
              <button type="button" className="btn btn--primary" onClick={this.goHome}>
                <Icon name="chevron-left" size={14} />
                回首页
              </button>
            </div>
          }
        />
      </GlassCard>
    );

    if (panel) {
      return (
        <div role="alert" data-error-scope="panel">
          {card}
        </div>
      );
    }
    return (
      <div className="boot" role="alert" data-error-scope="root">
        {card}
      </div>
    );
  }
}
