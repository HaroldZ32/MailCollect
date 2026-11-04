import type { ReactNode } from "react";

export type IconName =
  | "inbox"
  | "tasks"
  | "timeline"
  | "settings"
  | "search"
  | "refresh"
  | "mail"
  | "clock"
  | "calendar"
  | "user"
  | "users"
  | "spark"
  | "plus"
  | "close"
  | "chevron-left"
  | "alert"
  | "megaphone"
  | "link"
  | "check"
  | "paperclip"
  | "server"
  | "key"
  | "trash"
  | "arrow-right"
  | "bolt";

const PATHS: Record<IconName, ReactNode> = {
  inbox: (
    <>
      <path d="M4 13.5 6.2 5.8A2 2 0 0 1 8.1 4.4h7.8a2 2 0 0 1 1.9 1.4L20 13.5" />
      <path d="M4 13.5V18a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4.5" />
      <path d="M4 13.5h4.2l1.2 2.2h5.2l1.2-2.2H20" />
    </>
  ),
  tasks: (
    <>
      <rect x="4" y="4.5" width="16" height="15" rx="4" />
      <path d="m8.2 12 2.3 2.3 5.3-5.1" />
    </>
  ),
  timeline: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="3.5" />
      <path d="M7.5 9.5v5M12 8.5v7M16.5 11v3.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M5.9 5.9l1.4 1.4M16.7 16.7l1.4 1.4M18.1 5.9l-1.4 1.4M7.3 16.7l-1.4 1.4" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.2" />
      <path d="m15.6 15.6 3.4 3.4" />
    </>
  ),
  refresh: (
    <>
      <path d="M19 12a7 7 0 1 1-2.1-5" />
      <path d="M19 4.5V9h-4.5" />
    </>
  ),
  mail: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="3" />
      <path d="m4.5 7.5 7.5 5.5 7.5-5.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.8V12l2.8 1.8" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="3" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5c.9-3.2 3.6-4.8 7-4.8s6.1 1.6 7 4.8" />
    </>
  ),
  users: (
    <>
      <circle cx="9.5" cy="8.8" r="3.2" />
      <path d="M3.5 19.2c.8-2.9 3.1-4.3 6-4.3s5.2 1.4 6 4.3" />
      <path d="M15.6 5.9a3.2 3.2 0 0 1 0 5.8M17.2 15.2c1.9.5 3.1 1.9 3.6 4" />
    </>
  ),
  spark: (
    <path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 20.5 10.2 12.6 4.7 10.8 10.2 9Z" />
  ),
  plus: <path d="M12 5.5v13M5.5 12h13" />,
  close: <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />,
  "chevron-left": <path d="m14.5 6.5-5.5 5.5 5.5 5.5" />,
  alert: (
    <>
      <path d="M12 4.5 20 18.5H4Z" />
      <path d="M12 10v3.4M12 16.4v.1" />
    </>
  ),
  megaphone: (
    <>
      <path d="M4 10.5v3a2 2 0 0 0 2 2h1.5L15 19V5L7.5 8.5H6a2 2 0 0 0-2 2Z" />
      <path d="M15 8.5c1.7 1.7 1.7 5.3 0 7" />
      <path d="M18 6.5c3 3 3 8 0 11" />
    </>
  ),
  link: (
    <>
      <path d="M10 13.5a3.5 3.5 0 0 1 0-5l2-2a3.5 3.5 0 0 1 5 5l-1 1" />
      <path d="M14 10.5a3.5 3.5 0 0 1 0 5l-2 2a3.5 3.5 0 0 1-5-5l1-1" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  paperclip: <path d="M8.5 12.5 6.7 14.3a3.5 3.5 0 0 0 5 5l6.6-6.6a5 5 0 0 0-7-7L5.4 11.6" />,
  server: (
    <>
      <rect x="4" y="4.5" width="16" height="6" rx="2" />
      <rect x="4" y="13.5" width="16" height="6" rx="2" />
      <path d="M7.5 7.5h.1M7.5 16.5h.1" />
    </>
  ),
  key: (
    <>
      <circle cx="8.5" cy="15.5" r="3" />
      <path d="m10.8 13.3 6.4-6.4M15.4 6.9l2 2M17.6 8.6l1.4-1.4" />
    </>
  ),
  trash: (
    <>
      <path d="M5.5 7.5h13M9 7.5V5.8h6V7.5M7.5 7.5 8.3 19h7.4l.8-11.5" />
      <path d="M10.5 10.5v5.5M13.5 10.5v5.5" />
    </>
  ),
  "arrow-right": <path d="M5 12h13M13.5 7.5 18 12l-4.5 4.5" />,
  bolt: <path d="M13 3.5 5.5 13.5H11l-1 7L18.5 10.5H13Z" />,
};

export interface IconProps {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
  readonly strokeWidth?: number;
}

export function Icon({ name, size = 18, className, strokeWidth = 1.7 }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
