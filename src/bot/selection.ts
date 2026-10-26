import { normalizeText } from "../core/normalize/arabic.js";
import type { IndexEntry, LinkKind } from "../library/indexView.js";

/** What the participant asked for: link numbers, or "sheets 1-5" style typed batches. */
export type Selection =
  | { kind: "numbers"; nums: number[] }
  | { kind: "typed"; type: Exclude<LinkKind, "other">; nums: number[] | null };

const MAX_NUMBERS = 200;
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

const TYPE_WORDS: Record<string, Exclude<LinkKind, "other">> = {
  sheet: "sheet",
  sheets: "sheet",
  شيت: "sheet",
  شيتات: "sheet",
  ورقه: "sheet",
  اوراق: "sheet",
  lecture: "lecture",
  lectures: "lecture",
  lec: "lecture",
  lecs: "lecture",
  محاضره: "lecture",
  محاضرات: "lecture",
  mcq: "mcq",
  mcqs: "mcq",
  اسئله: "mcq",
  اسيله: "mcq",
};
const ALL_WORDS = new Set(["all", "كل", "جميع", "كامل"]);

/** "5", "1-5", "1 to 5", "من 1 الى 5", "1,3,5-7", "1 و 3". Returns null when not purely numeric. */
export function parseNumberList(raw: string): number[] | null {
  const s = raw
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .toLowerCase()
    .replace(/[،؛;]/g, ",")
    .replace(/[–—~]/g, "-")
    .replace(/(^|\s)(من|from)(?=\s|$)/g, " ")
    .replace(/(^|\s)(الى|إلى|الي|حتى|to|until|till)(?=\s|$)/g, "-")
    .replace(/(\d)\s*و\s*(?=\d)/g, "$1,")
    .replace(/\s*-\s*/g, "-")
    .trim();
  if (!/^[\d\s,-]+$/.test(s) || !/\d/.test(s)) return null;
  const nums: number[] = [];
  for (const tok of s.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d{1,4})(?:-(\d{1,4}))?$/.exec(tok);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) {
      nums.push(i);
      if (nums.length > MAX_NUMBERS) return null;
    }
  }
  return [...new Set(nums)];
}

export function parseSelection(raw: string): Selection | null {
  const plain = parseNumberList(raw);
  if (plain) return { kind: "numbers", nums: plain };

  const words = normalizeText(raw).split(" ").filter(Boolean);
  let all = false;
  if (words[0] && ALL_WORDS.has(words[0])) {
    all = true;
    words.shift();
  }
  const first = words[0]?.replace(/^ال(?=\p{L}{3,})/u, ""); // "الشيتات" -> "شيتات"
  const type = first ? (TYPE_WORDS[first] ?? TYPE_WORDS[words[0] as string]) : undefined;
  if (!type) return null;
  words.shift();
  if (words.length === 0) return all ? { kind: "typed", type, nums: null } : null;
  const nums = parseNumberList(rawTail(raw));
  return nums ? { kind: "typed", type, nums } : null;
}

/** The original text after the keyword (keeps "-" that normalizeText would drop). */
function rawTail(raw: string): string {
  return raw
    .trim()
    .replace(/^(كل|جميع|كامل|all)\s+/i, "")
    .replace(/^\S+\s*/, "");
}

/**
 * Typed batches are resolved against the first section of the index that has matching items,
 * which is the main lectures/sheets list; Lab/Exams/Notes sections are only used if the main one has none.
 */
export function resolveTyped(
  entries: IndexEntry[],
  sel: Extract<Selection, { kind: "typed" }>,
): IndexEntry[] {
  const ofType = entries.filter((e) => e.kind === sel.type);
  const blocks = [...new Set(ofType.map((e) => e.block))].sort((a, b) => a - b);
  for (const b of blocks) {
    const inBlock = ofType.filter((e) => e.block === b);
    const picked =
      sel.nums === null
        ? inBlock
        : inBlock.filter((e) => e.ord !== null && sel.nums?.includes(e.ord));
    if (picked.length > 0) return picked;
  }
  return [];
}
