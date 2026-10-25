import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  academicNodes,
  driveFiles,
  resourceSources,
  resources,
  telegramMessages,
} from "../db/schema.js";
import type { ResourceHit } from "./search.js";

export interface NodeItem {
  id: number;
  type: string;
  name: string;
  parentId: number | null;
}

const hitCols = {
  id: resources.id,
  displayName: resources.displayName,
  resourceType: resources.resourceType,
  classificationStatus: resources.classificationStatus,
  sourceDate: resources.sourceDate,
};

export async function childNodes(db: Db, parentId: number | null): Promise<NodeItem[]> {
  return db
    .select({
      id: academicNodes.id,
      type: academicNodes.nodeType,
      name: academicNodes.name,
      parentId: academicNodes.parentId,
    })
    .from(academicNodes)
    .where(
      and(
        eq(academicNodes.enabled, true),
        parentId === null ? isNull(academicNodes.parentId) : eq(academicNodes.parentId, parentId),
      ),
    )
    .orderBy(asc(academicNodes.sortOrder), asc(academicNodes.name));
}

export async function resourcesInNode(
  db: Db,
  nodeId: number,
  opts: { limit: number; offset: number },
): Promise<ResourceHit[]> {
  return db
    .select(hitCols)
    .from(resources)
    .where(and(eq(resources.isActive, true), eq(resources.academicNodeId, nodeId)))
    .orderBy(asc(resources.sourceDate), asc(resources.id))
    .limit(opts.limit)
    .offset(opts.offset);
}

export async function recentResources(
  db: Db,
  opts: { limit: number; offset: number },
): Promise<ResourceHit[]> {
  return db
    .select(hitCols)
    .from(resources)
    .where(eq(resources.isActive, true))
    .orderBy(sql`${resources.sourceDate} desc nulls last`, desc(resources.id))
    .limit(opts.limit)
    .offset(opts.offset);
}

export interface ResourceSourceDetail {
  type: "telegram" | "google_drive";
  url: string | null;
  preferred: boolean;
  deliveryEligible: boolean;
  fileName: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  telegramChatId: bigint | null;
  telegramMessageId: number | null;
  driveFileId: string | null;
}

export interface ResourceDetail {
  id: number;
  displayName: string;
  path: string[];
  sources: ResourceSourceDetail[];
}

/** Everything delivery needs: the source copies with their ids, sizes and verified links. */
export async function resourceDetail(db: Db, id: number): Promise<ResourceDetail | null> {
  const [res] = await db.select().from(resources).where(eq(resources.id, id));
  if (!res || !res.isActive) return null;

  const path: string[] = [];
  for (let nid = res.academicNodeId; nid; ) {
    const [n] = await db.select().from(academicNodes).where(eq(academicNodes.id, nid));
    if (!n) break;
    path.unshift(n.name);
    nid = n.parentId;
  }

  const rows = await db.select().from(resourceSources).where(eq(resourceSources.resourceId, id));
  const sources: ResourceSourceDetail[] = [];
  for (const s of rows) {
    if (s.sourceType === "telegram") {
      const [m] = await db
        .select()
        .from(telegramMessages)
        .where(eq(telegramMessages.id, s.sourceRecordId));
      sources.push({
        type: "telegram",
        url: s.sourceUrl,
        preferred: s.isPreferred,
        deliveryEligible: s.deliveryEligible,
        fileName: m?.fileName ?? null,
        mimeType: m?.mimeType ?? null,
        sizeBytes: m?.fileSizeBytes ?? null,
        telegramChatId: m?.chatId ?? null,
        telegramMessageId: m?.messageId ?? null,
        driveFileId: null,
      });
    } else {
      const [f] = await db.select().from(driveFiles).where(eq(driveFiles.id, s.sourceRecordId));
      sources.push({
        type: "google_drive",
        url: s.sourceUrl,
        preferred: s.isPreferred,
        deliveryEligible: s.deliveryEligible,
        fileName: f?.name ?? null,
        mimeType: f?.mimeType ?? null,
        sizeBytes: f?.sizeBytes ?? null,
        telegramChatId: null,
        telegramMessageId: null,
        driveFileId: f?.driveFileId ?? null,
      });
    }
  }
  return { id: res.id, displayName: res.displayName, path, sources };
}

export interface NodeInfo extends NodeItem {
  path: string[];
}

export async function nodeInfo(db: Db, id: number): Promise<NodeInfo | null> {
  const path: string[] = [];
  let first: NodeItem | null = null;
  for (let nid: number | null = id; nid; ) {
    const [n] = await db.select().from(academicNodes).where(eq(academicNodes.id, nid));
    if (!n) break;
    if (!first) first = { id: n.id, type: n.nodeType, name: n.name, parentId: n.parentId };
    path.unshift(n.name);
    nid = n.parentId;
  }
  return first ? { ...first, path } : null;
}
