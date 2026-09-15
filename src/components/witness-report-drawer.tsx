import { useEffect, useMemo, useState } from "react";
import { Drawer } from "vaul";
import { CheckCircle2, LocateFixed, MapPin, Send, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { deriveGeoPrecisionFromAccuracy, witnessKindLabel } from "@/lib/witness";

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
  const [submittedOk, setSubmittedOk] = useState(false);

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

  useEffect(() => {
    if (open) return;
    setSubmittedOk(false);
    setSubmitting(false);
    setLocErr("");
    setSubmitErr("");
  }, [open]);

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
      window.dispatchEvent(new Event("act:refresh-wire"));
      setSubmittedOk(true);
    } catch {
      setSubmitErr("Couldn’t submit right now.");
    } finally {
      setSubmitting(false);
    }
  }

  function close() {
    setLocErr("");
    setSubmitErr("");
    setSubmittedOk(false);
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
                <Drawer.Title className="text-base font-semibold">{submittedOk ? "Report sent" : "Report activity"}</Drawer.Title>
                <p className="mt-1 text-xs leading-relaxed text-subtle">
                  {submittedOk
                    ? "Thanks. We’ll label this honestly until corroborated. Not 911."
                    : "Witness report — may be wrong. Not 911. If there’s an emergency, call 911."}
                </p>
              </div>
              <Button variant="ghost" size="icon" aria-label="Close report" onClick={close}>
                <X className="size-5" />
              </Button>
            </div>

            {submittedOk ? (
              <div className="mt-5 rounded-xl border border-border bg-surface-2 px-4 py-4">
                <div className="flex items-start gap-3">
                  <CheckCircle2 className="mt-0.5 size-5 text-accent" aria-hidden />
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-fg">Submitted</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted">
                      Your report is in the Live mix as a witness signal. If you weren’t sure about the exact spot, that’s okay — we’ll keep the pin honest.
                    </p>
                  </div>
                </div>
              </div>
            ) : (
              <>
                <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Category</h3>
                <div className="mt-2 flex flex-wrap gap-2" data-vaul-no-drag>
                  {(["police", "fire", "crash", "other"] as const).map((k) => (
                    <button
                      key={k}
                      type="button"
                      onClick={() => setWitnessDraft({ kind: k })}
                      className={cn(
                        "h-10 rounded-full border px-3 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
                        witnessDraft.kind === k
                          ? "border-accent bg-accent text-accent-fg"
                          : "border-border bg-surface text-fg active:bg-surface-2",
                      )}
                    >
                      {witnessKindLabel(k)}
                    </button>
                  ))}
                </div>

                <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Where</h3>
                <p className="mt-1 text-xs leading-relaxed text-muted">
                  Use device location if you’re near the scene. Otherwise drop a pin — and keep it approximate if needed.
                </p>
                <p className="mt-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">
                  {locationLabel}
                </p>
                <div className="mt-2 flex gap-2" data-vaul-no-drag>
                  <Button type="button" variant="secondary" className="flex-1" onClick={useMyLocation}>
                    <LocateFixed className="mr-2 size-4" aria-hidden />
                    Use my location
                  </Button>
                  <Button type="button" variant="secondary" className="flex-1" onClick={pickOnMap}>
                    <MapPin className="mr-2 size-4" aria-hidden />
                    Drop a pin
                  </Button>
                </div>
                {locErr ? (
                  <p className="mt-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-xs text-muted">{locErr}</p>
                ) : null}

                <h3 className="mt-5 text-xs font-semibold uppercase tracking-wide text-subtle">Details (optional)</h3>
                <textarea
                  value={witnessDraft.note}
                  onChange={(e) => setWitnessDraft({ note: e.target.value.slice(0, 240) })}
                  rows={3}
                  placeholder="Short: what you saw, direction, smoke/blocked lanes, etc."
                  className="mt-2 w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-sm text-fg placeholder:text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                />
                <p className="mt-1 text-[11px] text-subtle">{witnessDraft.note.length}/240</p>

                {submitErr ? (
                  <p className="mt-3 rounded-lg border border-sev-high/30 bg-sev-high/10 px-3 py-2 text-xs leading-relaxed text-muted">
                    {submitErr}
                  </p>
                ) : null}
              </>
            )}
          </div>

          <div className="px-4 pt-2" data-vaul-no-drag>
            {submittedOk ? (
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1 min-h-12"
                  onClick={() => {
                    setSubmittedOk(false);
                    setOpen(false);
                  }}
                >
                  Done
                </Button>
                <Button
                  type="button"
                  className="flex-1 min-h-12"
                  onClick={() => {
                    setSubmittedOk(false);
                    setOpen(false);
                    setView("feed");
                  }}
                >
                  Back to Live
                </Button>
              </div>
            ) : (
              <Button type="button" className="w-full min-h-12" onClick={submit} disabled={!canSubmit}>
                <Send className="mr-2 size-4" aria-hidden />
                {submitting ? "Submitting…" : "Send report"}
              </Button>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

