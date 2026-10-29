import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audioFormat, cleanAudioHeader, splitAudio } from "../src/delivery/audioSplit.js";

const dir = () => mkdtemp(join(tmpdir(), "split-"));

function oggPage(seq: number, granule: bigint, body: Buffer, flags = 0): Buffer {
  const h = Buffer.alloc(27 + 1);
  h.write("OggS", 0, "latin1");
  h[5] = flags;
  h.writeBigInt64LE(granule, 6);
  h.writeUInt32LE(seq, 18);
  h[26] = 1;
  h[27] = body.length;
  return Buffer.concat([h, body]);
}

describe("splitAudio", () => {
  it("cuts mp3 at frame headers into parts under the limit, covering every byte", async () => {
    const d = await dir();
    const frame = Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413, 7)]);
    const src = join(d, "a.mp3");
    await writeFile(src, Buffer.concat(Array.from({ length: 100 }, () => frame)));
    const r = await splitAudio(src, "a.mp3", d, 10_000);
    expect(r?.files.length).toBeGreaterThan(3);
    let total = 0;
    for (const f of r?.files ?? []) {
      const b = await readFile(f);
      expect(b.length).toBeLessThanOrEqual(10_000);
      expect(b[0]).toBe(0xff);
      total += b.length;
    }
    expect(total).toBe(frame.length * 100);
    expect(r?.files[0]).toContain("(1-");
  });

  it("splits ogg on page boundaries and repeats the header pages in every part", async () => {
    const d = await dir();
    const head = [
      oggPage(0, 0n, Buffer.from("OpusHead".padEnd(19, "x")), 2),
      oggPage(1, 0n, Buffer.from("OpusTags")),
    ];
    const data = Array.from({ length: 60 }, (_, i) =>
      oggPage(2 + i, BigInt((i + 1) * 960), Buffer.alloc(200, i)),
    );
    const src = join(d, "a.opus");
    await writeFile(src, Buffer.concat([...head, ...data]));
    const r = await splitAudio(src, "a.opus", d, 4000);
    expect(r?.ext).toBe("ogg");
    expect(r?.files.length ?? 0).toBeGreaterThan(2);
    for (const f of r?.files ?? []) {
      const b = await readFile(f);
      expect(b.length).toBeLessThanOrEqual(4000);
      expect(b.subarray(0, 4).toString()).toBe("OggS");
      expect(b.includes("OpusHead")).toBe(true);
      expect(b.includes("OpusTags")).toBe(true);
    }
  });

  it("cuts wav into valid wav parts", async () => {
    const d = await dir();
    const fmt = Buffer.alloc(24);
    fmt.write("fmt ", 0, "latin1");
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt16LE(1, 8);
    fmt.writeUInt16LE(1, 10);
    fmt.writeUInt32LE(8000, 12);
    fmt.writeUInt32LE(16000, 16);
    fmt.writeUInt16LE(2, 20);
    fmt.writeUInt16LE(16, 22);
    const pcm = Buffer.alloc(30_000, 1);
    const hdr = Buffer.alloc(12);
    hdr.write("RIFF", 0, "latin1");
    hdr.writeUInt32LE(4 + 24 + 8 + pcm.length, 4);
    hdr.write("WAVE", 8, "latin1");
    const dh = Buffer.alloc(8);
    dh.write("data", 0, "latin1");
    dh.writeUInt32LE(pcm.length, 4);
    const src = join(d, "a.wav");
    await writeFile(src, Buffer.concat([hdr, fmt, dh, pcm]));
    const r = await splitAudio(src, "a.wav", d, 10_000);
    expect(r?.files.length).toBe(4);
    let data = 0;
    for (const f of r?.files ?? []) {
      const b = await readFile(f);
      expect(b.subarray(0, 4).toString()).toBe("RIFF");
      expect(b.readUInt32LE(40)).toBe(b.length - 44);
      data += b.length - 44;
    }
    expect(data).toBe(30_000);
  });

  it("returns null for containers it cannot cut safely", async () => {
    const d = await dir();
    const src = join(d, "a.m4a");
    await writeFile(
      src,
      Buffer.concat([Buffer.alloc(4), Buffer.from("ftypM4A "), Buffer.alloc(50_000)]),
    );
    expect(await splitAudio(src, "a.m4a", d, 10_000)).toBeNull();
    expect((await stat(src)).size).toBeGreaterThan(0);
    expect(audioFormat("x.bin", Buffer.alloc(16))).toBeNull();
  });
});

