import { and, eq, inArray, notInArray } from "drizzle-orm";
import { normalizeText } from "../core/normalize/arabic.js";
import type { Db } from "../db/client.js";
import {
  academicNodes,
  driveFiles,
  driveSources,
  resourceNodeLinks,
  resourceSources,
  resources,
  resourceTags,
  tags,
  telegramMessages,
} from "../db/schema.js";
import type { RawEntity } from "../telegram/types.js";
import { type DriveRow, type LibraryPlan, planLibrary, type TgRow } from "./classify.js";

export interface ApplyStats {
  nodes: number;
  resources: number;
  created: number;
  updated: number;
  deactivated: number;
  byStatus: Record<string, number>;
}

async function loadInputs(db: Db) {
  const tgRows = await db
    .select()
    .from(telegramMessages)
    .where(eq(telegramMessages.syncStatus, "active"));
  const telegram: TgRow[] = tgRows.map((r) => {
    const meta = (r.entitiesJson ?? {}) as {
      entities?: RawEntity[];
      returnIndexId?: number | null;
      isIndex?: boolean;
    };
    return {
      dbId: r.id,
      chatId: r.chatId,
      messageId: r.messageId,
      messageDate: r.messageDate,
      text: r.textOrCaption ?? "",
      entities: meta.entities ?? [],
      hashtags: r.hashtags,
      mediaType: r.mediaType,
      fileName: r.fileName,
      fileSizeBytes: r.fileSizeBytes,
      permalink: r.permalink,
      isIndex: meta.isIndex ?? false,
      returnIndexId: meta.returnIndexId ?? null,
    };
  });

  const dRows = await db
    .select({ f: driveFiles })
    .from(driveFiles)
    .innerJoin(driveSources, eq(driveSources.id, driveFiles.driveSourceId))
    .where(and(eq(driveFiles.syncStatus, "active"), eq(driveSources.enabled, true)));
  const drive: DriveRow[] = dRows.map(({ f }) => ({
    dbId: f.id,
    sourceId: f.driveSourceId,
    driveFileId: f.driveFileId,
    name: f.name,
    sizeBytes: f.sizeBytes,
    modifiedTime: f.modifiedTime,
    folderPath: f.folderPath,
    webViewLink: f.webViewLink,
  }));
  return { telegram, drive };
}

