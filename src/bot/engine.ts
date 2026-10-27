import { normalizeText } from "../core/normalize/arabic.js";
import { chunkText, marker, renderIndex } from "../library/indexView.js";
import { clip, t } from "./messages.js";
import { parseSelection, resolveTyped, type Selection } from "./selection.js";
import type { BotConfig, Item, LibraryPort, SessionState, Turn, View } from "./types.js";

const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";
const MAX_STACK = 20;

export const emptyState = (): SessionState => ({
  view: { type: "home" },
  items: [],
  hasNext: false,
  stack: [],
});

type Command =
  | { kind: "home" | "back" | "next" | "prev" }
  | { kind: "select"; sel: Selection }
  | { kind: "text"; text: string };

const WORDS: Record<string, "home" | "back" | "next" | "prev"> = {
  home: "home",
  menu: "home",
  start: "home",
  "0": "home",
  الرئيسيه: "home",
  القائمه: "home",
  قائمه: "home",
  ابدا: "home",
  back: "back",
  رجوع: "back",
  ارجع: "back",
  next: "next",
  التالي: "next",
  المزيد: "next",
  التاليه: "next",
  prev: "prev",
  previous: "prev",
  السابق: "prev",
  السابقه: "prev",
};

export function parseInput(raw: string): Command {
  const s = raw
    .trim()
    .replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)))
    .replace(/\s+/g, " ");
  if (s === "-" || s === "<") return { kind: s === "-" ? "back" : "prev" };
  if (s === "+" || s === ">") return { kind: "next" };
  if (s === "0") return { kind: "home" };
  const w = WORDS[normalizeText(s)];
  if (w) return { kind: w };
  const sel = parseSelection(s);
  if (sel) return { kind: "select", sel };
  return { kind: "text", text: s };
}

const icon = (i: Item) => (i.kind === "node" ? "📁" : i.kind === "resource" ? "📄" : "");

function renderList(
  title: string,
  items: Item[],
  hasNext: boolean,
  page: number,
  cfg: BotConfig,
  extra?: string,
): string {
  const lines = [title, ""];
  if (items.length === 0) lines.push(t("empty", cfg.lang));
  items.forEach((it, i) =>
    lines.push(`${i + 1}. ${icon(it)} ${clip(it.label)}`.replace("  ", " ")),
  );
  lines.push("", "──────────");
  const nav = [t("footerNav", cfg.lang)];
  if (hasNext) nav.push(t("next", cfg.lang));
  if (page > 1) nav.push(t("prev", cfg.lang));
  lines.push(nav.join("  •  "));
  if (extra) lines.push(extra);
  return lines.join("\n");
}

async function homeItems(lib: LibraryPort, cfg: BotConfig): Promise<Item[]> {
  let nodes = await lib.children(null);
  if (nodes.length === 1 && nodes[0]) nodes = await lib.children(nodes[0].id); // single root: show its children
  const items: Item[] = nodes.map((n) => ({ kind: "node", id: n.id, label: n.name }));
  items.push({ kind: "action", id: "recent", label: t("recent", cfg.lang) });
  return items;
}

interface Rendered {
  texts: string[];
  items: Item[];
  hasNext: boolean;
}

