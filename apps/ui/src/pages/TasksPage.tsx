import { useEffect, useMemo, useState } from "react";
import type { BulkDecisionInput, Task, TaskCounts } from "@mailcollect/shared";
import { api, isApiError } from "../lib/api";
import type { EmailDetail } from "../lib/api";
import { createMockEmails, createMockVerdicts } from "../lib/mock";
import { listIdOf, senderLabel } from "../lib/format";
import { GlassCard } from "../components/GlassCard";
import { BroadcastPrompt } from "../components/BroadcastPrompt";
import { TaskCard } from "../components/TaskCard";
import { EmptyState } from "../components/EmptyState";
import type { ConnectionMode } from "../lib/useMailData";

interface BroadcastGroup {
  readonly emailId: string;
  readonly tasks: readonly Task[];
  readonly listId: string | null;
  readonly subject: string;
  readonly from: string;
  readonly evidence: string;
}

export interface TasksPageProps {
  readonly mode: ConnectionMode;
  readonly tasks: readonly Task[];
  readonly counts: TaskCounts;
  readonly onBulkDecision: (input: BulkDecisionInput) => Promise<boolean>;
  readonly onComplete: (taskId: string) => void;
  readonly onOpenTimeline: (taskId: string) => void;
}

const STATS: readonly { readonly key: keyof TaskCounts; readonly label: string; readonly tone: string }[] = [
  { key: "candidate", label: "待确认", tone: "is-warning" },
  { key: "confirmed", label: "已确认", tone: "is-accent" },
  { key: "done", label: "已完成", tone: "is-success" },
  { key: "dismissed", label: "已忽略", tone: "" },
];

