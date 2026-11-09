import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties, ReactNode } from "react";
import clsx from "clsx";
import type { Category, CreateCategoryInput } from "@mailcollect/shared";
import { api, isApiError } from "../lib/api";
import { Icon } from "./Icon";

/**
 * 分类管理（C6 / AC-22）。
 *
 * 服务端行为（apps/server/src/routes/rules.ts）：
 * - 名称唯一，重复 → 409 `invalid_input`；`enterTodo` / `broadcast` 是必填布尔；
 * - 「未分类」是计算态：不是一行数据，创建/改名/指派/删除都以 400 拒绝 ——
 *   所以这里只把它渲染成只读的“孤儿桶”，不给任何编辑入口；
 * - 删除非空分类必须 `?confirm=true`：第一次不带 confirm 会拿到 409，文案里写明
 *   「会连带删除 N 条规则与 M 封邮件的标签」。本组件把这个 409 **原文**放进确认框，
 *   用户点「确认删除」后才带 confirm 真删；取消则什么都不写。
 */

/** 与 shared `UNCATEGORIZED_NAME` 镜像（ui → shared 只引类型，见 AGENT.md §7）。 */
export const UNCATEGORIZED_NAME = "未分类";

export interface RulesNotice {
  readonly kind: "ok" | "error";
  readonly text: string;
}

export interface CategoryManagerProps {
  readonly categories: readonly Category[];
  readonly ruleCountByCategory: ReadonlyMap<string, number>;
  readonly disabled?: boolean;
  readonly onChanged: () => void | Promise<void>;
  readonly onNotice: (notice: RulesNotice) => void;
}

interface CategoryForm {
  readonly name: string;
  readonly enterTodo: boolean;
  readonly broadcast: boolean;
}

const EMPTY_FORM: CategoryForm = { name: "", enterTodo: true, broadcast: false };

type EditorMode = { readonly kind: "closed" } | { readonly kind: "create" } | { readonly kind: "edit"; readonly category: Category };

interface PendingDelete {
  readonly category: Category;
  /** 服务端 409 的原始文案（含连带删除的规则/邮件数量）。 */
  readonly detail: string;
  readonly busy: boolean;
  readonly error: string | null;
}

const CARD_FIELD: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "9px 11px",
  borderRadius: "var(--radius-sm)",
  background: "rgba(255, 255, 255, 0.55)",
  border: "1px solid rgba(47, 124, 246, 0.1)",
};

const DANGER_BOX: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "10px 12px",
  borderRadius: "var(--radius-sm)",
  background: "var(--danger-soft)",
  color: "#b0454c",
  fontSize: 12,
  lineHeight: 1.65,
};