/** Writes a plan to the database. Idempotent; never deletes; respects admin-locked resources. */
export async function applyPlan(db: Db, plan: LibraryPlan): Promise<ApplyStats> {
  return db.transaction(async (tx) => {
    const stats: ApplyStats = {
      nodes: plan.nodes.length,
      resources: plan.resources.length,
      created: 0,
      updated: 0,
      deactivated: 0,
      byStatus: {},
    };

    // nodes (parents come before children in the plan)
    const nodeId = new Map<string, number>();
    for (const n of plan.nodes) {
      const values = {
        nodeKey: n.key,
        nodeType: n.type,
        name: n.name,
        nameNormalized: normalizeText(n.name),
        parentId: n.parentKey ? (nodeId.get(n.parentKey) ?? null) : null,
        sortOrder: n.sortOrder,
      };
      const [row] = await tx
        .insert(academicNodes)
        .values(values)
        .onConflictDoUpdate({ target: academicNodes.nodeKey, set: values }) // `enabled` is left to admins
        .returning({ id: academicNodes.id });
      if (row) nodeId.set(n.key, row.id);
    }

    // resources
    const keys = plan.resources.map((r) => r.key);
    const existing = keys.length
      ? await tx
          .select({
            id: resources.id,
            key: resources.resourceKey,
            locked: resources.classificationLocked,
          })
          .from(resources)
          .where(inArray(resources.resourceKey, keys))
      : [];
    const existingByKey = new Map(existing.map((e) => [e.key, e]));
    const resId = new Map<string, number>();
    const unlocked: number[] = [];

    for (const r of plan.resources) {
      stats.byStatus[r.status] = (stats.byStatus[r.status] ?? 0) + 1;
      const academicNodeId = r.nodeKey ? (nodeId.get(r.nodeKey) ?? null) : null;
      const prev = existingByKey.get(r.key);
      if (prev) {
        const base = {
          searchText: r.searchText,
          sourceDate: r.sourceDate,
          isActive: true,
          updatedAt: new Date(),
        };
        await tx
          .update(resources)
          .set(
            prev.locked
              ? base
              : {
                  ...base,
                  displayName: r.displayName,
                  academicNodeId,
                  classificationStatus: r.status,
                },
          )
          .where(eq(resources.id, prev.id));
        resId.set(r.key, prev.id);
        if (!prev.locked) unlocked.push(prev.id);
        stats.updated++;
      } else {
        const [row] = await tx
          .insert(resources)
          .values({
            resourceKey: r.key,
            displayName: r.displayName,
            searchText: r.searchText,
            academicNodeId,
            classificationStatus: r.status,
            sourceDate: r.sourceDate,
          })
          .returning({ id: resources.id });
        if (row) {
          resId.set(r.key, row.id);
          unlocked.push(row.id);
          stats.created++;
        }
      }
    }

    // sources: replace the sync-managed set
    const allIds = [...resId.values()];
    if (allIds.length) {
      await tx.delete(resourceSources).where(inArray(resourceSources.resourceId, allIds));
      const srcRows = plan.resources.flatMap((r) =>
        r.sources.map((s) => ({
          resourceId: resId.get(r.key) as number,
          sourceType: s.type,
          sourceRecordId: s.recordId,
          sourceUrl: s.url,
          isPreferred: s.preferred,
          deliveryEligible: true,
          lastVerifiedAt: new Date(),
        })),
      );
      for (let i = 0; i < srcRows.length; i += 500)
        await tx.insert(resourceSources).values(srcRows.slice(i, i + 500));
    }

    // node links + tags for non-locked resources
    if (unlocked.length) {
      await tx.delete(resourceNodeLinks).where(inArray(resourceNodeLinks.resourceId, unlocked));
      await tx.delete(resourceTags).where(inArray(resourceTags.resourceId, unlocked));
      const links = plan.resources
        .filter((r) => r.nodeKey && unlocked.includes(resId.get(r.key) as number))
        .map((r) => ({
          resourceId: resId.get(r.key) as number,
          nodeId: nodeId.get(r.nodeKey as string) as number,
        }))
        .filter((l) => l.nodeId !== undefined);
      for (let i = 0; i < links.length; i += 500)
        await tx.insert(resourceNodeLinks).values(links.slice(i, i + 500));

      const names = [...new Set(plan.resources.flatMap((r) => r.tags))];
      if (names.length) {
        await tx
          .insert(tags)
          .values(names.map((name) => ({ name })))
          .onConflictDoNothing();
        const tagRows = await tx.select().from(tags).where(inArray(tags.name, names));
        const tagId = new Map(tagRows.map((t) => [t.name, t.id]));
        const rt = plan.resources
          .filter((r) => unlocked.includes(resId.get(r.key) as number))
          .flatMap((r) =>
            r.tags.map((t) => ({
              resourceId: resId.get(r.key) as number,
              tagId: tagId.get(t) as number,
            })),
          );
        for (let i = 0; i < rt.length; i += 500)
          await tx
            .insert(resourceTags)
            .values(rt.slice(i, i + 500))
            .onConflictDoNothing();
      }
    }

    // resources no longer produced by any source: deactivate, never delete
    const gone = await tx
      .update(resources)
      .set({ isActive: false })
      .where(
        and(
          eq(resources.isActive, true),
          keys.length ? notInArray(resources.resourceKey, keys) : undefined,
        ),
      )
      .returning({ id: resources.id });
    stats.deactivated = gone.length;
    return stats;
  });
}

export async function classifyAndApply(db: Db, username: string): Promise<ApplyStats> {
  const input = await loadInputs(db);
  return applyPlan(db, planLibrary({ username, ...input }));
}
