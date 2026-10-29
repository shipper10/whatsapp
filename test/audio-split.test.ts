import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { audioFormat, splitAudio } from "../src/delivery/audioSplit.js";

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
