import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ResourceSourceDetail } from "../library/browse.js";
import { type FetchedFile, type FileFetcher, safeFileName, withExtension } from "./fetchers.js";

/** The slice of GramJsSource the fetcher needs (keeps it testable). */
export interface TelegramMediaDownloader {
  downloadMedia(
    messageId: number,
    destPath: string,
    maxBytes: number,
    onProgress?: (done: number, total: number) => void,
  ): Promise<void>;
}

export class TelegramFetcher implements FileFetcher {
  readonly type = "telegram" as const;
  constructor(private readonly client: TelegramMediaDownloader) {}

  canFetch(src: ResourceSourceDetail) {
    return src.type === "telegram" && src.telegramMessageId !== null;
  }

  async fetch(
    src: ResourceSourceDetail,
    destDir: string,
    maxBytes: number,
    signal: AbortSignal,
    onProgress?: (done: number, total: number | null) => void,
  ): Promise<FetchedFile> {
    const fileName = withExtension(
      safeFileName(src.fileName, `telegram-${src.telegramMessageId}`),
      src.mimeType,
    );
    const path = join(destDir, fileName);
    signal.throwIfAborted();
    await Promise.race([
      this.client.downloadMedia(src.telegramMessageId as number, path, maxBytes, onProgress),
      new Promise<never>((_, rej) =>
        signal.addEventListener("abort", () => rej(signal.reason), { once: true }),
      ),
    ]);
    const size = (await stat(path)).size;
    if (size > maxBytes) throw new Error("file exceeds the configured size limit");
    return {
      path,
      fileName,
      mimeType: src.mimeType ?? "application/octet-stream",
      sizeBytes: size,
    };
  }
}
