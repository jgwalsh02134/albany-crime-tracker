import type { Category, Severity } from "./types";

export function relativeTime(iso: string): string {
  try {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  } catch {
    return "";
  }
}

export function compactFromMinutes(mins: number): string {
  const m = Math.max(0, Math.round(mins));
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const hours = Math.round(m / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export function compactAgo(iso: string, now = Date.now()): string {
  try {
    const mins = (now - new Date(iso).getTime()) / 60_000;
    return compactFromMinutes(mins);
  } catch {
    return "";
  }
}

const NY_CLOCK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "2-digit",
});

const NY_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
});

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

export function clockTime(iso: string): string {
  try {
    return NY_CLOCK.format(new Date(iso));
  } catch {
    return "";
  }
}

export function shortDate(iso: string): string {
  try {
    return NY_DAY.format(new Date(iso));
  } catch {
    return "";
  }
}

export function minutesSinceNy7am(now = Date.now()): number {
  const parts = Object.fromEntries(NY_PARTS.formatToParts(new Date(now)).map((p) => [p.type, p.value]));
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (hour < 7) return (hour + 24 - 7) * 60 + minute;
  return (hour - 7) * 60 + minute;
}

export function typeLabel(type: string): string {
  return type.replace(/-/g, " ");
}

export function severityLabel(s: Severity): string {
  return s[0]!.toUpperCase() + s.slice(1);
}

export function categoryLabel(c: Category): string {
  return c[0]!.toUpperCase() + c.slice(1);
}
