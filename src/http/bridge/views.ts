import type { BridgeStore, LogFilter } from "../../bridge/store.js";
import {
  type BridgeRule,
  type ChatInfo,
  MESSAGE_TYPES,
  type MessageType,
  type Platform,
  SENDER_MODES,
  type SenderMode,
} from "../../bridge/types.js";
import { esc } from "../ui.js";
import { chatTable } from "./chatTable.js";
import {
  bridgePage,
  type Chats,
  endpointLabel,
  HERE,
  LABEL,
  pager,
  parseRef,
  ref,
  ruleChips,
  ruleRoute,
  SENDER_LABEL,
  utc,
} from "./shared.js";

export interface Status {
  whatsapp: boolean;
  telegram: boolean;
}
type Flash = { text: string; err?: boolean };

const conn = (name: string, ok: boolean) =>
  `<span class="badge ${ok ? "ok" : "bad"}">${name}: ${ok ? "connected" : "not connected"}</span>`;

/** One collapsible chat table per connected or known account. */
function accountTables(
  chats: Chats,
  path: string,
  query: URLSearchParams,
  pick?: Parameters<typeof chatTable>[0]["pick"],
) {
  return chats.accounts
    .map((a) => {
      const several = chats.accounts.filter((x) => x.platform === a.platform).length > 1;
      return chatTable({
        platform: a.platform,
        accountId: a.id,
        label: several ? a.label : undefined,
        chats: chats.chats.filter((c) => (c.accountId ?? 0) === a.id && c.platform === a.platform),
        connected: a.connected,
        path,
        query,
        pick,
      });
    })
    .join("");
}

// ---- Rules overview

export async function rulesView(
  store: BridgeStore,
  chats: Chats,
  st: Status,
  queue: { pending: number; running: number; failed: number } | undefined,
  flash?: Flash,
) {
  const rules = await store.rules();
  const cards = await Promise.all(
    rules.map(async (r) => {
      const sum = await store.logSummary(r.id);
      const route = ruleRoute(r, chats);
      return `<div class="card rule"><div class="main">
<div>${r.enabled ? '<span class="badge ok">active</span>' : '<span class="badge off">paused</span>'}</div>
<div class="route">${esc(route.from)}<br>→ ${esc(route.to)}</div>
${ruleChips(r)}
<div class="muted">last 24 h: <span class="ok">${sum.done} done</span> • ${sum.skipped} skipped • <span class="${sum.problems ? "bad" : ""}">${sum.problems} problems</span></div></div>
<div class="acts"><a class="btn" href="${HERE}/rules/${r.id}">Open &amp; log</a><a class="btn ghost" href="${HERE}/rules/${r.id}/edit">Edit</a>
<form class="inline" method="post" action="${HERE}/rules/${r.id}/toggle"><input type="hidden" name="next" value="list"><button class="ghost">${r.enabled ? "Pause" : "Resume"}</button></form></div></div>`;
    }),
  );
  const q = queue
    ? `<span class="badge">${queue.pending} waiting</span> <span class="badge">${queue.running} sending</span> <span class="badge ${queue.failed ? "bad" : "ok"}">${queue.failed} failed</span>`
    : "";
  return bridgePage(
    "rules",
    "Rules",
    `<div class="card row" style="justify-content:space-between"><div>${conn("WhatsApp", st.whatsapp)} ${conn("Telegram", st.telegram)} ${q}</div><a class="btn" style="flex:0 0 auto" href="${HERE}/new">+ New rule</a></div>
${cards.join("") || '<div class="card empty">No rules yet. Press “New rule” to connect two chats.</div>'}`,
    flash,
  );
}

// ---- Builder (create / edit)

interface BuilderState {
  src?: string;
  dst?: string;
  edit?: BridgeRule;
}

