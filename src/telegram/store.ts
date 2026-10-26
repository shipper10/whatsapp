import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { syncCursors, syncRuns, telegramMessages } from "../db/schema.js";
import type { TelegramRecord } from "./types.js";

/** Persistence port for the sync loop (Drizzle in production, in-memory in tests). */
export interface TelegramStore {
  upsertMany(records: TelegramRecord[]): Promise<{ inserted: number; updated: number }>;
  getCursor(sourceKey: string): Promise<number | null>;
  setCursor(sourceKey: string, lastMessageId: number): Promise<void>;
  startRun(sourceKey: string): Promise<number>;
  finishRun(runId: number, status: "ok" | "error", stats: object, error?: string): Promise<void>;
  /** Ids of every stored index message: these are re-read on each sync so edits to old indexes show up. */
  indexMessageIds?(): Promise<number[]>;
}

export class DbTelegramStore implements TelegramStore {
  constructor(private readonly db: Db) {}

  async upsertMany(records: TelegramRecord[]) {
    let inserted = 0;
    let updated = 0;
    for (const r of records) {
      const values = {
        chatId: r.chatId,
        messageId: r.messageId,
        messageDate: r.messageDate,
        textOrCaption: r.textOrCaption,
        entitiesJson: {
          entities: r.entities,
          links: r.links,
          internalLinkIds: r.internalLinkIds,
          returnIndexId: r.returnIndexId,
          isIndex: r.isIndex,
        },
        hashtags: r.hashtags,
        mediaType: r.mediaType,
        fileName: r.fileName,
        mimeType: r.mimeType,
        fileSizeBytes: r.fileSizeBytes,
        permalink: r.permalink,
        editDate: r.editDate,
        lastSeenAt: new Date(),
        syncStatus: "active",
      };
      const res = await this.db
        .insert(telegramMessages)
        .values(values)
        .onConflictDoUpdate({
          target: [telegramMessages.chatId, telegramMessages.messageId],
          set: values,
        })
        .returning({ created: sql<boolean>`(xmax = 0)` });
      if (res[0]?.created) inserted++;
      else updated++;
    }
    return { inserted, updated };
  }

  async indexMessageIds() {
    const rows = await this.db
      .select({ id: telegramMessages.messageId })
      .from(telegramMessages)
      .where(
        and(
          eq(telegramMessages.syncStatus, "active"),
          sql`(${telegramMessages.entitiesJson}->>'isIndex')::boolean = true`,
        ),
      );
    return rows.map((r) => r.id);
  }

  async getCursor(sourceKey: string) {
    const row = await this.db
      .select()
      .from(syncCursors)
      .where(and(eq(syncCursors.kind, "telegram"), eq(syncCursors.sourceKey, sourceKey)));
    const c = row[0]?.cursor;
    return c ? Number(c) : null;
  }

  async setCursor(sourceKey: string, lastMessageId: number) {
    await this.db
      .insert(syncCursors)
      .values({ kind: "telegram", sourceKey, cursor: String(lastMessageId) })
      .onConflictDoUpdate({
        target: [syncCursors.kind, syncCursors.sourceKey],
        set: { cursor: String(lastMessageId), updatedAt: new Date() },
      });
  }

  async startRun(sourceKey: string) {
    const [r] = await this.db
      .insert(syncRuns)
      .values({ kind: "telegram", sourceKey })
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
