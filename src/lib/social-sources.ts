import { hasClearIncidentLanguageForNewsroomSocial, keepSocialItem } from "./live-keep";
import { locateSpoken, placeFromText } from "./geo";
import type { LiveWireItem } from "./sources";
import { recordPipeFail, recordPipeOk } from "./pipe-health";
import { redditApiFetch, redditApiHealth, recordRedditOk } from "./reddit-api";
import { isOfficialAgencySocial } from "./social-official";
import { usableExcerpt } from "./html";

const UA = "AlbanyCountyCrimeTracker/1.0 (+https://app.albany.watch)";
const REDDIT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const LOCAL =
  /\b(albany|colonie|bethlehem|guilderland|cohoes|watervliet|menands|latham|delmar|new scotland|westerlo|coeymans|loudonville|altamont|ravena|selkirk|glenmont|green island|capital region|troop g|clifton park|troy|schenectady|rensselaer|sand lake|schodack|east greenbush|wolf road|western ave|central ave|new scotland|delaware ave|madison ave)\b/i;
const DROP =
  /\b(hiring|join our team|join the|apply now|now hiring|open house|recruit|recruitment|lateral transfer|civil service exam|exam|academy|graduation|promotion|retirement|sworn in|award|community event|festival|parade|concert|fundraiser|benefit|raffle|giveaway|supply drive|back-to-school|holiday travel|christmas|mlk|martin luther|birthday|recipe|sports|season preview|game day|weather|trusted by millions|install news app|police reform|nibrs|lanternfl|patroons|nightlife|travers|found pet|lost pet|adopt)\b/i;
const NOT_OURS =
  /\b(brooklyn|queens|bronx|manhattan|nycha|albany houses|albany,? ga\b|albany,? georgia|albany,? oregon|new albany|albany park|long island|gloversville|jackson man|milo yiannopoulos)\b/i;
const TITLE_CRIME =
  /\b(crash|collision|police|cops|shooting|shots|fire|arrest|accident|ambulance|trooper|sheriff|stab|homicide|stolen|burglary|dwi|wanted|missing|investigation|gunfire)\b/i;

const LIVE_MIN = 24 * 60;
const NEWS_MIN = 72 * 60;
const OFFICIAL_NEWS_MIN = 7 * 24 * 60;
const CACHE_MS = 2 * 60_000;
const REDDIT_CACHE_MS = 10 * 60_000;
const OFFICIAL_DAY_TTL_MS = 45_000;
const OFFICIAL_NIGHT_TTL_MS = 2 * 60_000;
const NONOFFICIAL_DAY_TTL_MS = 2 * 60_000;
const NONOFFICIAL_NIGHT_TTL_MS = 4 * 60_000;

const ET_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  hour12: false,
});

function isDaytimeET(now: number): boolean {
  const hour = Number(ET_HOUR.format(new Date(now)));
  return Number.isFinite(hour) && hour >= 6 && hour < 22;
}

let redditBlockedUntil = 0;
const REDDIT_BACKOFF_MS = 10 * 60_000;
const REDDIT_NOAUTH_BACKOFF_MS = 25 * 60_000;

type SocialFeed = {
  url: string;
  outlet: string;
  pipe: "facebook" | "x" | "reddit";
  official: boolean;
  needsLocal: boolean;
  format: "rss" | "atom";
  titleMust?: RegExp;
};

