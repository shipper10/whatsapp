import { createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ResourceSourceDetail } from "../library/browse.js";

export interface FetchedFile {
  path: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
}

/** Brings one source copy to a local temp file, only so it can be forwarded. Never inspects content. */
export interface FileFetcher {
  readonly type: ResourceSourceDetail["type"];
  canFetch(src: ResourceSourceDetail): boolean;
  fetch(
    src: ResourceSourceDetail,
    destDir: string,
    maxBytes: number,
    signal: AbortSignal,
    onProgress?: (done: number, total: number | null) => void,
  ): Promise<FetchedFile>;
}

export class FetchTooLargeError extends Error {
  constructor() {
    super("file exceeds the configured size limit");
  }
}

const MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/** Adds the extension implied by the MIME type when a name has none (voice notes and photos have no file name). */
export function withExtension(name: string, mime: string | null | undefined): string {
  if (/\.[a-z0-9]{1,6}$/i.test(name)) return name;
  const ext = mime ? MIME_EXT[mime.toLowerCase().split(";")[0]?.trim() ?? ""] : undefined;
  return ext ? `${name}.${ext}` : name;
}

/** Safe local file name: no separators/control chars, bounded length, keeps the extension. */
export function safeFileName(name: string | null | undefined, fallback = "file"): string {
  const cleaned = (name ?? "")
    .replace(/[\\/\u0000-\u001f<>:"|?*]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned) return fallback;
  if (cleaned.length <= 120) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 8 ? cleaned.slice(dot) : "";
  return cleaned.slice(0, 120 - ext.length) + ext;
}

/** Removes leftover per-delivery temp dirs older than ttl (crash/timeout safety net). */
export async function sweepTempDir(root: string, ttlMs: number, now = Date.now()): Promise<number> {
  await mkdir(root, { recursive: true });
  let removed = 0;
  for (const name of await readdir(root)) {
    if (!name.startsWith("dl-")) continue;
    const p = join(root, name);
    const st = await stat(p).catch(() => null);
    if (st && now - st.mtimeMs >= ttlMs) {
      await rm(p, { recursive: true, force: true });
      removed++;
    }
  }
  return removed;
}

/** Streams a web ReadableStream/Node stream to disk, aborting once maxBytes is exceeded. */
export async function streamToFile(
  source: NodeJS.ReadableStream,
  path: string,
  maxBytes: number,
  onProgress?: (done: number) => void,
): Promise<number> {
  let written = 0;
  const out = createWriteStream(path);
  source.on("data", (c: Buffer) => {
    written += c.length;
    onProgress?.(written);
    if (written > maxBytes)
      (source as unknown as { destroy(e?: Error): void }).destroy(new FetchTooLargeError());
  });
  await pipeline(source, out);
  return written;
}
