const TASHKEEL = /[ً-ٰٟۖ-ۭ]/g;
const TATWEEL = /ـ/g;
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";

/**
 * Normalization for matching only (never shown to users):
 * strips diacritics/tatweel, unifies alef/ya/ta-marbuta/hamza forms, maps Arabic-Indic digits,
 * lowercases Latin, removes punctuation, collapses whitespace.
 */
export function normalizeText(input: string): string {
  let s = input.normalize("NFKC").toLowerCase();
  s = s.replace(TASHKEEL, "").replace(TATWEEL, "");
  s = s.replace(/[آأإٱ]/g, "ا"); // آ أ إ ٱ -> ا
  s = s.replace(/ى/g, "ي"); // ى -> ي
  s = s.replace(/ة/g, "ه"); // ة -> ه
  s = s.replace(/ؤ/g, "و").replace(/ئ/g, "ي"); // ؤ -> و, ئ -> ي
  s = s.replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));
  s = s.replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)));
  s = s.replace(/[_\-./\\|]+/g, " ");
  s = s.replace(/[^\p{L}\p{N}\s]/gu, " ");
  return s.replace(/\s+/g, " ").trim();
}

/** Hashtags as written by the channel (#Cardio_MCQ), normalized without the '#'. */
export function extractHashtags(text: string): string[] {
  const tags = text.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(tags.map((t) => normalizeText(t.slice(1))))].filter(Boolean);
}