function feedPipeId(feed: SocialFeed): string {
  const key = feed.outlet
    .toLowerCase()
    .replace(/^facebook\s+·\s+|^x\s+·\s+|^reddit\s+·\s+/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `social:${feed.pipe}:${key || "feed"}`;
}

const FACEBOOK_FEEDS: SocialFeed[] = [
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/AlbanyNYPolice+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Albany PD",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/FDAlbanyny+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Albany Fire",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/ColoniePD+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Colonie PD",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/ColonieEMS+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Colonie EMS",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=%22Bethlehem+Police%22+(Delmar+OR+Glenmont)+site:facebook.com+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Bethlehem PD",
    pipe: "facebook",
    official: true,
    needsLocal: true,
    format: "rss",
    titleMust: /bethlehem police/i,
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/CohoesPD+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Cohoes PD",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/cohoesfire+when:14d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Cohoes Fire",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/WatervlietPolice+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Watervliet PD",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/guilderlandpolice+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Guilderland PD",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/SchenectadyPD+when:14d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Schenectady PD",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/SchenectadyFireDepartment+when:14d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Schenectady Fire",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/renscosheriff+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Rensselaer County Sheriff",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/EastGreenbushPoliceDept+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · East Greenbush Police",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/GuilderlandFD+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Guilderland Fire",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/WestmereFireDept+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Westmere Fire",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/LathamFireDept+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Latham Fire",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/nyspolice+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · NYSP",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/FullerRoadVFD+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Fuller Road VFD",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/midwayfiredept+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Midway Fire",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/srlfd+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Shaker Road–Loudonville FD",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/greenislandpolicedepartment+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Green Island Police",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/mpd.gov+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Menands Police",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/RensselaerCityPolice+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Rensselaer City Police",
    pipe: "facebook",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  // Newsroom pages are noisy; keep() enforces crime/public-safety keywords.
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/CBS6Albany+(crime+OR+police+OR+shooting+OR+fire+OR+crash+OR+arrest)+when:3d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · CBS6",
    pipe: "facebook",
    official: false,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/wten.albany+(crime+OR+police+OR+shooting+OR+fire+OR+crash+OR+arrest)+when:3d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · NEWS10",
    pipe: "facebook",
    official: false,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/NewsChannel13+(crime+OR+police+OR+shooting+OR+fire+OR+crash+OR+arrest)+when:3d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · WNYT",
    pipe: "facebook",
    official: false,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/SpectrumNews1Albany+(crime+OR+police+OR+shooting+OR+fire+OR+crash+OR+arrest)+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Spectrum News 1",
    pipe: "facebook",
    official: false,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/DailyGazette+(crime+OR+police+OR+shooting+OR+fire+OR+crash+OR+arrest)+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Daily Gazette",
    pipe: "facebook",
    official: false,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/troyrecord+(crime+OR+police+OR+shooting+OR+fire+OR+crash+OR+arrest)+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Troy Record",
    pipe: "facebook",
    official: false,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:facebook.com/timesunion+(crime+OR+police+OR+shooting+OR+fire+OR+crash+OR+arrest)+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Facebook · Times Union",
    pipe: "facebook",
    official: false,
    needsLocal: true,
    format: "rss",
  },
];

const X_FEEDS: SocialFeed[] = [
  {
    url: "https://news.google.com/rss/search?q=site:x.com/nyspolice+(albany+OR+colonie+OR+latham+OR+guilderland+OR+bethlehem+OR+delmar+OR+cohoes)+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · NYSP",
    pipe: "x",
    official: true,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/troynypolice+(arrest+OR+shooting+OR+fire+OR+crash+OR+road+closed)+when:14d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · Troy PD",
    pipe: "x",
    official: true,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/schdypolice+(arrest+OR+shooting+OR+fire+OR+crash+OR+road+closed)+when:14d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · Schdy Police",
    pipe: "x",
    official: true,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/cohoesfire+(fire+OR+ems+OR+crash+OR+road+closed)+when:14d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · Cohoes Fire",
    pipe: "x",
    official: true,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/guilderlandpd+when:30d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · Guilderland PD",
    pipe: "x",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/pdbethlehem+when:30d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · Bethlehem PD",
    pipe: "x",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/ACSOTWEET+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · Albany County Sheriff",
    pipe: "x",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/albanypolice+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · Albany Police",
    pipe: "x",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/colonie_police+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · Colonie Police",
    pipe: "x",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/ThruwayTraffic+(albany+OR+colonie+OR+guilderland+OR+troy+OR+schenectady+OR+rensselaer+OR+capital+region+OR+i-87+OR+i87+OR+northway)+when:3d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · Thruway TRANSalert",
    pipe: "x",
    official: true,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/FD_AlbanyNY+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · Albany Fire",
    pipe: "x",
    official: true,
    needsLocal: false,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/SpecNews1Albany+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · Spectrum News 1",
    pipe: "x",
    official: false,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/dgazette+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · Daily Gazette",
    pipe: "x",
    official: false,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/WAMCNews+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · WAMC",
    pipe: "x",
    official: false,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/CBS6Albany+(crash+OR+shooting+OR+fire+OR+arrest+OR+police)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · CBS6",
    pipe: "x",
    official: false,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/wten+(crash+OR+shooting+OR+fire+OR+arrest)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · NEWS10",
    pipe: "x",
    official: false,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/timesunion+(crash+OR+shooting+OR+arrest+OR+DWI)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · Times Union",
    pipe: "x",
    official: false,
    needsLocal: true,
    format: "rss",
  },
  {
    url: "https://news.google.com/rss/search?q=site:x.com/wnyt+(police+OR+shooting+OR+fire+OR+crash+OR+arrest)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "X · WNYT",
    pipe: "x",
    official: false,
    needsLocal: true,
    format: "rss",
  },
];

