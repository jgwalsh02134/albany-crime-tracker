import type { Incident } from "./types";
import type { WireHealth } from "./sources";

export type LiveWindowHonesty = {
  /** Short status for the Last 3 hours empty state. */
  last3hCopy: string;
  /** Empty filter / empty feed copy. */
  emptyFilterCopy: string;
  tone: "quiet" | "blotter-only" | "pipes-dry" | "pipes-failing" | "radio-elsewhere";
};

function hasScanner(inc: Incident): boolean {
  return (
    inc.sources.some((s) => s.kind === "scanner") ||
    Boolean(inc.seenOn?.some((c) => c.key === "scanner")) ||
    inc.verification === "scanner"
  );
}

/**
 * Never imply the county is quiet when daytime pipes are dry/failing
 * or when radio captions exist outside the current lens/window.
 */
export function liveWindowHonesty(opts: {
  health: WireHealth | null | undefined;
  nowItems: Incident[];
  liveItems: Incident[];
  sourceLens?: string;
}): LiveWindowHonesty {
  const { health, nowItems, liveItems, sourceLens = "all" } = opts;
  const traffic = health?.traffic ?? 0;
  const civic = health?.civic ?? 0;
  const nws = health?.nws ?? 0;
  const scannerWire = health?.scanner ?? 0;
  const scannerHeardJunk = /thank(?:s|\s+you)?\s+for\s+watching|subscribe|\[music\]/i.test(
    health?.scannerHeard || "",
  );
  const dry = health?.daytimePipesDry ?? (traffic === 0 && civic === 0 && nws === 0);
  const failing = Boolean(health?.daytimePipesFailing);
  const radioInWindow = nowItems.some(hasScanner);
  const radioInDay = liveItems.some(hasScanner) || scannerWire > 0;

  if (failing) {
    return {
      tone: "pipes-failing",
      last3hCopy:
        "Live pipes are erroring — not proof the county is quiet. Check 511, civic, and NWS in source health.",
      emptyFilterCopy:
        "Source pipes reported failures this refresh. Try All sources or pull to refresh.",
    };
  }

  if (dry && scannerWire === 0 && (health?.news ?? 0) === 0) {
    return {
      tone: "pipes-dry",
      last3hCopy:
        "Daytime pipes are empty this refresh (511 / civic / NWS / radio). That is a feed gap — not a quiet county.",
      emptyFilterCopy:
        "No open-pipe items in this filter. Blotter is the 7 AM dump; daytime sources returned nothing.",
    };
  }

  if (sourceLens === "scanner" && !radioInDay) {
    return {
      tone: "radio-elsewhere",
      last3hCopy: scannerHeardJunk
        ? "No usable radio captions in window — STT junk was rejected."
        : scannerWire === 0
          ? "No radio incidents on the wire right now. Captions still run when dispatch talks."
          : "Radio is on the wire but not in this window.",
      emptyFilterCopy:
        "No radio items match this filter. Switch to All to see blotter and news.",
    };
  }

  if (!nowItems.length && radioInDay && !radioInWindow) {
    return {
      tone: "radio-elsewhere",
      last3hCopy: `No calls in the last 3 hours in this view — ${scannerWire || liveItems.filter(hasScanner).length} radio item(s) are older or in another filter.`,
      emptyFilterCopy: "Nothing in this filter for the current window.",
    };
  }

  if (!nowItems.length && (health?.blotter ?? 0) > 0 && scannerWire === 0) {
    return {
      tone: "blotter-only",
      last3hCopy:
        "No official blotter updates since the 7 AM dump — and no radio / 511 / news in the last 3 hours.",
      emptyFilterCopy:
        "Nothing in this filter. Official blotter is overnight; daytime radio and 511 fill the gap when they fire.",
    };
  }

  if (!nowItems.length && dry) {
    return {
      tone: "pipes-dry",
      last3hCopy:
        "Nothing in the last 3 hours. 511, civic, and NWS are empty this refresh — do not read that as county-wide quiet.",
      emptyFilterCopy:
        "Nothing in this filter. Daytime open pipes returned no rows.",
    };
  }

  return {
    tone: "quiet",
    last3hCopy:
      "Nothing in the last 3 hours in this view. Overnight blotter still lists under Since 7 AM / NYSP overnight.",
    emptyFilterCopy:
      "Nothing in this filter. Radio and 511 cover the hours since the 7 AM blotter when they have traffic.",
  };
}