export function TasksPage({ mode, tasks, counts, onBulkDecision, onComplete, onOpenTimeline }: TasksPageProps) {
  const [emailDetails, setEmailDetails] = useState<Readonly<Record<string, EmailDetail>>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const broadcastIdsKey = useMemo(() => {
    const ids = new Set<string>();
    for (const task of tasks) {
      if (task.status === "candidate" && task.origin === "broadcast" && task.owner !== "other") {
        ids.add(task.sourceEmailId);
      }
    }
    return [...ids].sort().join(",");
  }, [tasks]);

  useEffect(() => {
    const ids = broadcastIdsKey === "" ? [] : broadcastIdsKey.split(",");
    if (ids.length === 0) {
      setEmailDetails({});
      return;
    }

    if (mode === "demo") {
      const emails = createMockEmails();
      const verdicts = createMockVerdicts();
      const next: Record<string, EmailDetail> = {};
      for (const id of ids) {
        const email = emails.find((item) => item.id === id);
        if (email !== undefined) {
          next[id] = { email, verdict: verdicts[id] ?? null, listId: listIdOf(email) };
        }
      }
      setEmailDetails(next);
      return;
    }

    if (mode !== "live") return;
    let cancelled = false;
    void Promise.all(ids.map(async (id) => [id, await api.emails.get(id)] as const))
      .then((pairs) => {
        if (cancelled) return;
        const next: Record<string, EmailDetail> = {};
        for (const [id, detail] of pairs) next[id] = detail;
        setEmailDetails(next);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (isApiError(error)) return;
        throw error;
      });
    return () => {
      cancelled = true;
    };
  }, [mode, broadcastIdsKey]);

  const groups = useMemo(() => {
    const byEmail = new Map<string, Task[]>();
    for (const task of tasks) {
      if (task.status !== "candidate" || task.origin !== "broadcast" || task.owner === "other") continue;
      const bucket = byEmail.get(task.sourceEmailId);
      if (bucket === undefined) {
        byEmail.set(task.sourceEmailId, [task]);
      } else {
        bucket.push(task);
      }
    }

    const result: BroadcastGroup[] = [];
    for (const [emailId, items] of byEmail) {
      const detail = emailDetails[emailId];
      const email = detail?.email;
      const first = items[0];
      if (first === undefined) continue;
      result.push({
        emailId,
        tasks: items,
        listId: detail?.listId ?? null,
        subject: email?.subject ?? "群发邮件（邮件元信息未加载）",
        from: email === undefined ? emailId : senderLabel(email.fromName, email.fromEmail),
        evidence: first.evidenceQuote,
      });
    }
    return result.sort((left, right) => left.subject.localeCompare(right.subject));
  }, [tasks, emailDetails]);

  const candidates = useMemo(
    () =>
      tasks.filter(
        (task) =>
          task.status === "candidate" &&
          task.origin !== "broadcast" &&
          (task.owner === "me" || task.owner === "unassigned"),
      ),
    [tasks],
  );
  const confirmed = useMemo(
    () => tasks.filter((task) => task.status === "confirmed" && task.owner !== "other"),
    [tasks],
  );
  const done = useMemo(
    () => tasks.filter((task) => task.status === "done" && task.owner !== "other"),
    [tasks],
  );

  const decideGroup = async (
    group: BroadcastGroup,
    decision: "confirm" | "dismiss",
    rememberList: boolean,
  ): Promise<void> => {
    setBusyKey(group.emailId);
    await onBulkDecision({
      ids: group.tasks.map((task) => task.id),
      decision,
      listId: rememberList ? group.listId : null,
    });
    setBusyKey(null);
  };

  const decideCandidate = (taskId: string, decision: "confirm" | "dismiss"): void => {
    setBusyKey(taskId);
    void onBulkDecision({ ids: [taskId], decision, listId: null }).then(() => setBusyKey(null));
  };

  return (
    <div className="tasks">
      <div className="task-stats stagger">
        {STATS.map((stat, index) => (
          <div className={`stat ${stat.tone}`.trim()} key={stat.key} style={{ animationDelay: `${index * 40}ms` }}>
            <span className="stat-num">{counts[stat.key]}</span>
            <span className="stat-label">{stat.label}</span>
          </div>
        ))}
      </div>

      {groups.length === 0 ? null : (
        <section>
          <div className="section-head">
            <h2 className="section-title">群发提醒</h2>
            <span className="chip chip--iris">{groups.length} 封</span>
            <span className="section-note">确认或忽略后，可以记住同一个 List-Id 的决定</span>
          </div>
          <div className="broadcast-grid stagger">
            {groups.map((group, index) => (
              <div key={group.emailId} style={{ animationDelay: `${index * 40}ms` }}>
                <BroadcastPrompt
                  subject={group.subject}
                  from={group.from}
                  listId={group.listId}
                  taskCount={group.tasks.length}
                  evidence={group.evidence}
                  busy={busyKey === group.emailId}
                  onDecision={(decision, remember) => {
                    void decideGroup(group, decision, remember);
                  }}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      {candidates.length === 0 ? null : (
        <section>
          <div className="section-head">
            <h2 className="section-title">待确认</h2>
            <span className="chip chip--warning">{candidates.length} 条</span>
            <span className="section-note">抽取置信度不足或责任人未判定，先不打扰</span>
          </div>
          <div className="task-grid stagger">
            {candidates.map((task, index) => (
              <div key={task.id} style={{ animationDelay: `${index * 40}ms` }}>
                <TaskCard
                  task={task}
                  onConfirm={(taskId) => decideCandidate(taskId, "confirm")}
                  onDismiss={(taskId) => decideCandidate(taskId, "dismiss")}
                />
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="section-head">
          <h2 className="section-title">已确认待办</h2>
          <span className="chip chip--accent">{confirmed.length} 条</span>
          <span className="section-spacer" />
          <span className="section-note">在时间线上可以拖拽改期</span>
        </div>
        {confirmed.length === 0 ? (
          <GlassCard quiet>
            <EmptyState
              icon="tasks"
              title="还没有确认的待办"
              text="待确认区里的候选条目通过后会出现在这里；群发邮件需要你点「加入待办」才会进入列表。"
            />
          </GlassCard>
        ) : (
          <div className="task-grid stagger">
            {confirmed.map((task, index) => (
              <div key={task.id} style={{ animationDelay: `${index * 40}ms` }}>
                <TaskCard
                  task={task}
                  onComplete={onComplete}
                  onOpenTimeline={onOpenTimeline}
                />
              </div>
            ))}
          </div>
        )}
      </section>

      {done.length === 0 ? null : (
        <section>
          <div className="section-head">
            <h2 className="section-title">最近完成</h2>
            <span className="chip chip--success">{done.length} 条</span>
          </div>
          <div className="task-grid">
            {done.map((task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
