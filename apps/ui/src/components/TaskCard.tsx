import clsx from "clsx";
import type { Task } from "@mailcollect/shared";
import { Icon } from "./Icon";
import { formatDateTime, formatDue, formatWindow } from "../lib/format";

const KIND_LABEL: Record<Task["kind"], string> = {
  action: "行动",
  deadline: "到期",
  window: "时段",
};

const OWNER_LABEL: Record<Task["owner"], string> = {
  me: "点名给我",
  other: "他人负责",
  unassigned: "待指派",
  everyone: "所有人",
};

export interface TaskCardProps {
  readonly task: Task;
  readonly onComplete?: (taskId: string) => void;
  readonly onConfirm?: (taskId: string) => void;
  readonly onDismiss?: (taskId: string) => void;
  readonly onOpenTimeline?: (taskId: string) => void;
}

function timeChip(task: Task) {
  const time = task.time;
  if (time === null) {
    return (
      <span className="chip">
        <Icon name="clock" size={12} />
        未定时
      </span>
    );
  }
  if (time.windowStart !== null && time.windowEnd !== null) {
    return (
      <span className="task-time">
        <Icon name="calendar" size={12} />
        {formatWindow(time.windowStart, time.windowEnd)}
      </span>
    );
  }
  if (time.dueAt !== null) {
    return (
      <span className="task-time is-due">
        <Icon name="clock" size={12} />
        {formatDue(time.dueAt)}
      </span>
    );
  }
  return (
    <span className="chip">
      <Icon name="clock" size={12} />
      未定时
    </span>
  );
}

export function TaskCard({ task, onComplete, onConfirm, onDismiss, onOpenTimeline }: TaskCardProps) {
  const isCandidate = task.status === "candidate";
  const isConfirmed = task.status === "confirmed";
  const timed = task.time !== null && (task.time.dueAt !== null || task.time.windowStart !== null);

  return (
    <article className={clsx("task-card", isCandidate && "task-card--candidate")}>
      <div className="task-card-top">
        <h3 className="task-title">{task.title}</h3>
        <span className={clsx("chip", `chip--${task.origin === "broadcast" ? "iris" : "accent"}`)}>
          {KIND_LABEL[task.kind]}
        </span>
      </div>

      {task.detail === null ? null : <p className="task-detail">{task.detail}</p>}

      <blockquote className="task-quote">{task.evidenceQuote}</blockquote>

      <div className="task-meta">
        {timeChip(task)}
        {task.owner === "me" ? null : (
          <span className={clsx("chip", task.owner === "unassigned" ? "chip--warning" : "chip--muted")}>
            {OWNER_LABEL[task.owner]}
          </span>
        )}
        {task.origin === "broadcast" ? <span className="chip chip--iris">群发来源</span> : null}
        <span className="chip">{Math.round(task.confidence * 100)}% 置信</span>
      </div>

      <div className="task-actions">
        {isCandidate ? (
          <>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => onConfirm?.(task.id)}>
              <Icon name="check" size={13} />
              加入待办
            </button>
            <button type="button" className="btn btn--quiet btn--sm" onClick={() => onDismiss?.(task.id)}>
              <Icon name="close" size={13} />
              忽略
            </button>
          </>
        ) : null}

        {isConfirmed ? (
          <>
            <button type="button" className="btn btn--primary btn--sm" onClick={() => onComplete?.(task.id)}>
              <Icon name="check" size={13} />
              标记完成
            </button>
            {timed ? (
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={() => onOpenTimeline?.(task.id)}
              >
                <Icon name="timeline" size={13} />
                在时间线查看
              </button>
            ) : null}
          </>
        ) : null}

        {task.status === "done" ? (
          <span className="chip chip--success">
            <Icon name="check" size={12} />
            已完成 · {formatDateTime(task.updatedAt)}
          </span>
        ) : null}
      </div>
    </article>
  );
}
