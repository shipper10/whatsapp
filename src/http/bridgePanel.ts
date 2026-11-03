import type { IncomingMessage as HttpReq } from "node:http";
import type { BridgeStore, NewRule } from "../bridge/store.js";
import {
  type BridgeRule,
  type ChatInfo,
  MESSAGE_TYPES,
  type MessageType,
  type Platform,
  SENDER_MODES,
  type SenderMode,
} from "../bridge/types.js";
import { readBody } from "./server.js";
import { BASE, esc, page } from "./ui.js";

export interface BridgeUiDeps {
  store: BridgeStore;
  status: () => { whatsapp: boolean; telegram: boolean };
  refresh: () => Promise<{ platform: Platform; count: number }[]>;
  /** Recent forwarding failures (newest first). */
  problems?: () => { at: Date; platform: Platform; type: string; stage: string; error: string }[];
}

export interface BridgeUiResult {
  code?: number;
  body?: string;
  redirect?: string;
}
export type BridgeUi = (req: HttpReq, sub: string, url: URL) => Promise<BridgeUiResult>;

const LABEL: Record<Platform, string> = { whatsapp: "WhatsApp", telegram: "Telegram" };
const here = `${BASE}/bridge`;
const PAGE_SIZE = 15;
const SENDER_LABEL: Record<SenderMode, string> = {
  saved: "Name saved in my contacts (falls back to profile name)",
  profile: "Name the person chose for their own profile",
  custom: "A fixed name I type",
  none: "No name",
};

export const ref = (p: Platform, chatId: string, topicId = "") => `${p}|${chatId}|${topicId}`;

function parseRef(v: string | null | undefined) {
  const [platform, chatId, topicId = ""] = (v ?? "").split("|");
  if ((platform !== "whatsapp" && platform !== "telegram") || !chatId) return null;
  return { platform: platform as Platform, chatId, topicId };
}
type Ref = NonNullable<ReturnType<typeof parseRef>>;

function chatLabel(c: ChatInfo, all: ChatInfo[]): string {
  const parent = c.parentId ? all.find((x) => x.chatId === c.parentId && !x.topicId) : undefined;
  const base = c.topicId && parent ? `${parent.title} › ${c.title}` : c.title;
  return `${base} (${c.kind})`;
}

/** The state of the page lives in the address, so every link and form works without scripts. */
interface State {
  src?: string;
  dst?: string;
  edit?: number;
  qw: string;
  kw: string;
  pw: number;
  qt: string;
  kt: string;
  pt: number;
}

function stateOf(p: URLSearchParams): State {
  const n = (k: string) => Math.max(1, Number(p.get(k)) || 1);
  const edit = Number(p.get("edit"));
  return {
    src: p.get("src") || undefined,
    dst: p.get("dst") || undefined,
    edit: edit > 0 ? edit : undefined,
    qw: p.get("qw") ?? "",
    kw: p.get("kw") ?? "",
    pw: n("pw"),
    qt: p.get("qt") ?? "",
    kt: p.get("kt") ?? "",
    pt: n("pt"),
  };
}

function link(s: State, over: Partial<State>, anchor = "") {
  const m = { ...s, ...over };
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(m))
    if (v !== undefined && v !== "" && v !== 1) p.set(k, String(v));
  const qs = p.toString();
  return `${here}${qs ? `?${qs}` : ""}${anchor}`;
}

function filterChats(all: ChatInfo[], q: string, kind: string) {
  const needle = q.trim().toLowerCase();
  return all.filter((c) => {
    if (kind && c.kind !== kind) return false;
    if (!needle) return true;
    const parent = c.parentId ? all.find((x) => x.chatId === c.parentId && !x.topicId) : undefined;
    return [c.title, parent?.title ?? "", c.chatId].some((t) => t.toLowerCase().includes(needle));
  });
}

