import type { RawEntity, RawMedia, RawTelegramMessage } from "./types.js";

/**
 * Converts one message of a Telegram Desktop `result.json` export into RawTelegramMessage.
 * TEST/FIXTURE USE ONLY: production reads Telegram directly through GramJS.
 */
type Part = string | { type: string; text: string; href?: string };
interface ExportMessage {
  id: number;
  type: string;
  date: string;
  edited?: string;
  text: Part[] | string;
  media_type?: string;
  file_name?: string;
  mime_type?: string;
  file_size?: number;
  file?: string;
}

const entityType = (t: string): RawEntity["type"] =>
  t === "hashtag" ? "hashtag" : t === "text_link" ? "text_link" : t === "link" ? "url" : "other";

export function fromExport(m: ExportMessage): RawTelegramMessage | null {
  if (m.type !== "message") return null;
  const parts = typeof m.text === "string" ? [m.text] : m.text;
  let text = "";
  const entities: RawEntity[] = [];
  for (const p of parts) {
    if (typeof p === "string") {
      text += p;
    } else {
      entities.push({
        type: entityType(p.type),
        offset: text.length,
        length: p.text.length,
        url: p.href,
      });
      text += p.text;
    }
  }
  let media: RawMedia | undefined;
  if (m.file || m.media_type) {
    const kind =
      m.media_type === "audio_file"
        ? "audio"
        : m.media_type === "video_file"
          ? "video"
          : m.file_name
            ? "document"
            : "other";
    media = { kind, fileName: m.file_name, mimeType: m.mime_type, sizeBytes: m.file_size };
  }
  return {
    id: m.id,
    date: new Date(m.date),
    editDate: m.edited ? new Date(m.edited) : undefined,
    text,
    entities,
    media,
  };
}
