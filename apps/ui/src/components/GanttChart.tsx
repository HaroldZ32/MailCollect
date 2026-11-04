import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gantt } from "dhtmlx-gantt";
import type { SerializedLink, Task as GanttTask, ZoomLevel } from "dhtmlx-gantt";
import type { Task, UpdateTaskInput } from "@mailcollect/shared";
import { EmptyState } from "./EmptyState";
import { Icon } from "./Icon";
import { formatGanttDate } from "../lib/format";

const DUE_LEAD_MS = 90 * 60 * 1000;
const FALLBACK_WINDOW_MS = 2 * 60 * 60 * 1000;
const INITIAL_LEVEL = 1;

const ZOOM_BUTTONS: readonly { readonly level: number; readonly label: string }[] = [
  { level: 0, label: "日" },
  { level: 1, label: "周" },
  { level: 2, label: "月" },
];

interface TimedTask {
  readonly task: Task;
  readonly start: Date;
  readonly end: Date;
  readonly dueOnly: boolean;
}

interface BarPosition {
  readonly left: number;
  readonly top: number;
  readonly height: number;
}

const timedIndex = new Map<string, TimedTask>();

function toTimedTask(task: Task): TimedTask | null {
  if (task.status !== "confirmed") return null;
  const time = task.time;
  if (time === null) return null;

  if (time.windowStart !== null && time.windowEnd !== null) {
    const start = new Date(time.windowStart);
    const end = new Date(time.windowEnd);
    if (end.getTime() > start.getTime()) return { task, start, end, dueOnly: false };
  }

  if (time.windowStart !== null) {
    const start = new Date(time.windowStart);
    return { task, start, end: new Date(start.getTime() + FALLBACK_WINDOW_MS), dueOnly: false };
  }

  if (time.dueAt !== null) {
    const due = new Date(time.dueAt);
    return { task, start: new Date(due.getTime() - DUE_LEAD_MS), end: due, dueOnly: true };
  }

  return null;
}

function buildZoomLevels(): ZoomLevel[] {
  return [
    {
      name: "日",
      label: "日",
      scale_height: 52,
      min_column_width: 42,
      scales: [
        { unit: "month", step: 1, format: "%Y-%m" },
        { unit: "day", step: 1, format: "%d" },
      ],
    },
    {
      name: "周",
      label: "周",
      scale_height: 52,
      min_column_width: 92,
      scales: [
        { unit: "month", step: 1, format: "%Y-%m" },
        { unit: "week", step: 1, format: "%m-%d" },
      ],
    },
    {
      name: "月",
      label: "月",
      scale_height: 52,
      min_column_width: 96,
      scales: [
        { unit: "year", step: 1, format: "%Y" },
        { unit: "month", step: 1, format: "%m月" },
      ],
    },
  ];
}

function buildLinks(entries: readonly TimedTask[]): SerializedLink[] {
  const byThread = new Map<string, TimedTask[]>();
  for (const entry of entries) {
    const threadId = entry.task.threadId;
    if (threadId === null) continue;
    const group = byThread.get(threadId);
    if (group === undefined) {
      byThread.set(threadId, [entry]);
    } else {
      group.push(entry);
    }
  }

  const links: SerializedLink[] = [];
  for (const group of byThread.values()) {
    if (group.length < 2) continue;
    const ordered = [...group].sort((left, right) => left.start.getTime() - right.start.getTime());
    for (let index = 1; index < ordered.length; index += 1) {
      const previous = ordered[index - 1];
      const next = ordered[index];
      if (previous === undefined || next === undefined) continue;
      if (next.start.getTime() < previous.end.getTime()) continue;
      links.push({
        id: `link-${previous.task.id}-${next.task.id}`,
        source: previous.task.id,
        target: next.task.id,
        type: "0",
      });
    }
  }
  return links;
}