function chatTable(p: Platform, all: ChatInfo[], s: State, connected: boolean) {
  const w = p === "whatsapp";
  const q = w ? s.qw : s.qt;
  const kind = w ? s.kw : s.kt;
  const pg = w ? s.pw : s.pt;
  const anchor = w ? "#wa" : "#tg";
  const kinds = [...new Set(all.map((c) => c.kind))].sort();
  const rows = filterChats(all, q, kind);
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const cur = Math.min(pg, pages);
  const shown = rows.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);
  const hidden = Object.entries({
    src: s.src,
    dst: s.dst,
    edit: s.edit,
    ...(w ? { qt: s.qt, kt: s.kt, pt: s.pt } : { qw: s.qw, kw: s.kw, pw: s.pw }),
  })
    .filter(([, v]) => v !== undefined && v !== "" && v !== 1)
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
    .join("");
  const body = shown
    .map((c) => {
      const r = ref(p, c.chatId, c.topicId);
      const pick = (side: "src" | "dst", text: string) =>
        `<a href="${link(s, { [side]: r }, "#builder")}" style="margin-inline-end:.4rem;${s[side] === r ? "font-weight:700" : ""}">${s[side] === r ? "✔ " : ""}${text}</a>`;
      return `<tr><td>${esc(c.topicId ? `↳ ${c.title}` : c.title)}</td><td>${esc(c.kind)}</td><td style="white-space:nowrap">${pick("src", "From")}${pick("dst", "To")}</td></tr>`;
    })
    .join("");
  const nav =
    pages > 1
      ? `<p class="muted">${cur > 1 ? `<a href="${link(s, w ? { pw: cur - 1 } : { pt: cur - 1 }, anchor)}">‹ prev</a> ` : ""}page ${cur} / ${pages} (${rows.length})${cur < pages ? ` <a href="${link(s, w ? { pw: cur + 1 } : { pt: cur + 1 }, anchor)}">next ›</a>` : ""}</p>`
      : `<p class="muted">${rows.length} shown</p>`;
  return `<div class="card" id="${anchor.slice(1)}"><h2>${LABEL[p]} chats <span class="${connected ? "ok" : "bad"}">${connected ? "● connected" : "● not connected"}</span></h2>
<form method="get" action="${here}${anchor}" class="row">${hidden}
<input name="${w ? "qw" : "qt"}" value="${esc(q)}" placeholder="Search name or id…">
<select name="${w ? "kw" : "kt"}"><option value="">All types</option>${kinds.map((k) => `<option${k === kind ? " selected" : ""}>${esc(k)}</option>`).join("")}</select>
<button>Search</button></form>
<table><tr><th>Name</th><th>Type</th><th></th></tr>${body || '<tr><td colspan="3" class="muted">no chats match — press Refresh chat lists if this is empty</td></tr>'}</table>${nav}</div>`;
}

function describeRule(rule: BridgeRule, all: ChatInfo[]) {
  const name = (p: Platform, chatId: string, topicId: string) => {
    const hit = all.find(
      (c) => c.platform === p && c.chatId === chatId && (c.topicId ?? "") === topicId,
    );
    return `${LABEL[p]}: ${hit ? chatLabel(hit, all) : chatId}${topicId && !hit ? ` / topic ${topicId}` : ""}`;
  };
  return `${name(rule.srcPlatform, rule.srcChatId, rule.srcTopicId)} → ${name(rule.dstPlatform, rule.dstChatId, rule.dstTopicId)}`;
}

interface Chats {
  whatsapp: ChatInfo[];
  telegram: ChatInfo[];
}

