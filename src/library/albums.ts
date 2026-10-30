import type { TgRow } from "./classify.js";

/**
 * Telegram albums arrive as separate messages sharing a grouped id, and only one of them carries the
 * caption. For classification an album is ONE item: its first message, with the caption (and hashtags)
 * of whichever member has them. The other members are reachable through the first one at delivery time.
 */
export function mergeAlbums(rows: TgRow[]): TgRow[] {
  const groups = new Map<string, TgRow[]>();
  for (const r of rows) {
    if (!r.groupedId || !r.mediaType) continue;
    const key = `${r.chatId}:${r.groupedId}`;
    const list = groups.get(key);
    if (list) list.push(r);
    else groups.set(key, [r]);
  }
  const dropped = new Set<number>();
  const merged = new Map<number, TgRow>();
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    members.sort((a, b) => a.messageId - b.messageId);
    const [first, ...rest] = members as [TgRow, ...TgRow[]];
    const text = members.find((m) => m.text.trim())?.text ?? first.text;
    const hashtags = [...new Set(members.flatMap((m) => m.hashtags))];
    const entities = (members.find((m) => m.text.trim()) ?? first).entities;
    merged.set(first.dbId, { ...first, text, hashtags, entities });
    for (const m of rest) dropped.add(m.dbId);
  }
  return rows.filter((r) => !dropped.has(r.dbId)).map((r) => merged.get(r.dbId) ?? r);
}
