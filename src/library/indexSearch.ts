import { normalizeText } from "../core/normalize/arabic.js";

export interface IndexTitle {
  messageId: number;
  title: string;
}

const SEPARATOR = /^[\s─━—\-_=]{5,}$/;
const NOISE = new Set(["فهرس", "index", "ماده", "subject", "course", "مادة"]);

/** "🧬 Cell Biology Index" -> "Cell Biology"; two-line headers ("1️⃣ First Year / 🗓 2nd Semester Index") are joined. */
export function indexTitle(text: string): string {
  const head: string[] = [];
  for (const line of text.split("\n")) {
    if (SEPARATOR.test(line)) break;
    head.push(line);
  }
  return head
    .join(" ")
    .replace(/[^\p{L}\p{N}\s&.\-]/gu, " ")
    .replace(/\bindex\b|فهرس/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const words = (s: string) =>
  normalizeText(s)
    .split(" ")
    .filter(Boolean)
    .map((w) => (w.length > 3 ? w.replace(/^ال/, "") : w));

/**
 * Finds index messages by (partial) name. `aliases` are "arabic=english" pairs so Arabic words reach
 * English titles ("كيمياء=Chemistry", "الفصل الثاني=2nd semester"). Pure; the caller loads the titles.
 */
export function matchIndexes(
  items: IndexTitle[],
  query: string,
  aliases: string[],
  limit = 8,
): IndexTitle[] {
  const base = words(query).filter((w) => !NOISE.has(w));
  if (base.length === 0) return [];

  const variants: string[][] = [base];
  for (const a of aliases) {
    const [from, to] = a.split("=");
    if (!from || !to) continue;
    const f = words(from);
    const t = words(to);
    for (const v of [...variants]) {
      for (let i = 0; i + f.length <= v.length; i++) {
        if (f.every((w, k) => v[i + k] === w))
          variants.push([...v.slice(0, i), ...t, ...v.slice(i + f.length)]);
      }
    }
  }

  const scored = new Map<number, { item: IndexTitle; score: number }>();
  for (const item of items) {
    const tw = words(item.title);
    for (const v of variants) {
      if (v.every((q) => tw.some((w) => w.startsWith(q)))) {
        const score = tw.length - (v === base ? 0.5 : 0);
        const prev = scored.get(item.messageId);
        if (!prev || score < prev.score) scored.set(item.messageId, { item, score });
      }
    }
  }
  return [...scored.values()]
    .sort((a, b) => a.score - b.score || a.item.messageId - b.item.messageId)
    .slice(0, limit)
    .map((x) => x.item);
}
