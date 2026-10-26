import { withRetry } from "../core/retry.js";
import type { ParseContext } from "./parse.js";
import { parseMessage } from "./parse.js";
import type { TelegramStore } from "./store.js";
import type { TelegramSource } from "./types.js";

export interface SyncOptions {
  sourceKey: string;
  ctx: ParseContext;
  batchSize?: number;
  /** Re-read this many ids behind the cursor to catch edits. 0 disables. */
  rescanWindow?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncStats {
  fetched: number;
  inserted: number;
  updated: number;
  cursor: number | null;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Incremental, idempotent, resumable sync. The cursor (highest message id fully stored) only
 * advances after a batch is persisted, so a crash or outage never skips messages. Re-running is safe.
 */
export async function syncTelegram(
  source: TelegramSource,
  store: TelegramStore,
  opts: SyncOptions,
): Promise<SyncStats> {
  const batchSize = opts.batchSize ?? 100;
  const retries = opts.maxRetries ?? 4;
  const sleep = opts.sleep ?? defaultSleep;
  const stats: SyncStats = { fetched: 0, inserted: 0, updated: 0, cursor: null };
  const runId = await store.startRun(opts.sourceKey);

  try {
    let cursor = (await store.getCursor(opts.sourceKey)) ?? 0;
    const isIncremental = cursor > 0;
    let minId =
      isIncremental && (opts.rescanWindow ?? 0) > 0
        ? Math.max(0, cursor - (opts.rescanWindow ?? 0))
        : cursor;

    for (;;) {
      const batch = await withRetry(
        () => source.fetchBatch({ minId, limit: batchSize }),
        retries,
        sleep,
      );
      if (batch.messages.length > 0) {
        const res = await store.upsertMany(batch.messages.map((m) => parseMessage(m, opts.ctx)));
        stats.fetched += batch.messages.length;
        stats.inserted += res.inserted;
        stats.updated += res.updated;
      }
      // The cursor follows the window, not the stored messages: ids with no message must not stall us.
      cursor = Math.max(cursor, batch.lastId);
      await store.setCursor(opts.sourceKey, cursor);
      if (batch.exhausted || batch.lastId <= minId) break;
      minId = batch.lastId;
    }
    stats.cursor = cursor || null;
    await store.finishRun(runId, "ok", stats);
    return stats;
  } catch (err) {
    await store.finishRun(runId, "error", stats, err instanceof Error ? err.message : String(err));
    throw err;
  }
}
