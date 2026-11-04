import type { RawEmail } from "@mailcollect/shared";

const MS_PER_DAY = 86_400_000;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
const CJK = /[\u3400-\u9fff]/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function startOfDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function dayOffset(iso: string, now: Date): number {
  const target = startOfDay(new Date(iso)).getTime();
  return Math.round((startOfDay(now).getTime() - target) / MS_PER_DAY);
}

function monthDay(date: Date): string {
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function formatClock(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDateTime(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const sameYear = date.getFullYear() === now.getFullYear();
  const dayPart = sameYear ? monthDay(date) : `${date.getFullYear()}年${monthDay(date)}`;
  return `${dayPart} ${formatClock(iso)}`;
}

export function formatMailTime(iso: string, now: Date = new Date()): string {
  const offset = dayOffset(iso, now);
  if (offset === 0) return formatClock(iso);
  if (offset === 1) return "昨天";
  const date = new Date(iso);
  if (offset > 1 && offset < 7) return WEEKDAYS[date.getDay()] ?? "";
  if (date.getFullYear() === now.getFullYear()) return monthDay(date);
  return `${date.getFullYear()}年${monthDay(date)}`;
}

export function formatFullDate(iso: string): string {
  const date = new Date(iso);
  return `${date.getFullYear()}年${monthDay(date)} ${WEEKDAYS[date.getDay()] ?? ""} ${formatClock(iso)}`;
}

export function formatGanttDate(date: Date): string {
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatWindow(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const sameDay =
    start.getFullYear() === end.getFullYear() &&
    start.getMonth() === end.getMonth() &&
    start.getDate() === end.getDate();
  if (sameDay) return `${monthDay(start)} ${formatClock(startIso)}–${formatClock(endIso)}`;
  return `${monthDay(start)} ${formatClock(startIso)} → ${monthDay(end)} ${formatClock(endIso)}`;
}

export function formatDue(iso: string): string {
  return `到期 ${formatDateTime(iso)}`;
}

export function snippet(text: string, maxLength = 120): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength)}…`;
}

export function initials(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "") return "?";
  if (CJK.test(trimmed)) return trimmed.slice(0, 1);
  const words = trimmed.split(/\s+/).filter((word) => word !== "");
  const first = words[0] ?? trimmed;
  const second = words[1];
  if (second === undefined) return first.slice(0, 2).toUpperCase();
  return `${first.slice(0, 1)}${second.slice(0, 1)}`.toUpperCase();
}

export function hueFor(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 997;
  }
  return 196 + (hash % 34);
}

export function headerValue(headers: Readonly<Record<string, string>>, name: string): string | null {
  const needle = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === needle) return value;
  }
  return null;
}

export function listIdOf(email: RawEmail): string | null {
  const raw = headerValue(email.headers, "list-id");
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  return trimmed.replace(/^</, "").replace(/>$/, "");
}

export function senderLabel(name: string | null, email: string): string {
  if (name === null || name.trim() === "") return email;
  return name;
}

export function displayNameOf(task: { ownerName: string | null }): string {
  return task.ownerName ?? "未指定";
}

export function pluralCount(count: number, unit: string): string {
  return `${count} ${unit}`;
}
