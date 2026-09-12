/**
 * Live wire eligibility — Capital Region relevance without inventing CAD.
 * Pipes may fetch many rows; Live must keep local public-safety signal
 * and drop clear out-of-area junk.
 */

export const OUT_OF_AREA =
  /\b(philippines|mississippi|louisiana|alabama|arkansas|oklahoma|kansas|nebraska|idaho|montana|wyoming|alaska|hawaii|brooklyn|queens|bronx|manhattan|staten island|nycha|albany houses|albany,? ga\b|albany,? georgia|albany,? oregon|new albany|albany park|long island|new york city|\bnyc\b|kingston,? ny|utica|syracuse|buffalo|rochester|watertown|binghamton|ferry (?:sinks|capsizes)|ferry disaster)\b/i;

export const LIVE_PUBLIC_SAFETY =
  /\b(crash|collision|shot|shooting|homicide|murder|stabbing|stab|robbery|arrests?|arrested|fire|blaze|killed|injured|fatal|burglary|assault|charg(?:e|ed|es|ing)|vandal|carjack|wanted|bomb|arson|hit-and-run|dwi|intoxicated|trooper|state police|sheriff|police|cops|ems|ambulance|missing (?:person|child|woman|man)|evacuat|road clos|lanes? blocked|traffic alert|pursuit|swat|search warrant|press (?:release|conference)|incident|emergency|person down|overdose|narcotics|gunfire|shots fired|quality-of-life|large gatherings)\b/i;

export const COURT_ONLY =
  /\b(sentenced|years in prison|plea|convicted|verdict|gets \d+ years|indictment for)\b/i;

export const NOT_LIVE_NEWS =
  /\b(lawsuit|file suit|sues |weekly|notable dwi|week in review)\b/i;

export const LIVE_WINDOW_MIN = 24 * 60;

export type LiveKeepInput = {
  title: string;
  summary?: string;
  minutesAgo: number;
  /** Already known local from pipe parse */
  local?: boolean;
};

/** Keep for Live news lens — local public-safety within window, not court fluff / out-of-area. */
export function keepLiveNewsItem(row: LiveKeepInput): boolean {
  const hay = `${row.title} ${row.summary ?? ""}`;
  if (row.minutesAgo > LIVE_WINDOW_MIN) return false;
  if (OUT_OF_AREA.test(hay)) return false;
  if (COURT_ONLY.test(hay)) return false;
  if (NOT_LIVE_NEWS.test(hay)) return false;
  if (!LIVE_PUBLIC_SAFETY.test(hay)) return false;
  return true;
}

export type SocialKeepInput = {
  title: string;
  summary?: string;
  official: boolean;
  needsLocal: boolean;
  localMatch: boolean;
};

/**
 * Official PD/FD/Sheriff posts stay even without crime keywords
 * (press, traffic, missing person, incident updates).
 * Non-official still needs a crime/incident title cue.
 */
export function keepSocialItem(
  row: SocialKeepInput,
  drop: RegExp,
  notOurs: RegExp,
  titleCrime: RegExp,
): boolean {
  const hay = `${row.title} ${row.summary ?? ""}`;
  if (drop.test(hay) || notOurs.test(hay) || OUT_OF_AREA.test(hay)) return false;
  if (row.needsLocal && !row.localMatch) return false;
  if (row.official) return true;
  return titleCrime.test(row.title) || LIVE_PUBLIC_SAFETY.test(hay);
}