describe("cover art in Opus tags", () => {
  it("replaces an oversized tags block in parts and in single files", async () => {
    const { cleanAudioHeader } = await import("../src/delivery/audioSplit.js");
    const d = await dir();
    const idPage = oggPage(0, 0n, Buffer.from("OpusHead".padEnd(19, "x")), 2);
    const bigTags = Buffer.alloc(6000, 126);
    bigTags.write("OpusTags", 0, "latin1");
    // tags spread over 30 pages of 200 bytes, as a real cover-art block is
    const tagPages = Array.from({ length: 30 }, (_, i) =>
      oggPage(1 + i, 0n, bigTags.subarray(i * 200, i * 200 + 200), i ? 1 : 0),
    );
    const data = Array.from({ length: 40 }, (_, i) =>
      oggPage(31 + i, BigInt((i + 1) * 960), Buffer.alloc(200, i)),
    );
    const src = join(d, "c.opus");
    await writeFile(src, Buffer.concat([idPage, ...tagPages, ...data]));
    const clean = await cleanAudioHeader(src, "c.opus", d);
    expect(clean).not.toBeNull();
    const cb = await readFile(clean as string);
    expect(cb.length).toBeLessThan(40 * 228 + 500);
    expect(cb.includes(Buffer.alloc(100, 126))).toBe(false);
    const parts = await splitAudio(src, "c.opus", d, 4000);
    for (const f of parts?.files ?? [])
      expect((await readFile(f)).includes(Buffer.alloc(100, 126))).toBe(false);
    // a file with a normal small header is left alone
    const small = join(d, "s.opus");
    await writeFile(
      small,
      Buffer.concat([idPage, oggPage(1, 0n, Buffer.from("OpusTags")), ...data]),
    );
    expect(await cleanAudioHeader(small, "s.opus", d)).toBeNull();
  });
});

describe("mp3 with ID3 cover art and a whole-file VBR header", () => {
  const frame = () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x54, 0xc0]), Buffer.alloc(188, 3)]); // 64 kbps, 48 kHz, mono = 192 bytes
  const infoFrame = () => {
    const f = frame();
    f.fill(0, 4, 40);
    f.write("Info", 21, "latin1");
    return f;
  };
  const id3 = (n: number) => {
    const h = Buffer.alloc(10);
    h.write("ID3", 0, "latin1");
    h[3] = 3;
    h[6] = (n >> 21) & 0x7f;
    h[7] = (n >> 14) & 0x7f;
    h[8] = (n >> 7) & 0x7f;
    h[9] = n & 0x7f;
    return Buffer.concat([h, Buffer.alloc(n, 0x41)]);
  };

  it("drops the ID3 tag and the Info frame so every part reports only its own length", async () => {
    const d = await dir();
    const src = join(d, "l.mp3");
    await writeFile(
      src,
      Buffer.concat([id3(5000), infoFrame(), ...Array.from({ length: 100 }, frame)]),
    );
    const r = await splitAudio(src, "l.mp3", d, 3000);
    expect(r?.files.length).toBeGreaterThan(5);
    let total = 0;
    for (const f of r?.files ?? []) {
      const b = await readFile(f);
      expect(b.length).toBeLessThanOrEqual(3000);
      expect(b.subarray(0, 4)).toEqual(Buffer.from([0xff, 0xfb, 0x54, 0xc0]));
      expect(b.length % 192).toBe(0);
      expect(b.includes("Info")).toBe(false);
      expect(b.includes("ID3")).toBe(false);
      total += b.length;
    }
    expect(total).toBe(100 * 192);
  });

  it("does not cut at a false sync inside audio data", async () => {
    const d = await dir();
    const trap = frame();
    trap.fill(0xff, 100, 140); // many 0xFF 0xFF pairs that look like (invalid) headers
    const src = join(d, "t.mp3");
    await writeFile(src, Buffer.concat(Array.from({ length: 60 }, () => trap)));
    const r = await splitAudio(src, "t.mp3", d, 2000);
    for (const f of r?.files ?? []) expect((await readFile(f)).length % 192).toBe(0);
  });

  it("strips a big ID3 tag from a single file but leaves small ones alone", async () => {
    const d = await dir();
    const big = join(d, "b.mp3");
    await writeFile(
      big,
      Buffer.concat([id3(9000), infoFrame(), ...Array.from({ length: 10 }, frame)]),
    );
    const c = await cleanAudioHeader(big, "b.mp3", d);
    expect((await readFile(c as string)).length).toBe(11 * 192);
    const small = join(d, "s.mp3");
    await writeFile(small, Buffer.concat([id3(100), ...Array.from({ length: 10 }, frame)]));
    expect(await cleanAudioHeader(small, "s.mp3", d)).toBeNull();
  });
});
