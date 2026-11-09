import { useEffect, useState } from "react";
import type { Folder, FolderRole, HealthResponse, InitState } from "@mailcollect/shared";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import {
  DATA_CHANGED_EVENT,
  ONBOARDING_CHANGED_EVENT,
  ROUTE_EVENT,
  requestShellRoute,
  type ShellRoute,
} from "./OnboardingWizard";
import { api, isApiError } from "../lib/api";
import { initials, hueFor } from "../lib/format";

/**
 * 侧栏「文件夹」点击的路由缝：App.tsx 不在本任务写域内，InboxPage 通过这条窗口事件
 * 收到 `{accountId, path}` 并切换账号 + 文件夹，而不是把 folder 塞进 App 的导航 state。
 */
export const FOLDER_EVENT = "mailcollect:mail-folder";

export interface FolderTarget {
  readonly accountId: string;
  readonly path: string;
  readonly label: string;
}

const FOLDER_ICON: Record<FolderRole, IconName> = {
  inbox: "inbox",
  sent: "arrow-right",
  drafts: "mail",
  trash: "trash",
  archive: "tasks",
  junk: "alert",
  other: "mail",
};

const FOLDER_LABEL: Record<FolderRole, string> = {
  inbox: "收件箱",
  sent: "已发送",
  drafts: "草稿",
  trash: "垃圾箱",
  archive: "归档",
  junk: "垃圾邮件",
  other: "其他",
};

/** 服务端还没有文件夹快照时的兜底角色；草稿在收件箱的「草稿」页里，不在这里重复出现。 */
const FALLBACK_ROLES: readonly FolderRole[] = ["inbox", "sent", "archive", "trash"];

export type PageId = "inbox" | "tasks" | "timeline" | "rules" | "onboarding" | "settings";

interface NavEntry {
  readonly id: PageId;
  readonly label: string;
  readonly icon: IconName;
}

const NAV: readonly NavEntry[] = [
  { id: "inbox", label: "收件箱", icon: "inbox" },
  { id: "tasks", label: "待办", icon: "tasks" },
  { id: "timeline", label: "时间线", icon: "timeline" },
  { id: "rules", label: "规则", icon: "bolt" },
  { id: "onboarding", label: "初始化", icon: "spark" },
  { id: "settings", label: "设置", icon: "settings" },
];

/** 同一次浏览器会话里只自动全屏一次；「跳过/完成」的持久判定仍在服务端。 */
const AUTO_OPEN_KEY = "mailcollect.onboarding.auto-opened";

export interface SidebarProps {
  readonly page: PageId;
  readonly candidateCount: number;
  readonly profileName: string;
  readonly profileMeta: string;
  readonly onNavigate: (page: PageId) => void;
}

