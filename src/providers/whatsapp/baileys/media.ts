import type { AnyMessageContent } from "@whiskeysockets/baileys";

export type MediaKind = "audio" | "video" | "image" | "document";

export interface MediaInput {
  filePath: string;
  fileName: string;
  /** Declared type (Telegram's guess); the extension wins when we know it. */
  mimeType?: string;
  caption?: string;
  sizeBytes?: number;
}

export interface MediaPlan {
  kind: MediaKind;
  content: AnyMessageContent;
  /** Audio messages cannot carry a caption; send this as a separate text message. */
  followUpText?: string;
}

const AUDIO: Record<string, string> = {
  opus: "audio/ogg; codecs=opus",
  ogg: "audio/ogg; codecs=opus",
  oga: "audio/ogg; codecs=opus",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  amr: "audio/amr",
};
const VIDEO: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  "3gp": "video/3gpp",
};
const IMAGE: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const DOCUMENT: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  wav: "audio/wav",
  webm: "video/webm",
  mkv: "video/x-matroska",
  gif: "image/gif",
};

/** Largest sizes WhatsApp reliably accepts as an inline audio / video / image message; bigger ones go as documents. */
const LIMIT = { audio: 16 * 1024 * 1024, video: 64 * 1024 * 1024, image: 5 * 1024 * 1024 };

export const extensionOf = (name: string) =>
  /\.([a-z0-9]{1,6})$/i.exec(name)?.[1]?.toLowerCase() ?? "";

/**
 * Chooses how a file should be sent so WhatsApp can open it. Sending everything as a "document" with the
 * wrong type makes WhatsApp refuse formats like .opus ("sent in an unusual format"); audio, video and
 * images must travel as their own message kinds with a type WhatsApp recognises.
 */
export function planMedia(m: MediaInput): MediaPlan {
  const ext = extensionOf(m.fileName) || extensionOf(m.filePath);
  const size = m.sizeBytes ?? 0;
  const source = { url: m.filePath };

  if (AUDIO[ext] && size <= LIMIT.audio) {
    return {
      kind: "audio",
      content: { audio: source, mimetype: AUDIO[ext] as string, ptt: false },
      followUpText: m.caption || undefined,
    };
  }
  if (VIDEO[ext] && size <= LIMIT.video) {
    return {
      kind: "video",
      content: { video: source, mimetype: VIDEO[ext] as string, caption: m.caption },
    };
  }
  if (IMAGE[ext] && size <= LIMIT.image) {
    return {
      kind: "image",
      content: { image: source, mimetype: IMAGE[ext] as string, caption: m.caption },
    };
  }
  const mime =
    AUDIO[ext] ??
    VIDEO[ext] ??
    IMAGE[ext] ??
    DOCUMENT[ext] ??
    m.mimeType ??
    "application/octet-stream";
  return {
    kind: "document",
    content: {
      document: source,
      mimetype: mime.startsWith("audio/ogg") ? "audio/ogg" : mime,
      fileName: m.fileName,
      caption: m.caption,
    },
  };
}