const REDDIT_FEEDS: SocialFeed[] = [
  {
    url: "https://www.reddit.com/r/Albany/search.rss?q=police+OR+crash+OR+fire+OR+shooting+OR+arrest+OR+accident&sort=new&restrict_sr=on",
    outlet: "Reddit · r/Albany",
    pipe: "reddit",
    official: false,
    needsLocal: false,
    format: "atom",
  },
  {
    url: "https://www.reddit.com/r/Troy/search.rss?q=police+OR+crash+OR+fire+OR+shooting+OR+arrest&sort=new&restrict_sr=on",
    outlet: "Reddit · r/Troy",
    pipe: "reddit",
    official: false,
    needsLocal: false,
    format: "atom",
  },
  {
    url: "https://www.reddit.com/r/Schenectady/search.rss?q=police+OR+crash+OR+fire+OR+shooting+OR+arrest&sort=new&restrict_sr=on",
    outlet: "Reddit · r/Schenectady",
    pipe: "reddit",
    official: false,
    needsLocal: false,
    format: "atom",
  },
];

function decode(raw: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  return raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&nbsp;/gi, " ")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, ent: string) => {
      const key = ent.toLowerCase();
      if (key in named) return named[key]!;
      if (key.startsWith("#x")) {
        const n = Number.parseInt(key.slice(2), 16);
        return Number.isFinite(n) ? String.fromCharCode(n) : match;
      }
      if (key.startsWith("#")) {
        const n = Number(key.slice(1));
        return Number.isFinite(n) ? String.fromCharCode(n) : match;
      }
      return match;
    })
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tag(block: string, name: string): string {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? decode(m[1]!) : "";
}

function attr(block: string, el: string, name: string): string {
  const m = block.match(new RegExp(`<${el}[^>]*${name}=["']([^"']+)["']`, "i"));
  return m?.[1] ?? "";
}

function stripSource(title: string): string {
  return title
    .replace(/\s+[-–—]\s+(facebook\.com|x\.com|twitter\.com|reddit|$)/i, "")
    .replace(/\s+[-–—]\s+.{0,40}$/i, (tail) =>
      /facebook|x\.com|twitter|reddit|news10|cbs|wnyt|times union/i.test(tail) ? "" : tail,
    )
    .trim();
}

function keep(title: string, summary: string, feed: SocialFeed, now: number, published: number): boolean {
  const hay = `${title} ${summary}`;
  if (feed.titleMust && !feed.titleMust.test(title)) return false;
  // Newsroom pages are noisy. For non-official newsroom social, require clear incident language
  // so policy/politics/features don't become Live incidents.
  if (
    !feed.official &&
    /^(?:Facebook|X)\s+·\s+(?:CBS6|NEWS10|WNYT|Spectrum News 1|Daily Gazette|Troy Record|Times Union|WAMC)\b/i.test(
      feed.outlet,
    ) &&
    !hasClearIncidentLanguageForNewsroomSocial({ title, summary })
  ) {
    return false;
  }
  if (
    !keepSocialItem(
      {
        title,
        summary,
        official: feed.official,
        needsLocal: feed.needsLocal,
        localMatch: LOCAL.test(hay),
      },
      DROP,
      NOT_OURS,
      TITLE_CRIME,
    )
  ) {
    return false;
  }
  const minutesAgo = Math.max(0, Math.round((now - published) / 60_000));
  const cap = feed.official ? OFFICIAL_NEWS_MIN : NEWS_MIN;
  return minutesAgo <= cap;
}

