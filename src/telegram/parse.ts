import { extractHashtags } from "../core/normalize/arabic.js";
import type { RawTelegramMessage, TelegramRecord } from "./types.js";

export interface ParseContext {
  chatId: bigint;
  /** Public username, e.g. "BahriMed". Used for permalinks and to recognise internal links. */
  username: string | null;
}

const slice = (text: string, offset: number, length: number) => text.slice(offset, offset + length);

/** Pure, metadata-only parsing of one message. Never touches file contents. */
export function parseMessage(raw: RawTelegramMessage, ctx: ParseContext): TelegramRecord {
  const links: string[] = [];
  const tagsFromEntities: string[] = [];
  let returnIndexId: number | null = null;
  const internalIds: number[] = [];
  const linkRe = ctx.username
    ? new RegExp(`^https?://t\\.me/${ctx.username}/(\\d+)(?:\\?.*)?$`, "i")
    : null;

  for (const e of raw.entities) {
    if (e.type === "hashtag") tagsFromEntities.push(slice(raw.text, e.offset, e.length));
    const url =
      e.type === "text_link"
        ? e.url
        : e.type === "url"
          ? slice(raw.text, e.offset, e.length)
          : undefined;
    if (!url) continue;
    links.push(url);
    const m = linkRe?.exec(url);
    if (m?.[1]) {
      const id = Number(m[1]);
      internalIds.push(id);
      const label = slice(raw.text, e.offset, e.length);
      if (/^\s*(return|back)\b|رجوع|العودة/i.test(label)) {
        returnIndexId ??= id;
      }
    }
  }

  const hashtags = [
    ...new Set([...extractHashtags(tagsFromEntities.join(" ")), ...extractHashtags(raw.text)]),
  ];
  const uniqueInternal = [...new Set(internalIds)];
  const media = raw.media;

  return {
    chatId: ctx.chatId,
    messageId: raw.id,
    messageDate: raw.date,
    editDate: raw.editDate ?? null,
    textOrCaption: raw.text,
    entities: raw.entities,
    hashtags,
    links: [...new Set(links)],
    internalLinkIds: uniqueInternal,
    returnIndexId,
    mediaType: media?.kind ?? null,
    fileName: media?.fileName ?? null,
    mimeType: media?.mimeType ?? null,
    fileSizeBytes: media?.sizeBytes ?? null,
    permalink: ctx.username ? `https://t.me/${ctx.username}/${raw.id}` : null,
    isIndex: !media && uniqueInternal.length >= 2,
  };
}
