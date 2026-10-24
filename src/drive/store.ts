import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { driveFiles, driveSources, syncRuns } from "../db/schema.js";
import type { DriveFileMeta, DriveSourceConfig } from "./types.js";

export interface DriveStore {
  listSources(): Promise<DriveSourceConfig[]>;
  upsertFiles(
    sourceId: number,
    files: DriveFileMeta[],
    seenAt: Date,
  ): Promise<{ inserted: number; updated: number }>;
  /** Marks active files of this source not seen since `before` as missing (never deletes rows). */
  markMissing(sourceId: number, before: Date): Promise<number>;
  setSourceStatus(sourceId: number, status: "ok" | "error", error: string | null): Promise<void>;
  startRun(sourceKey: string): Promise<number>;
  finishRun(runId: number, status: "ok" | "error", stats: object, error?: string): Promise<void>;
}

export class DbDriveStore implements DriveStore {
  constructor(private readonly db: Db) {}

  async listSources() {
    const rows = await this.db.select().from(driveSources).where(eq(driveSources.enabled, true));
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      folderId: r.folderId,
      credentialRef: r.credentialRef,
      recursiveScan: r.recursiveScan,
      enabled: r.enabled,
    }));
  }

  async upsertFiles(sourceId: number, files: DriveFileMeta[], seenAt: Date) {
    let inserted = 0;
    let updated = 0;
    for (const f of files) {
      const values = {
        driveSourceId: sourceId,
        driveFileId: f.driveFileId,
        name: f.name,
        mimeType: f.mimeType,
        sizeBytes: f.sizeBytes,
        modifiedTime: f.modifiedTime,
        parentFolderId: f.parentFolderId,
        folderPath: f.folderPath,
        webViewLink: f.webViewLink,
        lastSeenAt: seenAt,
        syncStatus: "active",
      };
      const res = await this.db
        .insert(driveFiles)
        .values(values)
        .onConflictDoUpdate({
          target: [driveFiles.driveSourceId, driveFiles.driveFileId],
          set: values,
        })
        .returning({ created: sql<boolean>`(xmax = 0)` });
      if (res[0]?.created) inserted++;
      else updated++;
    }
    return { inserted, updated };
  }

  async markMissing(sourceId: number, before: Date) {
    const res = await this.db
      .update(driveFiles)
      .set({ syncStatus: "missing" })
      .where(
        and(
          eq(driveFiles.driveSourceId, sourceId),
          eq(driveFiles.syncStatus, "active"),
          lt(driveFiles.lastSeenAt, before),
        ),
      )
      .returning({ id: driveFiles.id });
    return res.length;
  }

  async setSourceStatus(sourceId: number, status: "ok" | "error", error: string | null) {
    await this.db
      .update(driveSources)
      .set({
        syncStatus: status,
        lastError: error,
        ...(status === "ok" ? { lastSyncAt: new Date() } : {}),
      })
      .where(eq(driveSources.id, sourceId));
  }

  async startRun(sourceKey: string) {
    const [r] = await this.db
      .insert(syncRuns)
      .values({ kind: "drive", sourceKey })
      .returning({ id: syncRuns.id });
    return r?.id ?? 0;
  }

  async finishRun(runId: number, status: "ok" | "error", stats: object, error?: string) {
    await this.db
      .update(syncRuns)
      .set({ status, stats, error: error ?? null, finishedAt: new Date() })
      .where(eq(syncRuns.id, runId));
  }
}
