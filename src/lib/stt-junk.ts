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
] as const;

export const STT_KEEP_SAMPLES = [
  "Colonie PD responding to a crash on Wolf Road",
  "Welfare check at 200 Central Avenue Albany",
  "Structure fire Delaware Avenue Bethlehem",
  "Engine 1 en route to Western Avenue",
] as const;
