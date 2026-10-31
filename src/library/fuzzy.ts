/**
 * Forgiving word matching for typed names: case, accents, plurals, ordinals ("2nd" = "second" = "2"),
 * unfinished words and common typos (a missing, extra, wrong or swapped letter). Pure, no I/O.
 */

import { toAsciiDigits } from "../core/normalize/text.js";

const ORDINALS: Record<string, string> = {
  first: "1",
  second: "2",
  third: "3",
  fourth: "4",
  fifth: "5",
  sixth: "6",
  seventh: "7",
  eighth: "8",
  ninth: "9",
  tenth: "10",
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
};

/** One word in its comparable form. */
export function canonWord(raw: string): string {
  let w = toAsciiDigits(raw)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // accents
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  const ord = /^(\d+)(?:st|nd|rd|th)$/.exec(w);
  if (ord?.[1]) return ord[1];
  if (ORDINALS[w]) return ORDINALS[w] as string;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1); // sheets -> sheet
  return w;
}

/** Words of a phrase in comparable form; empty words dropped. */
export const words = (s: string): string[] =>
  s
    .split(/[^\p{L}\p{N}]+/u)
    .map(canonWord)
    .filter(Boolean);

/** Optimal string alignment distance (insert, delete, replace, swap neighbours); stops early above `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const prev2: number[] = [];
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + cost,
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        v = Math.min(v, (prev2[j - 2] as number) + 1);
      cur[j] = v;
      rowMin = Math.min(rowMin, v);
    }
    if (rowMin > max) return max + 1;
    prev2.length = 0;
    prev2.push(...prev);
    prev = cur;
  }
  return prev[b.length] as number;
}

const hasDigit = (s: string) => /\d/.test(s);

/** Typos allowed for a typed word of this length. */
const allowedTypos = (len: number) => (len < 4 ? 0 : len < 8 ? 1 : 2);

/**
 * How well a typed word matches one title word, 0..1.
 * exact 1 • beginning of the word ≈ .8–.99 • typo of the word ≈ .7–.85 • typo in an unfinished word ≈ .6–.75 • inside the word ≈ .6
 */
export function wordScore(q: string, t: string): number {
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (hasDigit(q) || hasDigit(t)) return 0; // numbers must match exactly ("1" is not "13")
  const ratio = Math.min(1, q.length / t.length);
  if (t.startsWith(q)) return 0.8 + 0.19 * ratio;
  const typos = allowedTypos(q.length);
  if (typos > 0) {
    const whole = editDistance(q, t, typos);
    if (whole <= typos) return 0.85 - 0.12 * whole;
    const head = t.slice(0, q.length);
    const part = editDistance(q, head, typos);
    if (part <= typos && q.length >= 5) return 0.75 - 0.1 * part;
    // one letter too many typed at the end of an unfinished word
    const part2 = editDistance(q, t.slice(0, q.length + 1), typos);
    if (part2 <= typos && q.length >= 5) return 0.72 - 0.1 * part2;
  }
  if (q.length >= 3 && t.includes(q)) return 0.6 + 0.1 * ratio;
  return 0;
}

const FILLER = new Set(["of", "and", "the", "to", "in", "for", "a", "an"]);
/** Words people add that carry no meaning for finding an index. */
export const NOISE = new Set([
  "index",
  "indexes",
  "subject",
  "course",
  "material",
  "files",
  "file",
]);

export interface Scored<T> {
  item: T;
  score: number;
}

/**
 * Scores one title against a typed query, 0 when it does not match. Every typed word must match a
 * different title word; "cellbiology" (no space) and initials ("cb") are understood too. Shorter titles
 * that the query fully covers rank higher.
 */
export function scoreTitle(queryWords: string[], title: string): number {
  const tw = words(title);
  if (queryWords.length === 0 || tw.length === 0) return 0;

  // 1) word by word, each title word used once
  const used = new Set<number>();
  let sum = 0;
  let ok = true;
  for (const q of queryWords) {
    let best = 0;
    let at = -1;
    tw.forEach((t, i) => {
      if (used.has(i)) return;
      const s = wordScore(q, t);
      if (s > best) {
        best = s;
        at = i;
      }
    });
    if (best === 0) {
      ok = false;
      break;
    }
    used.add(at);
    sum += best;
  }
  let score = 0;
  if (ok) {
    const meaningful = tw.filter((w) => !FILLER.has(w)).length || tw.length;
    const coverage = Math.min(1, queryWords.length / meaningful);
    score = (sum / queryWords.length) * (0.88 + 0.12 * coverage);
  }

  // 2) typed without spaces ("cellbiology") or as initials ("cb")
  const squashQ = queryWords.join("");
  const squashT = tw.join("");
  if (squashQ.length >= 4 && !hasDigit(squashQ)) {
    const head = squashT.slice(0, squashQ.length);
    const d = editDistance(squashQ, head, allowedTypos(squashQ.length));
    if (squashT.startsWith(squashQ))
      score = Math.max(score, 0.8 + 0.15 * (squashQ.length / squashT.length));
    else if (d <= allowedTypos(squashQ.length)) score = Math.max(score, 0.7 - 0.08 * d);
  }
  if (queryWords.length === 1) {
    const q = queryWords[0] as string;
    const initials = tw
      .filter((w) => !FILLER.has(w))
      .map((w) => w[0])
      .join("");
    if (q.length >= 2 && q.length <= 6 && initials.length >= 2 && !hasDigit(q)) {
      if (initials === q) score = Math.max(score, 0.82);
      else if (initials.startsWith(q)) score = Math.max(score, 0.7);
    }
  }
  return score;
}

/** Best matches first (score, then fewer words in the title, then input order). */
export function rank<T>(
  items: T[],
  titleOf: (i: T) => string,
  query: string,
  opts: { min?: number; limit?: number } = {},
): Scored<T>[] {
  const qw = words(query).filter((w) => !NOISE.has(w));
  if (qw.length === 0) return [];
  const min = opts.min ?? 0.55;
  return items
    .map((item, order) => ({
      item,
      order,
      score: scoreTitle(qw, titleOf(item)),
      n: words(titleOf(item)).length,
    }))
    .filter((x) => x.score >= min)
    .sort((a, b) => b.score - a.score || a.n - b.n || a.order - b.order)
    .slice(0, opts.limit ?? 8)
    .map(({ item, score }) => ({ item, score }));
}
