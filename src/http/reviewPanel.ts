import type { IncomingMessage as HttpReq } from "node:http";
import { and, asc, eq, inArray, like, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  academicNodes,
  adminAuditLogs,
  driveFiles,
  driveMatches,
  resourceNodeLinks,
  resourceSources,
  resources,
  telegramMessages,
} from "../db/schema.js";
import { scoreTitle, words } from "../library/fuzzy.js";
import type { BridgeUiResult } from "./bridgePanel.js";
import { readBody } from "./server.js";
import { BASE, esc } from "./ui.js";

export interface ReviewDeps {
  db: Db;
  /** Rebuilds the library from what is stored (used after a Drive/Telegram match changes the plan). */
  reclassify: () => Promise<unknown>;
}

const here = `${BASE}/review`;
const PAGE = 20;
const KINDS = ["all", "telegram", "drive"] as const;
type Kind = (typeof KINDS)[number];

interface Flash {
  text: string;
  err?: boolean;
}

/** "First Year › 4th Semester › Biomolecules" for every node, with " #id" added only where two would read the same. */
async function nodeLabels(db: Db) {
  const rows = await db
    .select()
    .from(academicNodes)
    .where(eq(academicNodes.enabled, true))
    .orderBy(asc(academicNodes.sortOrder), asc(academicNodes.id));
  const byId = new Map(rows.map((n) => [n.id, n]));
  const pathOf = (id: number) => {
    const out: string[] = [];
    for (
      let n = byId.get(id), i = 0;
      n && i < 12;
      n = n.parentId ? byId.get(n.parentId) : undefined, i++
    )
      if (n.nodeType !== "root") out.unshift(n.name);
    return out.join(" › ");
  };
  const raw = rows
    .filter((n) => n.nodeType !== "root")
    .map((n) => ({ id: n.id, path: pathOf(n.id) }));
  const seen = new Map<string, number>();
  for (const r of raw) seen.set(r.path, (seen.get(r.path) ?? 0) + 1);
  const labels = raw.map((r) => ({
    id: r.id,
    label: (seen.get(r.path) ?? 0) > 1 ? `${r.path} #${r.id}` : r.path,
  }));
  return {
    labels,
    byLabel: new Map(labels.map((l) => [l.label, l.id])),
    byId: new Map(labels.map((l) => [l.id, l.label])),
  };
}

const similarity = (a: string, b: string) => {
  const strip = (s: string) => s.replace(/\.[a-z0-9]{1,5}$/i, "");
  const wa = words(strip(a));
  const wb = words(strip(b));
  return Math.max(scoreTitle(wa, strip(b)), scoreTitle(wb, strip(a)));
};

async function loadRows(db: Db, kind: Kind, page: number) {
  const where = and(
    eq(resources.isActive, true),
    inArray(resources.classificationStatus, ["needs_review", "uncategorized"]),
    kind === "all" ? undefined : like(resources.resourceKey, kind === "drive" ? "drive:%" : "tg:%"),
  );
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(resources)
    .where(where);
  const rows = await db
    .select({
      id: resources.id,
      name: resources.displayName,
      status: resources.classificationStatus,
      node: resources.academicNodeId,
      key: resources.resourceKey,
    })
    .from(resources)
    .where(where)
    .orderBy(asc(resources.classificationStatus), asc(resources.id))
    .limit(PAGE)
    .offset((page - 1) * PAGE);
  const ids = rows.map((r) => r.id);
  const links = ids.length
    ? await db
        .select({ rid: resourceSources.resourceId, url: resourceSources.sourceUrl })
        .from(resourceSources)
        .where(inArray(resourceSources.resourceId, ids))
    : [];
  return { total: n, rows, urlOf: new Map(links.map((l) => [l.rid, l.url])) };
}

