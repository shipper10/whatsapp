import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

let cached: Promise<string | null> | undefined;

/** ffmpeg from FFMPEG_PATH, the bundled ffmpeg-static package, or the system PATH (first that exists). */
export function findFfmpeg(): Promise<string | null> {
  cached ??= (async () => {
    const candidates: string[] = [];
    if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
    try {
      const m = (await import("ffmpeg-static")) as unknown as { default: string | null };
      if (m.default) candidates.push(m.default);
    } catch {
      /* optional */
    }
    candidates.push("ffmpeg");
    for (const c of candidates) {
      const ok = await new Promise<boolean>((res) => {
        const p = spawn(c, ["-version"], { stdio: "ignore" });
        p.on("error", () => res(false));
        p.on("close", (code) => res(code === 0));
      });
      if (ok) return c;
    }
    return null;
  })();
  return cached;
}

/**
 * Re-encodes any audio to clean mono Ogg/Opus (what WhatsApp itself produces): no cover art, no odd
 * metadata, no unusual stream layout. Returns the new file path, or null when ffmpeg is missing or fails
 * (the caller then sends the original).
 */
export async function normalizeAudio(
  input: string,
  output: string,
  timeoutMs = 5 * 60_000,
): Promise<string | null> {
  const bin = await findFfmpeg();
  if (!bin) return null;
  const args = [
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-i",
    input,
    "-vn",
    "-map_metadata",
    "-1",
    "-c:a",
    "libopus",
    "-b:a",
    "48k",
    "-ac",
    "1",
    "-ar",
    "48000",
    "-application",
    "voip",
    "-f",
    "ogg",
    output,
  ];
  const ok = await new Promise<boolean>((res) => {
    const p = spawn(bin, args, { stdio: "ignore" });
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("error", () => res(false));
    p.on("close", (code) => {
      clearTimeout(t);
      res(code === 0);
    });
  });
  if (!ok) return null;
  const size = await stat(output)
    .then((s) => s.size)
    .catch(() => 0);
  return size > 0 ? output : null;
}
