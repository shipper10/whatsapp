const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits to 0-9, so numbers typed on any keyboard work. */
export const toAsciiDigits = (s: string): string =>
  s
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)));

/**
 * Normalization for matching only (never shown to users): lowercases, removes accents, maps other
 * digit systems to 0-9, turns punctuation into spaces and collapses whitespace.
 */
export function normalizeText(input: string): string {
  let s = input.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  s = toAsciiDigits(s);
  s = s.replace(/[_\-./\\|]+/g, " ");
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** Hashtags as written by the channel (#Cardio_MCQ), normalized without the '#'. */
export function extractHashtags(text: string): string[] {
  const tags = text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(tags.map((t) => normalizeText(t.slice(1))))].filter(Boolean);
}