/** Telegram files that have no Drive copy yet and read like this Drive file's name. */
async function lookalikes(db: Db, driveNames: { id: number; name: string }[]) {
  if (driveNames.length === 0)
    return new Map<number, { id: number; name: string; score: number }[]>();
  const free = await db
    .select({ id: resources.id, name: resources.displayName })
    .from(resources)
    .where(
      and(
        eq(resources.isActive, true),
        like(resources.resourceKey, "tg:%"),
        sql`not exists (select 1 from resource_sources s where s.resource_id = ${resources.id} and s.source_type = 'google_drive')`,
      ),
    );
  const out = new Map<number, { id: number; name: string; score: number }[]>();
  for (const d of driveNames) {
    const top = free
      .map((f) => ({ ...f, score: similarity(d.name, f.name) }))
      .filter((f) => f.score >= 0.55)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    out.set(d.id, top);
  }
  return out;
}

const tab = (kind: Kind, on: Kind, label: string, n?: number) =>
  `<a class="${kind === on ? "on" : ""}" href="${here}?kind=${kind}">${label}${n === undefined ? "" : ` (${n})`}</a>`;

async function view(db: Db, kind: Kind, page: number, flash?: Flash) {
  const [{ total, rows, urlOf }, nodes] = await Promise.all([
    loadRows(db, kind, page),
    nodeLabels(db),
  ]);
  const drive = rows.filter((r) => r.key.startsWith("drive:"));
  const similar = await lookalikes(
    db,
    drive.map((r) => ({ id: r.id, name: r.name })),
  );
  const back = `<input type="hidden" name="kind" value="${kind}"><input type="hidden" name="page" value="${page}">`;

  const item = (r: (typeof rows)[number]) => {
    const isDrive = r.key.startsWith("drive:");
    const url = urlOf.get(r.id);
    const guess = r.node ? (nodes.byId.get(r.node) ?? "") : "";
    const cands = (similar.get(r.id) ?? [])
      .map(
        (c) =>
          `<form class="inline" method="post" action="${here}/merge"><input type="hidden" name="drive" value="${r.id}"><input type="hidden" name="telegram" value="${c.id}">${back}<button class="btn sm ghost" title="Same file as this Telegram upload">🔗 ${esc(c.name.slice(0, 50))}</button></form>`,
      )
      .join(" ");
    return `<div class="card">
<div class="rule"><div class="main"><span class="route">${esc(r.name)}</span>
<div class="chips"><span class="badge ${r.status === "uncategorized" ? "bad" : "warn"}">${esc(r.status)}</span><span class="badge">${isDrive ? "Drive" : "Telegram"}</span><span class="badge off">#${r.id}</span>${url ? `<a href="${esc(url)}" rel="noreferrer noopener" target="_blank">open ↗</a>` : ""}</div></div></div>
<form method="post" action="${here}/assign" class="row"><input type="hidden" name="id" value="${r.id}">${back}
<input name="node" list="nodes" value="${esc(guess)}" placeholder="Type to choose where it belongs…" autocomplete="off" required>
<button>${guess ? "✔ Assign" : "Assign"}</button></form>
${isDrive ? `<p class="muted" style="margin:.5rem 0 .2rem">${cands ? "Same file as a Telegram upload?" : "No similar Telegram file found."}</p><div class="chips">${cands}</div>` : ""}
</div>`;
  };

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const pager = `<div class="pager">${page > 1 ? `<a class="btn ghost sm" href="${here}?kind=${kind}&page=${page - 1}">← Previous</a>` : ""}<span class="muted">Page ${page} of ${pages} · ${total} to review</span>${page < pages ? `<a class="btn ghost sm" href="${here}?kind=${kind}&page=${page + 1}">Next →</a>` : ""}</div>`;
  return `${flash ? `<div class="flash${flash.err ? " err" : ""}">${esc(flash.text)}</div>` : ""}
<h1>Review</h1>
<p class="muted">Files the sync could not place. Choose where each belongs (start typing a subject or semester) — it is then locked so later syncs keep it there. A Drive file that has a Telegram twin can be joined to it with one click.</p>
<div class="tabs">${tab("all", kind, "All")}${tab("telegram", kind, "Telegram")}${tab("drive", kind, "Drive")}</div>
<datalist id="nodes">${nodes.labels.map((l) => `<option value="${esc(l.label)}"></option>`).join("")}</datalist>
${rows.length ? rows.map(item).join("") : '<div class="card empty">✅ Nothing to review here.</div>'}
${pager}`;
}

