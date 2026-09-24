import { randomUUID } from "node:crypto";
import webpush from "web-push";
import { getSql } from "@/lib/db";
import type { Incident } from "@/lib/types";
import { incidentInRadiusMiles, pushHonestyLabel, severityFloorMeets, type SeverityFloor } from "@/lib/push-filters";
import { stripHtml } from "@/lib/security/sanitize";

export type PushStatus = {
  enabled: boolean;
  publicKey?: string;
  reason?: string;
};

type StoredPushSubscription = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  radiusMiles: 1 | 2 | 3;
  severityFloor: SeverityFloor;
  lat: number | null;
  lng: number | null;
  accuracyM: number | null;
  geoPrecision:
    | "street"
    | "intersection"
    | "landmark"
    | "road"
    | "town"
    | "county"
    | "unknown"
    | null;
};

function vapidConfig(): { subject: string; publicKey: string; privateKey: string } | null {
  const publicKey = (process.env.VAPID_PUBLIC_KEY || "").trim();
  const privateKey = (process.env.VAPID_PRIVATE_KEY || "").trim();
  const subject = (process.env.VAPID_SUBJECT || "").trim();
  if (!publicKey || !privateKey || !subject) return null;
  return { subject, publicKey, privateKey };
}

export function getPushStatus(): PushStatus {
  const cfg = vapidConfig();
  if (!cfg) {
    return {
      enabled: false,
      reason: "Push not configured. Set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_SUBJECT on the server.",
    };
  }
  return { enabled: true, publicKey: cfg.publicKey };
}

let webpushReady = false;
function ensureWebPushReady(): boolean {
  const cfg = vapidConfig();
  if (!cfg) return false;
  if (!webpushReady) {
    webpush.setVapidDetails(cfg.subject, cfg.publicKey, cfg.privateKey);
    webpushReady = true;
  }
  return true;
}

export async function upsertPushSubscription(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  radiusMiles: 1 | 2 | 3;
  severityFloor: SeverityFloor;
  lat?: number | null;
  lng?: number | null;
  accuracyM?: number | null;
  geoPrecision?: StoredPushSubscription["geoPrecision"];
  userAgent?: string | null;
}): Promise<{ id: string }> {
  const sql = await getSql();
  const id = randomUUID();
  const ua = stripHtml(input.userAgent ?? "", 220);
  await sql.query(
    `
      insert into push_subscriptions (
        id, endpoint, p256dh, auth,
        radius_miles, severity_floor,
        lat, lng, accuracy_m, geo_precision,
        user_agent, disabled, disabled_reason, updated_at
      )
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, null, now())
      on conflict (endpoint) do update set
        updated_at = now(),
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        radius_miles = excluded.radius_miles,
        severity_floor = excluded.severity_floor,
        lat = excluded.lat,
        lng = excluded.lng,
        accuracy_m = excluded.accuracy_m,
        geo_precision = excluded.geo_precision,
        user_agent = excluded.user_agent,
        disabled = false,
        disabled_reason = null
    `,
    [
      id,
      input.endpoint,
      input.p256dh,
      input.auth,
      input.radiusMiles,
      input.severityFloor,
      input.lat ?? null,
      input.lng ?? null,
      input.accuracyM ?? null,
      input.geoPrecision ?? null,
      ua || null,
    ],
  );
  const rows = await sql.query<{ id: string }>(
    `select id from push_subscriptions where endpoint = $1 limit 1`,
    [input.endpoint],
  );
  return { id: rows[0]?.id ? String(rows[0].id) : id };
}

export async function disablePushSubscriptionByEndpoint(
  endpoint: string,
  reason = "user-unsubscribed",
): Promise<void> {
  const sql = await getSql();
  await sql.query(
    `
      update push_subscriptions
      set disabled = true, disabled_reason = $2, updated_at = now()
      where endpoint = $1
    `,
    [endpoint, stripHtml(reason, 120)],
  );
}

async function listActivePushSubscriptions(): Promise<StoredPushSubscription[]> {
  const sql = await getSql();
  const rows = await sql.query<{
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    radius_miles: number;
    severity_floor: SeverityFloor;
    lat: number | null;
    lng: number | null;
    accuracy_m: number | null;
    geo_precision: StoredPushSubscription["geoPrecision"];
  }>(
    `
      select id, endpoint, p256dh, auth, radius_miles, severity_floor, lat, lng, accuracy_m, geo_precision
      from push_subscriptions
      where disabled = false
      order by updated_at desc
      limit 5000
    `,
  );
  return rows.map((r) => ({
    id: String(r.id),
    endpoint: String(r.endpoint),
    p256dh: String(r.p256dh),
    auth: String(r.auth),
    radiusMiles: (Number(r.radius_miles) || 1) as 1 | 2 | 3,
    severityFloor: r.severity_floor,
    lat: typeof r.lat === "number" && Number.isFinite(r.lat) ? r.lat : null,
    lng: typeof r.lng === "number" && Number.isFinite(r.lng) ? r.lng : null,
    accuracyM: typeof r.accuracy_m === "number" && Number.isFinite(r.accuracy_m) ? r.accuracy_m : null,
    geoPrecision: r.geo_precision ?? null,
  }));
}

