import { rank } from "./fuzzy.js";

export interface IndexTitle {
  messageId: number;
  title: string;
  /** Other names the channel uses for it, e.g. the link text in the semester index ("Medical Professionalism"). */
  aliases?: string[];
}

export type ScoredIndex = IndexTitle & { score: number };

const SEPARATOR = /^[\s─━—\-_=]{5,}$/;

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
    .replace(/\bindex\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Index messages whose title matches a typed name, best first (see fuzzy.ts for what "matches" means). */
export function matchIndexes(items: IndexTitle[], query: string, limit = 8): ScoredIndex[] {
  const names = items.flatMap((i) => [i.title, ...(i.aliases ?? [])].map((name) => ({ i, name })));
  const best = new Map<number, ScoredIndex>();
  for (const r of rank(names, (n) => n.name, query, { limit: names.length })) {
    const cur = best.get(r.item.i.messageId);
    if (!cur || r.score > cur.score) best.set(r.item.i.messageId, { ...r.item.i, score: r.score });
  }
  return [...best.values()].slice(0, limit);
}

/** Text of a link label without emoji and brackets: "🫀 [Cardiovascular System](…) · 4 CH" -> "Cardiovascular System". */
export function linkLabel(label: string): string {
  return label
    .replace(/[^\p{L}\p{N}\s&.\-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
