import type { AnyMessageContent } from "@whiskeysockets/baileys";

export type MediaKind = "audio" | "video" | "image" | "document";

export interface MediaInput {
  filePath: string;
  fileName: string;
  /** Declared type (Telegram's guess); the extension wins when we know it. */
  mimeType?: string;
  caption?: string;
  sizeBytes?: number;
  /** First bytes of the file; the real container is detected from them instead of trusting the name. */
  head?: Buffer;
  /** Send audio as a document (attachment) instead of an audio message. */
  audioAsDocument?: boolean;
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

/**
 * Largest sizes sent as an inline audio / video / image message; bigger ones go as documents.
 * (The 16 MB / 5 MB figures in Meta's docs are for the business Cloud API; the normal app is looser, but
 * images stay small because WhatsApp recompresses them.)
 */
const LIMIT = { audio: 64 * 1024 * 1024, video: 64 * 1024 * 1024, image: 5 * 1024 * 1024 };

export type SniffedAudio = "ogg-opus" | "ogg-other" | "mp3" | "aac" | "m4a" | "amr" | "wav" | null;

/** Detects the real audio container from the first bytes (file extensions and Telegram's type are often wrong). */
export function sniffAudio(b: Buffer | undefined): SniffedAudio {
  if (!b || b.length < 12) return null;
  const ascii = (from: number, to: number) => b.subarray(from, to).toString("latin1");
  if (ascii(0, 4) === "OggS") return b.includes("OpusHead") ? "ogg-opus" : "ogg-other";
  if (ascii(0, 3) === "ID3") return "mp3";
  if (ascii(0, 5) === "#!AMR") return "amr";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (ascii(4, 8) === "ftyp") return "m4a";
  if (b[0] === 0xff && ((b[1] as number) & 0xf6) === 0xf0) return "aac"; // ADTS
  if (b[0] === 0xff && ((b[1] as number) & 0xe0) === 0xe0) return "mp3"; // MPEG frame sync
  return null;
}
const SNIFF_AUDIO_MIME: Record<Exclude<SniffedAudio, null | "ogg-other" | "wav">, string> = {
  "ogg-opus": "audio/ogg; codecs=opus",
  mp3: "audio/mpeg",
  aac: "audio/aac",
  m4a: "audio/mp4",
  amr: "audio/amr",
};

export const extensionOf = (name: string) =>
  /\.([a-z0-9]{1,6})$/i.exec(name)?.[1]?.toLowerCase() ?? "";

/**
 * Chooses how a file should be sent so WhatsApp can open it. Sending everything as a "document" with the
 * wrong type makes WhatsApp refuse formats like .opus ("sent in an unusual format"); audio, video and
 * images must travel as their own message kinds with a type WhatsApp recognises.
 */
export function planMedia(m: MediaInput): MediaPlan {
  let ext = extensionOf(m.fileName) || extensionOf(m.filePath);
  let fileName = m.fileName;
  const size = m.sizeBytes ?? 0;
  const source = { url: m.filePath };

  // Audio: trust the bytes over the name. Ogg/Opus is always sent as .ogg (WhatsApp rejects a bare ".opus").
  const sniffed = sniffAudio(m.head);
  if (sniffed === "ogg-opus" || sniffed === "ogg-other" || ext === "opus" || ext === "oga") {
    if (ext !== "ogg") fileName = fileName.replace(/\.[a-z0-9]{1,6}$/i, "") + ".ogg";
    ext = "ogg";
  }
  const audioMime =
    sniffed && sniffed in SNIFF_AUDIO_MIME
      ? SNIFF_AUDIO_MIME[sniffed as keyof typeof SNIFF_AUDIO_MIME]
      : undefined;
  const inlineAudio =
    (sniffed ? audioMime !== undefined : AUDIO[ext] !== undefined) &&
    size <= LIMIT.audio &&
    !m.audioAsDocument;
  if (inlineAudio) {
    return {
      kind: "audio",
      content: { audio: source, mimetype: (audioMime ?? AUDIO[ext]) as string, ptt: false },
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
      fileName,
      caption: m.caption,
    },
  };
}

export const isAudioName = (name: string) => extensionOf(name) in AUDIO;
