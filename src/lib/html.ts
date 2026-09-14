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
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g, (match, ent: string) => {
    const key = ent.toLowerCase();
    if (key in NAMED) return NAMED[key]!;
    if (key.startsWith("#x")) return codePoint(Number.parseInt(key.slice(2), 16), match);
    if (key.startsWith("#")) return codePoint(Number.parseInt(key.slice(1), 10), match);
    return match;
  });
}

