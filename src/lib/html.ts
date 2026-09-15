const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function codePoint(n: number, fallback: string): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return fallback;
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}

/**
 * Decode common HTML entities (named + numeric) into plain Unicode text.
 * Does not strip tags; call site may still need HTML removal/whitespace normalization.
 */
export function decodeHtmlEntities(raw: string): string {
  if (!raw || !raw.includes("&")) return raw;
  // Some upstreams double-escape (e.g. "&amp;nbsp;" or "&amp;#160;").
  // Decode up to a few passes so nested entities resolve without risking runaway loops.
  let out = raw.replaceAll("\u00A0", " ");
  for (let pass = 0; pass < 3; pass += 1) {
    const before = out;
    out = out
      // Tolerate missing semicolons for the most common whitespace entity.
      .replace(/&nbsp(?!;)/gi, "&nbsp;")
      .replace(/&#160(?!;)/g, "&#160;")
      .replace(/&#x0*a0(?!;)/gi, "&#xA0;")
      .replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, ent: string) => {
        const key = ent.toLowerCase();
        if (key in NAMED) return NAMED[key]!;
        if (key.startsWith("#x")) return codePoint(Number.parseInt(key.slice(2), 16), match);
        if (key.startsWith("#")) return codePoint(Number.parseInt(key.slice(1), 10), match);
        return match;
      })
      .replaceAll("\u00A0", " ");
    if (out === before) break;
  }
  // Prevent ugly runs of spaces produced by multiple &nbsp; (keep single spaces).
  out = out.replace(/[ \t]{2,}/g, " ");
  return out;
}

function cleanSnippet(raw: string | undefined | null): string {
  if (!raw) return "";
  // Normalize real NBSP characters even when there are no entity markers.
  const s = String(raw).replaceAll("\u00A0", " ");
  // Decode entities, strip any HTML tags, and collapse whitespace.
  return decodeHtmlEntities(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isJunkExcerpt(cleaned: string): boolean {
  if (!cleaned) return true;
  // Some Google News RSS descriptions for FB/X are essentially just a domain.
  // Treat "only this domain/URL" as unusable signal text.
  return /^(?:https?:\/\/)?(?:www\.)?(facebook\.com|twitter\.com|x\.com|news\.google\.com)(?:\/[^\s]*)?$/i.test(cleaned);
}

/**
 * Return `text` when it contains readable signal; otherwise fall back to `fallback`
 * (typically the item's title). Applies entity decode + whitespace normalization and
 * treats domain-only snippets (facebook.com / x.com / etc.) as unusable.
 */
export function usableExcerpt(text: string | undefined | null, fallback: string | undefined | null): string {
  const cleaned = cleanSnippet(text);
  if (!isJunkExcerpt(cleaned)) return cleaned;
  const fb = cleanSnippet(fallback);
  return fb || cleaned;
}

