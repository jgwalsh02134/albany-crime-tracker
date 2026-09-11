import { clockTime } from "./format";
import type { Incident, NewsStory } from "./types";

export const APP_ORIGIN =
  typeof window !== "undefined" && window.location?.origin
    ? window.location.origin
    : "https://app.albany.watch";

export const APP_SHARE_NAME = "Albany County Crime Tracker";

export function incidentDeepLink(id: string, origin = APP_ORIGIN): string {
  return `${origin.replace(/\/$/, "")}/i/${encodeURIComponent(id)}`;
}

export function sourceCaveat(incident: Incident): string {
  if (incident.sources.some((s) => s.kind === "social" || /Citizen/i.test(s.name))) {
    return "Unconfirmed citizen/social tip — not a 911 or CAD call.";
  }
  if (incident.verification === "scanner") {
    return "Unconfirmed scanner traffic — not an official CAD incident.";
  }
  if (incident.verification === "developing") {
    return "Developing / newsroom report — not a confirmed blotter call.";
  }
  if (incident.sources.some((s) => s.tier === "official" || s.kind === "blotter")) {
    return "From official blotter or agency sources.";
  }
  return "Source unverified — treat as developing.";
}

export type SharePayload = {
  title: string;
  text: string;
  url: string;
};

export function incidentSharePayload(incident: Incident, origin = APP_ORIGIN): SharePayload {
  const place = incident.address.toLowerCase().includes(incident.municipality.toLowerCase())
    ? incident.address
    : `${incident.address}, ${incident.municipality}`;
  const when = clockTime(incident.occurredAt);
  const caveat = sourceCaveat(incident);
  const url = incidentDeepLink(incident.id, origin);
  const text = [
    incident.title,
    `${place} · ${when}`,
    caveat,
    url,
  ].join("\n");
  return {
    title: `${incident.title} · ${APP_SHARE_NAME}`,
    text,
    url,
  };
}

export function newsSharePayload(story: NewsStory, origin = APP_ORIGIN): SharePayload {
  const url = story.url?.startsWith("http") ? story.url : incidentDeepLink(story.id, origin);
  const text = [
    story.title,
    [story.municipality, story.outlet].filter(Boolean).join(" · "),
    "Newsroom coverage — open the source for the full story.",
    url,
  ].join("\n");
  return {
    title: `${story.title} · ${APP_SHARE_NAME}`,
    text,
    url,
  };
}

export function mapSharePayload(count: number, hours: number, origin = APP_ORIGIN): SharePayload {
  const url = origin.replace(/\/$/, "") || "https://app.albany.watch";
  const text = `${count} Capital District incidents in the last ${hours}h\n${url}`;
  return { title: APP_SHARE_NAME, text, url };
}

export function xIntentUrl(payload: SharePayload): string {
  const u = new URL("https://twitter.com/intent/tweet");
  u.searchParams.set("text", payload.text.slice(0, 240));
  u.searchParams.set("url", payload.url);
  return u.toString();
}

export function facebookIntentUrl(payload: SharePayload): string {
  const u = new URL("https://www.facebook.com/sharer/sharer.php");
  u.searchParams.set("u", payload.url);
  u.searchParams.set("quote", payload.text.slice(0, 280));
  return u.toString();
}

export function smsIntentUrl(payload: SharePayload): string {
  const body = encodeURIComponent(`${payload.title}\n${payload.text}`);
  // iOS uses &body=, Android often uses ?body=
  return `sms:?&body=${body}`;
}

export type ShareResult = "shared" | "copied" | "cancelled" | "opened";

export async function sharePayload(payload: SharePayload): Promise<ShareResult> {
  try {
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      await navigator.share({
        title: payload.title,
        text: payload.text,
        url: payload.url,
      });
      return "shared";
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return "cancelled";
    /* fall through to clipboard */
  }
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(payload.text);
      return "copied";
    }
  } catch {
    /* ignore */
  }
  return "cancelled";
}

export async function copyShareLink(payload: SharePayload): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(payload.url);
    return true;
  } catch {
    try {
      await navigator.clipboard.writeText(payload.text);
      return true;
    } catch {
      return false;
    }
  }
}