function configureGantt(): void {
  gantt.config.date_format = "%Y-%m-%d %H:%i";
  gantt.config.readonly = false;
  gantt.config.row_height = 46;
  gantt.config.bar_height = 24;
  gantt.config.grid_width = 318;
  gantt.config.min_column_width = 56;
  gantt.config.scale_height = 52;
  gantt.config.duration_unit = "hour";
  gantt.config.round_dnd_dates = true;
  gantt.config.drag_move = true;
  gantt.config.drag_resize = true;
  gantt.config.drag_progress = false;
  gantt.config.drag_links = false;
  gantt.config.show_links = true;
  gantt.config.link_arrow_size = 8;
  gantt.config.open_tree_initially = true;
  gantt.config.auto_types = false;
  gantt.config.columns = [
    { name: "text", label: "待办", width: 210, resize: true },
    { name: "start_date", label: "开始", align: "center", width: 104 },
    { name: "end_date", label: "截止", align: "center", width: 104 },
  ];
  gantt.plugins({ marker: true });
  gantt.templates.date_grid = (date) => formatGanttDate(date);
  gantt.templates.task_class = (start, end, task) => {
    const entry = timedIndex.get(String(task.id));
    if (entry === undefined) return "";
    return entry.dueOnly ? "mc-bar mc-bar--due" : "mc-bar mc-bar--window";
  };
  gantt.templates.task_text = (start, end, task) => {
    const entry = timedIndex.get(String(task.id));
    if (entry === undefined || entry.dueOnly) return "";
    return task.text ?? "";
  };
}

function renderDueLayer(task: GanttTask): HTMLElement | boolean {
  const entry = timedIndex.get(String(task.id));
  const dueAt = entry?.task.time?.dueAt ?? null;
  if (entry === undefined || dueAt === null) return false;

  const due = new Date(dueAt);
  const position: BarPosition = gantt.getTaskPosition(task, due);
  const wrapper = document.createElement("div");
  wrapper.className = "mc-due";
  wrapper.style.left = `${position.left}px`;
  wrapper.style.top = `${position.top}px`;
  wrapper.style.height = `${position.height}px`;

  const line = document.createElement("span");
  line.className = "mc-due-line";
  const dot = document.createElement("span");
  dot.className = "mc-due-dot";
  wrapper.append(line, dot);
  return wrapper;
}

export interface GanttChartProps {
  readonly tasks: readonly Task[];
  readonly onTaskTimeChange: (taskId: string, patch: UpdateTaskInput) => Promise<boolean>;
}

