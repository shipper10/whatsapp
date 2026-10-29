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

type Ranges = { prefix?: Buffer; from: number; to: number; baseGranule?: bigint }[];

/** Byte-sync formats (mp3 / aac): cut just before a frame header near the size limit. */
async function plainRanges(
  fh: FileHandle,
  size: number,
  max: number,
  aac: boolean,
): Promise<Ranges> {
  const out: Ranges = [];
  let pos = 0;
  while (pos < size) {
    let end = Math.min(size, pos + max);
    if (end < size) {
      const win = await readAt(
        fh,
        Math.max(pos + 1, end - 65536),
        end - Math.max(pos + 1, end - 65536),
      );
      const base = end - win.length;
      for (let i = win.length - 2; i >= 0; i--) {
        const ok = aac
          ? win[i] === 0xff && ((win[i + 1] as number) & 0xf6) === 0xf0
          : win[i] === 0xff && ((win[i + 1] as number) & 0xe0) === 0xe0;
        if (ok) {
          end = base + i;
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
async function oggRanges(fh: FileHandle, size: number, max: number): Promise<Ranges | null> {
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
  let hdrEnd = 0;
  while (hdrEnd < pages.length && (pages[hdrEnd] as (typeof pages)[number]).granule <= 0n) hdrEnd++;
  if (hdrEnd === 0 || hdrEnd >= pages.length) return null;
  const first = pages[0] as (typeof pages)[number];
  const last = pages[hdrEnd - 1] as (typeof pages)[number];
  const headerLen = last.pos + last.len - first.pos;
  const prefix = await readAt(fh, 0, headerLen);
  const out: Ranges = [];
  let start = (pages[hdrEnd] as (typeof pages)[number]).pos;
  let acc = headerLen;
  let cur = start;
  let base = 0n;
  let lastGranule = 0n;
  for (let i = hdrEnd; i < pages.length; i++) {
    const p = pages[i] as (typeof pages)[number];
    if (acc + p.len > max && !p.continued && p.pos > start) {
      out.push({ prefix, from: start, to: p.pos, baseGranule: base });
      base = lastGranule;
      start = p.pos;
      acc = headerLen;
    }
    acc += p.len;
    cur = p.pos + p.len;
    if (p.granule > 0n) lastGranule = p.granule;
  }
  out.push({ prefix, from: start, to: cur, baseGranule: base });
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
      if (ext === "mp3") {
        // A VBR "Xing"/"Info" frame claims the duration of the WHOLE file; blank the tag so each part reports its own.
        for (const tag of ["Xing", "Info"]) {
          const at = body.subarray(0, 1024).indexOf(tag);
          if (at > 0) body.fill(0, at, at + 4);
        }
      }
      await writeFile(f, r.prefix ? Buffer.concat([r.prefix, body]) : body);
      files.push(f);
    }
    return { files, ext };
  } finally {
    await fh.close();
  }
}