export function createReviewUi(deps: ReviewDeps) {
  const { db } = deps;
  const audit = (action: string, detail: object) =>
    db.insert(adminAuditLogs).values({ actor: "panel", action, detail });
  const kindOf = (v: string | null): Kind =>
    (KINDS as readonly string[]).includes(v ?? "") ? (v as Kind) : "all";
  const pageOf = (v: string | null) => Math.max(1, Number(v) || 1);
  const redirect = (f: URLSearchParams, flash: Flash) => {
    const q = new URLSearchParams({
      kind: kindOf(f.get("kind")),
      page: String(pageOf(f.get("page"))),
    });
    q.set("f", `${flash.err ? "!" : ""}${flash.text}`);
    return { redirect: `${here}?${q}` };
  };

  async function assign(f: URLSearchParams) {
    const rid = Number(f.get("id"));
    const nodes = await nodeLabels(db);
    const nid = nodes.byLabel.get((f.get("node") ?? "").trim());
    if (!rid || !nid)
      return redirect(f, { text: "Pick a place from the suggestions list.", err: true });
    const done = await db.transaction(async (tx) => {
      const res = await tx
        .update(resources)
        .set({
          academicNodeId: nid,
          classificationStatus: "classified",
          classificationLocked: true,
          updatedAt: new Date(),
        })
        .where(eq(resources.id, rid))
        .returning({ id: resources.id });
      if (!res.length) return false;
      await tx.delete(resourceNodeLinks).where(eq(resourceNodeLinks.resourceId, rid));
      await tx.insert(resourceNodeLinks).values({ resourceId: rid, nodeId: nid });
      return true;
    });
    if (!done) return redirect(f, { text: "That file no longer exists.", err: true });
    await audit("assign", { resourceId: rid, nodeId: nid, via: "panel" });
    return redirect(f, { text: `✅ #${rid} → ${nodes.byId.get(nid)}` });
  }

  async function merge(f: URLSearchParams) {
    const [d, t] = [Number(f.get("drive")), Number(f.get("telegram"))];
    const [drv] = await db
      .select({ s: resourceSources.sourceRecordId })
      .from(resourceSources)
      .where(
        and(eq(resourceSources.resourceId, d), eq(resourceSources.sourceType, "google_drive")),
      );
    const [tg] = await db
      .select({ s: resourceSources.sourceRecordId })
      .from(resourceSources)
      .where(and(eq(resourceSources.resourceId, t), eq(resourceSources.sourceType, "telegram")));
    if (!drv || !tg)
      return redirect(f, { text: "Could not find one of the two files.", err: true });
    await db
      .insert(driveMatches)
      .values({ driveFileId: drv.s, telegramMessageId: tg.s })
      .onConflictDoUpdate({ target: driveMatches.driveFileId, set: { telegramMessageId: tg.s } });
    await audit("drive.match", { driveResource: d, telegramResource: t, via: "panel" });
    await deps.reclassify();
    return redirect(f, { text: `✅ Drive file joined to Telegram file #${t}` });
  }

  return async (req: HttpReq, sub: string, url: URL): Promise<BridgeUiResult> => {
    if (req.method === "POST") {
      const f = new URLSearchParams((await readBody(req)) ?? "");
      if (sub === "/assign") return assign(f);
      if (sub === "/merge") return merge(f);
      return { code: 404, body: "Not found" };
    }
    if (sub !== "/" && sub !== "") return { code: 404, body: "Not found" };
    const raw = url.searchParams.get("f");
    const flash = raw ? { text: raw.replace(/^!/, ""), err: raw.startsWith("!") } : undefined;
    return {
      body: await view(
        db,
        kindOf(url.searchParams.get("kind")),
        pageOf(url.searchParams.get("page")),
        flash,
      ),
    };
  };
}
export type ReviewUi = ReturnType<typeof createReviewUi>;
