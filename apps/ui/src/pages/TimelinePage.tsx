import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import type { Task, UpdateTaskInput } from "@mailcollect/shared";
import { maybeForceThrow } from "../components/ErrorBoundary";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";

/** 动态导入的甘特图组件类型（与 GanttChart 的 props 保持一致）。 */
type GanttComponent = ComponentType<{
  readonly tasks: readonly Task[];
  readonly onTaskTimeChange: (taskId: string, patch: UpdateTaskInput) => Promise<boolean>;
}>;

let ganttChunk: Promise<GanttComponent> | null = null;

/** 连续加载失败次数（成功后归零）；用于决定是否给出「刷新页面」兜底。 */
const RELOAD_AFTER_FAILURES = 2;
const AUTO_RELOAD_FLAG = "mailcollect.gantt-chunk-auto-reloaded";
let consecutiveChunkFailures = 0;

function readSessionFlag(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === "1";
  } catch {
    // 隐私模式下 sessionStorage 不可写：当作「已经自动重载过」，绝不冒无限刷新的险。
    return true;
  }
}

function writeSessionFlag(key: string): void {
  try {
    window.sessionStorage.setItem(key, "1");
  } catch {
    // 写不进去就只保留手动「刷新页面」按钮，不自动重载。
  }
}

/**
 * 加载甘特图 chunk（仍然是动态 import，保留代码分割）。
 *
 * 失败的 `React.lazy` 会把「被拒绝的 Promise」缓存在 lazy 组件实例上：之后无论是
 * 错误卡上的「重试」还是重新进入面板，都会复用同一个拒绝结果，面板永久报错/空白，
 * 只有整页刷新才能恢复。这里改为手写加载——失败即清空模块级缓存，下一次挂载会
 * 真正重新请求 chunk（T37 的 known-repro 机制）。
 *
 * 注意：重新 import 的仍是**同一个带哈希的 URL**。如果 index.html 是旧的、chunk
 * 已经不存在（过期 dist / 旧打包产物），重试永远不会成功；连续失败到阈值时必须
 * 给出「刷新页面」的逃生口（T58）。
 */
function loadGantt(): Promise<GanttComponent> {
  if (ganttChunk === null) {
    const pending = import("../components/GanttChart").then((module) => module.GanttChart);
    ganttChunk = pending;
    pending.catch(() => {
      if (ganttChunk === pending) ganttChunk = null;
    });
  }
  return ganttChunk;
}

function GanttFallback() {
  return (
    <div className="timeline-card glass-card glass-card--flush">
      <div className="empty-state">
        <div className="skeleton" style={{ width: 62, height: 62, borderRadius: 21 }} />
        <div className="skeleton skeleton-line" style={{ width: 200, height: 11 }} />
        <div className="skeleton skeleton-line" style={{ width: 280, height: 9 }} />
      </div>
    </div>
  );
}

interface GanttLoadErrorProps {
  readonly failures: number;
  readonly onRetry: () => void;
  readonly onRefresh: () => void;
  readonly onHome: () => void;
}

function GanttLoadError({ failures, onRetry, onRefresh, onHome }: GanttLoadErrorProps) {
  return (
    <div
      className="timeline-card glass-card glass-card--flush"
      role="alert"
      data-timeline-error="chunk"
      data-chunk-failures={failures}
    >
      <EmptyState
        icon="alert"
        tone="iris"
        title="时间线组件加载失败"
        text="无法加载甘特图代码（网络中断，或部署产物已更新）。重试只会重新请求同一份文件；若它已不存在，请刷新页面获取新的入口文件。"
        action={
          <div className="form-actions" style={{ justifyContent: "center" }}>
            <button type="button" className="btn" onClick={onRetry}>
              <Icon name="refresh" size={14} />
              重试加载
            </button>
            {failures >= RELOAD_AFTER_FAILURES ? (
              <button type="button" className="btn btn--primary" onClick={onRefresh}>
                <Icon name="refresh" size={14} />
                刷新页面
              </button>
            ) : null}
            <button type="button" className="btn" onClick={onHome}>
              <Icon name="chevron-left" size={14} />
              回首页
            </button>
          </div>
        }
      />
    </div>
  );
}

export interface TimelinePageProps {
  readonly tasks: readonly Task[];
  readonly onTaskTimeChange: (taskId: string, patch: UpdateTaskInput) => Promise<boolean>;
}

export function TimelinePage({ tasks, onTaskTimeChange }: TimelinePageProps) {
  // 仅测试/开发构建可达：让面板级 ErrorBoundary 接管渲染错误（AC-31）。
  maybeForceThrow("timeline");
  const [Loaded, setLoaded] = useState<GanttComponent | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [failures, setFailures] = useState(0);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let disposed = false;
    setLoadError(false);
    loadGantt().then(
      (component) => {
        if (disposed) return;
        consecutiveChunkFailures = 0;
        setFailures(0);
        setLoaded(() => component);
      },
      () => {
        if (disposed) return;
        consecutiveChunkFailures += 1;
        setFailures(consecutiveChunkFailures);
        setLoadError(true);
        // 连续失败到阈值：会话内最多自动整页重载一次，给「旧 index.html 指向已删 chunk」
        // 一条出路；同时用 sessionStorage 守卫，避免刷新后依旧 404 时无限循环。
        if (consecutiveChunkFailures >= RELOAD_AFTER_FAILURES && !readSessionFlag(AUTO_RELOAD_FLAG)) {
          writeSessionFlag(AUTO_RELOAD_FLAG);
          window.location.reload();
        }
      },
    );
    return () => {
      disposed = true;
    };
  }, [attempt]);

  if (loadError) {
    return (
      <GanttLoadError
        failures={failures}
        onRetry={() => setAttempt((value) => value + 1)}
        onRefresh={() => window.location.reload()}
        onHome={() => window.location.assign("/")}
      />
    );
  }

  if (Loaded === null) {
    return (
      <div className="timeline">
        <GanttFallback />
      </div>
    );
  }

  return (
    <div className="timeline">
      <Loaded tasks={tasks} onTaskTimeChange={onTaskTimeChange} />
    </div>
  );
}