export function Sidebar({ page, candidateCount, profileName, profileMeta, onNavigate }: SidebarProps) {
  const hue = hueFor(profileName);
  const avatarBackground = `linear-gradient(140deg, hsl(${hue + 6} 92% 70%), hsl(${hue} 80% 54%))`;

  // 初始化状态与「是否配置齐全」只有服务端知道（App.tsx 不把它们传进侧栏），
  // 所以侧栏自己取一次：演示/离线时静默降级，不阻塞导航。
  const [onboarding, setOnboarding] = useState<InitState | null>(null);
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([api.onboarding.get({ signal: controller.signal }), api.health()])
      .then(([state, healthResponse]: [InitState, HealthResponse]) => {
        if (controller.signal.aborted) return;
        setOnboarding(state);
        setHealth(healthResponse);
        // AC-01：未完成且未跳过时自动全屏一次；「跳过」之后不再自动全屏。
        if (state.completed || state.skipped) return;
        let alreadyOpened: boolean;
        try {
          alreadyOpened = window.sessionStorage.getItem(AUTO_OPEN_KEY) === "1";
          window.sessionStorage.setItem(AUTO_OPEN_KEY, "1");
        } catch {
          // 隐私模式下 sessionStorage 可能不可写：这次不自动弹，但入口仍然可用。
          return;
        }
        if (!alreadyOpened) onNavigate("onboarding");
      })
      .catch(() => {
        // 服务端不可达（演示数据 / 离线）：没有初始化事实可读，保持安静。
      });
    return () => controller.abort();
  }, [onNavigate]);

  // 向导写完标记后广播；这里同步更新，避免退出后仍显示旧提示。
  useEffect(() => {
    const onChanged = (event: Event): void => {
      const detail = (event as CustomEvent<InitState>).detail;
      if (detail !== undefined && detail !== null) setOnboarding(detail);
    };
    window.addEventListener(ONBOARDING_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(ONBOARDING_CHANGED_EVENT, onChanged);
  }, []);

  // 向导 / 设置页每次成功写入后广播 DATA_CHANGED_EVENT；侧栏的 health 只在 mount 取过一次，
  // 必须跟着事件重取，否则「未配置 / 未设置档案」会一直是旧值（T66-B）。
  useEffect(() => {
    const onDataChanged = (): void => {
      void api.health()
        .then((response) => setHealth(response))
        .catch(() => {
          // 服务端不可达时保持旧值，等下一次事件或重新挂载。
        });
    };
    window.addEventListener(DATA_CHANGED_EVENT, onDataChanged);
    return () => window.removeEventListener(DATA_CHANGED_EVENT, onDataChanged);
  }, []);

  // 设置页的「重新打开初始化向导」与向导自身的退出都经这条路由事件回到壳层；
  // App.tsx 不在本写域内，这条既有接线（onNavigate）是唯一不改 App 的路由缝。
  useEffect(() => {
    const onRoute = (event: Event): void => {
      const detail = (event as CustomEvent<ShellRoute>).detail;
      if (detail !== undefined) onNavigate(detail);
    };
    window.addEventListener(ROUTE_EVENT, onRoute);
    return () => window.removeEventListener(ROUTE_EVENT, onRoute);
  }, [onNavigate]);

  // 文件夹与未读数：侧栏自己取一次（App 不传入），失败时按角色兜底并保持可点击。
  const [folderAccount, setFolderAccount] = useState<string | null>(null);
  const [folders, setFolders] = useState<readonly Folder[]>([]);
  const [foldersError, setFoldersError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const list = await api.accounts.list();
        if (!active) return;
        const first = list.find((account) => account.enabled) ?? list[0] ?? null;
        setFolderAccount(first?.id ?? null);
        if (first === null) {
          setFolders([]);
          return;
        }
        try {
          const snapshot = await api.folders.list({ accountId: first.id });
          if (!active) return;
          setFolders(snapshot);
          setFoldersError(null);
        } catch (error) {
          if (!active) return;
          setFolders(
            FALLBACK_ROLES.map((role) => ({ accountId: first.id, path: role, role, unread: 0 })),
          );
          setFoldersError(isApiError(error) ? error.message : "文件夹读取失败");
        }
      } catch {
        // 服务端不可达（演示数据 / 离线）：没有文件夹事实可读，保持安静。
      }
    })();
    return () => {
      active = false;
    };
  }, [page]);

  const onboardingPending = onboarding !== null && !onboarding.completed && !onboarding.skipped;
  const unconfigured: string[] = [];
  if (health !== null) {
    if (!health.hasProfile) unconfigured.push("档案");
    if (health.accountCount === 0) unconfigured.push("邮箱账号");
  }

  return (
    <aside className="sidebar" aria-label="主导航">
      <div className="brand">
        <div className="brand-mark">
          <Icon name="mail" size={21} strokeWidth={1.9} />
        </div>
        <div className="brand-text">
          <div className="brand-name">MailCollect</div>
          <div className="brand-sub">邮件待办助手</div>
        </div>
      </div>

      <nav className="nav">
        {NAV.map((entry) => {
          const active = entry.id === page;
          return (
            <button
              key={entry.id}
              type="button"
              className={active ? "nav-item is-active" : "nav-item"}
              aria-current={active ? "page" : undefined}
              onClick={() => {
                // 「初始化」经路由事件走：Sidebar 自己的监听器负责导航，
                // 同时把「重开」信号发给向导（结束页要回到第一步）。
                if (entry.id === "onboarding") {
                  requestShellRoute("onboarding");
                  return;
                }
                onNavigate(entry.id);
              }}
            >
              <span className="nav-icon">
                <Icon name={entry.icon} size={18} />
              </span>
              <span className="nav-label">{entry.label}</span>
              {entry.id === "tasks" && candidateCount > 0 ? (
                <span className="nav-badge">{candidateCount}</span>
              ) : null}
              {entry.id === "onboarding" && onboardingPending ? (
                <span className="nav-badge" title="初始化未完成">
                  !
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {folders.length === 0 ? null : (
        <div style={{ marginTop: 12, minWidth: 0 }}>
          <div className="field-label" style={{ padding: "0 10px 6px" }}>
            文件夹
            {foldersError === null ? null : (
              <span className="field-hint" title={foldersError} style={{ marginLeft: 6 }}>
                （角色兜底）
              </span>
            )}
          </div>
          <nav className="nav" aria-label="文件夹">
            {folders
              .filter((entry) => entry.role !== "drafts")
              .map((entry) => (
                <button
                  key={`${entry.accountId}-${entry.path}`}
                  type="button"
                  className="nav-item"
                  title={`${entry.accountId} · ${entry.path}`}
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent<FolderTarget>(FOLDER_EVENT, {
                        detail: {
                          accountId: entry.accountId,
                          path: entry.path,
                          label: FOLDER_LABEL[entry.role] ?? entry.path,
                        },
                      }),
                    );
                    onNavigate("inbox");
                  }}
                >
                  <span className="nav-icon">
                    <Icon name={FOLDER_ICON[entry.role] ?? "inbox"} size={17} />
                  </span>
                  <span className="nav-label">{FOLDER_LABEL[entry.role] ?? entry.path}</span>
                  {entry.unread > 0 ? <span className="nav-badge">{entry.unread}</span> : null}
                </button>
              ))}
          </nav>
        </div>
      )}

      <div className="sidebar-footer">
        {unconfigured.length === 0 ? null : (
          <div className="settings-note" style={{ marginBottom: 10 }}>
            <Icon name="alert" size={13} />
            <span style={{ marginLeft: 6 }}>未配置：{unconfigured.join(" / ")}</span>
            <button
              type="button"
              className="btn btn--sm btn--quiet"
              style={{ marginLeft: 6 }}
              onClick={() => onNavigate("onboarding")}
            >
              去配置
            </button>
          </div>
        )}
        {onboardingPending ? (
          <div className="field-hint" style={{ marginBottom: 10 }}>
            初始化未完成 · 可随时从「初始化」继续，或到设置页重开。
          </div>
        ) : null}
        <div className="profile-chip">
          <div className="avatar" style={{ background: avatarBackground }}>
            {initials(profileName)}
          </div>
          <div className="profile-chip-text">
            <div className="profile-chip-name">{profileName}</div>
            <div className="profile-chip-meta">{profileMeta}</div>
          </div>
        </div>      </div>
    </aside>
  );
}
