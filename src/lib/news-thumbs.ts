/**
 * News thumbnail helpers: reject outlet stock, parse OG images, light cache.
 * Used server-side when assembling the live wire / news stories.
 */

const UA = "AlbanyCountyCrimeTracker/1.0 (+https://app.albany.watch)";

/** Outlet logos, seals, default share cards, and obvious stock art — not story photos. */
const GENERIC_IMAGE_RE =
  /(?:^|[/_-])(?:logo|seal|brand|favicon|sprite|masthead|wordmark|placeholder|default[-_]?(?:image|og|share|social|thumb)?|site[-_]?icon|apple[-_]?touch|og[-_]?default|social[-_]?share|generic|stock|ambulance\.webp|firegeneric|news[-_]?10[-_]?site[-_]?icon|cropped-[^/]*icon|gnews\/logo|google_news_\d+)(?:[./_?-]|$)/i;

const GOOGLE_NEWS_HOST_RE = /(?:^|\.)news\.google\.com$/i;
const GNEWS_LOGO_RE =
  /googleusercontent\.com\/.*(?:=w(?:16|24|32|48|64|96|128|256)\b|=s0-w(?:16|24|32|48|64|96|128|256)\b)|gstatic\.com\/gnews\/logo/i;

export type ThumbCacheEntry = { image: string | null; at: number };

const ogCache = new Map<string, ThumbCacheEntry>();
const CACHE_TTL_MS = 30 * 60_000;
// Keep below the `live-sources` softPipe budget so a single slow publisher doesn't
// cause the whole enrichment step to time out and fall back to un-enriched stories.
const OG_TIMEOUT_MS = 1800;
const MAX_ENRICH = 10;

export function isGenericOutletImage(url: string | undefined | null): boolean {
  if (!url) return true;
  try {
    const u = new URL(url);
    const hay = `${u.pathname}${u.search}${u.hash}`;
    if (GENERIC_IMAGE_RE.test(hay) || GENERIC_IMAGE_RE.test(url)) return true;
    if (GNEWS_LOGO_RE.test(url)) return true;
    // Tiny WordPress crop icons (?w=32) and channel feed marks.
    const w = u.searchParams.get("w");
    if (w && Number(w) > 0 && Number(w) <= 64) return true;
    return false;
  } catch {
    return true;
  }
}

