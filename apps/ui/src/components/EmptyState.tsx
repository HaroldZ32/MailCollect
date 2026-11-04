import type { ReactNode } from "react";
import clsx from "clsx";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";

export interface EmptyStateProps {
  readonly icon: IconName;
  readonly title: string;
  readonly text: string;
  readonly tone?: "accent" | "iris";
  readonly action?: ReactNode;
}

export function EmptyState({ icon, title, text, tone = "accent", action }: EmptyStateProps) {
  return (
    <div className="empty-state">
      <div className={clsx("empty-orb", tone === "iris" && "is-iris")}>
        <Icon name={icon} size={26} />
      </div>
      <p className="empty-title">{title}</p>
      <p className="empty-text">{text}</p>
      {action === undefined ? null : <div className="empty-action">{action}</div>}
    </div>
  );
}