function render(
  rules: BridgeRule[],
  chats: Chats,
  st: { whatsapp: boolean; telegram: boolean },
  s: State,
  editing: BridgeRule | undefined,
  flash?: { text: string; err?: boolean },
  problems: { at: Date; platform: Platform; type: string; stage: string; error: string }[] = [],
) {
  const all = [...chats.whatsapp, ...chats.telegram];
  const labelOf = (v: string | undefined) => {
    const r = parseRef(v);
    if (!r) return '<span class="muted">not chosen — press “From” / “To” in a table below</span>';
    const hit = all.find(
      (c) => c.platform === r.platform && c.chatId === r.chatId && (c.topicId ?? "") === r.topicId,
    );
    return `${LABEL[r.platform]}: ${esc(hit ? chatLabel(hit, all) : `${r.chatId}${r.topicId ? ` / topic ${r.topicId}` : ""}`)}`;
  };
  const o = editing ?? {
    types: [...MESSAGE_TYPES] as MessageType[],
    senderMode: "saved" as SenderMode,
    customName: "",
    showPhone: true,
    forwardOwn: true,
  };
  const ruleRows = rules
    .map(
      (r) =>
        `<tr><td>${r.enabled ? "🟢" : "⚪"} ${esc(describeRule(r, all))}<div class="muted">${esc(r.types.join(", "))} • name: ${esc(r.senderMode === "custom" ? `“${r.customName}”` : r.senderMode)}${r.showPhone ? " + phone" : ""}${r.forwardOwn ? "" : " • my own messages: no"}</div></td>
<td><a href="${link(s, { edit: r.id, src: ref(r.srcPlatform, r.srcChatId, r.srcTopicId), dst: ref(r.dstPlatform, r.dstChatId, r.dstTopicId) }, "#builder")}">Edit</a></td>
<td><form method="post" action="${here}/rules/${r.id}/toggle"><button class="alt" style="color:inherit;border-color:var(--line)">${r.enabled ? "Pause" : "Resume"}</button></form></td>
<td><form method="post" action="${here}/rules/${r.id}/delete"><button class="alt">Delete</button></form></td></tr>`,
    )
    .join("");
  const check = (name: string, on: boolean, text: string) =>
    `<label style="margin-inline-end:1rem"><input type="checkbox" name="${name}" value="1"${on ? " checked" : ""} style="width:auto"> ${text}</label>`;
  const typeBoxes = MESSAGE_TYPES.map(
    (t) =>
      `<label style="margin-inline-end:.8rem"><input type="checkbox" name="types" value="${t}"${o.types.includes(t) ? " checked" : ""} style="width:auto"> ${t}</label>`,
  ).join("");
  const builder = `<div class="card" id="builder"><h2>${editing ? `Edit rule #${editing.id}` : "New rule"}</h2>
<p><b>From:</b> ${labelOf(s.src)}<br><b>To:</b> ${labelOf(s.dst)}</p>
<form method="post" action="${here}/rules">
<input type="hidden" name="src" value="${esc(s.src ?? "")}"><input type="hidden" name="dst" value="${esc(s.dst ?? "")}">
${editing ? `<input type="hidden" name="edit" value="${editing.id}">` : `<p><label>Direction <select name="direction"><option value="forward">one way (From → To)</option><option value="both">both ways</option></select></label></p>`}
<p>${typeBoxes}</p>
<p><label>Sender name <select name="senderMode">${SENDER_MODES.map((m) => `<option value="${m}"${m === o.senderMode ? " selected" : ""}>${esc(SENDER_LABEL[m])}</option>`).join("")}</select></label></p>
<p><label>Fixed name (used when “A fixed name” is selected) <input name="customName" value="${esc(o.customName)}" maxlength="60"></label></p>
<p>${check("showPhone", o.showPhone, "show phone number (when available)")}${check("forwardOwn", o.forwardOwn, "also forward messages written by my own account")}</p>
<p><button>${editing ? "Save changes" : "Add rule"}</button>${editing ? ` <a href="${link({ ...s, edit: undefined, src: undefined, dst: undefined }, {}, "")}">cancel</a>` : ""}</p></form></div>`;
  return page(
    "Bridge",
    `<h1>WhatsApp ⇄ Telegram bridge</h1>
${flash ? `<div class="flash${flash.err ? " err" : ""}">${esc(flash.text)}</div>` : ""}
<div class="card"><h2>Rules</h2><table>${ruleRows || '<tr><td class="muted">no rules yet</td></tr>'}</table></div>
${
  problems.length
    ? `<div class="card"><h2>Recent problems</h2><table>${problems
        .slice(0, 10)
        .map(
          (p) =>
            `<tr><td class="muted" style="white-space:nowrap">${p.at.toISOString().slice(11, 19)} UTC</td><td>${esc(p.type)} → ${LABEL[p.platform]} (${esc(p.stage)})</td><td class="bad">${esc(p.error)}</td></tr>`,
        )
        .join("")}</table></div>`
    : ""
}
${builder}
<form method="post" action="${here}/refresh"><p><button>Refresh chat lists</button></p></form>
${chatTable("whatsapp", chats.whatsapp, s, st.whatsapp)}${chatTable("telegram", chats.telegram, s, st.telegram)}`,
  );
}

/** Bridge configuration page: searchable chat tables, rules, and a builder to add or edit a rule. No scripts. */
export function createBridgeUi(deps: BridgeUiDeps): BridgeUi {
  const view = async (
    s: State,
    flash?: { text: string; err?: boolean },
  ): Promise<BridgeUiResult> => {
    const [rules, wa, tg] = await Promise.all([
      deps.store.rules(),
      deps.store.chats("whatsapp"),
      deps.store.chats("telegram"),
    ]);
    const editing = s.edit ? rules.find((r) => r.id === s.edit) : undefined;
    if (editing && !s.src && !s.dst) {
      s = {
        ...s,
        src: ref(editing.srcPlatform, editing.srcChatId, editing.srcTopicId),
        dst: ref(editing.dstPlatform, editing.dstChatId, editing.dstTopicId),
      };
    }
    return {
      code: flash?.err ? 400 : 200,
      body: render(
        rules,
        { whatsapp: wa, telegram: tg },
        deps.status(),
        s,
        editing,
        flash,
        deps.problems?.(),
      ),
    };
  };

  return async (req, sub, url) => {
    if (req.method === "GET" || req.method === "HEAD")
      return sub === "/" ? view(stateOf(url.searchParams)) : { code: 404, body: "Not found" };
    if (req.method !== "POST") return { code: 405, body: "Method not allowed" };

    const blank = stateOf(new URLSearchParams());
    if (sub === "/refresh") {
      const r = await deps.refresh();
      return view(blank, {
        text: r.length
          ? r.map((x) => `${LABEL[x.platform]}: ${x.count}`).join(" • ")
          : "Nothing is connected yet",
        err: r.length === 0,
      });
    }
    const m = /^\/rules\/(\d+)\/(toggle|delete)$/.exec(sub);
    if (m) {
      const id = Number(m[1]);
      if (m[2] === "delete") await deps.store.deleteRule(id);
      else {
        const cur = await deps.store.rule(id);
        if (cur) await deps.store.setEnabled(id, !cur.enabled);
      }
      return { redirect: here };
    }
    if (sub === "/rules") {
      const form = new URLSearchParams((await readBody(req)) ?? "");
      const editId = Number(form.get("edit")) || undefined;
      const keep: State = {
        ...blank,
        src: form.get("src") || undefined,
        dst: form.get("dst") || undefined,
        edit: editId,
      };
      const src = parseRef(form.get("src"));
      const dst = parseRef(form.get("dst"));
      const types = form
        .getAll("types")
        .filter((t): t is MessageType => (MESSAGE_TYPES as readonly string[]).includes(t));
      if (!src || !dst)
        return view(keep, {
          text: "Pick a source (From) and a destination (To) from the tables.",
          err: true,
        });
      if (src.platform === dst.platform && src.chatId === dst.chatId && src.topicId === dst.topicId)
        return view(keep, { text: "Source and destination are the same chat.", err: true });
      if (types.length === 0)
        return view(keep, { text: "Select at least one message type.", err: true });
      const mode = form.get("senderMode") as SenderMode;
      const senderMode: SenderMode = (SENDER_MODES as readonly string[]).includes(mode)
        ? mode
        : "saved";
      const customName = (form.get("customName") ?? "").trim().slice(0, 60);
      if (senderMode === "custom" && !customName)
        return view(keep, {
          text: "Type the fixed name, or pick another sender option.",
          err: true,
        });
      const all = [
        ...(await deps.store.chats(src.platform)),
        ...(await deps.store.chats(dst.platform)),
      ];
      const title = (x: Ref) =>
        all.find(
          (c) =>
            c.platform === x.platform && c.chatId === x.chatId && (c.topicId ?? "") === x.topicId,
        )?.title ?? x.chatId;
      const base = {
        enabled: true,
        types,
        senderMode,
        customName,
        showPhone: form.get("showPhone") === "1",
        forwardOwn: form.get("forwardOwn") === "1",
      };
      const mk = (a: Ref, b: Ref): NewRule => ({
        ...base,
        name: `${title(a)} → ${title(b)}`,
        srcPlatform: a.platform,
        srcChatId: a.chatId,
        srcTopicId: a.topicId,
        dstPlatform: b.platform,
        dstChatId: b.chatId,
        dstTopicId: b.topicId,
      });
      if (editId) {
        const cur = await deps.store.rule(editId);
        if (!cur) return view(blank, { text: "That rule no longer exists.", err: true });
        await deps.store.updateRule(editId, { ...mk(src, dst), enabled: cur.enabled });
      } else {
        await deps.store.addRule(mk(src, dst));
        if (form.get("direction") === "both") await deps.store.addRule(mk(dst, src));
      }
      return { redirect: here };
    }
    return { code: 404, body: "Not found" };
  };
}