/** Shows one of the channel's own index messages with numbered links. */
async function renderIndexView(
  lib: LibraryPort,
  cfg: BotConfig,
  messageId: number,
  header?: string,
): Promise<Rendered> {
  const msg = await lib.indexMessage(messageId);
  if (!msg) return { texts: [t("indexMissing", cfg.lang)], items: [], hasNext: false };
  const r = renderIndex(msg, {
    hideUrl: (u) =>
      (!cfg.showLinks.drive && /(^|\.)drive\.google\.com|docs\.google\.com/i.test(u)) ||
      (!cfg.showLinks.telegram && /(^|\/\/)(www\.)?(t|telegram)\.me\//i.test(u)),
  });
  const items: Item[] = r.entries.map((e) => ({
    kind: "link",
    id: e.targetId,
    label: e.label,
    linkKind: e.kind,
    ord: e.ord,
    block: e.block,
  }));
  const body = header ? `${header}\n\n${r.text}` : r.text;
  const texts = chunkText(body);
  texts[texts.length - 1] = `${texts[texts.length - 1]}\n\n${t("indexFooter", cfg.lang)}`;
  return { texts, items, hasNext: false };
}

async function renderView(lib: LibraryPort, cfg: BotConfig, view: View): Promise<Rendered> {
  const size = cfg.pageSize;
  if (view.type === "index") return renderIndexView(lib, cfg, view.messageId);
  if (view.type === "indexes") {
    const found = await lib.findIndexes(view.query, cfg.aliases, 10);
    const items: Item[] = found.map((f) => ({
      kind: "link",
      id: f.messageId,
      label: f.title,
      linkKind: "other",
      ord: null,
      block: 1,
    }));
    const lines = found.map((f, i) => `${marker(i + 1)} ${clip(f.title, 80)}`);
    const text = [
      `${t("indexesTitle", cfg.lang)} «${clip(view.query, 40)}»`,
      "",
      ...lines,
      "",
      t("footerNav", cfg.lang),
    ].join("\n");
    return { texts: [text], items, hasNext: false };
  }
  if (view.type === "home") {
    const root = cfg.rootIndexId || (await lib.rootIndexId());
    if (root) {
      const idx = await renderIndexView(lib, cfg, root, `${cfg.welcome}\n📚 ${cfg.cohort}`);
      if (idx.items.length > 0) return idx;
    }
    const items = await homeItems(lib, cfg);
    const text = [cfg.welcome, "", `📚 ${cfg.cohort}`, ""]
      .concat(
        items.map(
          (it, i) => `${i + 1}. ${it.kind === "action" ? "" : `${icon(it)} `}${clip(it.label)}`,
        ),
      )
      .concat(["", "──────────", t("searchHint", cfg.lang)])
      .join("\n");
    return { texts: [text], items, hasNext: false };
  }

  if (view.type === "node") {
    const info = await lib.node(view.nodeId);
    const kids = await lib.children(view.nodeId);
    const start = (view.page - 1) * size;
    const items: Item[] = kids
      .slice(start, start + size)
      .map((n) => ({ kind: "node", id: n.id, label: n.name }));
    let hasNext = kids.length > start + size;
    const need = size - items.length;
    if (need > 0) {
      const res = await lib.resources(view.nodeId, need + 1, Math.max(0, start - kids.length));
      items.push(
        ...res
          .slice(0, need)
          .map((r): Item => ({ kind: "resource", id: r.id, label: r.displayName })),
      );
      hasNext = res.length > need;
    } else if (!hasNext && kids.length === start + size) {
      hasNext = (await lib.resources(view.nodeId, 1, 0)).length > 0;
    }
    const title = `📂 ${clip((info?.path ?? []).slice(-2).join(" › ") || "…", 100)}`;
    return {
      texts: [renderList(title, items, hasNext, view.page, cfg, t("searchHint", cfg.lang))],
      items,
      hasNext,
    };
  }

  if (view.type === "search") {
    const offset = (view.page - 1) * size;
    const cap = Math.max(0, cfg.maxResults - offset);
    const res = await lib.search(view.query, Math.min(size, cap) + 1, offset);
    const shown = res.slice(0, Math.min(size, cap));
    const hasNext = res.length > shown.length && offset + shown.length < cfg.maxResults;
    const items = shown.map((r): Item => ({ kind: "resource", id: r.id, label: r.displayName }));
    if (items.length === 0 && view.page === 1) {
      return {
        texts: [
          `${t("searchTitle", cfg.lang)} «${clip(view.query, 40)}»\n\n${t("noResults", cfg.lang)}`,
        ],
        items,
        hasNext: false,
      };
    }
    return {
      texts: [
        renderList(
          `${t("searchTitle", cfg.lang)} «${clip(view.query, 40)}»`,
          items,
          hasNext,
          view.page,
          cfg,
        ),
      ],
      items,
      hasNext,
    };
  }

  const offset = (view.page - 1) * size;
  const res = await lib.recent(size + 1, offset);
  const items = res
    .slice(0, size)
    .map((r): Item => ({ kind: "resource", id: r.id, label: r.displayName }));
  const hasNext = res.length > size && offset + size < cfg.maxResults * 3;
  return {
    texts: [renderList(t("recent", cfg.lang), items, hasNext, view.page, cfg)],
    items,
    hasNext,
  };
}

const pagedView = (v: View, page: number): View =>
  v.type === "home" || v.type === "index" || v.type === "indexes" ? v : { ...v, page };

/** One conversation turn. Pure with respect to I/O except for the library reads; the caller persists state. */
export async function step(
  lib: LibraryPort,
  cfg: BotConfig,
  prev: SessionState | null,
  input: string,
): Promise<Turn> {
  const state = prev ?? emptyState();
  const cmd = parseInput(input);
  let view = state.view;
  let stack = state.stack;
  let prefix: string | undefined;

  const show = async (v: View, st: View[]): Promise<Turn> => {
    const r = await renderView(lib, cfg, v);
    return {
      state: { view: v, items: r.items, hasNext: r.hasNext, stack: st.slice(-MAX_STACK) },
      replies: prefix ? [`${prefix}\n\n${r.texts[0]}`, ...r.texts.slice(1)] : r.texts,
    };
  };

  // fresh session: a bare number or command makes no sense yet, show the home menu
  if (!prev && cmd.kind !== "text") return show({ type: "home" }, []);

  switch (cmd.kind) {
    case "home":
      return show({ type: "home" }, []);
    case "back": {
      const back = stack[stack.length - 1];
      return back ? show(back, stack.slice(0, -1)) : show({ type: "home" }, []);
    }
    case "next":
    case "prev": {
      if (view.type === "home" || view.type === "index" || view.type === "indexes")
        return show(view, stack);
      const page = cmd.kind === "next" ? view.page + 1 : view.page - 1;
      if ((cmd.kind === "next" && !state.hasNext) || page < 1) {
        prefix = t("noMore", cfg.lang);
        return show(view, stack);
      }
      return show(pagedView(view, page), stack);
    }
    case "select": {
      let picks: Item[];
      if (cmd.sel.kind === "typed") {
        if (view.type !== "index" && view.type !== "home") {
          // "sheet 3" outside an index is just a search phrase
          stack = view.type === "search" ? stack : [...stack, view];
          return show({ type: "search", query: input.trim().slice(0, 100), page: 1 }, stack);
        }
        const hits = resolveTyped(
          state.items.flatMap((it, i) =>
            it.kind === "link"
              ? [
                  {
                    n: i + 1,
                    targetId: it.id,
                    label: it.label,
                    kind: it.linkKind,
                    ord: it.ord,
                    block: it.block,
                  },
                ]
              : [],
          ),
          cmd.sel,
        );
        picks = hits.map((h) => state.items[h.n - 1]).filter((x): x is Item => !!x);
        if (picks.length === 0) {
          prefix = t("noTyped", cfg.lang);
          return show(view, stack);
        }
      } else {
        picks = cmd.sel.nums.map((n) => state.items[n - 1]).filter((x): x is Item => !!x);
        if (picks.length === 0) {
          prefix = t("invalid", cfg.lang);
          return show(view, stack);
        }
      }

      if (picks.length === 1) {
        const item = picks[0] as Item;
        if (item.kind === "node")
          return show({ type: "node", nodeId: item.id, page: 1 }, [...stack, view]);
        if (item.kind === "action") return show({ type: "recent", page: 1 }, [...stack, view]);
      }

      const linkIds = picks.flatMap((p) => (p.kind === "link" ? [p.id] : []));
      const kinds = await lib.messageKinds(linkIds);
      if (picks.length === 1 && picks[0]?.kind === "link" && kinds.get(picks[0].id) === "index")
        return show({ type: "index", messageId: picks[0].id }, [...stack, view]);

      const resources: number[] = [];
      const messages: number[] = [];
      const missing: number[] = [];
      let skippedNav = false;
      for (const p of picks) {
        if (p.kind === "resource") resources.push(p.id);
        else if (p.kind === "link") {
          const k = kinds.get(p.id);
          if (k === "file" || k === "text") messages.push(p.id);
          else if (k === "index") skippedNav = true;
          else missing.push(p.id);
        } else skippedNav = true;
      }
      const notes: string[] = [];
      let total = resources.length + messages.length;
      if (total > cfg.maxBatch) {
        notes.push(t("capped", cfg.lang).replace("{n}", String(cfg.maxBatch)));
        const keepMsgs = Math.max(0, cfg.maxBatch - resources.length);
        resources.splice(cfg.maxBatch);
        messages.splice(keepMsgs);
        total = resources.length + messages.length;
      }
      if (skippedNav) notes.push(t("navSkipped", cfg.lang));
      if (missing.length > 0)
        notes.push(`${t("notSynced", cfg.lang)} ${missing.map((m) => `#${m}`).join(" ")}`);
      if (total === 0) {
        prefix = notes.join("\n") || t("invalid", cfg.lang);
        return show(view, stack);
      }
      return {
        state,
        replies: notes.length ? [notes.join("\n")] : [],
        deliver: { resources, messages },
      };
    }
    case "text": {
      const query = cmd.text.slice(0, 100);
      if (normalizeText(query).length === 0) {
        prefix = t("invalid", cfg.lang);
        return show(view, stack);
      }
      // "? word" forces a file search; anything else first tries to jump straight to a matching index.
      const forced = /^\s*(?:[?؟]|بحث\s|search\s)\s*(.*)$/i.exec(query);
      const q = (forced ? (forced[1] ?? "") : query).trim();
      if (forced && normalizeText(q).length === 0) {
        prefix = t("invalid", cfg.lang);
        return show(view, stack);
      }
      if (!forced) {
        const idx = await lib.findIndexes(q, cfg.aliases, 8);
        const next: View | null =
          idx.length === 1 && idx[0]
            ? { type: "index", messageId: idx[0].messageId }
            : idx.length > 1
              ? { type: "indexes", query: q }
              : null;
        if (next) return show(next, view.type === "indexes" ? stack : [...stack, view]);
      }
      stack = view.type === "search" ? stack : [...stack, view];
      return show({ type: "search", query: q, page: 1 }, stack);
    }
  }
}
