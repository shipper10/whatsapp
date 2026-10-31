import { rank } from "./fuzzy.js";

export interface IndexTitle {
  messageId: number;
  title: string;
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
  return rank(items, (i) => i.title, query, { limit }).map((r) => ({ ...r.item, score: r.score }));
}
