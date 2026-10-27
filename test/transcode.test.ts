import { execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findFfmpeg, normalizeAudio } from "../src/delivery/transcode.js";
import { sniffAudio } from "../src/providers/whatsapp/baileys/media.js";

describe("normalizeAudio", () => {
  it("re-encodes an mp3 to clean mono ogg/opus; returns null for garbage", async () => {
    const bin = await findFfmpeg();
    if (!bin) return; // no ffmpeg on this machine
    const dir = await mkdtemp(join(tmpdir(), "tc-"));
    const src = join(dir, "a.mp3");
    execFileSync(bin, ["-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=2", src]);
    const out = await normalizeAudio(src, join(dir, "o.ogg"));
    expect(out).not.toBeNull();
    expect(sniffAudio((await readFile(out as string)).subarray(0, 256))).toBe("ogg-opus");
    expect(await normalizeAudio(join(dir, "missing.bin"), join(dir, "x.ogg"))).toBeNull();
  }, 60000);
});
