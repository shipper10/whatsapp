import { normalizeText } from "../core/normalize/text.js";
import type { RawEntity } from "../telegram/types.js";

/**
 * Metadata-only classification. Inputs are Telegram message metadata and Drive file metadata.
 * Nothing here reads file contents. Pure and deterministic: the same input yields the same plan,
 * which is what makes re-running the sync idempotent.
 */

export interface TgRow {
  /** telegram_messages.id */
  dbId: number;
  chatId: bigint;
  messageId: number;
  messageDate: Date;
  text: string;
  entities: RawEntity[];
  hashtags: string[];
  mediaType: string | null;
  fileName: string | null;
  fileSizeBytes: number | null;
  permalink: string | null;
  isIndex: boolean;
  returnIndexId: number | null;
  /** Album id shared by the messages of one Telegram album. */
  groupedId?: string | null;
}

export interface DriveRow {
  /** drive_files.id */
  dbId: number;
  sourceId: number;
  driveFileId: string;
  name: string;
  sizeBytes: number | null;
  modifiedTime: Date | null;
  folderPath: string | null;
  webViewLink: string | null;
}

export type ClassificationStatus = "classified" | "needs_review" | "uncategorized";

export interface PlanNode {
  key: string;
  type: "root" | "semester" | "subject" | "topic";
  name: string;
  parentKey: string | null;
  sortOrder: number;
}

export interface PlanResourceSource {
  type: "telegram" | "google_drive";
  recordId: number;
  url: string | null;
  preferred: boolean;
}

export interface PlanResource {
  key: string;
  displayName: string;
  /** Normalized, space separated text used by search. */
  searchText: string;
  nodeKey: string | null;
  status: ClassificationStatus;
  tags: string[];
  sources: PlanResourceSource[];
  sourceDate: Date | null;
}

export interface LibraryPlan {
  nodes: PlanNode[];
  resources: PlanResource[];
}

// ---------- text helpers ----------

const KEYCAP = /[0-9#*]️?⃣/g;
const RETURN_LABEL = /^\s*(return|back)\b/i;
const SEPARATOR = /^[\s─━—–\-_=~·•]{5,}$/;

export function cleanLabel(s: string): string {
  return s
    .replace(KEYCAP, " ")
    .replace(/[‍️]/g, "")
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N})\]]+$/u, "")
    .replace(/\s+/g, " ")
    .replace(/\s+(main\s+)?index$/i, "")
    .trim();
}

function deriveTitle(text: string): string {
  const lines = text.split("\n");
  const head: string[] = [];
  for (const l of lines) {
    if (SEPARATOR.test(l)) break;
    if (l.trim()) head.push(cleanLabel(l.replace(/\s+(main\s+)?index\s*$/i, "")));
  }
  return head.filter(Boolean).join(" ").trim();
}

interface Line {
  text: string;
  links: { id: number; label: string }[];
}

function linesOf(row: TgRow, internalId: (url: string) => number | null): Line[] {
  const out: Line[] = [];
  let offset = 0;
  for (const text of row.text.split("\n")) {
    const start = offset;
    const end = offset + text.length;
    offset = end + 1;
    const links: Line["links"] = [];
    for (const e of row.entities) {
      if (e.type !== "text_link" && e.type !== "url") continue;
      if (e.offset < start || e.offset >= end) continue;
      const label = row.text.slice(e.offset, e.offset + e.length);
      const url = e.type === "text_link" ? e.url : label;
      const id = url ? internalId(url) : null;
      if (id !== null) links.push({ id, label });
    }
    out.push({ text, links });
  }
  return out;
}

/** Text of a line without its link labels and decoration: used to tell "category" lines from "topic" lines. */
function residual(line: Line): string {
  let t = line.text;
  for (const l of line.links) t = t.replace(l.label, "");
  return t.replace(/[^\p{L}\p{N}]+/gu, "");
}

interface Ref {
  indexId: number;
  topic: string | null;
  category: string | null;
}