export function builderView(
  chats: Chats,
  st: Status,
  query: URLSearchParams,
  b: BuilderState,
  flash?: Flash,
) {
  const editing = b.edit;
  const path = editing ? `/rules/${editing.id}/edit` : "/new";
  const label = (v: string | undefined) => {
    const r = parseRef(v);
    return r
      ? esc(endpointLabel(chats, r))
      : '<span class="muted">not chosen yet — press “From” / “To” in a table below</span>';
  };
  const link = (side: "src" | "dst", value: string) => {
    const q = new URLSearchParams(query);
    q.set(side, value);
    return `${HERE}${path}?${q}#builder`;
  };
  const o = editing ?? {
    types: [...MESSAGE_TYPES] as MessageType[],
    senderMode: "saved" as SenderMode,
    customName: "",
    showPhone: true,
    forwardOwn: true,
    forwardEdits: true,
    forwardDeletes: true,
    logEnabled: true,
  };
  const check = (name: string, on: boolean, text: string) =>
    `<label style="display:block"><input type="checkbox" name="${name}" value="1"${on ? " checked" : ""} style="width:auto"> ${text}</label>`;
  const typeBoxes = MESSAGE_TYPES.map(
    (t) =>
      `<label style="margin-inline-end:.8rem;white-space:nowrap"><input type="checkbox" name="types" value="${t}"${o.types.includes(t) ? " checked" : ""} style="width:auto"> ${t}</label>`,
  ).join("");
  const pick = { src: b.src, dst: b.dst, link };
  const tables = accountTables(chats, path, query, pick);
  return bridgePage(
    editing ? "rules" : "new",
    editing ? `Edit rule #${editing.id}` : "New rule",
    `<div class="card" id="builder"><h2>${editing ? `Edit rule #${editing.id}` : "1. Choose the chats"}</h2>
<p><b>From:</b> ${label(b.src)}<br><b>To:</b> ${label(b.dst)}</p>
<p class="muted">Press “From” and “To” in the tables below, then set the options and save at the bottom.</p></div>
${tables}
<div class="card"><h2>${editing ? "Options" : "2. Options"}</h2>
<form method="post" action="${HERE}/rules">
<input type="hidden" name="src" value="${esc(b.src ?? "")}"><input type="hidden" name="dst" value="${esc(b.dst ?? "")}">
${editing ? `<input type="hidden" name="edit" value="${editing.id}">` : `<p><label>Direction <select name="direction"><option value="forward">one way (From → To)</option><option value="both">both ways</option></select></label></p>`}
<details class="card" open><summary>Message types</summary><p>${typeBoxes}</p></details>
<details class="card" open><summary>Sender</summary>
<p><label>Sender name <select name="senderMode">${SENDER_MODES.map((m) => `<option value="${m}"${m === o.senderMode ? " selected" : ""}>${esc(SENDER_LABEL[m])}</option>`).join("")}</select></label></p>
<p><label>Fixed name (used when “A fixed name” is selected) <input name="customName" value="${esc(o.customName)}" maxlength="60"></label></p>
${check("showPhone", o.showPhone, "show phone number (when available)")}</details>
<details class="card" open><summary>Behaviour</summary>
${check("forwardOwn", o.forwardOwn, "also forward messages written by my own account")}
${check("forwardEdits", o.forwardEdits, "mirror edits")}
${check("forwardDeletes", o.forwardDeletes, "mirror deletions")}
${check("logEnabled", o.logEnabled, "keep a log for this rule")}</details>
<p><button>${editing ? "Save changes" : "Add rule"}</button> <a class="btn ghost" href="${editing ? `${HERE}/rules/${editing.id}` : HERE}">Cancel</a></p></form></div>`,
    flash,
  );
}

// ---- One rule: settings + its own log

const LEVEL_BADGE: Record<string, string> = { ok: "ok", skip: "off", warn: "warn", error: "bad" };
const LOG_PAGE = 25;
const FILTERS: [LogFilter, string][] = [
  ["all", "All"],
  ["done", "Done"],
  ["skip", "Skipped"],
  ["problems", "Problems"],
];

export async function ruleView(
  store: BridgeStore,
  rule: BridgeRule,
  chats: Chats,
  query: URLSearchParams,
  flash?: Flash,
) {
  const route = ruleRoute(rule, chats);
  const f = FILTERS.some(([k]) => k === query.get("f")) ? (query.get("f") as LogFilter) : "all";
  const total = await store.logCount(rule.id, f);
  const pages = Math.max(1, Math.ceil(total / LOG_PAGE));
  const cur = Math.min(Math.max(1, Number(query.get("p")) || 1), pages);
  const [rows, sum, everything] = await Promise.all([
    store.logs(rule.id, { filter: f, limit: LOG_PAGE, offset: (cur - 1) * LOG_PAGE }),
    store.logSummary(rule.id),
    store.logCount(rule.id),
  ]);
  const base = `${HERE}/rules/${rule.id}`;
  const tabs = FILTERS.map(
    ([k, t]) =>
      `<a href="${base}${k === "all" ? "" : `?f=${k}`}#log"${k === f ? ' class="on"' : ""}>${t}</a>`,
  ).join("");
  const lines = rows
    .map(
      (r) =>
        `<tr class="l-${esc(r.level)}"><td class="t">${utc(r.at)}</td><td><span class="badge ${LEVEL_BADGE[r.level] ?? ""}">${esc(r.event)}</span></td><td>${esc(r.msgType)}</td><td>${esc(r.detail)}</td></tr>`,
    )
    .join("");
  const q = new URLSearchParams(f === "all" ? "" : { f });
  const post = (action: string, text: string, cls = "ghost") =>
    `<form class="inline" method="post" action="${base}/${action}"><button class="${cls} sm">${text}</button></form>`;
  const ask = (action: string, text: string) =>
    `<a class="btn danger sm" href="${base}/confirm?do=${action}">${text}</a>`;
  return bridgePage(
    "rules",
    `Rule #${rule.id}`,
    `<div class="card rule"><div class="main">
<div>${rule.enabled ? '<span class="badge ok">active</span>' : '<span class="badge off">paused</span>'} <span class="muted">rule #${rule.id}</span></div>
<div class="route">${esc(route.from)}<br>→ ${esc(route.to)}</div>${ruleChips(rule)}
<div class="muted">last 24 h: <span class="ok">${sum.done} done</span> • ${sum.skipped} skipped • <span class="${sum.problems ? "bad" : ""}">${sum.problems} problems</span></div></div>
<div class="acts"><a class="btn ghost" href="${base}/edit">Edit</a>${post("toggle", rule.enabled ? "Pause" : "Resume")}${ask("delete", "Delete")}</div></div>
<details class="card" open id="log"><summary>Log <span class="badge">${everything} lines</span>${rule.logEnabled ? '<span class="badge ok">recording</span>' : '<span class="badge off">stopped</span>'}</summary>
<div class="row" style="justify-content:space-between;margin-bottom:.5rem"><div class="tabs" style="margin:0">${tabs}</div>
<div class="acts" style="flex:0 0 auto;display:flex;gap:.4rem">${post("log-toggle", rule.logEnabled ? "Stop logging" : "Start logging")}${ask("log-clear", "Clear log")}</div></div>
${rule.logEnabled ? "" : '<p class="warn">Logging is stopped for this rule — nothing new is recorded. Old lines are kept until you clear them.</p>'}
<div class="scroll"><table><tr><th>Time (UTC)</th><th>Event</th><th>Type</th><th>Details</th></tr>${lines || `<tr><td colspan="4" class="empty">${everything ? "No lines match this filter." : "Nothing recorded yet."}</td></tr>`}</table></div>
${pager(base, q, "p", cur, pages, total)}
<p class="muted">The newest 500 lines are kept automatically.</p></details>`,
    flash,
  );
}