async function alreadyDelivered(subscriptionId: string, incidentId: string): Promise<boolean> {
  const sql = await getSql();
  const rows = await sql.query<{ id: string }>(
    `select id from push_deliveries where subscription_id = $1 and incident_id = $2 limit 1`,
    [subscriptionId, incidentId],
  );
  return rows.length > 0;
}

async function recordDelivery(input: {
  subscriptionId: string;
  incidentId: string;
  status: "sent" | "failed";
  error?: string;
}): Promise<void> {
  const sql = await getSql();
  await sql.query(
    `
      insert into push_deliveries (id, subscription_id, incident_id, status, error)
      values ($1, $2, $3, $4, $5)
      on conflict (subscription_id, incident_id) do nothing
    `,
    [randomUUID(), input.subscriptionId, input.incidentId, input.status, input.error ? stripHtml(input.error, 240) : null],
  );
}

function deepLinkForIncident(origin: string, id: string): string {
  const base = origin?.startsWith("http") ? origin : "https://app.albany.watch";
  return `${base.replace(/\/$/, "")}/i/${encodeURIComponent(id)}`;
}

function buildPayload(origin: string, inc: Incident): string {
  const honesty = pushHonestyLabel(inc);
  const url = deepLinkForIncident(origin, inc.id);
  const title = `${honesty}: ${inc.title}`.slice(0, 110);
  const where = inc.address && inc.municipality ? `${inc.address}, ${inc.municipality}` : inc.municipality || inc.address || "";
  const body = [where, `Severity: ${inc.severity}`].filter(Boolean).join(" · ").slice(0, 220);
  return JSON.stringify({ title, body, url, tag: `inc:${inc.id}` });
}

async function sendToSubscription(origin: string, sub: StoredPushSubscription, inc: Incident): Promise<void> {
  if (!ensureWebPushReady()) return;
  const payload = buildPayload(origin, inc);
  await webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    payload,
    { TTL: 60 * 60 },
  );
}

const pushGlobal = globalThis as typeof globalThis & {
  __pushSweepLastMs__?: number;
  __pushSweepInFlight__?: Promise<void>;
};

export async function maybeRunPushSweepFromIncidents(opts: {
  incidents: Incident[];
  origin: string;
}): Promise<void> {
  const status = getPushStatus();
  if (!status.enabled) return;

  const now = Date.now();
  const last = pushGlobal.__pushSweepLastMs__ ?? 0;
  const minMs = 45_000;
  if (now - last < minMs) return;
  if (pushGlobal.__pushSweepInFlight__) return;

  const run = (async () => {
    pushGlobal.__pushSweepLastMs__ = now;
    const fresh = opts.incidents.filter((i) => i.minutesAgo <= 12);
    if (!fresh.length) return;

    const subs = await listActivePushSubscriptions();
    if (!subs.length) return;

    for (const inc of fresh) {
      for (const sub of subs) {
        if (!severityFloorMeets(inc.severity, sub.severityFloor)) continue;
        const user = sub.lat != null && sub.lng != null ? { lat: sub.lat, lng: sub.lng } : null;
        if (!incidentInRadiusMiles(inc, user, sub.radiusMiles)) continue;
        if (await alreadyDelivered(sub.id, inc.id)) continue;
        try {
          await sendToSubscription(opts.origin, sub, inc);
          await recordDelivery({ subscriptionId: sub.id, incidentId: inc.id, status: "sent" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : "push-send-failed";
          await recordDelivery({ subscriptionId: sub.id, incidentId: inc.id, status: "failed", error: msg });
          // If the push service reports the endpoint is gone, disable it.
          const statusCode = (err as { statusCode?: number } | null)?.statusCode;
          if (statusCode === 404 || statusCode === 410) {
            await disablePushSubscriptionByEndpoint(sub.endpoint, "gone");
          }
        }
      }
    }
  })().finally(() => {
    pushGlobal.__pushSweepInFlight__ = undefined;
  });

  pushGlobal.__pushSweepInFlight__ = run;
  return run;
}

export async function sendTestPush(opts: {
  endpoint: string;
  origin: string;
  title: string;
  body: string;
  url: string;
}): Promise<void> {
  if (!ensureWebPushReady()) throw new Error("push-not-configured");
  const sql = await getSql();
  const rows = await sql.query<{
    id: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    disabled: boolean;
  }>(
    `select id, endpoint, p256dh, auth, disabled from push_subscriptions where endpoint = $1 limit 1`,
    [opts.endpoint],
  );
  const row = rows[0];
  if (!row || row.disabled) throw new Error("subscription-not-found");
  const payload = JSON.stringify({
    title: stripHtml(opts.title, 120),
    body: stripHtml(opts.body, 240),
    url: opts.url || opts.origin,
    tag: "test",
  });
  await webpush.sendNotification(
    { endpoint: String(row.endpoint), keys: { p256dh: String(row.p256dh), auth: String(row.auth) } },
    payload,
    { TTL: 60 * 15 },
  );
}

