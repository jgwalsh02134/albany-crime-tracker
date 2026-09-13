/**
 * Whisper / STT hallucination and boilerplate rejection.
 * Keep this list aggressive — junk must never become Live or scannerHeard.
 */

const BOILERPLATE =
  /\b(?:thank(?:s|\s+you)?\s+for\s+watching|thanks\s+for\s+listening|please\s+(?:like|subscribe|comment)|subscribe\s+to\s+(?:my|the|our)|hit\s+(?:the\s+)?(?:like|bell|subscribe)|smash\s+that\s+like|leave\s+a\s+comment|follow\s+(?:me|us)\s+on|don'?t\s+forget\s+to\s+subscribe|ring\s+the\s+bell|patreon|sponsor(?:ed)?\s+by|this\s+video\s+is\s+sponsored)\b/i;

const SILENCE_MARKERS =
  /^(?:silence|blank|inaudible|music|\[(?:silence|blank|inaudible|music|no\s*audio)\]|\(+.*?quiet.*?\)+|\.+|…+)$/i;

const FOREIGN_DISPATCH =
  /\b(?:brooklyn\s+north|brooklyn|queens|bronx|manhattan|nycha|automatic\s+line|nypd\s+citywide)\b/i;

const GARBAGE_FILLER =
  /\b(?:\[music\]|♪|♫|copyright\s+free|royalty\s+free|ambient\s+noise|white\s+noise|test\s+tone|asmr)\b/i;

/** Very short YouTube / podcast outros that Whisper invents on silence. */
const OUTRO_ONLY =
  /^(?:thank(?:s|\s+you)?[.!]?\s*)?(?:for\s+watching|bye[- ]?bye|goodbye|see\s+you(?:\s+next\s+time)?|have\s+a\s+(?:nice|good)\s+day)[.!]*$/i;

export function isSttJunk(text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (t.length < 3) return true;
  if (!/[a-z0-9]/i.test(t)) return true;
  if (SILENCE_MARKERS.test(t)) return true;
  if (OUTRO_ONLY.test(t)) return true;
  if (BOILERPLATE.test(t)) return true;
  if (GARBAGE_FILLER.test(t)) return true;
  if (FOREIGN_DISPATCH.test(t)) return true;
  // Hallucinated ten-code salad / comma spam (classic Whisper on silence).
  if ((t.match(/10-\d+/g) || []).length >= 3) return true;
  if (/copy\s+en\s+route\s+on\s+scene/i.test(t)) return true;
  if ((t.match(/,/g) || []).length >= 6) return true;
  // Pure thank-you / subscribe blurbs even with trailing noise.
  if (/thank(?:s|\s+you)?\s+for\s+watching/i.test(t) && t.length < 80) return true;
  if (/subscribe/i.test(t) && t.length < 60 && !/\b(?:street|avenue|albany|colonie|crash|fire)\b/i.test(t)) {
    return true;
  }
  // Whisper news-article / distant-agency hallucinations (classic on silence/ads).
  if (/https?:\/\/|www\.|\.(?:com|org|net|gov)\b/i.test(t)) return true;
  if (/for more information|visit www|press release|arrest warrant was issued|counts? in the office of a federal/i.test(t)) return true;
  if (/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2},?\s+20\d{2}\b/i.test(t)) return true;
  // Far-away agencies / cities that are not Capital Region radio.
  if (/\b(?:portland|seattle|chicago|houston|dallas|phoenix|miami|atlanta|denver|boston|los angeles|san francisco|san diego|baltimore|detroit|minneapolis|milwaukee|louisiana|new orleans|baton rouge|mississippi|alabama|philippines)\b/i.test(t)) {
    return true;
  }
  if (/\b(?:portlandpolice|lapd|nypd|chicago\s+pd|nopd|orleans\s+parish)\b/i.test(t)) return true;
  // Distant "police department" news prose without Capital Region place.
  if (/\bpolice\s+department\b/i.test(t) && /\b(?:operator|for more information|arrest warrant)\b/i.test(t)
    && !/\b(?:albany|colonie|bethlehem|guilderland|central|western|wolf|latham|delmar)\b/i.test(t)) {
    return true;
  }
  // Long past-tense news prose (radio is short clipped speech).
  const sentences = t.split(/[.!?]+/).map((s) => s.trim()).filter((s) => s.length > 20);
  if (sentences.length >= 3 && t.length > 160) {
    const pasty = sentences.filter((s) =>
      /\b(?:was|were|reported|arrested|issued|eventually|killing|killed|charged)\b/i.test(s),
    ).length;
    if (pasty >= 2) return true;
  }
  // Extremely long single caption — radio lines are short.
  if (t.length > 280 && !/\b(?:central|western|wolf|albany|colonie|bethlehem|guilderland)\b/i.test(t)) {
    return true;
  }

  // Whisper filler on silence / ads: "you you", "uh uh", "yeah yeah".
  const FILLER = new Set(["you", "uh", "um", "ah", "oh", "yeah", "yep", "okay", "ok", "hmm", "mm", "mmm", "huh", "ha", "hey"]);
  const words = t.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
  if (words.length >= 1 && words.length <= 6 && words.every((w) => FILLER.has(w))) return true;
  if (words.length >= 2 && new Set(words).size === 1 && words[0]!.length <= 4) return true;
  return false;
}

/** Export phrase samples for unit tests / docs. */
export const STT_JUNK_SAMPLES = [
  "Thank you for watching.",
  "Thanks for watching!",
  "thanks for watching",
  "Please like and subscribe",
  "Subscribe to my channel",
  "Don't forget to subscribe",
  "Smash that like button",
  "[music]",
  "silence",
  "inaudible",
  "Brooklyn North automatic line",
  "10-4 10-8 10-7",
  "copy en route on scene",
  "Bye bye",
  "See you next time",
  "you you",
  "uh uh",
  "yeah yeah",
  "Operator, police chase a man reported killing a man on the street. Other police officers eventually arrested the man. An arrest warrant was issued for him on December 18, 2015 for three counts in the office of a federal police officer. For more information, visit www.PortlandPolice.com",
  "For more information visit www.example.com",
  "Louisiana State Police issued a press release on January 4, 2024",
  "New Orleans police arrested a man after a shooting downtown",
] as const;

export const STT_KEEP_SAMPLES = [
  "Colonie PD responding to a crash on Wolf Road",
  "Welfare check at 200 Central Avenue Albany",
  "Structure fire Delaware Avenue Bethlehem",
  "Engine 1 en route to Western Avenue",
  "92 Central Avenue welfare check",
  "Traffic stop Central and Quail",
] as const;
