import { PRIVATE_CHATS } from "../../bridge/engine.js";
import type { ChatInfo, Platform } from "../../bridge/types.js";
import { esc } from "../ui.js";
import { HERE, LABEL, pager, ref } from "./shared.js";

const PAGE_SIZE = 15;

function filterChats(all: ChatInfo[], q: string, kind: string) {
  const needle = q.trim().toLowerCase();
  return all.filter((c) => {
    if (kind && c.kind !== kind) return false;
    if (!needle) return true;
    const parent = c.parentId ? all.find((x) => x.chatId === c.parentId && !x.topicId) : undefined;
    return [c.title, parent?.title ?? "", c.chatId].some((t) => t.toLowerCase().includes(needle));
  });
}

/**
 * One searchable, paginated chat table. Query keys are prefixed (`w`/`t`) so both tables share a page.
 * With `pick`, each row offers From / To links that put the chat into the rule builder.
 */
export function chatTable(opts: {
  platform: Platform;
  /** 0 = main account. */
  accountId: number;
  /** Shown after the platform name when the platform has several accounts. */
  label?: string;
  chats: ChatInfo[];
  connected: boolean;
  /** Path (under the bridge) of the page this table is on. */
  path: string;
  query: URLSearchParams;
  open?: boolean;
  pick?: { src?: string; dst?: string; link: (side: "src" | "dst", value: string) => string };
}) {
  const { platform: p, chats, query, path } = opts;
  const k = `${p === "whatsapp" ? "w" : "t"}${opts.accountId}`;
  const q = query.get(`q${k}`) ?? "";
  const kind = query.get(`k${k}`) ?? "";
  const rows = filterChats(chats, q, kind);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cur = Math.min(Math.max(1, Number(query.get(`p${k}`)) || 1), pages);
  const shown = rows.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);
  const kinds = [...new Set(chats.map((c) => c.kind))].sort();
  const hidden = [...query.entries()]
    .filter(([key]) => ![`q${k}`, `k${k}`, `p${k}`].includes(key))
    .map(([key, v]) => `<input type="hidden" name="${esc(key)}" value="${esc(v)}">`)
    .join("");
  const body = shown
    .map((c) => {
      const r = ref(p, c.chatId, c.topicId, opts.accountId);
      const actions = opts.pick
        ? (["src", "dst"] as const)
            .map((side) => {
              const on = opts.pick?.[side] === r;
              return `<a class="btn sm${on ? "" : " ghost"}" href="${esc(opts.pick?.link(side, r))}">${on ? "✔ " : ""}${side === "src" ? "From" : "To"}</a>`;
            })
            .join(" ")
        : "";
      return `<tr><td>${esc(c.topicId ? `↳ ${c.title}` : c.title)}</td><td><span class="badge">${esc(c.kind)}</span></td>${opts.pick ? `<td style="white-space:nowrap">${actions}</td>` : ""}</tr>`;
    })
    .join("");
  const cols = opts.pick ? 3 : 2;
  const allPrivate =
    opts.pick && p === "whatsapp" && cur === 1 && !q && !kind
      ? (() => {
          const r = ref(p, PRIVATE_CHATS, "", opts.accountId);
          const on = opts.pick?.src === r;
          return `<tr><td><b>👤 All private chats</b><br><span class="muted">every new person gets their own topic in a Telegram group</span></td><td><span class="badge ok">special</span></td><td style="white-space:nowrap"><a class="btn sm${on ? "" : " ghost"}" href="${esc(opts.pick?.link("src", r))}">${on ? "✔ " : ""}From</a></td></tr>`;
        })()
      : "";
  return `<details class="card"${opts.open === false ? "" : " open"} id="${k}"><summary>${LABEL[p]}${opts.label ? ` · ${esc(opts.label)}` : ""} chats <span class="badge ${opts.connected ? "ok" : "bad"}">${opts.connected ? "connected" : "not connected"}</span><span class="muted">${chats.length} total</span></summary>
<form method="get" action="${HERE}${path}#${k}" class="row">${hidden}
<input name="q${k}" value="${esc(q)}" placeholder="Search name or id…">
<select name="k${k}"><option value="">All types</option>${kinds.map((x) => `<option${x === kind ? " selected" : ""}>${esc(x)}</option>`).join("")}</select>
<button>Search</button></form>
<div class="scroll"><table><tr><th>Name</th><th>Type</th>${opts.pick ? "<th></th>" : ""}</tr>${allPrivate}${body || `<tr><td colspan="${cols}" class="muted">no chats match — press “Refresh chat lists” on the Chats page if this is empty</td></tr>`}</table></div>
${pager(`${HERE}${path}`, query, `p${k}`, cur, pages, rows.length)}</details>`;
}