// ---- Confirmation (no scripts are allowed, so a destructive action asks on its own page)

export function confirmView(rule: BridgeRule, action: "delete" | "log-clear") {
  const text =
    action === "delete"
      ? "Delete this rule and its log? Messages already forwarded stay where they are."
      : "Clear every line of this rule's log?";
  return bridgePage(
    "rules",
    "Confirm",
    `<div class="card"><h2>${action === "delete" ? "Delete" : "Clear log of"} rule #${rule.id}</h2><p>${text}</p>
<form method="post" action="${HERE}/rules/${rule.id}/${action}"><button class="danger">Yes, ${action === "delete" ? "delete" : "clear"}</button> <a class="btn ghost" href="${HERE}/rules/${rule.id}">Cancel</a></form></div>`,
  );
}

// ---- Chats

export function chatsView(chats: Chats, st: Status, query: URLSearchParams, flash?: Flash) {
  return bridgePage(
    "chats",
    "Chats",
    `<div class="card row" style="justify-content:space-between"><span class="muted">The lists refresh by themselves every 30 minutes.</span>
<form class="inline" method="post" action="${HERE}/refresh"><button>Refresh chat lists</button></form></div>
${accountTables(chats, "/chats", query)}`,
    flash,
  );
}

// ---- System

export interface SystemData {
  queue?: {
    pending: number;
    running: number;
    failed: number;
    failedList: { kind: string; lastError: string | null }[];
  };
  problems: { at: Date; platform: Platform; type: string; stage: string; error: string }[];
  activity: {
    at: Date;
    platform: Platform;
    chat: string;
    type: string;
    fromMe: boolean;
    rules: number;
  }[];
}

