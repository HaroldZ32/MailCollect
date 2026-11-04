import type { ReactNode } from "react";
import clsx from "clsx";

export interface GlassCardProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly flush?: boolean;
  readonly quiet?: boolean;
  readonly as?: "section" | "article" | "aside" | "div";
}

export function GlassCard({
  children,
  className,
  flush = false,
  quiet = false,
  as: Tag = "section",
}: GlassCardProps) {
  return (
    <Tag
      className={clsx(
        "glass-card",
        flush && "glass-card--flush",
        quiet && "glass-card--quiet",
        className,
      )}
    >
      {children}
    </Tag>
  );
}
