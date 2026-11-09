import { useCallback, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import clsx from "clsx";
import type { Category, RecomputeProgress, Rule, RuleNode, RuleTree } from "@mailcollect/shared";
import { api, eventsUrl, isApiError, resolveToken } from "../lib/api";
import { GlassCard } from "../components/GlassCard";
import { EmptyState } from "../components/EmptyState";
import { Icon } from "../components/Icon";
import { CategoryManager, RulesModal, UNCATEGORIZED_NAME } from "../components/CategoryManager";
import type { RulesNotice } from "../components/CategoryManager";
import {
  MAX_DEPTH,
  RuleTreeEditor,
  createDefaultTree,
  issuesFromServerMessage,
  summarizeTree,
  validateTreeLocally,
} from "../components/RuleTreeEditor";
import type { RuleTreeIssue } from "../components/RuleTreeEditor";

/**
 * 规则面板（C6 / C8 / AC-22 / AC-28 的 UI 侧）。
 *
 * 数据面（apps/server/src/routes/rules.ts）：
 * - `GET/POST /api/rules`、`PATCH/DELETE /api/rules/:id`、`POST /api/rules/reorder`；
 * - 任何规则/分类写操作都会在服务端自动排队一轮重算；
 * - `POST /api/rules/recompute` 返回 jobId，进度同时走 SSE（`recompute` / `classification`）。
 *
 * 这里**不**把轮询当唯一刷新机制：SSE 连上时进度全部来自事件；只有 SSE 尚未连上时
 * 才对显式发起的那一轮做 `recomputeStatus` 兜底轮询。
 */

const SEED_RULE_IDS: ReadonlySet<string> = new Set(["seed-rule-personal", "seed-rule-broadcast"]);

interface RuleDraft {
  readonly mode: "create" | "edit";
  readonly ruleId: string | null;
  readonly name: string;
  readonly categoryId: string;
  readonly tree: RuleTree;
}

interface PendingRuleDelete {
  readonly rule: Rule;
  readonly busy: boolean;
  readonly error: string | null;
}

type SseState = "idle" | "connecting" | "open" | "closed";

const ROW_BASE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "9px 11px",
  borderRadius: "var(--radius-md)",
  background: "rgba(255, 255, 255, 0.6)",
  // 用长写而不是 border 简写：拖拽高亮会临时覆盖 borderColor，React 在移除该覆盖时
  // 只清长写；混用简写会让边框色回落到 currentColor（深色描边残留）。
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: "rgba(47, 124, 246, 0.1)",
  minWidth: 0,
};

const BANNER: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "9px 12px",
  borderRadius: "var(--radius-md)",
  background: "rgba(255, 255, 255, 0.66)",
  border: "1px solid rgba(47, 124, 246, 0.12)",
  fontSize: 12,
  color: "var(--text-secondary)",
  flexWrap: "wrap",
};

function isSeedRuleId(id: string): boolean {
  return SEED_RULE_IDS.has(id);
}

function isSeedRule(rule: Rule): boolean {
  return isSeedRuleId(rule.id);
}

/** 结构比较（忽略对象键顺序）：保存后校验“服务端返回的树 == 提交的树”。 */
function sameRuleNode(a: RuleNode, b: RuleNode): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "field":
      return (
        b.kind === "field" &&
        a.field === b.field &&
        a.op === b.op &&
        (a.which ?? "sent") === (b.which ?? "sent") &&
        sameValue(a.value, b.value)
      );
    case "semantic":
      return b.kind === "semantic" && a.expr === b.expr;
    case "not":
      return b.kind === "not" && sameRuleNode(a.child, b.child);
    case "and":
    case "or": {
      if (b.kind !== a.kind || a.children.length !== b.children.length) return false;
      return a.children.every((child, index) => {
        const other = b.children[index];
        return other !== undefined && sameRuleNode(child, other);
      });
    }
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => item === b[index]);
  }
  if (typeof a === "object" && typeof b === "object" && a !== null && b !== null) {
    const left = a as { from?: unknown; to?: unknown };
    const right = b as { from?: unknown; to?: unknown };
    return left.from === right.from && left.to === right.to;
  }
  return false;
}