export function CategoryManager({
  categories,
  ruleCountByCategory,
  disabled = false,
  onChanged,
  onNotice,
}: CategoryManagerProps) {
  const [mode, setMode] = useState<EditorMode>({ kind: "closed" });
  const [form, setForm] = useState<CategoryForm>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingToggle, setPendingToggle] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null);

  const closeEditor = (): void => {
    if (saving) return;
    setMode({ kind: "closed" });
    setFormError(null);
  };

  const openCreate = (): void => {
    setForm(EMPTY_FORM);
    setFormError(null);
    setMode({ kind: "create" });
  };

  const openEdit = (category: Category): void => {
    setForm({ name: category.name, enterTodo: category.enterTodo, broadcast: category.broadcast });
    setFormError(null);
    setMode({ kind: "edit", category });
  };

  const submitForm = async (): Promise<void> => {
    const name = form.name.trim();
    if (name === "") {
      setFormError("分类名称不能为空");
      return;
    }
    if (name === UNCATEGORIZED_NAME) {
      setFormError(`「${UNCATEGORIZED_NAME}」是计算态，不能创建或改名为它`);
      return;
    }
    if (mode.kind === "closed") return;
    if (mode.kind === "create" && categories.some((category) => category.name === name)) {
      setFormError(`已存在同名分类「${name}」`);
      return;
    }
    if (
      mode.kind === "edit" &&
      categories.some((category) => category.name === name && category.id !== mode.category.id)
    ) {
      setFormError(`已存在同名分类「${name}」`);
      return;
    }

    const input: CreateCategoryInput = {
      name,
      enterTodo: form.enterTodo,
      broadcast: form.broadcast,
    };

    setSaving(true);
    setFormError(null);
    try {
      if (mode.kind === "create") {
        await api.categories.create(input);
        onNotice({ kind: "ok", text: `已创建分类「${name}」` });
      } else {
        await api.categories.update(mode.category.id, input);
        onNotice({ kind: "ok", text: `已保存分类「${name}」` });
      }
      setMode({ kind: "closed" });
      await onChanged();
    } catch (error) {
      setFormError(isApiError(error) ? error.message : "保存分类失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (category: Category, patch: { enterTodo?: boolean; broadcast?: boolean }): Promise<void> => {
    setPendingToggle(category.id);
    try {
      await api.categories.update(category.id, patch);
      await onChanged();
    } catch (error) {
      onNotice({
        kind: "error",
        text: isApiError(error) ? error.message : `切换分类「${category.name}」的开关失败`,
      });
    } finally {
      setPendingToggle(null);
    }
  };

  /**
   * 删除第一步：不带 confirm 调用。
   * - 空分类：服务端直接删除 → 成功；
   * - 非空分类：服务端 409，文案里带「连带删除 N 条规则与 M 封邮件」→ 原样进确认框。
   */
  const requestDelete = async (category: Category): Promise<void> => {
    try {
      await api.categories.remove(category.id);
      onNotice({ kind: "ok", text: `已删除分类「${category.name}」` });
      await onChanged();
    } catch (error) {
      if (isApiError(error) && error.status === 409) {
        setPendingDelete({ category, detail: error.message, busy: false, error: null });
        return;
      }
      onNotice({
        kind: "error",
        text: isApiError(error) ? error.message : `删除分类「${category.name}」失败`,
      });
    }
  };

  const confirmDelete = async (): Promise<void> => {
    if (pendingDelete === null) return;
    const { category } = pendingDelete;
    setPendingDelete({ ...pendingDelete, busy: true, error: null });
    try {
      await api.categories.remove(category.id, { confirm: true });
      setPendingDelete(null);
      onNotice({ kind: "ok", text: `已删除分类「${category.name}」及其规则/标签` });
      await onChanged();
    } catch (error) {
      setPendingDelete((current) =>
        current === null
          ? null
          : {
              ...current,
              busy: false,
              error: isApiError(error) ? error.message : "删除失败，请重试",
            },
      );
    }
  };

  const realCategories = categories;

  return (
    <>
      <div className="card-head" style={{ marginBottom: 12 }}>
        <div className="card-head-icon is-iris">
          <Icon name="users" size={18} />
        </div>
        <div className="card-head-text" style={{ flex: 1 }}>
          <div className="card-title">分类</div>
          <div className="card-sub">每条规则恰好指向一个分类；一封邮件可以命中多个分类</div>
        </div>
        <button
          type="button"
          className="btn btn--primary btn--sm"
          disabled={disabled}
          onClick={openCreate}
          data-testid="category-add"
        >
          <Icon name="plus" size={13} />
          新建分类
        </button>
      </div>

      {realCategories.length === 0 ? (
        <div style={{ padding: "18px 4px", textAlign: "center", fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.7 }}>
          还没有分类。
          <br />
          先建一个分类，再让规则指向它 —— 命中的邮件会自动打上这个标签。
        </div>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 7 }} data-testid="category-list">
          {realCategories.map((category) => {
            const ruleCount = ruleCountByCategory.get(category.id) ?? 0;
            const toggling = pendingToggle === category.id;
            return (
              <li key={category.id} style={CARD_FIELD} data-testid={`category-row-${category.id}`}>
                <div style={{ flex: "1 1 150px", minWidth: 120 }}>
                  <div style={{ fontSize: 13, fontWeight: 650 }}>{category.name}</div>
                  <div style={{ marginTop: 3, display: "flex", gap: 5, flexWrap: "wrap" }}>
                    <span className={clsx("chip", category.enterTodo ? "chip--accent" : "")}>
                      {category.enterTodo ? "进待办" : "不进待办"}
                    </span>
                    <span className={clsx("chip", category.broadcast ? "chip--iris" : "")}>
                      {category.broadcast ? "群发提醒" : "非群发"}
                    </span>
                    <span className="chip">{ruleCount} 条规则</span>
                  </div>
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <label className="check" title="命中的邮件进入 LLM 待办抽取">
                    <input
                      type="checkbox"
                      checked={category.enterTodo}
                      disabled={disabled || toggling}
                      onChange={(event) => {
                        void toggle(category, { enterTodo: event.target.checked });
                      }}
                    />
                    进待办
                  </label>
                  <label className="check" title="命中的邮件只进「群发提醒」卡片，不抽取待办">
                    <input
                      type="checkbox"
                      checked={category.broadcast}
                      disabled={disabled || toggling}
                      onChange={(event) => {
                        void toggle(category, { broadcast: event.target.checked });
                      }}
                    />
                    群发提醒
                  </label>
                </div>

                <div style={{ display: "flex", gap: 4 }}>
                  <button
                    type="button"
                    className="btn btn--icon btn--sm btn--quiet"
                    aria-label={`编辑分类「${category.name}」`}
                    title="编辑"
                    disabled={disabled || toggling}
                    onClick={() => {
                      openEdit(category);
                    }}
                  >
                    <Icon name="settings" size={14} />
                  </button>
                  <button
                    type="button"
                    className="btn btn--icon btn--sm btn--quiet"
                    aria-label={`删除分类「${category.name}」`}
                    title="删除（非空分类会先告诉你连带删除的数量）"
                    disabled={disabled || toggling}
                    onClick={() => {
                      void requestDelete(category);
                    }}
                    data-testid={`category-delete-${category.id}`}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* 「未分类」不是一行数据：只读展示，永不提供编辑/删除/指派入口。 */}
      <div
        style={{
          marginTop: 8,
          display: "flex",
          alignItems: "center",
          gap: 9,
          padding: "9px 11px",
          borderRadius: "var(--radius-sm)",
          background: "rgba(255, 255, 255, 0.4)",
          border: "1px dashed rgba(15, 37, 64, 0.16)",
        }}
        data-testid="category-uncategorized"
      >
        <span style={{ fontSize: 13, fontWeight: 650, color: "var(--text-secondary)" }}>{UNCATEGORIZED_NAME}</span>
        <span className="chip">自动</span>
        <span className="section-note" style={{ flex: 1, minWidth: 0 }}>
          没有任何规则命中的邮件归到这里；它是计算态，不能创建、改名、指派或删除。
        </span>
        <span className="chip chip--warning" title="只读">
          只读
        </span>
      </div>

      {mode.kind === "closed" ? null : (
        <RulesModal
          title={mode.kind === "create" ? "新建分类" : `编辑分类「${mode.category.name}」`}
          subtitle="两个开关互不抑制：一封邮件同时命中多个分类时，各自的开关分别按 OR 生效"
          icon="users"
          width={520}
          onClose={closeEditor}
          footer={
            <>
              <button type="button" className="btn btn--quiet" disabled={saving} onClick={closeEditor}>
                取消
              </button>
              <button
                type="button"
                className="btn btn--primary"
                disabled={saving}
                onClick={() => {
                  void submitForm();
                }}
                data-testid="category-save"
              >
                {saving ? "保存中…" : mode.kind === "create" ? "创建分类" : "保存修改"}
              </button>
            </>
          }
        >
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submitForm();
            }}
          >
            <div className="form-row">
              <label className="field-label" htmlFor="category-name">
                分类名称
              </label>
              <input
                id="category-name"
                className="input"
                value={form.name}
                autoFocus
                maxLength={40}
                placeholder="例如：账单 / 项目邮件 / 群发通知"
                disabled={saving}
                onChange={(event) => {
                  setForm((current) => ({ ...current, name: event.target.value }));
                }}
                data-testid="category-name"
              />
              <span className="field-hint">名称必须唯一；「未分类」是保留的计算态，不能用作名称。</span>
            </div>

            <div style={{ marginTop: 14, display: "flex", flexDirection: "column", gap: 8 }}>
              <label className="check" style={{ alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={form.enterTodo}
                  disabled={saving}
                  onChange={(event) => {
                    setForm((current) => ({ ...current, enterTodo: event.target.checked }));
                  }}
                />
                <span>
                  <strong>进入待办抽取</strong>
                  <br />
                  命中的邮件交给 LLM 判定是否成为我的待办。
                </span>
              </label>
              <label className="check" style={{ alignItems: "flex-start" }}>
                <input
                  type="checkbox"
                  checked={form.broadcast}
                  disabled={saving}
                  onChange={(event) => {
                    setForm((current) => ({ ...current, broadcast: event.target.checked }));
                  }}
                />
                <span>
                  <strong>群发提醒</strong>
                  <br />
                  命中的邮件只进「群发/通知」卡片，不抽取待办。
                </span>
              </label>
            </div>

            {formError === null ? null : (
              <div style={{ ...DANGER_BOX, marginTop: 12 }} role="alert">
                <Icon name="alert" size={13} />
                <span>{formError}</span>
              </div>
            )}
          </form>
        </RulesModal>
      )}

      {pendingDelete === null ? null : (
        <RulesModal
          title={`删除分类「${pendingDelete.category.name}」？`}
          subtitle="服务端返回的连带影响如下（原文展示）"
          icon="alert"
          width={520}
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
                data-testid="category-delete-cancel"
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn--danger"
                disabled={pendingDelete.busy}
                onClick={() => {
                  void confirmDelete();
                }}
                data-testid="category-delete-confirm"
              >
                {pendingDelete.busy ? "删除中…" : "确认删除（连带规则与标签）"}
              </button>
            </>
          }
        >
          <div style={DANGER_BOX} role="alert" data-testid="category-delete-warning">
            <Icon name="alert" size={14} />
            <span>{pendingDelete.detail}</span>
          </div>
          <p style={{ marginTop: 10, fontSize: 11.5, lineHeight: 1.65, color: "var(--text-secondary)" }}>
            删除分类会同时删除指向它的规则，以及邮件上的该分类标签；此操作不可撤销。取消则不会写入任何数据。
          </p>
          {pendingDelete.error === null ? null : (
            <div style={{ ...DANGER_BOX, marginTop: 10 }} role="alert">
              <Icon name="alert" size={13} />
              <span>{pendingDelete.error}</span>
            </div>
          )}
        </RulesModal>
      )}
    </>
  );
}

/**
 * 规则/分类共用的模态壳（分类编辑、删除确认、规则编辑都用它）。
 *
 * - Escape 关闭；点遮罩关闭；Tab 焦点限制在弹层内；打开时锁 body 滚动；
 * - 关闭后把焦点还给触发元素，键盘用户不会掉到文档开头。
 */
export function RulesModal({
  title,
  subtitle,
  icon = "bolt",
  width = 560,
  onClose,
  children,
  footer,
}: {
  readonly title: string;
  readonly subtitle?: string;
  readonly icon?: "bolt" | "alert" | "users" | "settings" | "tasks";
  readonly width?: number;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const card = cardRef.current;
    if (card === null) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    const focusables = (): readonly HTMLElement[] => {
      const selector = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
      const all = [...card.querySelectorAll<HTMLElement>(selector)].filter(
        (element) => !element.hasAttribute("disabled"),
      );
      // 焦点先进正文（名称输入等），而不是右上角关闭按钮；Tab 环仍包含页脚与关闭按钮。
      const body = card.querySelector<HTMLElement>("[data-modal-body]");
      if (body === null) return all;
      const inBody = [...body.querySelectorAll<HTMLElement>(selector)].filter(
        (element) => !element.hasAttribute("disabled"),
      );
      return [...inBody, ...all.filter((element) => !inBody.includes(element))];
    };

    focusables()[0]?.focus();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const list = focusables();
      const first = list[0];
      const last = list[list.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previous?.focus();
    };
  }, []);

  // 挂在 body 上：GlassCard 的 backdrop-filter 会成为 fixed 子元素的包含块，
  // 若留在原树里，遮罩会被裁到卡片范围内（分类弹层就落在右栏卡片上）。
  const host = typeof document === "undefined" ? null : document.body;
  if (host === null) return null;

  return createPortal(
    <div
      className="dialog-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current();
      }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        data-testid="rules-modal"
        style={{
          width: `min(${width}px, 100%)`,
          maxHeight: "88vh",
          display: "flex",
          flexDirection: "column",
          padding: 20,
          borderRadius: "var(--radius-lg)",
          border: "var(--glass-border)",
          background: "linear-gradient(180deg, rgba(255, 255, 255, 0.96), rgba(255, 255, 255, 0.9))",
          boxShadow: "var(--shadow-lift), inset 0 1px 0 rgba(255, 255, 255, 0.95)",
          backdropFilter: "var(--glass-filter)",
          WebkitBackdropFilter: "var(--glass-filter)",
        }}
      >
        <div className="dialog-head">
          <div
            className="dialog-icon"
            style={
              icon === "alert"
                ? { background: "var(--danger-soft)", color: "#b0454c" }
                : undefined
            }
          >
            <Icon name={icon} size={18} />
          </div>
          <div className="dialog-titles">
            <div className="dialog-title">{title}</div>
            {subtitle === undefined ? null : (
              <div className="dialog-sub" style={{ whiteSpace: "normal" }}>
                {subtitle}
              </div>
            )}
          </div>
          <button
            type="button"
            className="dialog-close"
            aria-label="关闭"
            onClick={() => closeRef.current()}
          >
            <Icon name="close" size={14} />
          </button>
        </div>

        <div data-modal-body style={{ minHeight: 0, overflow: "auto", paddingRight: 2 }}>{children}</div>

        {footer === undefined ? null : (
          <div
            className="dialog-actions"
            style={{ marginTop: 14, display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    host,
  );
}
