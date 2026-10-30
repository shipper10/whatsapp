import { normalizeText } from "../core/normalize/arabic.js";

/**
 * The translation dictionary is a list of "arabic=english" pairs (setting `library.indexAliases`).
 * It is edited from the admin panel, so these helpers only read it; nothing here knows about storage.
 */
export interface Pair {
  ar: string;
  en: string;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function parsePairs(lines: string[]): Pair[] {
  const out: Pair[] = [];
  for (const line of lines) {
    const i = line.indexOf("=");
    if (i < 1) continue;
    const ar = clean(line.slice(0, i));
    const en = clean(line.slice(i + 1));
    if (ar && en) out.push({ ar, en });
  }
  return out;
}

export const formatPairs = (pairs: Pair[]) => pairs.map((p) => `${p.ar}=${p.en}`);

/** Same pair ignoring case, diacritics and the Arabic "ال". */
const key = (s: string) => normalizeText(s).replace(/(^| )ال/g, "$1");

/** Adds or replaces: a pair with the same Arabic side (or the same English side) is overwritten. */
export function upsertPair(pairs: Pair[], next: Pair): Pair[] {
  const ar = clean(next.ar);
  const en = clean(next.en);
  if (!ar || !en) return pairs;
  const kept = pairs.filter((p) => key(p.ar) !== key(ar));
  return [...kept, { ar, en }];
}

export const removePair = (pairs: Pair[], ar: string): Pair[] =>
  pairs.filter((p) => key(p.ar) !== key(ar));

const words = (s: string) => normalizeText(s).split(" ").filter(Boolean);

/**
 * Other spellings of a query: each Arabic phrase of the dictionary replaced by its English side and
 * the other way round. Lets "كيمياء حيوية" find files named "Biochemistry" and vice versa.
 */
export function expandQuery(query: string, pairs: Pair[], max = 4): string[] {
  const base = words(query);
  if (base.length === 0) return [];
  const variants = new Map<string, string[]>([[base.join(" "), base]]);
  for (const p of pairs) {
    for (const [from, to] of [
      [words(p.ar), words(p.en)],
      [words(p.en), words(p.ar)],
    ] as const) {
      if (from.length === 0) continue;
      for (const v of [...variants.values()]) {
        for (let i = 0; i + from.length <= v.length; i++) {
          if (from.every((w, k) => v[i + k] === w)) {
            const nv = [...v.slice(0, i), ...to, ...v.slice(i + from.length)];
            variants.set(nv.join(" "), nv);
          }
        }
      }
      if (variants.size >= max) return [...variants.keys()].slice(0, max);
    }
  }
  return [...variants.keys()].slice(0, max);
}

const STOP = new Set([
  "index",
  "the",
  "and",
  "of",
  "for",
  "in",
  "a",
  "an",
  "to",
  "with",
  "on",
  "year",
  "semester",
  "1st",
  "2nd",
  "3rd",
  "4th",
  "5th",
  "6th",
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
]);

/**
 * English words that appear in index titles but have no Arabic equivalent in the dictionary, most
 * frequent first. These are the words worth adding a translation for.
 */
export function untranslatedWords(titles: string[], pairs: Pair[], limit = 60) {
  const known = new Set(pairs.flatMap((p) => words(p.en)));
  const counts = new Map<string, { word: string; n: number; sample: string }>();
  for (const title of titles) {
    for (const raw of title.split(/[^\p{L}\p{N}]+/u)) {
      if (!/^[A-Za-z][A-Za-z-]{2,}$/.test(raw)) continue; // English words only
      const w = raw.toLowerCase();
      if (STOP.has(w) || known.has(w)) continue;
      const c = counts.get(w);
      if (c) c.n++;
      else counts.set(w, { word: w, n: 1, sample: title });
    }
  }
  return [...counts.values()]
    .sort((a, b) => b.n - a.n || a.word.localeCompare(b.word))
    .slice(0, limit);
}
