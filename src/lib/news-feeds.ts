export type NewsFeed = {
  url: string;
  outlet: string;
  /** When true, keep only public-safety/crime keywords from this feed. */
  crimeOnly?: boolean;
};

/**
 * Canonical newsroom feeds and “gap coverage” Google News RSS queries.
 *
 * This list intentionally drives BOTH:
 * - polling in `live-sources.ts` (completeness fallback)
 * - Superfeedr subscriptions in `superfeedr.ts` (latency)
 */
export const NEWS_FEEDS: NewsFeed[] = [
  { url: "https://www.news10.com/feed/", outlet: "News10" },
  { url: "https://www.news10.com/news/crime/feed/", outlet: "News10 Crime" },
  { url: "https://cbs6albany.com/news/local.rss", outlet: "CBS6" },
  { url: "https://wnyt.com/feed/", outlet: "WNYT" },
  { url: "https://www.wamc.org/news.rss", outlet: "WAMC" },
  {
    url: "https://news.google.com/rss/search?q=site:patch.com/new-york/albany-ny+(police+OR+crash+OR+shooting+OR+fire+OR+arrest+OR+dwi+OR+trooper+OR+sheriff)+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Patch Albany",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=Albany+NY+(police+OR+crash+OR+shooting+OR+fire+OR+arrest+OR+sheriff+OR+DWI+OR+trooper+OR+stabbing+OR+homicide+OR+wanted)+when:1d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Google News",
  },
  {
    url: "https://news.google.com/rss/search?q=(Cohoes+OR+Watervliet+OR+Menands+OR+%22Green+Island%22)+(police+OR+crash+OR+arrest+OR+fire+OR+DWI)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "North cities",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=(Guilderland+OR+Altamont+OR+Voorheesville)+(police+OR+crash+OR+arrest+OR+fire+OR+DWI+OR+blotter)+when:3d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Guilderland news",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=site:spectrumlocalnews.com+(albany+OR+colonie+OR+troy)+(crash+OR+shooting+OR+arrest+OR+fire)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Spectrum",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=%22Albany+County+Sheriff%22+(arrest+OR+crash+OR+shooting+OR+DWI)+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "ACSO",
    crimeOnly: true,
  },
  {
    url: "https://www.troyrecord.com/feed/",
    outlet: "Troy Record",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=site:timesunion.com+(crash+OR+shooting+OR+arrest+OR+DWI+OR+homicide+OR+stabbing)+(albany+OR+colonie+OR+delmar+OR+latham+OR+bethlehem+OR+guilderland)+when:3d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Times Union",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=site:spotlightnews.com+(arrest+OR+crash+OR+blotter+OR+DWI+OR+shooting)+when:7d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Spotlight",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=site:patch.com/new-york+(colonie+OR+bethlehem+OR+latham)+(police+OR+crash+OR+arrest)+when:3d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Patch",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=site:dailygazette.com+(albany+OR+colonie+OR+schenectady)+(crash+OR+shooting+OR+arrest+OR+fire)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Daily Gazette",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=site:fox23news.com+(albany+OR+colonie+OR+troy)+(crash+OR+shooting+OR+arrest+OR+fire)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "FOX23",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=(%22Central+Avenue%22+OR+%22Western+Avenue%22+OR+%22Wolf+Road%22)+(Albany+OR+Colonie)+(crash+OR+arrest+OR+fire+OR+shooting+OR+police)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Corridor news",
    crimeOnly: true,
  },
  {
    url: "https://news.google.com/rss/search?q=(Bethlehem+OR+Delmar+OR+Latham)+(police+OR+crash+OR+arrest+OR+fire+OR+DWI)+when:2d&hl=en-US&gl=US&ceid=US:en",
    outlet: "Town news",
    crimeOnly: true,
  },
];