export function isUsableStoryImage(url: string | undefined | null): boolean {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  if (/\.(m3u8|mp4|mp3)(\?|$)/i.test(url) || /fuel-streaming|\/video\//i.test(url)) return false;
  if (isGenericOutletImage(url)) return false;
  return true;
}

function normalizeCandidate(raw: string, baseUrl?: string): string | undefined {
  const cleaned = decodeHtmlEntities(raw).trim();
  if (!cleaned) return undefined;
  // Protocol-relative URLs appear in some RSS/OG tags.
  const withProto = cleaned.startsWith("//") ? `https:${cleaned}` : cleaned;
  return absolutize(withProto, baseUrl);
}

/** Prefer article photos over outlet stock when multiple candidates exist. */
export function pickBestImage(candidates: (string | undefined | null)[]): string | undefined {
  const urls: string[] = [];
  for (const raw of candidates) {
    if (!raw) continue;
    const url = normalizeCandidate(raw) ?? raw.replace(/&amp;/gi, "&").trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (/\.(m3u8|mp4|mp3)(\?|$)/i.test(url) || /fuel-streaming|\/video\//i.test(url)) continue;
    if (isGenericOutletImage(url)) continue;
    const looksImage =
      /\.(jpe?g|png|webp|gif)(\?|$)/i.test(url) ||
      // Common publisher/CDN patterns (often lack file extensions).
      /\/media2\/|wp-content\/uploads|resources\/media|cdn-cgi\/image|\/dims4\/|\/resize\/|\/crop\/|\/quality\/|brightspotcdn\.com|googleusercontent\.com|cloudfront|imgix|static/i.test(
        url,
      ) ||
      // Brightspot-like image proxies frequently embed the origin URL.
      /\b(?:url|image|img)=https?%3a%2f%2f/i.test(url);
    if (!looksImage) continue;
    if (!urls.includes(url)) urls.push(url);
  }
  // Prefer article photos; omit pure outlet stock so OG enrichment / placeholder can take over.
  return urls[0];
}

export function parseOgImageFromHtml(html: string, baseUrl?: string): string | undefined {
  const patterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image(?::src)?["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image(?::src)?["']/i,
    /<link[^>]+rel=["']image_src["'][^>]+href=["']([^"']+)["']/i,
  ];
  const found: string[] = [];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) found.push(decodeHtmlEntities(m[1]));
  }
  const absolute = found.map((raw) => absolutize(raw, baseUrl)).filter(Boolean) as string[];
  return pickBestImage(absolute);
}

function decodeHtmlEntities(raw: string): string {
  return raw
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function absolutize(raw: string, baseUrl?: string): string | undefined {
  try {
    return new URL(raw, baseUrl).href;
  } catch {
    return undefined;
  }
}

function cacheGet(key: string): string | null | undefined {
  const hit = ogCache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    ogCache.delete(key);
    return undefined;
  }
  return hit.image;
}

function cacheSet(key: string, image: string | null): void {
  ogCache.set(key, { image, at: Date.now() });
  if (ogCache.size > 400) {
    const first = ogCache.keys().next().value;
    if (first) ogCache.delete(first);
  }
}

/** Resolve Google News article URLs to the publisher page when feasible. */
export async function resolveArticleUrl(url: string): Promise<string> {
  if (!isGoogleNewsUrl(url)) return url;
  const cached = cacheGet(`resolve:${url}`);
  if (cached !== undefined && cached) return cached;
  if (cached === null) return url;

  try {
    const decoded = await decodeGoogleNewsArticleUrl(url);
    if (decoded && !isGoogleNewsUrl(decoded)) {
      cacheSet(`resolve:${url}`, decoded);
      return decoded;
    }
  } catch {
    /* failure-safe */
  }
  cacheSet(`resolve:${url}`, null);
  return url;
}

export function isGoogleNewsUrl(url: string): boolean {
  try {
    return GOOGLE_NEWS_HOST_RE.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Best-effort Google News article decode via the public batchexecute endpoint.
 * Failure-safe: returns undefined on captcha / timeout / parse miss.
 */
async function decodeGoogleNewsArticleUrl(url: string): Promise<string | undefined> {
  const m = url.match(/\/articles\/([^?#]+)/);
  if (!m?.[1]) return undefined;
  const articleId = decodeURIComponent(m[1]);
  // Embedded http(s) in older base64 payloads.
  try {
    const raw = Buffer.from(articleId.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const bytes = raw.toString("latin1");
    const start = Math.max(0, bytes.indexOf("https://"));
    const alt = start > 0 ? start : bytes.indexOf("http://");
    const idx = alt >= 0 ? alt : -1;
    if (idx >= 0) {
      let end = idx;
      while (end < bytes.length) {
        const c = bytes.charCodeAt(end);
        // Stop at control chars and DEL; keep typical URL punctuation.
        if (c < 0x20 || c === 0x7f) break;
        end += 1;
      }
      const candidate = bytes.slice(idx, end).trim();
      if (candidate.length >= 12 && candidate.length <= 400 && /^https?:\/\//i.test(candidate) && !isGoogleNewsUrl(candidate)) {
        // Validate parse; reject obvious truncations.
        try {
          // eslint-disable-next-line no-new
          new URL(candidate);
          return candidate;
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* continue */
  }

  const payload = [
    [
      [
        "Fbv4je",
        JSON.stringify([
          "garturlreq",
          [
            ["en-US", "US", ["FINANCE_TOP_INDICES", "WEB_TEST_1_0_0"], null, null, 1, 1, "US:en", null, 10, null, null, null, null, null, null, 0, 1],
            articleId,
            1,
            [1, 1],
          ],
        ]),
        null,
        "generic",
      ],
    ],
  ];
  const body = new URLSearchParams({ "f.req": JSON.stringify(payload) });
  const res = await fetch("https://news.google.com/_/DotsSplashUi/data/batchexecute?rpcids=Fbv4je", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
    },
    body,
    signal: AbortSignal.timeout(OG_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!res.ok) return undefined;
  const text = await res.text();
  const urls = text.match(/https?:\\\/\\\/[^"\\]+|https?:\/\/[^"\\\s<>]+/g) ?? [];
  for (const raw of urls) {
    const cleaned = raw.replace(/\\\//g, "/").replace(/\\u003d/gi, "=").replace(/\\u0026/gi, "&");
    if (/news\.google\.com|gstatic\.com|google\.com\/(?:_\/|recaptcha)/i.test(cleaned)) continue;
    if (/^https?:\/\//i.test(cleaned)) return cleaned;
  }
  return undefined;
}

export async function fetchOgImage(articleUrl: string): Promise<string | undefined> {
  const cached = cacheGet(`og:${articleUrl}`);
  if (cached !== undefined) return cached ?? undefined;

  try {
    const canonical = await resolveArticleUrl(articleUrl);
    const res = await fetch(canonical, {
      headers: {
        "User-Agent": UA,
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
      },
      signal: AbortSignal.timeout(OG_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) {
      cacheSet(`og:${articleUrl}`, null);
      return undefined;
    }
    const html = await res.text();
    // Cap parse work on huge pages. Prefer up through </head> so meta tags remain in-bounds
    // (some publishers and Google News ship extremely large <head> blocks).
    const headClose = html.search(/<\/head>/i);
    const cap = 700_000;
    const slice =
      headClose >= 0 && headClose < cap
        ? html.slice(0, headClose + "</head>".length)
        : html.length > cap
          ? html.slice(0, cap)
          : html;
    const image = parseOgImageFromHtml(slice, res.url || canonical);
    const usable = isUsableStoryImage(image) ? image! : undefined;
    cacheSet(`og:${articleUrl}`, usable ?? null);
    return usable;
  } catch {
    cacheSet(`og:${articleUrl}`, null);
    return undefined;
  }
}

export type ThumbEnrichable = { id: string; title: string; url: string; image?: string };

/**
 * Preserve good RSS thumbs; enrich missing / generic ones via OG (bounded concurrency).
 * Also borrow a sibling story's image when titles match closely.
 */
export async function enrichStoryImages<T extends ThumbEnrichable>(
  items: T[],
  opts: { max?: number } = {},
): Promise<T[]> {
  const max = opts.max ?? MAX_ENRICH;
  const out = items.map((item) => ({ ...item }));

  // Cross-borrow: identical/near-identical titles already carrying a good image.
  const byTitle = new Map<string, string>();
  for (const row of out) {
    if (isUsableStoryImage(row.image)) {
      byTitle.set(normTitle(row.title), row.image!);
    }
  }
  for (const row of out) {
    if (isUsableStoryImage(row.image)) continue;
    const borrowed = byTitle.get(normTitle(row.title));
    if (borrowed) row.image = borrowed;
  }

  const need = out
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => !isUsableStoryImage(row.image))
    .slice(0, max);

  await Promise.all(
    need.map(async ({ row, index }) => {
      const image = await fetchOgImage(row.url);
      if (image && isUsableStoryImage(image)) {
        // Do not overwrite a real photo with seal/logo (already filtered).
        out[index] = { ...out[index]!, image };
        byTitle.set(normTitle(row.title), image);
      }
    }),
  );

  // Second borrow pass after OG fills some gaps.
  for (const row of out) {
    if (isUsableStoryImage(row.image)) continue;
    const borrowed = byTitle.get(normTitle(row.title));
    if (borrowed) row.image = borrowed;
  }

  return out;
}

function normTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s[-–—]\s[^–—-]{2,60}$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Test helper — clear process-local cache. */
export function clearNewsThumbCache(): void {
  ogCache.clear();
}
