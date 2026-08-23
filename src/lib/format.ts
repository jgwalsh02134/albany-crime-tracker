import { formatDistanceToNowStrict, format } from "date-fns";
import type { Category, Severity } from "./types";

export function relativeTime(iso: string): string {
  try {
    return formatDistanceToNowStrict(new Date(iso), { addSuffix: true });
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

export function clockTime(iso: string): string {
  try {
    return format(new Date(iso), "h:mm a");
  } catch {
    return "";
  }
}

export function shortDate(iso: string): string {
  try {
    return format(new Date(iso), "MMM d");
  } catch {
    return "";
  }
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