export function RulesPage() {
  const [categories, setCategories] = useState<readonly Category[]>([]);
  const [rules, setRules] = useState<readonly Rule[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<RulesNotice | null>(null);
  const [busyRuleIds, setBusyRuleIds] = useState<ReadonlySet<string>>(new Set());
  const [reorderBusy, setReorderBusy] = useState(false);
  const [recompute, setRecompute] = useState<RecomputeProgress | null>(null);
  const [sseState, setSseState] = useState<SseState>("idle");

  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [draftIssues, setDraftIssues] = useState<readonly RuleTreeIssue[]>([]);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PendingRuleDelete | null>(null);

  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoading(true);
    try {
      const [nextCategories, nextRules] = await Promise.all([
        api.categories.list({ signal }),
        api.rules.list({ signal }),
      ]);
      setCategories(nextCategories);
      setRules(nextRules);
      setLoadError(null);
      setLoaded(true);
    } catch (error) {
      if (signal?.aborted === true) return;
      // AbortError 由数据层原样上抛（见 lib/api.ts）；它不是加载失败。
      if (error instanceof DOMException && error.name === "AbortError") return;
      setLoadError(isApiError(error) ? error.message : "规则与分类加载失败");
    } finally {
      if (signal?.aborted !== true) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    return () => {
      controller.abort();
    };
  }, [reload]);

  // 提示条 5 秒后自动消失。
  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => {
      setNotice(null);
    }, 5000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [notice]);

  // SSE：只在本页成功加载过一次后连接；重算进度与逐封分类事件都由它推送。
  useEffect(() => {
    if (!loaded) return;
    const token = resolveToken();
    if (token === "") return;
    const source = new EventSource(eventsUrl(token));
    setSseState("connecting");

    const parse = (event: Event): unknown => {
      if (!(event instanceof MessageEvent)) return null;
      const raw: unknown = event.data;
      if (typeof raw !== "string" || raw.trim() === "") return null;
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        return null;
      }
    };

    const onOpen = (): void => {
      setSseState("open");
    };
    const onRecompute = (event: Event): void => {
      const payload = parse(event);
      if (typeof payload !== "object" || payload === null) return;
      const candidate = payload as Partial<RecomputeProgress>;
      if (typeof candidate.jobId !== "string" || typeof candidate.done !== "number") return;
      if (typeof candidate.total !== "number" || typeof candidate.finished !== "boolean") return;
      setRecompute({
        jobId: candidate.jobId,
        done: candidate.done,
        total: candidate.total,
        finished: candidate.finished,
      });
    };
    const onClassification = (event: Event): void => {
      const payload = parse(event);
      if (typeof payload !== "object" || payload === null) return;
      // 收件箱（ui-mail 的写域）可以订阅这个窗口事件来刷新标签徽章。
      window.dispatchEvent(new CustomEvent("mailcollect:classification", { detail: payload }));
    };
    const onError = (event: Event): void => {
      if (event instanceof MessageEvent) {
        const payload = parse(event);
        if (typeof payload === "object" && payload !== null) {
          const message = (payload as { message?: unknown })["message"];
          if (typeof message === "string" && message.trim() !== "") {
            setNotice({ kind: "error", text: message });
          }
        }
        return;
      }
      setSseState(source.readyState === EventSource.CLOSED ? "closed" : "connecting");
    };

    source.addEventListener("open", onOpen);
    source.addEventListener("recompute", onRecompute);
    source.addEventListener("classification", onClassification);
    source.addEventListener("error", onError);

    return () => {
      source.removeEventListener("open", onOpen);
      source.removeEventListener("recompute", onRecompute);
      source.removeEventListener("classification", onClassification);
      source.removeEventListener("error", onError);
      source.close();
      setSseState("idle");
    };
  }, [loaded]);

  // 兜底：SSE 尚未连上时，只为“显式发起的那一轮”轮询状态；连上后立刻让位给事件。
  const recomputeJobId = recompute?.jobId ?? null;
  const recomputeFinished = recompute?.finished ?? false;
  useEffect(() => {
    if (recomputeJobId === null || recomputeFinished || sseState === "open") return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void api.rules
        .recomputeStatus(recomputeJobId)
        .then((status) => {
          if (!cancelled) setRecompute(status);
        })
        .catch(() => {
          // 作业过期（404）或网络中断：停止兜底，事件/下一次操作会重新给出进度。
          if (!cancelled) window.clearInterval(timer);
        });
    }, 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [recomputeJobId, recomputeFinished, sseState]);

  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const ruleCountByCategory = new Map<string, number>();
  for (const rule of rules) {
    ruleCountByCategory.set(rule.categoryId, (ruleCountByCategory.get(rule.categoryId) ?? 0) + 1);
  }

  const runRecompute = async (): Promise<void> => {
    try {
      const response = await api.rules.recompute({});
      setRecompute({ jobId: response.jobId, done: 0, total: 0, finished: false });
      setNotice({ kind: "ok", text: "已开始重算已存邮件的分类标签" });
    } catch (error) {
      setNotice({ kind: "error", text: isApiError(error) ? error.message : "发起重算失败" });
    }
  };

  const toggleRule = async (rule: Rule, enabled: boolean): Promise<void> => {
    setBusyRuleIds((previous) => new Set(previous).add(rule.id));
    try {
      await api.rules.update(rule.id, { enabled });
      await reload();
    } catch (error) {
      setNotice({ kind: "error", text: isApiError(error) ? error.message : "切换规则启停失败" });
    } finally {
      setBusyRuleIds((previous) => {
        const next = new Set(previous);
        next.delete(rule.id);
        return next;
      });
    }
  };

  const persistOrder = async (nextRules: readonly Rule[]): Promise<void> => {
    const previous = rules;
    setRules(nextRules);
    setReorderBusy(true);
    try {
      await api.rules.reorder({ ids: nextRules.map((rule) => rule.id) });
      await reload();
    } catch (error) {
      setRules(previous);
      setNotice({ kind: "error", text: isApiError(error) ? error.message : "调整规则顺序失败" });
    } finally {
      setReorderBusy(false);
    }
  };

  const moveRule = async (ruleId: string, direction: -1 | 1): Promise<void> => {
    const index = rules.findIndex((rule) => rule.id === ruleId);
    if (index < 0) return;
    const target = index + direction;
    if (target < 0 || target >= rules.length) return;
    const next = [...rules];
    const [moved] = next.splice(index, 1);
    if (moved === undefined) return;
    next.splice(target, 0, moved);
    await persistOrder(next);
  };

  const dropOn = async (targetId: string): Promise<void> => {
    const source = dragId;
    setDragId(null);
    setOverId(null);
    if (source === null || source === targetId) return;
    const fromIndex = rules.findIndex((rule) => rule.id === source);
    const toIndex = rules.findIndex((rule) => rule.id === targetId);
    if (fromIndex < 0 || toIndex < 0) return;
    const next = [...rules];
    const [moved] = next.splice(fromIndex, 1);
    if (moved === undefined) return;
    next.splice(toIndex, 0, moved);
    await persistOrder(next);
  };

  const openCreate = (): void => {
    const firstCategory = categories[0];
    if (firstCategory === undefined) {
      setNotice({ kind: "error", text: `先创建分类，再让规则指向它（「${UNCATEGORIZED_NAME}」不能作为目标）` });
      return;
    }
    setDraft({
      mode: "create",
      ruleId: null,
      name: "",
      categoryId: firstCategory.id,
      tree: createDefaultTree(),
    });
    setDraftIssues([]);
    setDraftError(null);
  };

  const openEdit = (rule: Rule): void => {
    setDraft({
      mode: "edit",
      ruleId: rule.id,
      name: rule.name,
      categoryId: rule.categoryId,
      tree: rule.tree,
    });
    setDraftIssues([]);
    setDraftError(null);
  };

  const closeDraft = (): void => {
    if (saving) return;
    setDraft(null);
    setDraftIssues([]);
    setDraftError(null);
  };

  const saveDraft = async (): Promise<void> => {
    if (draft === null) return;
    const name = draft.name.trim();
    if (name === "") {
      setDraftError("规则名称不能为空");
      setDraftIssues([]);
      return;
    }
    if (draft.categoryId === "") {
      setDraftError("请选择目标分类");
      setDraftIssues([]);
      return;
    }
    if (!categories.some((category) => category.id === draft.categoryId)) {
      setDraftError("目标分类不存在，请重新选择");
      setDraftIssues([]);
      return;
    }
    const localIssues = validateTreeLocally(draft.tree);
    if (localIssues.length > 0) {
      setDraftIssues(localIssues);
      setDraftError(`条件树有 ${localIssues.length} 个问题，修正后才能保存`);
      return;
    }

    setSaving(true);
    setDraftError(null);
    try {
      if (draft.mode === "create") {
        const created = await api.rules.create({
          name,
          categoryId: draft.categoryId,
          tree: draft.tree,
        });
        if (!sameRuleNode(draft.tree, created.tree)) {
          setNotice({ kind: "error", text: "保存成功，但服务端返回的条件树与提交内容不一致（往返校验失败）" });
        } else {
          setNotice({ kind: "ok", text: `已保存规则「${name}」，后台会自动重算标签` });
        }
      } else {
        const ruleId = draft.ruleId;
        if (ruleId === null) throw new Error("缺少规则 id");
        const updated = await api.rules.update(ruleId, {
          name,
          categoryId: draft.categoryId,
          tree: draft.tree,
        });
        if (!sameRuleNode(draft.tree, updated.tree)) {
          setNotice({ kind: "error", text: "保存成功，但服务端返回的条件树与提交内容不一致（往返校验失败）" });
        } else {
          setNotice({ kind: "ok", text: `已保存规则「${name}」，后台会自动重算标签` });
        }
      }
      setDraft(null);
      setDraftIssues([]);
      await reload();
    } catch (error) {
      if (isApiError(error) && error.status === 400) {
        const issues = issuesFromServerMessage(error.message);
        if (issues !== null) setDraftIssues(issues);
      }
      setDraftError(isApiError(error) ? error.message : "保存规则失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const deleteRule = async (): Promise<void> => {
    if (pendingDelete === null) return;
    const { rule } = pendingDelete;
    setPendingDelete({ ...pendingDelete, busy: true, error: null });
    try {
      await api.rules.remove(rule.id);
      setPendingDelete(null);
      setNotice({ kind: "ok", text: `已删除规则「${rule.name}」` });
      await reload();
    } catch (error) {
      setPendingDelete((current) =>
        current === null
          ? null
          : { ...current, busy: false, error: isApiError(error) ? error.message : "删除规则失败" },
      );
    }
  };

  const recomputePercent =
    recompute === null || recompute.total === 0
      ? 0
      : Math.min(100, Math.round((recompute.done / recompute.total) * 100));

  if (!loaded && loading) {
    return (
      <div data-panel="rules">
        <GlassCard>
          <div className="dialog-loading" data-testid="rules-loading">
            <span className="pulse-dot" />
            正在加载分类与规则…
          </div>
        </GlassCard>
      </div>
    );
  }

  if (!loaded && loadError !== null) {
    return (
      <div data-panel="rules">
        <GlassCard>
          <EmptyState
            icon="alert"
            tone="iris"
            title="规则加载失败"
            text={loadError}
            action={
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  void reload();
                }}
                data-testid="rules-retry"
              >
                <Icon name="refresh" size={14} />
                重试
              </button>
            }
          />
        </GlassCard>
      </div>
    );
  }

  return (
    <div data-panel="rules" data-testid="rules-page">
      {notice === null ? null : (
        <div
          className={clsx("toast", notice.kind === "error" && "toast--error")}
          role="status"
          data-testid="rules-toast"
        >
          <span className="toast-dot" />
          <span>{notice.text}</span>
        </div>
      )}

      <div className="settings">
        {recompute === null ? null : (
          <div style={BANNER} role="status" aria-live="polite" data-testid="recompute-banner">
            <Icon name="refresh" size={14} />
            <span>{recompute.finished ? "标签重算完成" : "正在重算邮件标签…"}</span>
            <span className="chip chip--accent">
              {recompute.total === 0
                ? recompute.finished
                  ? "无已存邮件"
                  : "排队中"
                : `${recompute.done} / ${recompute.total}`}
            </span>
            <span
              aria-hidden="true"
              style={{
                flex: "1 1 140px",
                height: 6,
                borderRadius: 999,
                background: "rgba(47, 124, 246, 0.14)",
                overflow: "hidden",
              }}
            >
              <span
                style={{
                  display: "block",
                  width: `${recompute.finished ? 100 : recomputePercent}%`,
                  height: "100%",
                  background: "var(--accent-gradient)",
                  transition: "width 220ms var(--ease-out)",
                }}
              />
            </span>
            {sseState === "open" ? null : (
              <span className="section-note" title="实时连接尚未建立，进度由轮询兜底">
                轮询兜底中
              </span>
            )}
            {recompute.finished ? (
              <button
                type="button"
                className="btn btn--icon btn--sm btn--quiet"
                aria-label="收起重算进度"
                onClick={() => {
                  setRecompute(null);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            ) : null}
          </div>
        )}

        <div className="settings-grid">
          <GlassCard>
            <div className="card-head" style={{ marginBottom: 12 }}>
              <div className="card-head-icon">
                <Icon name="bolt" size={18} />
              </div>
              <div className="card-head-text" style={{ flex: 1 }}>
                <div className="card-title">规则</div>
                <div className="card-sub">
                  每条规则 = 名称 + 目标分类 + 条件树；一封邮件可以命中多条规则、多个分类
                </div>
              </div>
            </div>

            <div className="form-actions" style={{ marginTop: 0, marginBottom: 12 }}>
              <button
                type="button"
                className="btn btn--primary btn--sm"
                onClick={openCreate}
                disabled={loading}
                title={categories.length === 0 ? "先创建分类，再新建规则" : "新建规则"}
                data-testid="rule-add"
              >
                <Icon name="plus" size={13} />
                新建规则
              </button>
              <button
                type="button"
                className="btn btn--sm"
                disabled={loading}
                onClick={() => {
                  void runRecompute();
                }}
                title="对已存邮件重算一遍分类标签"
                data-testid="rule-recompute"
              >
                <Icon name="refresh" size={13} />
                重新计算标签
              </button>
              <button
                type="button"
                className="btn btn--sm btn--quiet"
                disabled={loading}
                onClick={() => {
                  void reload();
                }}
                title="重新读取分类与规则"
              >
                <Icon name="refresh" size={13} />
                刷新
              </button>
            </div>

            {loadError === null ? null : (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 10,
                  padding: "8px 11px",
                  borderRadius: "var(--radius-sm)",
                  background: "var(--danger-soft)",
                  color: "#b0454c",
                  fontSize: 11.5,
                }}
                role="alert"
              >
                <Icon name="alert" size={13} />
                <span style={{ flex: 1 }}>重新加载失败：{loadError}</span>
                <button
                  type="button"
                  className="btn btn--sm btn--quiet"
                  onClick={() => {
                    void reload();
                  }}
                >
                  重试
                </button>
              </div>
            )}

            {rules.length === 0 ? (
              <EmptyState
                icon="bolt"
                tone="iris"
                title={categories.length === 0 ? "先创建一个分类" : "还没有规则"}
                text={
                  categories.length === 0
                    ? `规则必须指向一个已存在的分类；「${UNCATEGORIZED_NAME}」是计算态，不能作为目标。`
                    : "点「新建规则」，用与 / 或 / 非和括号组合字段条件或语义条件；命中的邮件会自动打上目标分类。"
                }
                action={
                  categories.length === 0 ? null : (
                    <button type="button" className="btn btn--primary" onClick={openCreate}>
                      <Icon name="plus" size={14} />
                      新建规则
                    </button>
                  )
                }
              />
            ) : (
              <ul
                style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 7 }}
                data-testid="rule-list"
              >
                {rules.map((rule, index) => {
                  const category = categoryById.get(rule.categoryId);
                  const busy = busyRuleIds.has(rule.id) || reorderBusy;
                  const isDropTarget = overId === rule.id && dragId !== rule.id;
                  return (
                    <li
                      key={rule.id}
                      style={{
                        ...ROW_BASE,
                        ...(isDropTarget ? { boxShadow: "var(--focus-ring)", borderColor: "rgba(47,124,246,.4)" } : {}),
                        opacity: dragId === rule.id ? 0.55 : 1,
                      }}
                      draggable={!busy}
                      onDragStart={(event) => {
                        setDragId(rule.id);
                        event.dataTransfer.effectAllowed = "move";
                        event.dataTransfer.setData("text/plain", rule.id);
                      }}
                      onDragEnd={() => {
                        setDragId(null);
                        setOverId(null);
                      }}
                      onDragOver={(event) => {
                        if (dragId === null || dragId === rule.id) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setOverId(rule.id);
                      }}
                      onDragLeave={() => {
                        setOverId((current) => (current === rule.id ? null : current));
                      }}
                      onDrop={(event) => {
                        event.preventDefault();
                        void dropOn(rule.id);
                      }}
                      data-testid={`rule-row-${rule.id}`}
                    >
                      <span
                        aria-hidden="true"
                        title="拖拽排序"
                        style={{
                          cursor: busy ? "default" : "grab",
                          color: "var(--text-tertiary)",
                          display: "inline-flex",
                          flex: "none",
                        }}
                      >
                        <svg width="12" height="18" viewBox="0 0 12 18" fill="currentColor">
                          <circle cx="3" cy="4" r="1.3" />
                          <circle cx="9" cy="4" r="1.3" />
                          <circle cx="3" cy="9" r="1.3" />
                          <circle cx="9" cy="9" r="1.3" />
                          <circle cx="3" cy="14" r="1.3" />
                          <circle cx="9" cy="14" r="1.3" />
                        </svg>
                      </span>

                      <div style={{ flex: "1 1 220px", minWidth: 0 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span style={{ fontSize: 13.5, fontWeight: 700 }}>{rule.name}</span>
                          <span
                            className={clsx("chip", category?.broadcast === true ? "chip--iris" : "chip--accent")}
                            title="目标分类"
                          >
                            {category?.name ?? "分类已不存在"}
                          </span>
                          {isSeedRule(rule) ? (
                            <span className="chip" title="初始化时生成的种子规则；可以修改或删除，删除后不会自动重建">
                              内置
                            </span>
                          ) : null}
                          {rule.enabled ? null : <span className="chip chip--warning">已停用</span>}
                        </div>
                        <div
                          title={summarizeTree(rule.tree)}
                          style={{
                            marginTop: 3,
                            fontFamily: "var(--font-mono)",
                            fontSize: 11,
                            lineHeight: 1.55,
                            color: "var(--text-secondary)",
                            overflowWrap: "anywhere",
                          }}
                          data-testid={`rule-summary-${rule.id}`}
                        >
                          {summarizeTree(rule.tree)}
                        </div>
                      </div>

                      <label className="check" title={rule.enabled ? "停用后不再参与打标" : "启用后参与打标"}>
                        <input
                          type="checkbox"
                          checked={rule.enabled}
                          disabled={busy}
                          onChange={(event) => {
                            void toggleRule(rule, event.target.checked);
                          }}
                        />
                        {rule.enabled ? "启用" : "停用"}
                      </label>

                      <div style={{ display: "flex", gap: 2, flex: "none" }}>
                        <button
                          type="button"
                          className="btn btn--icon btn--sm btn--quiet"
                          aria-label={`上移规则「${rule.name}」`}
                          title="上移"
                          disabled={busy || index === 0}
                          onClick={() => {
                            void moveRule(rule.id, -1);
                          }}
                        >
                          <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1 }}>
                            ↑
                          </span>
                        </button>
                        <button
                          type="button"
                          className="btn btn--icon btn--sm btn--quiet"
                          aria-label={`下移规则「${rule.name}」`}
                          title="下移"
                          disabled={busy || index === rules.length - 1}
                          onClick={() => {
                            void moveRule(rule.id, 1);
                          }}
                        >
                          <span aria-hidden="true" style={{ fontSize: 14, lineHeight: 1 }}>
                            ↓
                          </span>
                        </button>
                        <button
                          type="button"
                          className="btn btn--icon btn--sm btn--quiet"
                          aria-label={`编辑规则「${rule.name}」`}
                          title="编辑"
                          disabled={busy}
                          onClick={() => {
                            openEdit(rule);
                          }}
                          data-testid={`rule-edit-${rule.id}`}
                        >
                          <Icon name="settings" size={14} />
                        </button>
                        <button
                          type="button"
                          className="btn btn--icon btn--sm btn--quiet"
                          aria-label={`删除规则「${rule.name}」`}
                          title="删除"
                          disabled={busy}
                          onClick={() => {
                            setPendingDelete({ rule, busy: false, error: null });
                          }}
                          data-testid={`rule-delete-${rule.id}`}
                        >
                          <Icon name="trash" size={14} />
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}

            <div className="field-hint" style={{ marginTop: 10 }}>
              顺序只影响展示与“同一分类被多条规则命中时保留哪条规则”，不会抑制任何命中；停用的规则不参与打标。
            </div>
          </GlassCard>

          <GlassCard>
            <CategoryManager
              categories={categories}
              ruleCountByCategory={ruleCountByCategory}
              disabled={loading}
              onChanged={reload}
              onNotice={setNotice}
            />
          </GlassCard>
        </div>
      </div>

      {draft === null ? null : (
        <RulesModal
          title={draft.mode === "create" ? "新建规则" : "编辑规则"}
          subtitle={`条件树支持与 / 或 / 非与括号分组，逻辑嵌套深度上限 ${MAX_DEPTH}`}
          icon="bolt"
          width={880}
          onClose={closeDraft}
          footer={
            <>
              <button type="button" className="btn btn--quiet" disabled={saving} onClick={closeDraft}>
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={saving}
                onClick={() => {
                  void saveDraft();
                }}
                data-testid="rule-save"
              >
                {saving ? "保存中…" : "保存规则"}
              </button>
            </>
          }
        >
          <div className="form-grid" style={{ marginBottom: 12 }}>
            <div className="form-row">
              <label className="field-label" htmlFor="rule-name">
                规则名称
              </label>
              <input
                id="rule-name"
                className="input"
                autoFocus
                value={draft.name}
                maxLength={60}
                placeholder="例如：账单与催缴"
                disabled={saving}
                onChange={(event) => {
                  setDraft({ ...draft, name: event.target.value });
                }}
                data-testid="rule-name"
              />
            </div>
            <div className="form-row">
              <label className="field-label" htmlFor="rule-category">
                目标分类（每条规则恰好一个）
              </label>
              <select
                id="rule-category"
                className="select"
                value={draft.categoryId}
                disabled={saving || categories.length === 0}
                onChange={(event) => {
                  setDraft({ ...draft, categoryId: event.target.value });
                }}
                data-testid="rule-category"
              >
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                    {category.enterTodo ? "（进待办）" : ""}
                    {category.broadcast ? "（群发提醒）" : ""}
                  </option>
                ))}
              </select>
              <span className="field-hint">
                「{UNCATEGORIZED_NAME}」是计算态，不能作为规则目标；分类名可在分类管理里改。
              </span>
            </div>
          </div>

          {draft.mode === "edit" && draft.ruleId !== null && isSeedRuleId(draft.ruleId) ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 10,
                padding: "8px 11px",
                borderRadius: "var(--radius-sm)",
                background: "var(--iris-soft)",
                color: "#4e5bd8",
                fontSize: 11.5,
                lineHeight: 1.6,
              }}
            >
              <Icon name="spark" size={13} />
              这是初始化时生成的种子规则，可以修改；删除后不会再自动重建。
            </div>
          ) : null}

          <RuleTreeEditor
            tree={draft.tree}
            onChange={(tree: RuleTree) => {
              setDraft({ ...draft, tree });
            }}
            issues={draftIssues}
            disabled={saving}
          />

          {draftError === null ? null : (
            <div
              style={{
                marginTop: 10,
                display: "flex",
                alignItems: "flex-start",
                gap: 8,
                padding: "9px 11px",
                borderRadius: "var(--radius-sm)",
                background: "var(--danger-soft)",
                color: "#b0454c",
                fontSize: 11.5,
                lineHeight: 1.6,
              }}
              role="alert"
              data-testid="rule-error"
            >
              <Icon name="alert" size={13} />
              <span style={{ overflowWrap: "anywhere" }}>{draftError}</span>
            </div>
          )}
        </RulesModal>
      )}

      {pendingDelete === null ? null : (
        <RulesModal
          title={`删除规则「${pendingDelete.rule.name}」？`}
          subtitle="删除后不再参与打标；这一操作不可撤销"
          icon="alert"
          width={480}
          onClose={() => {
            if (!pendingDelete.busy) setPendingDelete(null);
          }}
          footer={
            <>
              <button
                type="button"
                className="btn btn--quiet"
                disabled={pendingDelete.busy}
                onClick={() => {
                  setPendingDelete(null);
                }}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={pendingDelete.busy}
                onClick={() => {
                  void deleteRule();
                }}
                data-testid="rule-delete-confirm"
              >
                {pendingDelete.busy ? "删除中…" : "确认删除"}
              </button>
            </>
          }
        >
          <div style={{ fontSize: 12, lineHeight: 1.7, color: "var(--text-secondary)" }}>
            规则「{pendingDelete.rule.name}」当前{pendingDelete.rule.enabled ? "启用" : "停用"}，目标分类「
            {categoryById.get(pendingDelete.rule.categoryId)?.name ?? "（已不存在）"}」。删除规则不会删除分类；
            已打上的标签会在下一轮重算时收敛。
          </div>
          {pendingDelete.error === null ? null : (
            <div
              style={{
                marginTop: 10,
                padding: "9px 11px",
                borderRadius: "var(--radius-sm)",
                background: "var(--danger-soft)",
                color: "#b0454c",
                fontSize: 11.5,
              }}
              role="alert"
            >
              {pendingDelete.error}
            </div>
          )}
        </RulesModal>
      )}
    </div>
  );
}