function toItem(
  title: string,
  url: string,
  summary: string,
  published: number,
  now: number,
  outlet: string,
  official: boolean,
): LiveWireItem {
  const hay = `${title} ${summary}`;
  const place = placeFromText(hay);
  const outletHint = municipalityHintFromOutlet(outlet);
  const muni = place?.name || outletHint;
  const pin = locateSpoken(hay, muni || "");
  const minutesAgo = Math.max(0, Math.round((now - published) / 60_000));
  return {
    id: url,
    title,
    url,
    outlet,
    summary: usableExcerpt(summary, title).slice(0, 360),
    publishedAt: new Date(published).toISOString(),
    minutesAgo,
    kind: "social",
    municipality: muni,
    address: pin.road || muni,
    agency: official ? outlet.replace(/^Facebook · |^X · /, "") : outlet,
    lat: pin.geo.lat,
    lng: pin.geo.lng,
    geoPrecision: pin.precision,
  };
}

function municipalityHintFromOutlet(outlet: string): string | undefined {
  const o = outlet.trim();
  if (/^(?:Facebook|X)\s+·\s+Colonie\b/i.test(o)) return "Colonie";
  // Colonie volunteer companies often post without "Latham/Loudonville" in the title text.
  if (/^Facebook\s+·\s+(?:Latham Fire|Fuller Road VFD|Midway Fire|Shaker Road–Loudonville FD)\b/i.test(o)) return "Colonie";
  if (/^Facebook\s+·\s+Albany\b/i.test(o) || /^X\s+·\s+Albany\b/i.test(o)) return "Albany";
  if (/^Facebook\s+·\s+Bethlehem\b/i.test(o) || /^X\s+·\s+Bethlehem\b/i.test(o)) return "Bethlehem";
  if (/^Facebook\s+·\s+Guilderland\b/i.test(o) || /^X\s+·\s+Guilderland\b/i.test(o)) return "Guilderland";
  if (/^Facebook\s+·\s+Cohoes\b/i.test(o) || /^X\s+·\s+Cohoes\b/i.test(o)) return "Cohoes";
  if (/^Facebook\s+·\s+Watervliet\b/i.test(o) || /^X\s+·\s+Watervliet\b/i.test(o)) return "Watervliet";
  if (/^X\s+·\s+Thruway\b/i.test(o)) return "Albany";
  return undefined;
}

function parseRss(xml: string, feed: SocialFeed, now: number): LiveWireItem[] {
  const out: LiveWireItem[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<item[\s\S]*?<\/item>/gi)) {
    const block = match[0]!;
    const rawTitle = tag(block, "title");
    const title = stripSource(rawTitle);
    const url = attr(block, "link", "href") || tag(block, "link") || tag(block, "guid");
    if (!title || !url || seen.has(url) || /RSS reader not yet/i.test(title)) continue;
    const summary = tag(block, "description") || tag(block, "content:encoded") || title;
    const published = Date.parse(tag(block, "pubDate") || tag(block, "dc:date")) || now;
    if (!keep(title, summary, feed, now, published)) continue;
    seen.add(url);
    out.push(toItem(title, url, tidySummary(title, summary), published, now, feed.outlet, feed.official));
  }
  return out;
}

function parseAtom(xml: string, feed: SocialFeed, now: number): LiveWireItem[] {
  const out: LiveWireItem[] = [];
  const seen = new Set<string>();
  for (const match of xml.matchAll(/<entry[\s\S]*?<\/entry>/gi)) {
    const block = match[0]!;
    const title = stripSource(tag(block, "title"));
    const url = attr(block, "link", "href") || tag(block, "link") || tag(block, "id");
    if (!title || !url || seen.has(url)) continue;
    const summary = tag(block, "content") || tag(block, "summary") || title;
    const published = Date.parse(tag(block, "published") || tag(block, "updated")) || now;
    if (!keep(title, summary, feed, now, published)) continue;
    seen.add(url);
    out.push(toItem(title, url, tidySummary(title, summary), published, now, feed.outlet, feed.official));
  }
  return out;
}

function tidySummary(title: string, summary: string): string {
  let s = summary.replace(/\s+/g, " ").trim();
  if (s.startsWith(title)) s = s.slice(title.length).replace(/^[\s\-–—]+/, "").trim();
  if (s.length < 24) return title;
  return s.slice(0, 360);
}

type CacheEntry = { at: number; items: LiveWireItem[] } | null;
const g = globalThis as unknown as { __actSocialCache?: Map<string, CacheEntry> };
function cacheMap(): Map<string, CacheEntry> {
  if (!g.__actSocialCache) g.__actSocialCache = new Map();
  return g.__actSocialCache;
}

