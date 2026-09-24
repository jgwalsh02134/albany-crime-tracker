/**
 * Live scanner cards need a usable place or a serious incident.
 * Unit-status and bare town/agency chips stay on Radio captions.
 */

const SERIOUS_INCIDENT =
  /\b(shoot(?:ing|er)?|shots?\s*fired|gunfire|stab(?:bing|bed)?|homicide|murder|robbery|carjack|structure\s+fire|working\s+fire|building\s+fire|house\s+fire|vehicle\s+fire|car\s+fire|brush\s+fire|dumpster\s+fire|fully\s+involved|blaze|smoke\s+showing|crash|collision|rollover|hit[- ]and[- ]run|pedestrian\s+struck|\bfatal\b|person\s+down|man\s+down|overdose|unconscious|domestic|assault|burglary|hold[- ]?up|\barmed\b|\bweapon\b|active\s+shooter|\bswat\b|pursuit|\bdwi\b|intoxicat)\b/i;

const UNIT_STATUS =
  /\b(en route|in service|out of service|in quarters|10-4\b|10-8\b|10-7\b|10-6\b|10-19\b|copy that|roger|affirmative|standing by|clear the air|arriving on(?:\s+\w+){0,3}|on (?:the )?gate)\b/i;

const STREETISH =
  /\b(street|st\.?|avenue|ave\.?|road|rd\.?|boulevard|blvd\.?|drive|dr\.?|lane|ln\.?|parkway|pkwy|broadway|thruway|northway|i-?\d{2,3}|route\s*\d+|wolf|western|central|delaware|madison|pearl|lark|quail|everett|washington|swan|fuller|shaker)\b/i;

function signalText(title: string, summary: string): string {
  return `${title} ${summary}`
    .replace(/\bearly report from\b[\s\S]*$/i, " ")
    .replace(/\bnot a cad log\b[\s\S]*$/i, " ")
    .replace(
      /\b(?:albany|colonie|bethlehem|guilderland|county|menands|cohoes|watervliet|latham|delmar|westmere|volunteer)\s+fire\b/gi,
      " ",
    )
    .replace(/\bfire\s+(?:radio|department|dept)\b/gi, " ");
}

export function isLiveScannerCard(input: {
  title?: string;
  summary?: string;
  address?: string;
  geoPrecision?: string;
}): boolean {
  const signal = signalText(input.title ?? "", input.summary ?? "");
  const serious = SERIOUS_INCIDENT.test(signal);
  const precision = input.geoPrecision || "";
  const preciseGeo =
    precision === "street" || precision === "intersection" || precision === "landmark" || precision === "road";
  const addr = (input.address || "").trim();
  const addrStreet = Boolean(addr) && !/^area unknown$/i.test(addr) && STREETISH.test(addr);
  const usable = preciseGeo || addrStreet;
  if (!usable && !serious) return false;
  if (!usable && UNIT_STATUS.test(signal) && !serious) return false;
  return true;
}
