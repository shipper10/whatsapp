import { withRetry } from "../core/retry.js";
import type { DriveStore } from "./store.js";
import type { DriveClient, DriveFileMeta, DriveSourceConfig } from "./types.js";
import { driveFileUrl } from "./url.js";

const FOLDER = "application/vnd.google-apps.folder";

export interface DriveSyncOptions {
  maxDepth?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface DriveSourceResult {
  sourceId: number;
  label: string;
  ok: boolean;
  scanned: number;
  inserted: number;
  updated: number;
  missing: number;
  error?: string;
}

/** Walks one source (BFS, cycle-safe) and returns file metadata only. Folders are traversal, not resources. */
export async function scanSource(
  client: DriveClient,
  source: DriveSourceConfig,
  opts: DriveSyncOptions = {},
): Promise<DriveFileMeta[]> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxDepth = opts.maxDepth ?? 20;
  const files: DriveFileMeta[] = [];
  const seenFolders = new Set<string>([source.folderId]);
  let level: { id: string; path: string }[] = [{ id: source.folderId, path: "" }];

  for (let depth = 0; level.length > 0 && depth <= maxDepth; depth++) {
    const next: { id: string; path: string }[] = [];
    for (const folder of level) {
      const children = await withRetry(
        () => client.listChildren(folder.id),
        opts.maxRetries ?? 3,
        sleep,
      );
      for (const c of children) {
        if (c.mimeType === FOLDER) {
          if (source.recursiveScan && !seenFolders.has(c.id)) {
            seenFolders.add(c.id);
            next.push({ id: c.id, path: folder.path ? `${folder.path}/${c.name}` : c.name });
          }
          continue;
        }
        files.push({
          driveFileId: c.id,
          name: c.name,
          mimeType: c.mimeType || null,
          sizeBytes: c.size ? Number(c.size) : null,
          modifiedTime: c.modifiedTime ? new Date(c.modifiedTime) : null,
          parentFolderId: folder.id,
          folderPath: folder.path,
          webViewLink: c.webViewLink ?? driveFileUrl(c.id),
        });
      }
    }
    level = next;
  }
  return files;
}

/**
 * Syncs every enabled source independently: one source failing (e.g. folder not shared) is recorded
 * on that source and never stops the others. Files are marked "missing" only after a COMPLETE
 * successful scan, never on a failed or partial one, and rows are never deleted.
 */
export async function syncDrive(
  store: DriveStore,
  clientFor: (source: DriveSourceConfig) => DriveClient,
  opts: DriveSyncOptions = {},
): Promise<DriveSourceResult[]> {
  const now = opts.now ?? (() => new Date());
  const results: DriveSourceResult[] = [];

  for (const source of await store.listSources()) {
    const runId = await store.startRun(`drive:${source.id}`);
    const startedAt = now();
    const r: DriveSourceResult = {
      sourceId: source.id,
      label: source.label,
      ok: false,
      scanned: 0,
      inserted: 0,
      updated: 0,
      missing: 0,
    };
    try {
      const files = await scanSource(clientFor(source), source, opts);
      const up = await store.upsertFiles(source.id, files, startedAt);
      r.scanned = files.length;
      r.inserted = up.inserted;
      r.updated = up.updated;
      r.missing = await store.markMissing(source.id, startedAt);
      r.ok = true;
      await store.setSourceStatus(source.id, "ok", null);
      await store.finishRun(runId, "ok", r);
    } catch (err) {
      r.error = err instanceof Error ? err.message : String(err);
      await store.setSourceStatus(source.id, "error", r.error);
      await store.finishRun(runId, "error", r, r.error);
    }
    results.push(r);
  }
  return results;
}
