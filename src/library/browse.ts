import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  academicNodes,
  driveFiles,
  resourceSources,
  resources,
  telegramMessages,
} from "../db/schema.js";
import { withExtension } from "../delivery/fetchers.js";
import type { RawEntity } from "../telegram/types.js";
import { type IndexTitle, indexTitle } from "./indexSearch.js";
import { cleanCaption } from "./indexView.js";
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
  /** photo | document | video | audio | null (text-only message or Drive file). */
  mediaType?: string | null;
}

export interface ResourceDetail {
  id: number;
  displayName: string;
  path: string[];
  sources: ResourceSourceDetail[];
  /** The channel's own text for this file (sent with it as the caption). */
  caption?: string | null;
}

/** Every stored copy (Telegram and Drive) of a resource, with verified ids, sizes and links. */
async function loadSources(db: Db, resourceId: number): Promise<ResourceSourceDetail[]> {
  const rows = await db
    .select()
    .from(resourceSources)
    .where(eq(resourceSources.resourceId, resourceId));
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
        mediaType: m?.mediaType ?? null,
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
  return sources;
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

  const sources = await loadSources(db, id);
  const tgText =
    sources.find((x) => x.type === "telegram" && x.preferred) ??
    sources.find((x) => x.type === "telegram");
  let caption: string | null = null;
  if (tgText?.telegramMessageId != null) {
    const [m] = await db
      .select({ text: telegramMessages.textOrCaption })
      .from(telegramMessages)
      .where(eq(telegramMessages.messageId, tgText.telegramMessageId))
      .limit(1);
    caption = m?.text ? cleanCaption(m.text) : null;
  }
  return { id: res.id, displayName: res.displayName, path, sources, caption };
}

/** A synced Telegram message as the index view sees it. */
export interface IndexMessage {
  messageId: number;
  text: string;
  entities: RawEntity[];
  username: string | null;
  isIndex: boolean;
}

const usernameOf = (permalink: string | null) =>
  /t\.me\/([^/]+)\//.exec(permalink ?? "")?.[1] ?? null;

export async function indexMessage(db: Db, messageId: number): Promise<IndexMessage | null> {
  const [m] = await db
    .select()
    .from(telegramMessages)
    .where(
      and(eq(telegramMessages.messageId, messageId), eq(telegramMessages.syncStatus, "active")),
    )
    .limit(1);
  if (!m) return null;
  const meta = (m.entitiesJson ?? {}) as { entities?: RawEntity[]; isIndex?: boolean };
  return {
    messageId: m.messageId,
    text: m.textOrCaption ?? "",
    entities: meta.entities ?? [],
    username: usernameOf(m.permalink),
    isIndex: meta.isIndex ?? false,
  };
}

/** The top of the index tree: the first navigation message that does not link back to another index. */
export async function rootIndexId(db: Db): Promise<number | null> {
  const [m] = await db
    .select({ id: telegramMessages.messageId })
    .from(telegramMessages)
    .where(
      and(
        eq(telegramMessages.syncStatus, "active"),
        sql`(${telegramMessages.entitiesJson}->>'isIndex')::boolean = true`,
        sql`${telegramMessages.entitiesJson}->>'returnIndexId' is null`,
      ),
    )
    .orderBy(asc(telegramMessages.messageId))
    .limit(1);
  return m?.id ?? null;
}

/** Titles of every synced index message (the channel's own tree of subjects/semesters/years). */
export async function indexTitles(db: Db): Promise<IndexTitle[]> {
  const rows = await db
    .select({ id: telegramMessages.messageId, text: telegramMessages.textOrCaption })
    .from(telegramMessages)
    .where(
      and(
        eq(telegramMessages.syncStatus, "active"),
        sql`(${telegramMessages.entitiesJson}->>'isIndex')::boolean = true`,
      ),
    )
    .orderBy(asc(telegramMessages.messageId));
  return rows.map((r) => ({ messageId: r.id, title: indexTitle(r.text ?? "") }));
}

export type MessageKind = "index" | "file" | "text" | "missing";

export async function messageKinds(db: Db, ids: number[]): Promise<Map<number, MessageKind>> {
  const out = new Map<number, MessageKind>(ids.map((i) => [i, "missing"]));
  if (ids.length === 0) return out;
  const rows = await db
    .select({
      id: telegramMessages.messageId,
      media: telegramMessages.mediaType,
      meta: telegramMessages.entitiesJson,
    })
    .from(telegramMessages)
    .where(
      and(inArray(telegramMessages.messageId, ids), eq(telegramMessages.syncStatus, "active")),
    );
  for (const r of rows) {
    const isIndex = ((r.meta ?? {}) as { isIndex?: boolean }).isIndex === true;
    out.set(r.id, isIndex ? "index" : r.media ? "file" : "text");
  }
  return out;
}

/** Delivery details for any synced Telegram message, whether or not the classifier made a resource of it. */
export async function telegramMessageDetail(
  db: Db,
  messageId: number,
): Promise<ResourceDetail | null> {
  const [m] = await db
    .select()
    .from(telegramMessages)
    .where(
      and(eq(telegramMessages.messageId, messageId), eq(telegramMessages.syncStatus, "active")),
    )
    .limit(1);
  if (!m) return null;
  const [rs] = await db
    .select({ resourceId: resourceSources.resourceId })
    .from(resourceSources)
    .where(
      and(eq(resourceSources.sourceType, "telegram"), eq(resourceSources.sourceRecordId, m.id)),
    )
    .limit(1);
  const caption = m.textOrCaption ? cleanCaption(m.textOrCaption) : "";
  const mime = m.mimeType ?? (m.mediaType === "photo" ? "image/jpeg" : null);
  const fileName = m.mediaType
    ? withExtension(m.fileName ?? `${m.mediaType}-${m.messageId}`, mime)
    : null;
  const title = caption.split("\n").find((l) => l.trim()) ?? m.fileName ?? `#${m.messageId}`;
  // Drive copies live on the resource this message was merged into; they must not be lost on this path.
  const driveCopies = rs
    ? (await loadSources(db, rs.resourceId)).filter((x) => x.type === "google_drive")
    : [];
  return {
    id: rs?.resourceId ?? 0,
    displayName: title.slice(0, 120),
    path: [],
    caption: m.textOrCaption ?? null,
    sources: [
      {
        type: "telegram",
        url: m.permalink,
        preferred: true,
        deliveryEligible: true,
        fileName,
        mimeType: mime,
        sizeBytes: m.fileSizeBytes,
        telegramChatId: m.chatId,
        telegramMessageId: m.messageId,
        driveFileId: null,
        mediaType: m.mediaType,
      },
      ...driveCopies,
    ],
  };
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