type FeedFetchStatus = "ok" | "cache" | "fail" | "blocked";
type FeedFetchResult = { items: LiveWireItem[]; status: FeedFetchStatus; error?: string };

type SocialMode = "live" | "full";
type SocialOpts = { mode?: SocialMode };

function ttlMs(feed: SocialFeed, now: number): number {
  if (feed.pipe === "reddit") return REDDIT_CACHE_MS;
  // Tighten daytime polls for official agency outlets (FB/X via GNews).
  if (feed.official) return isDaytimeET(now) ? OFFICIAL_DAY_TTL_MS : OFFICIAL_NIGHT_TTL_MS;
  return isDaytimeET(now) ? NONOFFICIAL_DAY_TTL_MS : NONOFFICIAL_NIGHT_TTL_MS;
}

function fetchTimeoutMs(feed: SocialFeed, opts?: SocialOpts): number {
  if (opts?.mode === "live") return feed.pipe === "reddit" ? 4500 : 3500;
  // Full mode can tolerate slightly more wait, but keep it bounded so dying feeds do not accumulate work.
  return feed.pipe === "reddit" ? 7000 : 6000;
}

async function fetchFeed(feed: SocialFeed, now: number, opts?: SocialOpts): Promise<FeedFetchResult> {
  if (feed.outlet.startsWith("Reddit") && Date.now() < redditBlockedUntil) {
    const remainSec = Math.max(0, Math.round((redditBlockedUntil - Date.now()) / 1000));
    recordPipeFail("social:reddit", "Reddit", `rate-limited backoff ${remainSec}s`);
    recordPipeFail(feedPipeId(feed), feed.outlet, `rate-limited backoff ${remainSec}s`);
    const cache = cacheMap();
    const key = `${feed.pipe}:${feed.outlet}:${feed.url}`;
    const hit = cache.get(key);
    return { items: hit?.items ?? [], status: "blocked", error: `rate-limited backoff ${remainSec}s` };
  }
  const cache = cacheMap();
  const key = `${feed.pipe}:${feed.outlet}:${feed.url}`;
  const hit = cache.get(key);
  const ttl = ttlMs(feed, now) || CACHE_MS;
  if (hit && now - hit.at < ttl) return { items: hit.items, status: "cache" };
  try {
    const res = await fetch(feed.url, {
      headers: {
        "User-Agent": feed.format === "atom" ? REDDIT_UA : UA,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(fetchTimeoutMs(feed, opts)),
    });
    if (!res.ok) {
      recordPipeFail(feedPipeId(feed), feed.outlet, `HTTP ${res.status}`);
      if (res.status === 429 && feed.pipe === "reddit") {
        const hasAuth = redditApiHealth().authConfigured;
        redditBlockedUntil = Date.now() + (hasAuth ? REDDIT_BACKOFF_MS : REDDIT_NOAUTH_BACKOFF_MS);
      }
      return { items: hit?.items ?? [], status: "fail", error: `HTTP ${res.status}` };
    }
    const xml = await res.text();
    let items: LiveWireItem[] = [];
    if (feed.format === "atom") items = parseAtom(xml, feed, now);
    else if (xml.includes("<item")) items = parseRss(xml, feed, now);
    recordPipeOk(feedPipeId(feed), feed.outlet, items.length);
    cache.set(key, { at: now, items });
    return { items, status: "ok" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "social-error";
    recordPipeFail(feedPipeId(feed), feed.outlet, msg);
    return { items: hit?.items ?? [], status: "fail", error: msg };
  }
}

export type SocialBundle = {
  items: LiveWireItem[];
  facebook: number;
  x: number;
  reddit: number;
  citizen: number;
};

export async function collectSocial(now: number, opts?: SocialOpts): Promise<SocialBundle> {
  const [fb, x, reddit] = await Promise.all([
    Promise.all(FACEBOOK_FEEDS.map((f) => fetchFeed(f, now, opts))),
    Promise.all(X_FEEDS.map((f) => fetchFeed(f, now, opts))),
    collectReddit(now, opts),
  ]);
  const seen = new Set<string>();
  const items: LiveWireItem[] = [];
  for (const row of [...fb.flatMap((r) => r.items), ...x.flatMap((r) => r.items), ...reddit.flat()]) {
    const key = `${row.outlet}|${row.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
    if (seen.has(row.id) || seen.has(key)) continue;
    seen.add(row.id);
    seen.add(key);
    items.push(row);
  }
  items.sort((a, b) => a.minutesAgo - b.minutesAgo);
  const facebook = items.filter((i) => i.outlet.startsWith("Facebook")).length;
  const xCount = items.filter((i) => i.outlet.startsWith("X ·")).length;
  const redditCount = items.filter((i) => i.outlet.startsWith("Reddit")).length;
  // Health honesty: only mark FB/X ok when we actually fetched successfully (not just served cache).
  const fbOk = fb.some((r) => r.status === "ok");
  const xOk = x.some((r) => r.status === "ok");
  const fbFail = fb.some((r) => r.status === "fail");
  const xFail = x.some((r) => r.status === "fail");
  if (fbOk) recordPipeOk("social:facebook", "Facebook", facebook);
  else if (fbFail) recordPipeFail("social:facebook", "Facebook", fb.find((r) => r.status === "fail")?.error || "fetch failed");
  if (xOk) recordPipeOk("social:x", "X", xCount);
  else if (xFail) recordPipeFail("social:x", "X", x.find((r) => r.status === "fail")?.error || "fetch failed");
  // Reddit ok/fail is recorded inside collectReddit via API/RSS path.
  return { items, facebook, x: xCount, reddit: redditCount, citizen: 0 };
}

export function isOfficialSocial(outlet: string): boolean {
  if (/^Civic ·/i.test(outlet)) return true;
  return isOfficialAgencySocial(outlet);
}

export function socialLive(items: LiveWireItem[]): LiveWireItem[] {
  return items.filter((i) => i.minutesAgo <= LIVE_MIN);
}

export function socialNews(items: LiveWireItem[]): LiveWireItem[] {
  return items.filter((i) => {
    if (i.minutesAgo <= LIVE_MIN) return false;
    const cap = isOfficialSocial(i.outlet) ? OFFICIAL_NEWS_MIN : NEWS_MIN;
    return i.minutesAgo <= cap;
  });
}

async function collectReddit(now: number, opts?: SocialOpts): Promise<LiveWireItem[][]> {
  const api = redditApiHealth();
  if (api.authConfigured) {
    const q =
      "police OR crash OR collision OR fire OR shooting OR shots OR arrest OR accident OR ambulance OR trooper OR sheriff";
    const subs = ["Albany", "Troy", "Schenectady"] as const;
    const posts = (
      await Promise.all(
        subs.map(async (sub) => {
          const [newest, search] = await Promise.all([
            redditApiFetch({ now, subreddit: sub, limit: 20 }),
            redditApiFetch({ now, subreddit: sub, q, limit: 20 }),
          ]);
          return [...newest, ...search];
        }),
      )
    ).flat();

    const seen = new Set<string>();
    const out: LiveWireItem[] = [];
    for (const p of posts) {
      const id = `reddit-${p.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const url = p.permalink.startsWith("http") ? p.permalink : `https://www.reddit.com${p.permalink}`;
      const title = p.title.slice(0, 180);
      const summary = (p.selftext || "").replace(/\s+/g, " ").trim().slice(0, 360) || title;
      const published = Math.round(p.created_utc * 1000);
      const minutesAgo = Math.max(0, Math.round((now - published) / 60_000));
      if (minutesAgo > NEWS_MIN) continue;
      if (!keep(title, summary, { url: "", outlet: "Reddit", pipe: "reddit", official: false, needsLocal: false, format: "atom" }, now, published)) {
        continue;
      }
      const item = toItem(title, url, summary, published, now, `Reddit · r/${p.subreddit}`, false);
      out.push(item);
    }
    out.sort((a, b) => a.minutesAgo - b.minutesAgo);
    recordRedditOk(out.length);
    return [out];
  }

  const rss = await Promise.all(REDDIT_FEEDS.map((f) => fetchFeed(f, now, opts)));
  const rssItems = rss.flatMap((r) => r.items);
  // When unauthenticated, surface the limitation as “thin,” not quiet.
  if (rssItems.length === 0 && Date.now() < redditBlockedUntil) {
    const remainSec = Math.max(0, Math.round((redditBlockedUntil - Date.now()) / 1000));
    recordPipeFail("social:reddit", "Reddit", `rate-limited backoff ${remainSec}s`);
  } else {
    recordPipeOk("social:reddit", "Reddit", rssItems.length);
  }
  return rss.map((r) => r.items);
}
