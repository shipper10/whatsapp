import { normalizeText } from "../core/normalize/arabic.js";
import { clip, t } from "./messages.js";
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
  | { kind: "number"; n: number }
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
  if (/^\d{1,3}$/.test(s))
    return Number(s) === 0 ? { kind: "home" } : { kind: "number", n: Number(s) };
  const w = WORDS[normalizeText(s)];
  if (w) return { kind: w };
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

async function renderView(
  lib: LibraryPort,
  cfg: BotConfig,
  view: View,
): Promise<{ text: string; items: Item[]; hasNext: boolean }> {
  const size = cfg.pageSize;
  if (view.type === "home") {
    const items = await homeItems(lib, cfg);
    const text = [cfg.welcome, "", `📚 ${cfg.cohort}`, ""]
      .concat(
        items.map(
          (it, i) => `${i + 1}. ${it.kind === "action" ? "" : `${icon(it)} `}${clip(it.label)}`,
        ),
      )
      .concat(["", "──────────", t("searchHint", cfg.lang)])
      .join("\n");
    return { text, items, hasNext: false };
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
      text: renderList(title, items, hasNext, view.page, cfg, t("searchHint", cfg.lang)),
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
        text: `${t("searchTitle", cfg.lang)} «${clip(view.query, 40)}»\n\n${t("noResults", cfg.lang)}`,
        items,
        hasNext: false,
      };
    }
    return {
      text: renderList(
        `${t("searchTitle", cfg.lang)} «${clip(view.query, 40)}»`,
        items,
        hasNext,
        view.page,
        cfg,
      ),
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
    text: renderList(t("recent", cfg.lang), items, hasNext, view.page, cfg),
    items,
    hasNext,
  };
}

const pagedView = (v: View, page: number): View => (v.type === "home" ? v : { ...v, page });

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
      replies: [prefix ? `${prefix}\n\n${r.text}` : r.text],
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
      if (view.type === "home") return show(view, stack);
      const page = cmd.kind === "next" ? view.page + 1 : view.page - 1;
      if ((cmd.kind === "next" && !state.hasNext) || page < 1) {
        prefix = t("noMore", cfg.lang);
        return show(view, stack);
      }
      return show(pagedView(view, page), stack);
    }
    case "number": {
      const item = state.items[cmd.n - 1];
      if (!item) {
        prefix = t("invalid", cfg.lang);
        return show(view, stack);
      }
      if (item.kind === "node")
        return show({ type: "node", nodeId: item.id, page: 1 }, [...stack, view]);
      if (item.kind === "action") return show({ type: "recent", page: 1 }, [...stack, view]);
      return { state, replies: [], deliver: item.id };
    }
    case "text": {
      const query = cmd.text.slice(0, 100);
      if (normalizeText(query).length === 0) {
        prefix = t("invalid", cfg.lang);
        return show(view, stack);
      }
      stack = view.type === "search" ? stack : [...stack, view];
      return show({ type: "search", query, page: 1 }, stack);
    }
  }
}
