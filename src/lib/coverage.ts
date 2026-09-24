import type { WireHealth } from "./sources";

export type CoverageTone = "ok" | "warn" | "down" | "unknown";

export type CoverageFlag = {
  id: string;
  tone: CoverageTone;
  label: string;
  detail: string;
  kind: "static" | "dynamic";
};

function otherPipesOk(health: WireHealth): boolean {
  return (
    (health.news ?? 0) > 0 ||
    (health.traffic ?? 0) > 0 ||
    (health.civic ?? 0) > 0 ||
    (health.nws ?? 0) > 0 ||
    (health.facebook ?? 0) > 0 ||
    (health.x ?? 0) > 0 ||
    (health.reddit ?? 0) > 0 ||
    (health.citizen ?? 0) > 0 ||
    (health.blotter ?? 0) > 0
  );
}

export function radioCoverageFlag(health: WireHealth | null | undefined): CoverageFlag | null {
  if (!health) return null;

  const stt = health.scannerSttState;
  const hls = health.scannerHlsState;
  const hasKeys = Boolean(health.captions) && stt !== "no-key";

  if (!hasKeys) {
    return {
      id: "radio-captions-unavailable",
      kind: "dynamic",
      tone: "down",
      label: "Radio captions unavailable",
      detail: "Speech keys aren’t configured in this environment, so early radio reporting is missing.",
    };
  }

  if (hls === "error") {
    return {
      id: "radio-stream-down",
      kind: "dynamic",
      tone: "down",
      label: "Radio stream unreachable",
      detail: "Broadcastify HLS looks down/unreachable right now. Captions may not update until the stream recovers.",
    };
  }

  if (stt === "busy") {
    return {
      id: "radio-captions-delayed",
      kind: "dynamic",
      tone: "warn",
      label: "Radio captions delayed",
      detail: "Speech transcription is rate-limited/backing off. This is a reporting delay, not an all-clear.",
    };
  }

  if (stt === "error") {
    return {
      id: "radio-captions-degraded",
      kind: "dynamic",
      tone: "warn",
      label: "Radio captions degraded",
      detail: "Speech transcription is erroring. Live may miss early radio reporting until it recovers.",
    };
  }

  // If other pipes are clearly alive but scanner isn't producing, treat as a likely gap.
  if ((health.scanner ?? 0) === 0 && otherPipesOk(health)) {
    return {
      id: "radio-silent",
      kind: "dynamic",
      tone: "warn",
      label: "Radio quiet (sanity-check)",
      detail: "Other sources are active but radio produced 0 rows this refresh. Could be quiet — could be a radio gap.",
    };
  }

  return null;
}

export function coverageSummary(opts: {
  health: WireHealth | null | undefined;
  colonieFocused?: boolean;
}): {
  tone: CoverageTone;
  flags: CoverageFlag[];
  shortLabel: string;
} {
  const { health, colonieFocused = false } = opts;

  const flags: CoverageFlag[] = [];

  // Static blind spots (v1).
  flags.push({
    id: "colonie-encrypted",
    kind: "static",
    tone: colonieFocused ? "warn" : "unknown",
    label: "Colonie Police radio is encrypted",
    detail: "Live can’t monitor CPD police radio traffic. You’ll mainly see official alerts, fire/EMS, 511, and news.",
  });

  const nixlePipes = health?.pipes?.filter((p) => p.id.startsWith("nixle:")) ?? [];
  const nixleKnown = nixlePipes.length > 0;
  const nixleCount = nixlePipes.reduce((sum, p) => sum + (p.lastCount || 0), 0);
  const nixleQuiet = nixleKnown && nixleCount === 0;
  const radioUp = (health?.scanner ?? 0) > 0;
  const advisoryQuiet = Boolean(health?.daytimePipesDry) || nixleQuiet;

  if (health?.daytimePipesFailing) {
    flags.push({
      id: "daytime-failing",
      kind: "dynamic",
      tone: "down",
      label: "Some live pipes failed",
      detail: "This refresh had pipe errors. Empty results can mean a reporting gap, not that nothing happened.",
    });
  } else if (advisoryQuiet) {
    flags.push({
      id: radioUp ? "advisory-dark" : "daytime-dry",
      kind: "dynamic",
      tone: "warn",
      label: radioUp ? "Agency alerts quiet" : "Daytime pipes returned 0",
      detail: radioUp
        ? `Early radio is up. ${nixleQuiet ? "Nixle returned nothing. " : ""}511, civic, and NWS are empty this refresh — a gap in agency alerts, not an all-clear. Colonie Police radio is encrypted, so Nixle and department posts are the police signal there.`
        : "511 / civic / NWS returned 0 this refresh. Treat this as a feed gap until you confirm a healthy refresh.",
    });
  }

  const radio = radioCoverageFlag(health);
  if (radio) flags.push(radio);

  const tone = flags.some((f) => f.tone === "down")
    ? "down"
    : flags.some((f) => f.tone === "warn")
      ? "warn"
      : health
        ? "ok"
        : "unknown";

  const radioUpAlertsQuiet = radioUp && advisoryQuiet && tone !== "down";
  const shortLabel =
    tone === "down"
      ? "Coverage degraded"
      : radioUpAlertsQuiet
        ? "Radio up · alerts quiet"
        : tone === "warn"
          ? "Coverage limited"
          : tone === "ok"
            ? "Coverage"
            : "Coverage";

  return { tone, flags, shortLabel };
}

