export type LocateErrorKind = "denied" | "unavailable";

export type NearMeEmptyState = "denied" | "unavailable" | "locating" | "quiet";

export type NearMePos = { lat: number; lng: number; accM: number; at: number };

export function selectNearMeEmptyState(args: {
  nearActive: boolean;
  pos: NearMePos | null;
  locateErrorKind: LocateErrorKind | null;
}): NearMeEmptyState | null {
  const { nearActive, pos, locateErrorKind } = args;
  if (!nearActive) return null;

  // Only render the quiet-in-radius copy when we have a successful location fix.
  if (pos) return "quiet";

  if (locateErrorKind === "denied") return "denied";
  if (locateErrorKind === "unavailable") return "unavailable";
  return "locating";
}