/** Reads one index message: which resource messages it points to, under which topic/category. */
function readIndexRefs(row: TgRow, internalId: (url: string) => number | null): Map<number, Ref> {
  const refs = new Map<number, Ref>();
  let section: string | null = null;
  let topic: string | null = null;
  for (const line of linesOf(row, internalId)) {
    const usable = line.links.filter((l) => !RETURN_LABEL.test(l.label));
    if (usable.length === 0) {
      if (SEPARATOR.test(line.text) || !line.text.trim()) continue;
      const numbered = /^\s*[\p{N}]+\s*[-–.)]\s*(.+)$/u.exec(line.text);
      if (numbered?.[1]) {
        topic = cleanLabel(numbered[1]);
      } else if (/:\s*$/.test(line.text) || /^\s*\*/.test(line.text)) {
        section = cleanLabel(line.text.replace(/[:*]/g, ""));
        topic = null;
      }
      continue;
    }
    if (residual(line) === "" && topic) {
      for (const l of usable) {
        if (!refs.has(l.id))
          refs.set(l.id, {
            indexId: row.messageId,
            topic,
            category: cleanLabel(l.label) || section,
          });
      }
    } else {
      for (const l of usable) {
        if (!refs.has(l.id))
          refs.set(l.id, { indexId: row.messageId, topic: null, category: section });
      }
    }
  }
  return refs;
}

const baseName = (fileName: string) => fileName.replace(/\.[A-Za-z0-9]{1,5}$/, "");

function firstCaptionLine(text: string): string {
  for (const l of text.split("\n")) {
    const c = cleanLabel(l);
    if (c && !RETURN_LABEL.test(c) && !c.startsWith("#")) return c;
  }
  return "";
}

// ---------- planner ----------

export interface PlanInput {
  /** Public username of the channel (e.g. "BahriMed"): needed to recognise internal links. */
  username: string;
  telegram: TgRow[];
  drive: DriveRow[];
}

