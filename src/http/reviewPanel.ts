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
import { exclusive } from "../library/apply.js";
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
const KINDS = ["all", "telegram", "drive", "locked"] as const;
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

type Suggestion = { id: number; label: string };

/** Places whose whole name appears in the file's name ("Cell Biology Lecture 7" -> Cell Biology), most specific first. */
function placeGuesses(name: string, nodes: Suggestion[]): Suggestion[] {
  return nodes
    .map((n) => ({
      n,
      score: scoreTitle(words(n.label.split(" › ").pop() ?? ""), name),
      len: words(n.label).length,
    }))
    .filter((x) => x.score >= 0.85)
    .sort((a, b) => b.len - a.len)
    .slice(0, 3)
    .map((x) => x.n);
}

async function loadRows(db: Db, kind: Kind, page: number) {
  const where =
    kind === "locked"
      ? and(eq(resources.isActive, true), eq(resources.classificationLocked, true))
      : and(
          eq(resources.isActive, true),
          inArray(resources.classificationStatus, ["needs_review", "uncategorized"]),
          kind === "all"
            ? undefined
            : like(resources.resourceKey, kind === "drive" ? "drive:%" : "tg:%"),
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

/** Telegram uploads (without a Drive copy yet) whose name contains what the admin typed. */
async function findTelegram(db: Db, q: string) {
  const terms = words(q).slice(0, 5);
  if (terms.length === 0) return [];
  const rows = await db
    .select({ id: resources.id, name: resources.displayName, text: resources.searchText })
    .from(resources)
    .where(
      and(
        eq(resources.isActive, true),
        like(resources.resourceKey, "tg:%"),
        sql`not exists (select 1 from resource_sources s where s.resource_id = ${resources.id} and s.source_type = 'google_drive')`,
        ...terms.map((t) => sql`${resources.searchText} like ${`%${t.replace(/[%_\\]/g, "")}%`}`),
      ),
    )
    .orderBy(asc(resources.displayName))
    .limit(15);
  return rows;
}

async function view(
  db: Db,
  kind: Kind,
  page: number,
  flash?: Flash,
  find?: { id: number; q: string },
) {
  const [{ total, rows, urlOf }, nodes] = await Promise.all([
    loadRows(db, kind, page),
    nodeLabels(db),
  ]);
  const drive = rows.filter((r) => r.key.startsWith("drive:"));
  const similar = await lookalikes(
    db,
    drive.map((r) => ({ id: r.id, name: r.name })),
  );
  const finder = find
    ? await (async () => {
        const [target] = await db
          .select({ name: resources.displayName })
          .from(resources)
          .where(eq(resources.id, find.id));
        const hits = await findTelegram(db, find.q);
        const btn = (h: { id: number; name: string }) =>
          `<form class="inline" method="post" action="${here}/merge"><input type="hidden" name="drive" value="${find.id}"><input type="hidden" name="telegram" value="${h.id}"><input type="hidden" name="kind" value="${kind}"><input type="hidden" name="page" value="${page}"><button class="btn sm">🔗 Same file</button></form>`;
        return `<div class="card"><h2>Find the Telegram file for: ${esc(target?.name ?? "")}</h2>
<form method="get" action="${here}" class="row"><input type="hidden" name="kind" value="drive"><input type="hidden" name="page" value="${page}"><input type="hidden" name="find" value="${find.id}"><input name="q" value="${esc(find.q)}" placeholder="Part of the file name, e.g. krebs" required><button>Search</button></form>
<table>${hits.map((h) => `<tr><td>${esc(h.name)}</td><td>${btn(h)}</td></tr>`).join("") || '<tr><td class="muted">No Telegram file contains all those words. Try fewer or shorter words.</td></tr>'}</table></div>`;
      })()
    : "";
  const back = `<input type="hidden" name="kind" value="${kind}"><input type="hidden" name="page" value="${page}">`;

  const item = (r: (typeof rows)[number]) => {
    const isDrive = r.key.startsWith("drive:");
    const url = urlOf.get(r.id);
    const guess = r.node ? (nodes.byId.get(r.node) ?? "") : "";
    const locked = kind === "locked";
    const cands = locked
      ? ""
      : (similar.get(r.id) ?? [])
          .map(
            (c) =>
              `<form class="inline" method="post" action="${here}/merge"><input type="hidden" name="drive" value="${r.id}"><input type="hidden" name="telegram" value="${c.id}">${back}<button class="btn sm ghost" title="Same file as this Telegram upload">🔗 ${esc(c.name.slice(0, 50))}</button></form>`,
          )
          .join(" ");
    const picks =
      isDrive || locked
        ? ""
        : placeGuesses(r.name, nodes.labels)
            .filter((g) => g.label !== guess)
            .map(
              (g) =>
                `<form class="inline" method="post" action="${here}/assign"><input type="hidden" name="id" value="${r.id}"><input type="hidden" name="node" value="${esc(g.label)}">${back}<button class="btn sm ghost">📌 ${esc(g.label)}</button></form>`,
            )
            .join(" ");
    return `<div class="card">
<div class="rule"><div class="main"><span class="route">${esc(r.name)}</span>
<div class="chips">${locked ? '<span class="badge ok">🔒 locked</span>' : `<span class="badge ${r.status === "uncategorized" ? "bad" : "warn"}">${esc(r.status)}</span>`}<span class="badge">${isDrive ? "Drive" : "Telegram"}</span><span class="badge off">#${r.id}</span>${url ? `<a href="${esc(url)}" rel="noreferrer noopener" target="_blank">open ↗</a>` : ""}</div></div></div>
<form method="post" action="${here}/assign" class="row"><input type="hidden" name="id" value="${r.id}">${back}
<input name="node" list="nodes" value="${esc(guess)}" placeholder="Type to choose where it belongs…" autocomplete="off" required>
<button>${locked ? "Change place" : guess ? "✔ Assign" : "Assign"}</button>${locked ? `<button class="btn ghost" formaction="${here}/unlock" formnovalidate title="Let the sync decide again">🔓 Unlock</button>` : ""}</form>
${picks ? `<p class="muted" style="margin:.5rem 0 .2rem">Looks like it belongs to:</p><div class="chips">${picks}</div>` : ""}
${isDrive && !locked ? `<p class="muted" style="margin:.5rem 0 .2rem">${cands ? "Is this the same file as one of these Telegram uploads? Click to join them:" : "No similar Telegram upload found automatically."}</p><div class="chips">${cands}</div><form method="get" action="${here}" class="row"><input type="hidden" name="kind" value="drive"><input type="hidden" name="page" value="${page}"><input type="hidden" name="find" value="${r.id}"><input name="q" value="${esc(r.name.split(/\s+/).slice(0, 2).join(" "))}" placeholder="Search Telegram files by name"><button class="btn ghost">🔍 Search Telegram files</button></form>` : ""}
</div>`;
  };

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const pager = `<div class="pager">${page > 1 ? `<a class="btn ghost sm" href="${here}?kind=${kind}&page=${page - 1}">← Previous</a>` : ""}<span class="muted">Page ${page} of ${pages} · ${total} ${kind === "locked" ? "locked" : "to review"}</span>${page < pages ? `<a class="btn ghost sm" href="${here}?kind=${kind}&page=${page + 1}">Next →</a>` : ""}</div>`;
  return `${flash ? `<div class="flash${flash.err ? " err" : ""}">${esc(flash.text)}</div>` : ""}
<h1>Review</h1>
${kind === "locked" ? '<div class="card"><p style="margin:0"><b>Locked files</b> are the ones you placed by hand (here or with /assign). Syncs never move them. If you chose wrongly, pick the right place and press <b>Change place</b>, or press <b>🔓 Unlock</b> to let the sync decide again (it may land in review).</p></div>' : ""}
<div class="card"><p style="margin:0"><b>Telegram files:</b> the sync could not tell which subject they belong to. Click a 📌 suggestion, or type the subject (or semester) in the box and press Assign. It is then locked, so later syncs keep it there.</p>
<p style="margin:.5rem 0 0"><b>Drive files:</b> these are Drive files with no matching Telegram upload. If the same document exists in the channel, click 🔗 on the right one (or use 🔍 to search by name) and the two become one file in the library. If it is only on Drive, just Assign it to a subject.</p></div>
${finder}
<div class="tabs">${tab("all", kind, "All")}${tab("telegram", kind, "Telegram")}${tab("drive", kind, "Drive")}${tab("locked", kind, "🔒 Locked")}</div>
<datalist id="nodes">${nodes.labels.map((l) => `<option value="${esc(l.label)}"></option>`).join("")}</datalist>
${rows.length ? rows.map(item).join("") : '<div class="card empty">${kind === "locked" ? "No file has been placed by hand yet." : "✅ Nothing to review here."}</div>'}
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
    const done = await exclusive(() =>
      db.transaction(async (tx) => {
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
      }),
    );
    if (!done) return redirect(f, { text: "That file no longer exists.", err: true });
    await audit("assign", { resourceId: rid, nodeId: nid, via: "panel" });
    return redirect(f, { text: `✅ #${rid} → ${nodes.byId.get(nid)}` });
  }

  async function unlock(f: URLSearchParams) {
    const rid = Number(f.get("id"));
    const res = await exclusive(() =>
      db
        .update(resources)
        .set({ classificationLocked: false, updatedAt: new Date() })
        .where(eq(resources.id, rid))
        .returning({ id: resources.id }),
    );
    if (!res.length) return redirect(f, { text: "That file no longer exists.", err: true });
    await audit("unlock", { resourceId: rid, via: "panel" });
    await deps.reclassify();
    return redirect(f, { text: `✅ #${rid} unlocked: the sync placed it again` });
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
      if (sub === "/unlock") return unlock(f);
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
        Number(url.searchParams.get("find"))
          ? { id: Number(url.searchParams.get("find")), q: url.searchParams.get("q") ?? "" }
          : undefined,
      ),
    };
  };
}
export type ReviewUi = ReturnType<typeof createReviewUi>;