export function systemView(st: Status, d: SystemData, flash?: Flash) {
  const t = (at: Date) => utc(at);
  const queue = d.queue
    ? `<details class="card" open><summary>Queue <span class="badge">${d.queue.pending} waiting</span><span class="badge">${d.queue.running} sending</span><span class="badge ${d.queue.failed ? "bad" : "ok"}">${d.queue.failed} failed for good</span></summary>
${d.queue.failedList.length ? `<table>${d.queue.failedList.map((f) => `<tr><td>${esc(f.kind)}</td><td class="bad">${esc(f.lastError ?? "")}</td></tr>`).join("")}</table>` : '<p class="muted">Nothing is stuck. Messages that cannot be delivered are retried for about 40 minutes before they are listed here.</p>'}</details>`
    : "";
  return bridgePage(
    "system",
    "System",
    `<div class="card">${conn("WhatsApp", st.whatsapp)} ${conn("Telegram", st.telegram)}</div>
${queue}
<details class="card"${d.problems.length ? " open" : ""}><summary>Recent problems <span class="badge ${d.problems.length ? "bad" : "ok"}">${d.problems.length}</span><span class="muted">since the last restart — each rule’s own log keeps the history</span></summary>
<div class="scroll"><table>${
      d.problems
        .slice(0, 15)
        .map(
          (p) =>
            `<tr><td class="t">${t(p.at)}</td><td>${esc(p.type)} → ${LABEL[p.platform]} (${esc(p.stage)})</td><td class="bad">${esc(p.error)}</td></tr>`,
        )
        .join("") || '<tr><td class="muted">none</td></tr>'
    }</table></div></details>
<details class="card"><summary>Recent messages seen <span class="badge">${d.activity.length}</span><span class="muted">including ones no rule forwarded</span></summary>
<div class="scroll"><table>${
      d.activity
        .slice(0, 20)
        .map(
          (a) =>
            `<tr><td class="t">${t(a.at)}</td><td>${LABEL[a.platform]}: ${esc(a.chat)}</td><td>${esc(a.type)}${a.fromMe ? " (mine)" : ""}</td><td class="${a.rules ? "ok" : "muted"}">${a.rules ? `${a.rules} rule(s)` : "no rule matched"}</td></tr>`,
        )
        .join("") || '<tr><td class="muted">nothing yet since the last restart</td></tr>'
    }</table></div></details>`,
    flash,
  );
}

export type { ChatInfo };
export { ref };
