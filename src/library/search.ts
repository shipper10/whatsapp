import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { normalizeText } from "../core/normalize/arabic.js";
import type { Db } from "../db/client.js";
import { academicNodes, resourceAliases, resources } from "../db/schema.js";

export interface ResourceHit {
  id: number;
  displayName: string;
  resourceType: string;
  classificationStatus: string;
  sourceDate: Date | null;
}

const hitCols = {
  id: resources.id,
  displayName: resources.displayName,
  resourceType: resources.resourceType,
  classificationStatus: resources.classificationStatus,
  sourceDate: resources.sourceDate,
};

const tsQueryOf = (tokens: string[]) => tokens.map((t) => `${t}:*`).join(" & ");

/**
 * Metadata-only search over normalized resource text.
 * 1) full text, every word as a prefix  2) aliases (admin-defined synonyms)  3) trigram fallback for typos.
 */
export async function searchResources(
  db: Db,
  rawQuery: string,
  opts: { limit: number; offset?: number },
): Promise<ResourceHit[]> {
  const q = normalizeText(rawQuery);
  const tokens = q.split(" ").filter(Boolean);
  if (tokens.length === 0) return [];
  const offset = opts.offset ?? 0;

  // alias expansion: whole query or any single word may be an alias of a node or a resource
  const aliasRows = await db
    .select({ nodeId: resourceAliases.nodeId, resourceId: resourceAliases.resourceId })
    .from(resourceAliases)
    .where(inArray(resourceAliases.aliasNormalized, [...new Set([q, ...tokens])]));
  const aliasResourceIds = aliasRows
    .map((a) => a.resourceId)
    .filter((x): x is number => x !== null);
  const aliasNodeIds = aliasRows.map((a) => a.nodeId).filter((x): x is number => x !== null);
  const nodeNames = aliasNodeIds.length
    ? (
        await db
          .select({ n: academicNodes.nameNormalized })
          .from(academicNodes)
          .where(inArray(academicNodes.id, aliasNodeIds))
      ).map((r) => r.n)
    : [];

  const fts = (tsq: string) =>
    sql`to_tsvector('simple', ${resources.searchText}) @@ to_tsquery('simple', ${tsq})`;
  const conditions = [fts(tsQueryOf(tokens))];
  for (const name of nodeNames) {
    const t = name.split(" ").filter(Boolean);
    if (t.length) conditions.push(fts(tsQueryOf(t)));
  }
  if (aliasResourceIds.length) conditions.push(inArray(resources.id, aliasResourceIds));
  const anyMatch = sql.join(
    conditions.map((c) => sql`(${c})`),
    sql` or `,
  );

  const rank = sql`ts_rank(to_tsvector('simple', ${resources.searchText}), to_tsquery('simple', ${tsQueryOf(tokens)}))`;
  const main = await db
    .select(hitCols)
    .from(resources)
    .where(and(eq(resources.isActive, true), sql`(${anyMatch})`))
    .orderBy(desc(rank), sql`${resources.sourceDate} desc nulls last`, resources.id)
    .limit(opts.limit)
    .offset(offset);
  if (main.length > 0 || q.length < 3) return main;

  // typo-tolerant fallback
  const sim = sql`word_similarity(${q}, ${resources.searchText})`;
  return db
    .select(hitCols)
    .from(resources)
    .where(and(eq(resources.isActive, true), sql`${sim} > 0.45`))
    .orderBy(desc(sim), resources.id)
    .limit(opts.limit)
    .offset(offset);
}