export function GanttChart({ tasks, onTaskTimeChange }: GanttChartProps) {
  const [hostElement, setHostElement] = useState<HTMLDivElement | null>(null);
  const [level, setLevel] = useState(INITIAL_LEVEL);
  const initializedRef = useRef(false);
  const levelRef = useRef(INITIAL_LEVEL);
  const onTimeChangeRef = useRef(onTaskTimeChange);

  const timed = useMemo(() => {
    const entries: TimedTask[] = [];
    for (const task of tasks) {
      const entry = toTimedTask(task);
      if (entry !== null) entries.push(entry);
    }
    return entries.sort((left, right) => left.start.getTime() - right.start.getTime());
  }, [tasks]);

  const timedRef = useRef<readonly TimedTask[]>(timed);

  useEffect(() => {
    onTimeChangeRef.current = onTaskTimeChange;
  }, [onTaskTimeChange]);

  useEffect(() => {
    timedRef.current = timed;
  }, [timed]);

  const syncData = useCallback(() => {
    const entries = timedRef.current;
    timedIndex.clear();
    for (const entry of entries) timedIndex.set(entry.task.id, entry);

    const rows: GanttTask[] = entries.map((entry) => ({
      id: entry.task.id,
      text: entry.task.title,
      start_date: entry.start,
      end_date: entry.end,
      progress: 0,
      parent: 0,
    }));

    const scroll = gantt.getScrollState();
    gantt.clearAll();
    gantt.parse({ data: rows, links: buildLinks(entries) });
    gantt.setSizes();
    gantt.scrollTo(scroll.x, scroll.y);
  }, []);

  useEffect(() => {
    if (hostElement === null) return;

    configureGantt();
    gantt.init(hostElement);
    gantt.ext.zoom.init({ levels: buildZoomLevels(), activeLevelIndex: levelRef.current });
    gantt.ext.zoom.setLevel(levelRef.current);
    gantt.addMarker({ id: "today-marker", start_date: new Date(), css: "mc-today-marker", text: "今天" });
    gantt.addTaskLayer(renderDueLayer);
    gantt.attachEvent("onTaskDblClick", () => false);

    const dragHandler = gantt.attachEvent("onAfterTaskDrag", (id) => {
      const entry = timedIndex.get(String(id));
      if (entry === undefined) return;
      const moved = gantt.getTask(id);
      const start = moved.start_date;
      const end = moved.end_date;
      if (start === undefined || end === undefined) return;

      const patch: UpdateTaskInput = entry.dueOnly
        ? { dueAt: end.toISOString(), windowStart: null, windowEnd: null }
        : { windowStart: start.toISOString(), windowEnd: end.toISOString(), dueAt: null };

      void Promise.resolve(onTimeChangeRef.current(entry.task.id, patch)).then(
        (ok) => {
          if (!ok) syncData();
        },
        () => syncData(),
      );
    });

    initializedRef.current = true;
    syncData();
    gantt.showDate(new Date());

    const resizeObserver = new ResizeObserver(() => {
      gantt.setSizes();
    });
    resizeObserver.observe(hostElement);

    return () => {
      initializedRef.current = false;
      resizeObserver.disconnect();
      gantt.detachEvent(dragHandler);
      gantt.destructor();
    };
  }, [hostElement, syncData]);

  useEffect(() => {
    if (!initializedRef.current) return;
    syncData();
  }, [timed, syncData]);

  const applyLevel = (next: number): void => {
    levelRef.current = next;
    setLevel(next);
    if (initializedRef.current) gantt.ext.zoom.setLevel(next);
  };

  const jumpToToday = (): void => {
    if (initializedRef.current) gantt.showDate(new Date());
  };

  return (
    <div className="timeline-card glass-card glass-card--flush">
      <div className="gantt-toolbar">
        <div className="segmented" role="group" aria-label="时间刻度">
          {ZOOM_BUTTONS.map((button) => (
            <button
              key={button.level}
              type="button"
              className={button.level === level ? "is-active" : undefined}
              aria-pressed={button.level === level}
              onClick={() => applyLevel(button.level)}
            >
              {button.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--sm" onClick={jumpToToday}>
          <Icon name="calendar" size={13} />
          回到今天
        </button>
        <div className="legend">
          <span className="legend-item">
            <span className="legend-swatch is-window" />
            时段
          </span>
          <span className="legend-item">
            <span className="legend-swatch is-due" />
            到期点
          </span>
          <span className="legend-item">
            <span className="legend-swatch is-today" />
            今日线
          </span>
          <span className="legend-item">
            <span className="legend-swatch is-link" />
            同线程依赖
          </span>
        </div>
      </div>

      {timed.length === 0 ? (
        <EmptyState
          icon="timeline"
          title="时间线上还没有可排的待办"
          text="待办里的「时段」或「到期」任务会出现在这里：拖拽改期、拖动右侧手柄改时长，到期任务显示为一个可拖动的到期点。"
        />
      ) : (
        <div className="gantt-host">
          <div className="gantt-canvas" ref={setHostElement} />
        </div>
      )}

      <div className="timeline-hint">
        <span>拖拽条改期 · 拖右侧手柄改时长 · 上下滚轮看更多行</span>
        <span>共 {timed.length} 项（仅显示已确认待办）</span>
        <span>依赖箭头由同一邮件线程推导，只做展示</span>
      </div>
    </div>
  );
}
