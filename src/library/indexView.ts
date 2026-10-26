import type { RawEntity } from "../telegram/types.js";

export type LinkKind = "lecture" | "sheet" | "mcq" | "other";

/** One numbered link of an index message (a lecture, a sheet, a sub-index, ...). */
export interface IndexEntry {
  /** The number shown to the user, 1-based, in order of first appearance. */
  n: number;
  /** Telegram message id the link points to. */
  targetId: number;
  label: string;
  kind: LinkKind;
  /** The "N -" ordinal of the item the link belongs to (e.g. Lecture 3), if any. */
  ord: number | null;
  /** Section of the index: 0 = title, 1 = main content, then one per "────" separator. */
  block: number;
}

export interface IndexSource {
  text: string;
  entities: RawEntity[];
  /** Channel username used to recognise links to its own messages (case-insensitive). */
  username: string | null;
}

export interface RenderedIndex {
  text: string;
  entries: IndexEntry[];
}

const SEPARATOR = /^[\s─━—\-_=]{5,}$/;
const HASHTAG_ONLY = /^(\s*#[\p{L}\p{N}_]+)+\s*$/u;
const ORDINAL = /^\s*(\d{1,3})\s*[-–.)]/;

const kindOf = (label: string): LinkKind => {
  if (/🎙|lecture|محاضر/i.test(label)) return "lecture";
  if (/📔|sheet|شيت|ورق/i.test(label)) return "sheet";
  if (/🎯|mcq|اسئل|أسئل/i.test(label)) return "mcq";
  return "other";
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Marker shown after a link's label, e.g. `Lecture【12】`. Distinct from the item numbering in the text. */
export const marker = (n: number) => `【${n}】`;

/**
 * Turns a Telegram index message into WhatsApp text where every link to a channel message carries a
 * number the user can send back, and returns what each number points to. Pure; no I/O.
 */
export function renderIndex(src: IndexSource): RenderedIndex {
  const linkRe = new RegExp(
    `^https?://t\\.me/${src.username ? escapeRe(src.username) : "[A-Za-z0-9_]+"}/(\\d+)(?:\\?.*)?$`,
    "i",
  );
  const links = src.entities
    .filter((e) => e.type === "text_link" && e.url)
    .sort((a, b) => a.offset - b.offset);

  const entries: IndexEntry[] = [];
  const byTarget = new Map<number, IndexEntry>();
  const out: string[] = [];
  let block = 0;
  let lastOrd: number | null = null;
  let headerKind: LinkKind = "other";

  let offset = 0;
  for (const line of src.text.split("\n")) {
    const start = offset;
    const end = start + line.length;
    offset = end + 1;

    if (SEPARATOR.test(line)) {
      block++;
      lastOrd = null;
      headerKind = "other";
      out.push(line.trim());
      continue;
    }
    if (HASHTAG_ONLY.test(line)) continue;

    const here = links.filter((e) => e.offset >= start && e.offset < end);
    const lineOrd = ORDINAL.exec(line)?.[1];
    if (lineOrd) lastOrd = Number(lineOrd);
    if (here.length === 0) {
      if (/:\s*$/.test(line.trim())) {
        lastOrd = null;
        headerKind = kindOf(line);
      }
      out.push(line);
      continue;
    }

    let text = "";
    let cursor = start;
    const numbered = new Set<number>();
    for (const e of here) {
      const eEnd = Math.min(e.offset + e.length, end);
      const label = src.text.slice(e.offset, eEnd);
      text += src.text.slice(cursor, e.offset) + label;
      cursor = eEnd;
      const url = e.url as string;
      const id = linkRe.exec(url)?.[1];
      if (!id) {
        if (url.trim() !== label.trim()) text += ` ${url}`;
        continue;
      }
      const target = Number(id);
      let entry = byTarget.get(target);
      const kind = kindOf(label);
      if (!entry) {
        entry = {
          n: entries.length + 1,
          targetId: target,
          label: label.trim(),
          kind: kind !== "other" ? kind : headerKind,
          ord: lastOrd,
          block,
        };
        entries.push(entry);
        byTarget.set(target, entry);
      } else if (entry.kind === "other" && kind !== "other") {
        entry.kind = kind;
      }
      if (!numbered.has(target)) {
        numbered.add(target);
        text += marker(entry.n);
      }
    }
    text += src.text.slice(cursor, end);
    out.push(text);
  }

  const joined = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text: joined, entries };
}

/** Splits long text on line boundaries so no WhatsApp message gets too large. */
export function chunkText(text: string, max = 3500): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (cur && cur.length + line.length + 1 > max) {
      chunks.push(cur);
      cur = "";
    }
    if (line.length > max) {
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/** Caption for a delivered file: the channel's own text without navigation lines and hashtags. */
export function cleanCaption(text: string, max = 900): string {
  const keep = text
    .split("\n")
    .filter((l) => !/^\s*↩️/.test(l) && !/return to|العودة إلى/i.test(l) && !HASHTAG_ONLY.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return keep.length > max ? `${keep.slice(0, max - 1)}…` : keep;
}
