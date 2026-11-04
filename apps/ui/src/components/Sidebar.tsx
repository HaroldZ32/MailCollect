import clsx from "clsx";
import { Icon } from "./Icon";
import type { IconName } from "./Icon";
import type { ConnectionMode } from "../lib/useMailData";
import { initials, hueFor } from "../lib/format";

export type PageId = "inbox" | "tasks" | "timeline" | "settings";

interface NavEntry {
  readonly id: PageId;
  readonly label: string;
  readonly icon: IconName;
}

const NAV: readonly NavEntry[] = [
  { id: "inbox", label: "收件箱", icon: "inbox" },
  { id: "tasks", label: "待办", icon: "tasks" },
  { id: "timeline", label: "时间线", icon: "timeline" },
  { id: "settings", label: "设置", icon: "settings" },
];

const MODE_LABEL: Record<ConnectionMode, string> = {
  loading: "连接中",
  live: "已连接服务",
  demo: "演示数据",
  offline: "未连接",
};

const MODE_DOT: Record<ConnectionMode, string> = {
  loading: "",
  live: "",
  demo: "is-demo",
  offline: "is-offline",
};

export interface SidebarProps {
  readonly page: PageId;
  readonly candidateCount: number;
  readonly profileName: string;
  readonly profileMeta: string;
  readonly mode: ConnectionMode;
  readonly onNavigate: (page: PageId) => void;
}

export function Sidebar({ page, candidateCount, profileName, profileMeta, mode, onNavigate }: SidebarProps) {
  const hue = hueFor(profileName);
  const avatarBackground = `linear-gradient(140deg, hsl(${hue + 6} 92% 70%), hsl(${hue} 80% 54%))`;

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
              onClick={() => onNavigate(entry.id)}
            >
              <span className="nav-icon">
                <Icon name={entry.icon} size={18} />
              </span>
              <span className="nav-label">{entry.label}</span>
              {entry.id === "tasks" && candidateCount > 0 ? (
                <span className="nav-badge">{candidateCount}</span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="profile-chip">
          <div className="avatar" style={{ background: avatarBackground }}>
            {initials(profileName)}
          </div>
          <div className="profile-chip-text">
            <div className="profile-chip-name">{profileName}</div>
            <div className="profile-chip-meta">{profileMeta}</div>
          </div>
        </div>
        <div className="conn">
          <span className={clsx("conn-dot", MODE_DOT[mode])} />
          <span>{MODE_LABEL[mode]}</span>
        </div>
      </div>
    </aside>
  );
}