export function planLibrary(input: PlanInput): LibraryPlan {
  const linkRe = new RegExp(`^https?://t\\.me/${input.username}/(\\d+)(?:\\?.*)?$`, "i");
  const internalId = (url: string) => {
    const m = linkRe.exec(url);
    return m?.[1] ? Number(m[1]) : null;
  };

  const tg = new Map(input.telegram.map((r) => [r.messageId, r]));
  const indexRows = input.telegram.filter((r) => r.isIndex);
  const indexIds = new Set(indexRows.map((r) => r.messageId));
  const nodeKeyOf = (messageId: number) => `tg:${indexRows[0]?.chatId ?? 0}:${messageId}`;

  // 1. index tree
  const refsByIndex = new Map<number, Map<number, Ref>>();
  const childEdges = new Map<number, { id: number; label: string }[]>();
  const referenced = new Set<number>();
  for (const idx of indexRows) {
    refsByIndex.set(idx.messageId, readIndexRefs(idx, internalId));
    const kids: { id: number; label: string }[] = [];
    for (const line of linesOf(idx, internalId)) {
      for (const l of line.links) {
        if (RETURN_LABEL.test(l.label) || !indexIds.has(l.id) || l.id === idx.messageId) continue;
        kids.push({ id: l.id, label: cleanLabel(l.label) });
        referenced.add(l.id);
      }
    }
    childEdges.set(idx.messageId, kids);
  }

  const nodes: PlanNode[] = [];
  const nodeByMsg = new Map<number, PlanNode>();
  const visit = (
    msgId: number,
    parent: PlanNode | null,
    label: string | null,
    depth: number,
    order: number,
  ) => {
    if (nodeByMsg.has(msgId)) return;
    const row = tg.get(msgId);
    if (!row) return;
    const title = deriveTitle(row.text);
    const type: PlanNode["type"] =
      depth === 0 ? "root" : depth === 1 ? "semester" : depth === 2 ? "subject" : "topic";
    const node: PlanNode = {
      key: nodeKeyOf(msgId),
      type,
      name: (depth === 1 ? title : label || title) || `Index ${msgId}`,
      parentKey: parent?.key ?? null,
      sortOrder: order,
    };
    nodes.push(node);
    nodeByMsg.set(msgId, node);
    (childEdges.get(msgId) ?? []).forEach((k, i) => visit(k.id, node, k.label, depth + 1, i));
  };
  indexRows
    .filter((r) => !referenced.has(r.messageId))
    .forEach((r, i) => visit(r.messageId, null, null, 0, i));
  // indexes unreachable from a root (cycles / orphans) become roots so nothing is silently dropped
  indexRows.forEach((r, i) => visit(r.messageId, null, null, 0, 1000 + i));

  // 2. who points at which resource message
  const refOf = new Map<number, Ref>();
  for (const idx of indexRows)
    for (const [id, ref] of refsByIndex.get(idx.messageId) ?? [])
      if (!refOf.has(id)) refOf.set(id, ref);

  const nodesByName = new Map<string, PlanNode[]>();
  for (const n of nodes) {
    const k = normalizeText(n.name);
    nodesByName.set(k, [...(nodesByName.get(k) ?? []), n]);
  }
  const topicNodes = new Map<string, PlanNode>();
  const lookup = (key: string) => nodes.find((x) => x.key === key) ?? topicNodes.get(key);
  const ancestors = (n: PlanNode | undefined): PlanNode[] => {
    const out: PlanNode[] = [];
    for (let cur = n; cur; cur = cur.parentKey ? lookup(cur.parentKey) : undefined)
      out.unshift(cur);
    return out;
  };

  const topicNodeFor = (subject: PlanNode, topic: string): PlanNode => {
    const key = `${subject.key}:topic:${normalizeText(topic)}`;
    let t = topicNodes.get(key);
    if (!t) {
      t = {
        key,
        type: "topic",
        name: topic,
        parentKey: subject.key,
        sortOrder: 500 + topicNodes.size,
      };
      topicNodes.set(key, t);
    }
    return t;
  };

  // 3. Telegram resources
  const resources: PlanResource[] = [];
  const tgResources: { res: PlanResource; row: TgRow }[] = [];
  for (const row of input.telegram) {
    if (row.isIndex || !row.mediaType || row.mediaType === "photo" || row.mediaType === "other")
      continue;
    const ref = refOf.get(row.messageId);
    let node: PlanNode | undefined;
    let status: ClassificationStatus = "uncategorized";
    const tags = [...row.hashtags];
    if (row.returnIndexId !== null && nodeByMsg.has(row.returnIndexId)) {
      node = nodeByMsg.get(row.returnIndexId);
      status = "classified";
    } else if (ref && nodeByMsg.has(ref.indexId)) {
      node = nodeByMsg.get(ref.indexId);
      status = "classified";
    } else {
      const matches = row.hashtags
        .flatMap((h) => nodesByName.get(h) ?? [])
        .filter((n) => n.type !== "root" && n.type !== "semester");
      const unique = [...new Map(matches.map((n) => [n.key, n])).values()];
      if (unique.length === 1) {
        node = unique[0];
        status = "needs_review"; // hashtag-only evidence: suggest, don't assert
      }
    }
    if (node && ref?.topic) node = topicNodeFor(node, ref.topic);
    if (ref?.category) tags.push(`category:${normalizeText(ref.category)}`);
    tags.push(`kind:${row.mediaType}`);

    const displayName =
      (row.fileName ? baseName(row.fileName) : firstCaptionLine(row.text)) ||
      `Telegram #${row.messageId}`;
    const chain = ancestors(node);
    const res: PlanResource = {
      key: `tg:${row.chatId}:${row.messageId}`,
      displayName,
      searchText: normalizeText(
        [
          displayName,
          row.fileName ?? "",
          row.text.slice(0, 400),
          ...row.hashtags,
          ...chain.map((n) => n.name),
          ref?.category ?? "",
        ].join(" "),
      ),
      nodeKey: node?.key ?? null,
      status,
      tags: [...new Set(tags)],
      sources: [{ type: "telegram", recordId: row.dbId, url: row.permalink, preferred: true }],
      sourceDate: row.messageDate,
    };
    resources.push(res);
    tgResources.push({ res, row });
  }

  // 4. Drive files: merge into a Telegram resource only on an unambiguous 1:1 name(+size) match
  const tgByName = new Map<string, { res: PlanResource; row: TgRow }[]>();
  for (const t of tgResources) {
    if (!t.row.fileName) continue;
    const k = normalizeText(t.row.fileName);
    tgByName.set(k, [...(tgByName.get(k) ?? []), t]);
  }
  const driveByName = new Map<string, DriveRow[]>();
  for (const d of input.drive)
    driveByName.set(normalizeText(d.name), [...(driveByName.get(normalizeText(d.name)) ?? []), d]);

  const claimed = new Set<number>();
  const leftovers: {
    d: DriveRow;
    candidates: { res: PlanResource; row: TgRow }[];
    sameDrive: DriveRow[];
    driveSource: PlanResourceSource;
  }[] = [];
  for (const d of input.drive) {
    const k = normalizeText(d.name);
    const tgC = tgByName.get(k) ?? [];
    const sameDrive = driveByName.get(k) ?? [];
    const sizeOk = (t: { row: TgRow }) =>
      d.sizeBytes === null || t.row.fileSizeBytes === null || d.sizeBytes === t.row.fileSizeBytes;
    const candidates = tgC.filter(sizeOk);
    const driveSource: PlanResourceSource = {
      type: "google_drive",
      recordId: d.dbId,
      url: d.webViewLink,
      preferred: false,
    };

    if (
      candidates.length === 1 &&
      sameDrive.length === 1 &&
      candidates[0] &&
      !claimed.has(candidates[0].row.dbId)
    ) {
      claimed.add(candidates[0].row.dbId);
      candidates[0].res.sources.push(driveSource);
      candidates[0].res.searchText = normalizeText(
        `${candidates[0].res.searchText} ${d.folderPath ?? ""}`,
      );
      continue;
    }

    leftovers.push({ d, candidates, sameDrive, driveSource });
  }

  // 4b. Same file under a different name: identical size and extension, unique on both sides.
  const ext = (n: string) => /\.([a-z0-9]{1,6})$/i.exec(n)?.[1]?.toLowerCase() ?? "";
  const sizeKey = (size: number | null, name: string) =>
    size && size > 0 ? `${size}:${ext(name)}` : null;
  const tgBySize = new Map<string, { res: PlanResource; row: TgRow }[]>();
  for (const t of tgResources) {
    const k = sizeKey(t.row.fileSizeBytes, t.row.fileName ?? "");
    if (k && !claimed.has(t.row.dbId)) tgBySize.set(k, [...(tgBySize.get(k) ?? []), t]);
  }
  const driveBySize = new Map<string, number>();
  for (const l of leftovers) {
    const k = sizeKey(l.d.sizeBytes, l.d.name);
    if (k) driveBySize.set(k, (driveBySize.get(k) ?? 0) + 1);
  }

  for (const { d, candidates, sameDrive, driveSource } of leftovers) {
    const k = sizeKey(d.sizeBytes, d.name);
    const match = k ? (tgBySize.get(k) ?? []) : [];
    if (
      k &&
      match.length === 1 &&
      driveBySize.get(k) === 1 &&
      match[0] &&
      !claimed.has(match[0].row.dbId)
    ) {
      claimed.add(match[0].row.dbId);
      match[0].res.sources.push(driveSource);
      match[0].res.searchText = normalizeText(`${match[0].res.searchText} ${d.folderPath ?? ""}`);
      continue;
    }

    // standalone Drive resource
    const folderLeaf = d.folderPath?.split("/").pop() ?? "";
    const named = (nodesByName.get(normalizeText(folderLeaf)) ?? []).filter(
      (n) => n.type === "subject" || n.type === "topic",
    );
    const ambiguous = candidates.length > 0 || sameDrive.length > 1;
    const node = named.length === 1 ? named[0] : undefined;
    const displayName = baseName(d.name);
    resources.push({
      key: `drive:${d.sourceId}:${d.driveFileId}`,
      displayName,
      searchText: normalizeText(
        [
          displayName,
          d.name,
          d.folderPath ?? "",
          ...(node ? ancestors(node).map((n) => n.name) : []),
        ].join(" "),
      ),
      nodeKey: node?.key ?? null,
      status: node || ambiguous ? "needs_review" : "uncategorized",
      tags: ambiguous ? ["possible-duplicate"] : [],
      sources: [driveSource],
      sourceDate: d.modifiedTime,
    });
  }

  return { nodes: [...nodes, ...topicNodes.values()], resources };
}
