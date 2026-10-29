import { type FileHandle, open, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** WhatsApp plays audio inline only up to 16 MB; bigger files are cut into parts below this size. */
export const AUDIO_INLINE_MAX = 16 * 1024 * 1024;
export const AUDIO_PART_BYTES = 15 * 1000 * 1000;

export type AudioFormat = "mp3" | "aac" | "ogg" | "amr" | "wav" | "m4a";

const EXT: Record<string, AudioFormat> = {
  mp3: "mp3",
  aac: "aac",
  ogg: "ogg",
  oga: "ogg",
  opus: "ogg",
  amr: "amr",
  wav: "wav",
  m4a: "m4a",
  mp4: "m4a",
};

const extOf = (n: string) => /\.([a-z0-9]{1,6})$/i.exec(n)?.[1]?.toLowerCase() ?? "";

/** Real container from the first bytes, falling back to the file extension. */
export function audioFormat(fileName: string, head: Buffer): AudioFormat | null {
  const a = (f: number, t: number) => head.subarray(f, t).toString("latin1");
  if (a(0, 4) === "OggS") return "ogg";
  if (a(0, 5) === "#!AMR") return "amr";
  if (a(0, 4) === "RIFF" && a(8, 12) === "WAVE") return "wav";
  if (a(0, 3) === "ID3") return "mp3";
  if (a(4, 8) === "ftyp") return "m4a";
  if (head[0] === 0xff && ((head[1] ?? 0) & 0xf6) === 0xf0) return "aac";
  if (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0) return "mp3";
  return EXT[extOf(fileName)] ?? null;
}

export const looksLikeAudio = (mime: string | null, fileName: string) =>
  (mime?.startsWith("audio/") ?? false) || extOf(fileName) in EXT;

async function readAt(fh: FileHandle, pos: number, len: number): Promise<Buffer> {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return buf.subarray(0, bytesRead);
}

const AMR_NB = [13, 14, 16, 18, 20, 21, 27, 32, 6, 6, 6, 6, 0, 0, 0, 1];

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();
function oggCrc(b: Buffer): number {
  let c = 0;
  for (const x of b) c = ((c << 8) ^ (CRC[((c >>> 24) ^ x) & 0xff] as number)) >>> 0;
  return c >>> 0;
}

/** Renumbers pages and shifts granule positions so each part starts at zero (correct duration), then fixes checksums. */
function rebaseOgg(data: Buffer, firstSeq: number, baseGranule: bigint): Buffer {
  const out = Buffer.from(data);
  let pos = 0;
  let seq = firstSeq;
  while (pos + 27 <= out.length) {
    const nseg = out[pos + 26] as number;
    let body = 0;
    for (let i = 0; i < nseg; i++) body += out[pos + 27 + i] as number;
    const len = 27 + nseg + body;
    const g = out.readBigInt64LE(pos + 6);
    if (g > 0n) out.writeBigInt64LE(g - baseGranule, pos + 6);
    out.writeUInt32LE(seq++, pos + 18);
    pos += len;
    if (pos >= out.length) out[pos - len + 5] = (out[pos - len + 5] as number) | 0x04; // end of stream
    out.writeUInt32LE(0, pos - len + 22);
    out.writeUInt32LE(oggCrc(out.subarray(pos - len, pos)), pos - len + 22);
  }
  return out;
}

/** A tiny, valid OpusTags page (no comments, no cover art) to replace oversized ones. */
function minimalTagsPage(serial: number): Buffer {
  const vendor = Buffer.from("library-bot");
  const body = Buffer.alloc(8 + 4 + vendor.length + 4);
  body.write("OpusTags", 0, "latin1");
  body.writeUInt32LE(vendor.length, 8);
  vendor.copy(body, 12);
  const page = Buffer.alloc(28 + body.length);
  page.write("OggS", 0, "latin1");
  page.writeUInt32LE(serial, 14);
  page.writeUInt32LE(1, 18);
  page[26] = 1;
  page[27] = body.length;
  body.copy(page, 28);
  page.writeUInt32LE(oggCrc(page), 22);
  return page;
}

type Ranges = {
  prefix?: Buffer;
  from: number;
  to: number;
  baseGranule?: bigint;
  /** true when an oversized tags block was replaced */
  cleaned?: boolean;
}[];

const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MP3_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/** Length of the Layer III frame starting at i, or 0 when there is no valid header there. */
function mp3FrameLen(b: Buffer, i: number): number {
  if (i + 4 > b.length || b[i] !== 0xff || ((b[i + 1] as number) & 0xe0) !== 0xe0) return 0;
  const version = ((b[i + 1] as number) >> 3) & 3; // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5
  const layer = ((b[i + 1] as number) >> 1) & 3; // 1 = Layer III
  const brIdx = ((b[i + 2] as number) >> 4) & 15;
  const srIdx = ((b[i + 2] as number) >> 2) & 3;
  if (version === 1 || layer !== 1 || brIdx === 0 || brIdx === 15 || srIdx === 3) return 0;
  const rate = (MP3_RATES[version] as number[])[srIdx] as number;
  const kbps = (version === 3 ? MP3_BITRATES_V1_L3 : MP3_BITRATES_V2_L3)[brIdx] as number;
  const pad = ((b[i + 2] as number) >> 1) & 1;
  return Math.floor(((version === 3 ? 144 : 72) * kbps * 1000) / rate) + pad;
}

/** Length of the ADTS (AAC) frame at i, or 0. */
function aacFrameLen(b: Buffer, i: number): number {
  if (i + 7 > b.length || b[i] !== 0xff || ((b[i + 1] as number) & 0xf6) !== 0xf0) return 0;
  if ((((b[i + 2] as number) >> 2) & 15) >= 13) return 0;
  const len =
    (((b[i + 3] as number) & 3) << 11) | ((b[i + 4] as number) << 3) | ((b[i + 5] as number) >> 5);
  return len >= 7 ? len : 0;
}

/** A real frame boundary: valid header here AND another valid header right after it (when we can see that far). */
function isFrameStart(b: Buffer, i: number, aac: boolean): boolean {
  const f = aac ? aacFrameLen : mp3FrameLen;
  const len = f(b, i);
  if (!len) return false;
  return i + len + 4 > b.length ? true : f(b, i + len) > 0;
}

/** Where the audio really starts: after an ID3v2 tag, and after a VBR "Xing"/"Info" frame (which describes the WHOLE file). */
async function mp3Bounds(
  fh: FileHandle,
  size: number,
  dropInfoFrame: boolean,
): Promise<{ start: number; end: number }> {
  const head = await readAt(fh, 0, 16);
  let start = 0;
  if (head.subarray(0, 3).toString("latin1") === "ID3") {
    const tag =
      (((head[6] as number) & 0x7f) << 21) |
      (((head[7] as number) & 0x7f) << 14) |
      (((head[8] as number) & 0x7f) << 7) |
      ((head[9] as number) & 0x7f);
    start = 10 + tag + ((head[5] as number) & 0x10 ? 10 : 0);
  }
  if (dropInfoFrame) {
    const w = await readAt(fh, start, 2048);
    const at =
      w.length >= 4 ? [0, 1, 2, 3].map((k) => mp3FrameLen(w, k)).findIndex((l) => l > 0) : -1;
    if (at >= 0 && (w.indexOf("Xing", at) > 0 || w.indexOf("Info", at) > 0)) {
      const tagAt = Math.max(w.indexOf("Xing", at), w.indexOf("Info", at));
      if (tagAt - at <= 48) start += at + mp3FrameLen(w, at);
    }
  }
  let end = size;
  if (size - start > 128) {
    const tail = await readAt(fh, size - 128, 3);
    if (tail.toString("latin1") === "TAG") end = size - 128;
  }
  return { start, end };
}

/** Byte-sync formats (mp3 / aac): cut just before a validated frame header near the size limit. */
async function plainRanges(
  fh: FileHandle,
  size: number,
  max: number,
  aac: boolean,
): Promise<Ranges> {
  const out: Ranges = [];
  let pos = 0;
  let stop = size;
  if (!aac) {
    const b = await mp3Bounds(fh, size, true);
    pos = b.start;
    stop = b.end;
  }
  while (pos < stop) {
    let end = Math.min(stop, pos + max);
    if (end < stop) {
      const from = Math.max(pos + 1, end - 65536);
      const win = await readAt(fh, from, end + 8192 - from);
      for (let i = end - from; i >= 0; i--) {
        if (isFrameStart(win, i, aac)) {
          end = from + i;
          break;
        }
      }
    }
    out.push({ from: pos, to: end });
    pos = end;
  }
  return out;
}

/** Ogg: every part gets the original header pages, and is cut only on page boundaries. */
async function oggRanges(
  fh: FileHandle,
  size: number,
  max: number,
  opts?: { forceSingle?: boolean },
): Promise<Ranges | null> {
  const pages: { pos: number; len: number; granule: bigint; continued: boolean }[] = [];
  let pos = 0;
  while (pos + 27 <= size) {
    const h = await readAt(fh, pos, 27 + 255);
    if (h.subarray(0, 4).toString("latin1") !== "OggS") return null;
    const nseg = h[26] as number;
    let body = 0;
    for (let i = 0; i < nseg; i++) body += h[27 + i] as number;
    const len = 27 + nseg + body;
    pages.push({ pos, len, granule: h.readBigInt64LE(6), continued: ((h[5] as number) & 1) === 1 });
    pos += len;
  }
  if (pos !== size) return null; // truncated or trailing garbage: not safe to cut
  let hdrEnd = 0;
  while (hdrEnd < pages.length && (pages[hdrEnd] as (typeof pages)[number]).granule <= 0n) hdrEnd++;
  if (hdrEnd === 0 || hdrEnd >= pages.length) return null;
  const first = pages[0] as (typeof pages)[number];
  const last = pages[hdrEnd - 1] as (typeof pages)[number];
  const originalHeaderLen = last.pos + last.len - first.pos;
  let prefix = await readAt(fh, 0, originalHeaderLen);
  // Opus files from some tools carry the lecture's cover picture inside the tags (megabytes of it);
  // WhatsApp then reports "audio is not available". Keep the identification page, replace the tags.
  if (prefix.includes("OpusHead") && originalHeaderLen > 4096 && hdrEnd >= 2) {
    const idPage = prefix.subarray(0, first.len);
    prefix = Buffer.concat([idPage, minimalTagsPage(prefix.readUInt32LE(14))]);
  }
  const cleaned = prefix.length < originalHeaderLen;
  const headerLen = prefix.length;
  if (opts?.forceSingle) max = Number.MAX_SAFE_INTEGER;
  const out: Ranges = [];
  let start = (pages[hdrEnd] as (typeof pages)[number]).pos;
  let acc = headerLen;
  let cur = start;
  let base = 0n;
  let lastGranule = 0n;
  for (let i = hdrEnd; i < pages.length; i++) {
    const p = pages[i] as (typeof pages)[number];
    if (acc + p.len > max && !p.continued && p.pos > start) {
      out.push({ prefix, from: start, to: p.pos, baseGranule: base, cleaned });
      base = lastGranule;
      start = p.pos;
      acc = headerLen;
    }
    acc += p.len;
    cur = p.pos + p.len;
    if (p.granule > 0n) lastGranule = p.granule;
  }
  out.push({ prefix, from: start, to: cur, baseGranule: base, cleaned });
  return out;
}

async function amrRanges(fh: FileHandle, size: number, max: number): Promise<Ranges | null> {
  const header = await readAt(fh, 0, 6);
  let pos = 6;
  const out: Ranges = [];
  while (pos < size) {
    const win = await readAt(fh, pos, Math.min(size - pos, max - 6));
    let p = 0;
    while (p < win.length) {
      const n = (AMR_NB[((win[p] as number) >> 3) & 15] as number) + 0;
      if (n === 0 || p + n > win.length) break;
      p += n;
    }
    if (p === 0) return null;
    out.push({ prefix: header, from: pos, to: pos + p });
    pos += p;
  }
  return out;
}

async function wavParts(fh: FileHandle, size: number, max: number, dir: string, base: string) {
  const head = await readAt(fh, 0, 4096);
  const fmtAt = head.indexOf("fmt ");
  const dataAt = head.indexOf("data");
  if (fmtAt < 0 || dataAt < 0) return null;
  const fmtLen = head.readUInt32LE(fmtAt + 4);
  const fmt = head.subarray(fmtAt, fmtAt + 8 + fmtLen);
  const blockAlign = head.readUInt16LE(fmtAt + 8 + 12);
  const dataStart = dataAt + 8;
  const declared = head.readUInt32LE(dataAt + 4);
  const dataLen = declared > 0 && dataStart + declared <= size ? declared : size - dataStart;
  const chunk = Math.floor((max - 12 - fmt.length - 8) / blockAlign) * blockAlign;
  if (chunk <= 0) return null;
  const files: string[] = [];
  const total = Math.ceil(dataLen / chunk);
  for (let i = 0; i < total; i++) {
    const from = dataStart + i * chunk;
    const len = Math.min(chunk, dataLen - i * chunk);
    const hdr = Buffer.alloc(12 + fmt.length + 8);
    hdr.write("RIFF", 0, "latin1");
    hdr.writeUInt32LE(4 + fmt.length + 8 + len, 4);
    hdr.write("WAVE", 8, "latin1");
    fmt.copy(hdr, 12);
    hdr.write("data", 12 + fmt.length, "latin1");
    hdr.writeUInt32LE(len, 16 + fmt.length);
    const f = join(dir, `${base} (${i + 1}-${total}).wav`);
    await writeFile(f, Buffer.concat([hdr, await readAt(fh, from, len)]));
    files.push(f);
  }
  return files;
}

/**
 * Cuts an audio file into parts under WhatsApp's inline limit WITHOUT re-encoding (just copying bytes, so
 * it costs almost no CPU). Returns the part paths in order, or null when this container cannot be cut
 * safely (e.g. m4a), in which case the caller falls back to links.
 */
export async function splitAudio(
  path: string,
  fileName: string,
  dir: string,
  max = AUDIO_PART_BYTES,
): Promise<{ files: string[]; ext: string } | null> {
  const fh = await open(path, "r");
  try {
    const size = (await stat(path)).size;
    const fmt = audioFormat(fileName, await readAt(fh, 0, 4096));
    const base = fileName.replace(/\.[a-z0-9]{1,6}$/i, "") || "audio";
    if (fmt === "wav") {
      const files = await wavParts(fh, size, max, dir, base);
      return files ? { files, ext: "wav" } : null;
    }
    let ranges: Ranges | null = null;
    let ext = "";
    if (fmt === "mp3") (ranges = await plainRanges(fh, size, max, false)), (ext = "mp3");
    else if (fmt === "aac") (ranges = await plainRanges(fh, size, max, true)), (ext = "aac");
    else if (fmt === "ogg") (ranges = await oggRanges(fh, size, max)), (ext = "ogg");
    else if (fmt === "amr") (ranges = await amrRanges(fh, size, max)), (ext = "amr");
    if (!ranges || ranges.length < 2) return null;
    const files: string[] = [];
    for (const [i, r] of ranges.entries()) {
      const f = join(dir, `${base} (${i + 1}-${ranges.length}).${ext}`);
      let body = await readAt(fh, r.from, r.to - r.from);
      if (r.baseGranule !== undefined) body = rebaseOgg(body, 2, r.baseGranule);
      await writeFile(f, r.prefix ? Buffer.concat([r.prefix, body]) : body);
      files.push(f);
    }
    return { files, ext };
  } finally {
    await fh.close();
  }
}

/**
 * For Ogg/Opus files whose tags block is huge (embedded cover art), returns a copy with a minimal tags block,
 * otherwise null. Copies bytes only; no re-encoding.
 */
export async function cleanAudioHeader(
  path: string,
  fileName: string,
  dir: string,
): Promise<string | null> {
  const fh = await open(path, "r");
  try {
    const size = (await stat(path)).size;
    const fmt = audioFormat(fileName, await readAt(fh, 0, 4096));
    if (fmt === "mp3") {
      // Big ID3 tags (cover art) are dead weight at best; strip them. The whole-file VBR header stays valid.
      const b = await mp3Bounds(fh, size, false);
      if (b.start < 4096 && b.end === size) return null;
      const out = join(dir, "clean.mp3");
      await writeFile(out, await readAt(fh, b.start, b.end - b.start));
      return out;
    }
    if (fmt !== "ogg") return null;
    const ranges = await oggRanges(fh, size, Number.MAX_SAFE_INTEGER, { forceSingle: true });
    const r = ranges?.[0];
    if (!r?.prefix || !r.cleaned) return null; // nothing oversized to remove
    const body = rebaseOgg(await readAt(fh, r.from, r.to - r.from), 2, 0n);
    const out = join(dir, "clean.ogg");
    await writeFile(out, Buffer.concat([r.prefix, body]));
    return out;
  } finally {
    await fh.close();
  }
}
