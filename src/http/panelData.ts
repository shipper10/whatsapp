import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  academicNodes,
  deliveryLogs,
  driveSources,
  resources,
  subscriptions,
  syncRuns,
} from "../db/schema.js";

export interface Overview {
  whatsapp: string;
  syncs: { kind: string; ok: boolean | null; at: Date | null; error?: string; running?: string }[];
  load: {
    running: number;
    queued: number;
    inflightMb: number;
    cached: number;
    rssMb: number;
    freeDiskMb: number | null;
  };
  counts: { resources: number; uncategorized: number; nodes: number; subscribers: number };
  delivery: { outcome: string; n: number }[];
  sources: {
    label: string;
    enabled: boolean;
    status: string;
    lastSyncAt: Date | null;
    error: string | null;
  }[];
  recentRuns: { kind: string; status: string; at: Date; error: string | null }[];
}

/** Read-only figures for the panel's first page. */
export async function loadCounts(db: Db) {
  const n = sql<number>`count(*)::int`;
  const [[res], [unc], [nodes], [subs], delivery, sources, runs] = await Promise.all([
    db.select({ n }).from(resources).where(eq(resources.isActive, true)),
    db.select({ n }).from(resources).where(eq(resources.classificationStatus, "uncategorized")),
    db.select({ n }).from(academicNodes),
    db.select({ n }).from(subscriptions),
    db
      .select({ outcome: deliveryLogs.outcome, n })
      .from(deliveryLogs)
      .where(sql`${deliveryLogs.at} > now() - interval '7 days'`)
      .groupBy(deliveryLogs.outcome),
    db.select().from(driveSources),
    db.select().from(syncRuns).orderBy(desc(syncRuns.id)).limit(8),
  ]);
  return {
    counts: {
      resources: res?.n ?? 0,
      uncategorized: unc?.n ?? 0,
      nodes: nodes?.n ?? 0,
      subscribers: subs?.n ?? 0,
    },
    delivery,
    sources: sources.map((s) => ({
      label: s.label,
      enabled: s.enabled,
      status: s.syncStatus,
      lastSyncAt: s.lastSyncAt,
      error: s.lastError,
    })),
    recentRuns: runs.map((r) => ({
      kind: r.kind,
      status: r.status,
      at: r.finishedAt ?? r.startedAt,
      error: r.error,
    })),
  };
}
