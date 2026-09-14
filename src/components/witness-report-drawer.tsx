import { useMemo, useState } from "react";
import { Drawer } from "vaul";
import { LocateFixed, MapPin, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import type { WitnessKind } from "@/lib/types";
import { deriveGeoPrecisionFromAccuracy, witnessKindLabel } from "@/lib/witness";

function kindTone(kind: WitnessKind): "secondary" | "default" {
  return kind === "police" ? "default" : "secondary";
}

export function WitnessReportDrawer() {
  const open = useAppStore((s) => s.witnessOpen);
  const setOpen = useAppStore((s) => s.setWitnessOpen);
  const setView = useAppStore((s) => s.setView);
  const witnessDraft = useAppStore((s) => s.witnessDraft);
  const setWitnessDraft = useAppStore((s) => s.setWitnessDraft);
  const resetDraft = useAppStore((s) => s.resetWitnessDraft);
  const setPicking = useAppStore((s) => s.setWitnessPickingOnMap);

  const [locErr, setLocErr] = useState<string>("");
  const [submitErr, setSubmitErr] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = witnessDraft.lat != null && witnessDraft.lng != null && !submitting;

  const locationLabel = useMemo(() => {
    if (witnessDraft.lat == null || witnessDraft.lng == null) return "No location selected yet.";
    const lat = witnessDraft.lat.toFixed(5);
    const lng = witnessDraft.lng.toFixed(5);
    const how = witnessDraft.locationSource === "device" ? "device location" : witnessDraft.locationSource === "map" ? "map pin" : "location";
    const prec =
      witnessDraft.accuracyM != null
        ? `±${Math.round(witnessDraft.accuracyM)}m`
        : witnessDraft.geoPrecision
          ? witnessDraft.geoPrecision
          : "unknown";
    return `${how}: ${lat}, ${lng} · ${prec}`;
  }, [witnessDraft.accuracyM, witnessDraft.geoPrecision, witnessDraft.lat, witnessDraft.lng, witnessDraft.locationSource]);

  async function useMyLocation() {
    setLocErr("");
    setSubmitErr("");
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setLocErr("Location isn’t available in this browser.");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => {
        const acc = typeof p.coords.accuracy === "number" ? p.coords.accuracy : null;
        setWitnessDraft({
          lat: p.coords.latitude,
          lng: p.coords.longitude,
          accuracyM: acc,
          geoPrecision: deriveGeoPrecisionFromAccuracy(acc),
          locationSource: "device",
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) setLocErr("Location permission denied.");
        else setLocErr("Couldn’t fetch your location.");
      },
      { enableHighAccuracy: false, timeout: 9000, maximumAge: 60_000 },
    );
  }

  function pickOnMap() {
    setLocErr("");
    setSubmitErr("");
    setOpen(false);
    setPicking(true);
    setView("map");
  }

  async function submit() {
    if (!canSubmit) return;
    setSubmitting(true);
    setSubmitErr("");
    try {
      const res = await fetch("/api/witness", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          kind: witnessDraft.kind,
          note: witnessDraft.note || undefined,
          lat: witnessDraft.lat,
          lng: witnessDraft.lng,
          accuracyM: witnessDraft.accuracyM ?? undefined,
          geoPrecision: witnessDraft.geoPrecision ?? undefined,
        }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) {
        setSubmitErr(json?.error || "Couldn’t submit right now.");
        return;
      }
      resetDraft();
      setOpen(false);
      window.dispatchEvent(new Event("act:refresh-wire"));
      setView("feed");
    } catch {
      setSubmitErr("Couldn’t submit right now.");
    } finally {
      setSubmitting(false);
    }
  }

  function close() {
    setLocErr("");
    setSubmitErr("");
    setOpen(false);
  }

  return (
    <Drawer.Root open={open} onOpenChange={setOpen}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-bg/70" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[88dvh] w-full max-w-lg flex-col rounded-t-xl border border-border bg-surface pb-[max(1rem,env(safe-area-inset-bottom))] outline-none">
          <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-border" />
          <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-3 scrollbar-thin">
            <div className="flex items-start justify-between gap-2">
              <div>
                <Drawer.Title className="text-base font-semibold">Report activity</Drawer.Title>
                <p className="mt-1 text-xs leading-relaxed text-subtle">
                  Witness report — may be wrong. Not 911. If there’s an emergency, call 911.
                </p>
              </div>
              <Button variant="ghost" size="icon" aria-label="Close report" onClick={close}>
                <X className="size-5" />
              </Button>
            </div>

            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Kind</h3>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {(["police", "fire", "crash", "other"] as const).map((k) => (
                <Button
                  key={k}
                  type="button"
                  variant={witnessDraft.kind === k ? "default" : kindTone(k)}
                  className={cn("min-h-11 justify-center", witnessDraft.kind === k ? "" : "border border-border")}
                  onClick={() => setWitnessDraft({ kind: k })}
                >
                  {witnessKindLabel(k)}
                </Button>
              ))}
            </div>

            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Note (optional)</h3>
            <textarea
              value={witnessDraft.note}
              onChange={(e) => setWitnessDraft({ note: e.target.value.slice(0, 240) })}
              rows={3}
              placeholder="Short: what you see, what direction, any smoke/blocked lanes, etc."
              className="mt-2 w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
            />
            <p className="mt-1 text-[11px] text-subtle">{witnessDraft.note.length}/240</p>

            <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Location</h3>
            <p className="mt-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
              {locationLabel}
            </p>
            <div className="mt-2 flex gap-2">
              <Button type="button" variant="secondary" className="flex-1" onClick={useMyLocation}>
                <LocateFixed className="mr-2 size-4" aria-hidden />
                Use my location
              </Button>
              <Button type="button" variant="secondary" className="flex-1" onClick={pickOnMap}>
                <MapPin className="mr-2 size-4" aria-hidden />
                Tap map pin
              </Button>
            </div>
            {locErr ? (
              <p className="mt-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">{locErr}</p>
            ) : null}

            {submitErr ? (
              <p className="mt-3 rounded-lg border border-sev-high/30 bg-sev-high/10 px-3 py-2 text-xs leading-relaxed text-muted">
                {submitErr}
              </p>
            ) : null}
          </div>

          <div className="px-4 pt-2" data-vaul-no-drag>
            <Button type="button" className="w-full min-h-12" onClick={submit} disabled={!canSubmit}>
              <Send className="mr-2 size-4" aria-hidden />
              {submitting ? "Submitting…" : "Submit witness report"}
            </Button>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

