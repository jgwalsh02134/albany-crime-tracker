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

