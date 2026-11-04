import type { Task, UpdateTaskInput } from "@mailcollect/shared";
import { GanttChart } from "../components/GanttChart";

export interface TimelinePageProps {
  readonly tasks: readonly Task[];
  readonly onTaskTimeChange: (taskId: string, patch: UpdateTaskInput) => Promise<boolean>;
}

export function TimelinePage({ tasks, onTaskTimeChange }: TimelinePageProps) {
  return (
    <div className="timeline">
      <GanttChart tasks={tasks} onTaskTimeChange={onTaskTimeChange} />
    </div>
  );
}
