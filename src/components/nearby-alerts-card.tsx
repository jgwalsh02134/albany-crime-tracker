import { useEffect, useMemo, useState } from "react";
import { Bell, BellOff, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  fetchPushStatus,
  getCurrentPushSubscription,
  getLocationOnce,
  getOrCreatePushSubscription,
  pushSupported,
  type PushStatusResponse,
} from "@/lib/push-client";

type SeverityFloor = "high" | "critical";

export function NearbyAlertsCard({ variant = "card" }: { variant?: "card" | "inline" }) {
  const [status, setStatus] = useState<PushStatusResponse | null>(null);
  const [sub, setSub] = useState<PushSubscription | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [radius, setRadius] = useState<1 | 2 | 3>(2);
  const [floor, setFloor] = useState<SeverityFloor>("high");

  const supported = pushSupported();
  const enabled = status?.ok === true && status.enabled === true;
  const publicKey = status?.ok === true && status.enabled === true ? status.publicKey : "";

  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await fetchPushStatus();
      if (!alive) return;
      setStatus(s);
      if (!supported) return;
      const existing = await getCurrentPushSubscription().catch(() => null);
      if (!alive) return;
      setSub(existing);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wrapCls = useMemo(() => {
    if (variant === "inline") return "rounded-lg border border-border bg-surface px-3 py-3";
    return "rounded-xl border border-border bg-surface px-3 py-3";
  }, [variant]);

  async function enableAlerts() {
    setBusy(true);
    setErr("");
    try {
      if (!supported) throw new Error("Push isn’t supported in this browser.");
      if (!enabled || !publicKey) throw new Error("Alerts are unavailable on this deployment.");

      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Notification permission was not granted.");

      const subscription = await getOrCreatePushSubscription(publicKey);
      const loc = await getLocationOnce();
      const r = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
          radiusMiles: radius,
          severityFloor: floor,
          lat: loc?.lat ?? null,
          lng: loc?.lng ?? null,
          accuracyM: loc?.accuracyM ?? null,
        }),
      });
      const json = (await r.json().catch(() => null)) as any;
      if (!r.ok || !json?.ok) {
        const reason = json?.reason || json?.error || `HTTP ${r.status}`;
        throw new Error(String(reason));
      }
      setSub(subscription);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Enable failed");
    } finally {
      setBusy(false);
    }
  }

  async function disableAlerts() {
    setBusy(true);
    setErr("");
    try {
      const existing = sub ?? (await getCurrentPushSubscription().catch(() => null));
      if (!existing) {
        setSub(null);
        return;
      }
      await fetch("/api/push/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ endpoint: existing.endpoint }),
      }).catch(() => null);
      await existing.unsubscribe().catch(() => {});
      setSub(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Disable failed");
    } finally {
      setBusy(false);
    }
  }

  const unavailableCopy = !supported
    ? "Your browser doesn’t support web push."
    : status?.ok === false
      ? status.reason ||
        (status.error === "network"
          ? "Alerts status couldn’t be checked right now (network)."
          : status.error === "invalid-json"
            ? "Alerts status couldn’t be checked right now (invalid response)."
            : "Alerts status couldn’t be checked right now.")
      : status?.ok === true && status.enabled === false
        ? status.reason || "Alerts are unavailable on this deployment."
        : "";

  return (
    <div className={wrapCls}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-fg">Alert me nearby</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted">
            Early signals when serious activity pops up near you. Unconfirmed alerts are labeled honestly.
          </p>
        </div>
        <div className="shrink-0 pt-0.5">
          {sub ? <Bell className="size-5 text-accent" aria-hidden /> : <BellOff className="size-5 text-subtle" aria-hidden />}
        </div>
      </div>

      {unavailableCopy ? (
        <p className="mt-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">{unavailableCopy}</p>
      ) : null}

      {!sub ? (
        <div className="mt-3">
          <div className="mt-1" aria-label="Alert radius">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Radius</p>
            <div
              role="radiogroup"
              className={cn(
                "mt-2 grid grid-cols-3 overflow-hidden rounded-lg border border-border bg-surface",
                busy ? "opacity-70" : "",
              )}
            >
              {([1, 2, 3] as const).map((m) => (
                <button
                  key={m}
                  role="radio"
                  aria-checked={radius === m}
                  type="button"
                  onClick={() => setRadius(m)}
                  disabled={busy}
                  className={cn(
                    "min-h-11 px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                    m !== 1 ? "border-l border-border" : "",
                    radius === m ? "bg-accent text-accent-fg" : "bg-surface text-fg active:bg-surface-2",
                  )}
                >
                  <MapPin className="mr-1 inline size-3.5" aria-hidden />
                  {m} mi
                </button>
              ))}
            </div>
          </div>

          <div className="mt-3" aria-label="Severity floor">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-subtle">Severity</p>
            <div
              role="radiogroup"
              className={cn(
                "mt-2 grid grid-cols-2 overflow-hidden rounded-lg border border-border bg-surface",
                busy ? "opacity-70" : "",
              )}
            >
              {([
                ["high", "High+"],
                ["critical", "Critical only"],
              ] as const).map(([id, label], idx) => (
                <button
                  key={id}
                  role="radio"
                  aria-checked={floor === id}
                  type="button"
                  onClick={() => setFloor(id)}
                  disabled={busy}
                  className={cn(
                    "min-h-11 px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                    idx === 1 ? "border-l border-border" : "",
                    floor === id ? "bg-accent text-accent-fg" : "bg-surface text-fg active:bg-surface-2",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-subtle">
            We’ll try to use your location. If you deny location, you may receive county-wide serious alerts.
          </p>

          <button
            type="button"
            onClick={() => void enableAlerts()}
            disabled={busy || !enabled || !supported}
            className={cn(
              "mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-accent/35 bg-accent/10 px-4 text-sm font-semibold text-fg active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
              busy ? "opacity-70" : "",
              !enabled || !supported ? "opacity-60" : "",
            )}
          >
            {busy ? "Enabling…" : "Enable alerts"}
          </button>
        </div>
      ) : (
        <div className="mt-3">
          <p className="text-xs text-muted">
            Alerts enabled on this device. We’ll notify on new serious incidents that match your radius and severity floor.
          </p>
          <button
            type="button"
            onClick={() => void disableAlerts()}
            disabled={busy}
            className={cn(
              "mt-2 inline-flex min-h-11 w-full items-center justify-center rounded-lg border border-border bg-surface px-4 text-sm font-semibold text-fg active:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
              busy ? "opacity-70" : "",
            )}
          >
            {busy ? "Disabling…" : "Disable alerts"}
          </button>
        </div>
      )}

      {err ? <p className="mt-2 text-xs text-sev-high">{err}</p> : null}
    </div>
  );
}

