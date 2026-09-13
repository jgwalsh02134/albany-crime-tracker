/**
 * Live wire + News tab eligibility — Capital Region relevance without inventing CAD.
 * Pipes may fetch many rows; Live/News must keep local public-safety signal
 * and drop clear out-of-area junk.
 */

export const OUT_OF_AREA =
  /\b(philippines|mississippi|louisiana|alabama|arkansas|oklahoma|kansas|nebraska|idaho|montana|wyoming|alaska|hawaii|new orleans|baton rouge|shreveport|portland(?!\s*(?:cement|ave|avenue|st|street))|seattle|chicago|houston|dallas|phoenix|miami|atlanta|denver|boston|los angeles|san francisco|san diego|baltimore|detroit|minneapolis|milwaukee|brooklyn|queens|bronx|manhattan|staten island|nycha|albany houses|albany,? ga\b|albany,? georgia|albany,? oregon|new albany|albany park|long island|new york city|\bnyc\b|kingston,? ny|utica|syracuse|buffalo|rochester|watertown|binghamton|ferry (?:sinks|capsizes)|ferry disaster|portlandpolice|lapd|chicago\s+pd)\b/i;

export const CAPITAL_LOCAL =
  /\b(albany|colonie|bethlehem|guilderland|cohoes|watervliet|menands|latham|delmar|new scotland|westerlo|coeymans|loudonville|altamont|ravena|selkirk|glenmont|green island|capital (?:region|district)|troop g|clifton park|troy|schenectady|rensselaer|sand lake|schodack|east greenbush|niskayuna|rotterdam|glenville|scotia|halfmoon|mechanicville|saratoga|ballston|voorheesville|elsmere|slingerlands|crossgates|wolf\s*rd|central\s*(?:ave|avenue)|western\s*(?:ave|avenue)|thruway|northway|i-?87|i-?90|i-?787)\b/i;

/** Outlets that are already Capital Region–scoped when title geo is thin. */
export const LOCAL_OUTLET =
  /\b(News10|WRGB|CBS\s?6|WNYT|WAMC|Times Union|Spectrum|Daily Gazette|Patch(?:\s+Albany)?|Spotlight|Troy Record|FOX23|North cities|Guilderland news|ACSO|NYSP|Civic|NWS|511NY|Superfeedr)\b/i;

export const LIVE_PUBLIC_SAFETY =
  /\b(crash|collision|shot|shooting|homicide|murder|stabbing|stab|robbery|arrests?|arrested|fire|blaze|killed|injured|fatal|burglary|assault|charg(?:e|ed|es|ing)|vandal|carjack|wanted|bomb|arson|hit-and-run|dwi|intoxicated|trooper|state police|sheriff|police|cops|ems|ambulance|missing (?:person|child|woman|man)|evacuat|road clos|lanes? blocked|traffic alert|pursuit|swat|search warrant|press (?:release|conference)|incident|emergency|person down|overdose|narcotics|gunfire|shots fired|quality-of-life|large gatherings)\b/i;

export const COURT_ONLY =
  /\b(sentenced|years in prison|plea|convicted|verdict|gets \d+ years|indictment for)\b/i;

export const NOT_LIVE_NEWS =
  /\b(lawsuit|file suit|sues |weekly|notable dwi|week in review)\b/i;

export const LIVE_WINDOW_MIN = 24 * 60;
export const NEWS_TAB_WINDOW_MIN = 72 * 60;

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
  // Prefer Capital Region geo; allow when pipe already marked local.
  if (!row.local && !CAPITAL_LOCAL.test(hay)) return false;
  return true;
}

export type NewsTabInput = {
  title: string;
  summary?: string;
  outlet?: string;
  minutesAgo: number;
  kind?: string;
};

/**
 * News tab keep — harder drop of out-of-area; require Capital Region cue
 * or a known local outlet. Blotter rows are allowed but capped by ranker.
 */
export function keepNewsTabItem(row: NewsTabInput): boolean {
  const hay = `${row.title} ${row.summary ?? ""}`;
  if (row.minutesAgo > NEWS_TAB_WINDOW_MIN) return false;
  if (OUT_OF_AREA.test(hay)) return false;
  if (LOCAL_OUTLET.test(row.outlet ?? "") || CAPITAL_LOCAL.test(hay)) return true;
  // No local outlet and no Capital Region cue — drop.
  return false;
}

export function isBlotterOutlet(outlet: string): boolean {
  return /\b(NYSP blotter|blotter)\b/i.test(outlet);
}

/** Fresher + crime + thumb boost for News / Live news ranking. */
export function newsFreshnessScore(input: {
  minutesAgo: number;
  title: string;
  summary?: string;
  hasImage?: boolean;
  outlet?: string;
}): number {
  const hay = `${input.title} ${input.summary ?? ""}`;
  let s = 0;
  if (input.minutesAgo <= 30) s += 55;
  else if (input.minutesAgo <= 60) s += 45;
  else if (input.minutesAgo <= 180) s += 32;
  else if (input.minutesAgo <= 720) s += 18;
  else if (input.minutesAgo <= 24 * 60) s += 8;
  else s += 2;
  if (LIVE_PUBLIC_SAFETY.test(hay)) s += 12;
  if (/\b(shot|shooting|homicide|stab|fatal|fire|crash)\b/i.test(hay)) s += 8;
  if (input.hasImage) s += 6;
  if (isBlotterOutlet(input.outlet ?? "")) s -= 15; // don't let overnight blotter drown newsrooms
  if (OUT_OF_AREA.test(hay)) s -= 100;
  if (CAPITAL_LOCAL.test(hay)) s += 5;
  return s;
}

export function rankNewsItems<T extends NewsTabInput & { image?: string; id: string }>(items: T[]): T[] {
  return [...items]
    .filter((row) => keepNewsTabItem(row))
    .sort((a, b) => {
      const sa = newsFreshnessScore({
        minutesAgo: a.minutesAgo,
        title: a.title,
        summary: a.summary,
        hasImage: Boolean(a.image),
        outlet: a.outlet,
      });
      const sb = newsFreshnessScore({
        minutesAgo: b.minutesAgo,
        title: b.title,
        summary: b.summary,
        hasImage: Boolean(b.image),
        outlet: b.outlet,
      });
      if (sb !== sa) return sb - sa;
      return a.minutesAgo - b.minutesAgo;
    });
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
