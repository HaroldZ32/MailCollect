import { Suspense, lazy } from "react";
import type { Task, UpdateTaskInput } from "@mailcollect/shared";

const GanttChart = lazy(async () => {
  const module = await import("../components/GanttChart");
  return { default: module.GanttChart };
});

export interface TimelinePageProps {
  readonly tasks: readonly Task[];
  readonly onTaskTimeChange: (taskId: string, patch: UpdateTaskInput) => Promise<boolean>;
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

export function TimelinePage({ tasks, onTaskTimeChange }: TimelinePageProps) {
  return (
    <div className="timeline">
      <Suspense fallback={<GanttFallback />}>
        <GanttChart tasks={tasks} onTaskTimeChange={onTaskTimeChange} />
      </Suspense>
    </div>
  );
}
