import { stat } from "node:fs/promises";
import { join } from "node:path";
import { drive as createDrive } from "@googleapis/drive";
import { GoogleAuth } from "google-auth-library";
import type { ResourceSourceDetail } from "../library/browse.js";
import { type FetchedFile, type FileFetcher, safeFileName, streamToFile } from "./fetchers.js";

/**
 * Downloads a Drive file for forwarding. Uses the broader read-only scope, so it exists only when the
 * admin enabled `delivery.driveDownload`; indexing keeps using the metadata-only scope.
 */
export class DriveFetcher implements FileFetcher {
  readonly type = "google_drive" as const;
  private api: ReturnType<typeof createDrive>;

  constructor(
    keyFilePath: string,
    private readonly enabled: () => Promise<boolean>,
  ) {
    this.api = createDrive({
      version: "v3",
      auth: new GoogleAuth({
        keyFile: keyFilePath,
        scopes: ["https://www.googleapis.com/auth/drive.readonly"],
      }),
    });
  }

  canFetch(src: ResourceSourceDetail) {
    return src.type === "google_drive" && !!src.driveFileId;
  }

  async fetch(
    src: ResourceSourceDetail,
    destDir: string,
    maxBytes: number,
    signal: AbortSignal,
    onProgress?: (done: number, total: number | null) => void,
  ): Promise<FetchedFile> {
    if (!(await this.enabled())) throw new Error("drive download disabled");
    const res = await this.api.files.get(
      { fileId: src.driveFileId as string, alt: "media", supportsAllDrives: true },
      { responseType: "stream", signal },
    );
    const fileName = safeFileName(src.fileName, "file");
    const path = join(destDir, fileName);
    await streamToFile(res.data as NodeJS.ReadableStream, path, maxBytes, (done) =>
      onProgress?.(done, src.sizeBytes),
    );
    return {
      path,
      fileName,
      mimeType: src.mimeType ?? "application/octet-stream",
      sizeBytes: (await stat(path)).size,
    };
  }
}
