import { useState } from "react";
import { Icon } from "./Icon";

export interface BroadcastPromptProps {
  readonly subject: string;
  readonly from: string;
  readonly listId: string | null;
  readonly taskCount: number;
  readonly evidence: string;
  readonly busy: boolean;
  readonly onDecision: (decision: "confirm" | "dismiss", rememberList: boolean) => void;
}

export function BroadcastPrompt({
  subject,
  from,
  listId,
  taskCount,
  evidence,
  busy,
  onDecision,
}: BroadcastPromptProps) {
  const [remember, setRemember] = useState(true);
  const applyToList = remember && listId !== null;

  return (
    <article className="broadcast-card">
      <div className="broadcast-top">
        <div className="broadcast-icon">
          <Icon name="megaphone" size={17} />
        </div>
        <div className="broadcast-titles">
          <div className="broadcast-kicker">群发邮件 · 可能与你有关</div>
          <h3 className="broadcast-subject">{subject}</h3>
          <div className="broadcast-from">
            {from}
            {listId === null ? "" : ` · ${listId}`}
          </div>
        </div>
        <span className="chip chip--iris">{taskCount} 条候选</span>
      </div>

      <blockquote className="task-quote">{evidence}</blockquote>

      <div className="broadcast-actions">
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={busy}
          onClick={() => onDecision("confirm", applyToList)}
        >
          <Icon name="check" size={13} />
          加入待办
        </button>
        <button
          type="button"
          className="btn btn--quiet btn--sm"
          disabled={busy}
          onClick={() => onDecision("dismiss", applyToList)}
        >
          <Icon name="close" size={13} />
          忽略
        </button>
        <label className="check">
          <input
            type="checkbox"
            checked={remember}
            disabled={listId === null}
            onChange={(event) => setRemember(event.target.checked)}
          />
          记住该列表
        </label>
        <span className="broadcast-note">
          {listId === null ? "未检测到 List-Id" : applyToList ? `批量套用到 ${listId}` : "仅处理本次"}
        </span>
      </div>
    </article>
  );
}
