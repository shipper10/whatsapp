import type { IncomingMessage as HttpReq } from "node:http";
import type { BridgeStore } from "../bridge/store.js";
import {
  type BridgeRule,
  type ChatInfo,
  MESSAGE_TYPES,
  type MessageType,
  type Platform,
} from "../bridge/types.js";
import { readBody } from "./server.js";
import { BASE, esc, page } from "./ui.js";

export interface BridgeUiDeps {
  store: BridgeStore;
  status: () => { whatsapp: boolean; telegram: boolean };
  refresh: () => Promise<{ platform: Platform; count: number }[]>;
}

export interface BridgeUiResult {
  code?: number;
  body?: string;
  redirect?: string;
}
export type BridgeUi = (req: HttpReq, sub: string, url: URL) => Promise<BridgeUiResult>;

const LABEL: Record<Platform, string> = { whatsapp: "WhatsApp", telegram: "Telegram" };
const here = `${BASE}/bridge`;

const ref = (p: Platform, chatId: string, topicId = "") => `${p}|${chatId}|${topicId}`;

function chatLabel(c: ChatInfo, all: ChatInfo[]): string {
  const parent = c.parentId ? all.find((x) => x.chatId === c.parentId && !x.topicId) : undefined;
  const base = c.topicId && parent ? `${parent.title} › ${c.title}` : c.title;
  return `${base} (${c.kind})`;
}

function describe(rule: BridgeRule, all: ChatInfo[]) {
  const name = (p: Platform, chatId: string, topicId: string) => {
    const hit = all.find(
      (c) => c.platform === p && c.chatId === chatId && (c.topicId ?? "") === topicId,
    );
    return `${LABEL[p]}: ${hit ? chatLabel(hit, all) : chatId}${topicId && !hit ? ` / topic ${topicId}` : ""}`;
  };
  return `${name(rule.srcPlatform, rule.srcChatId, rule.srcTopicId)} → ${name(rule.dstPlatform, rule.dstChatId, rule.dstTopicId)}`;
}

function parseRef(
  v: string | null,
): { platform: Platform; chatId: string; topicId: string } | null {
  const [platform, chatId, topicId = ""] = (v ?? "").split("|");
  if ((platform !== "whatsapp" && platform !== "telegram") || !chatId) return null;
  return { platform, chatId, topicId };
}

function render(
  rules: BridgeRule[],
  chats: Record<Platform, ChatInfo[]>,
  st: { whatsapp: boolean; telegram: boolean },
  flash?: { text: string; err?: boolean },
) {
  const all = [...chats.whatsapp, ...chats.telegram];
  const options = (["whatsapp", "telegram"] as const)
    .map(
      (p) =>
        `<optgroup label="${LABEL[p]}">${chats[p]
          .map(
            (c) =>
              `<option value="${esc(ref(p, c.chatId, c.topicId))}">${esc(chatLabel(c, chats[p]))}</option>`,
          )
          .join("")}</optgroup>`,
    )
    .join("");
  const table = (p: Platform) =>
    `<div class="card"><h2>${LABEL[p]} chats <span class="${st[p] ? "ok" : "bad"}">${st[p] ? "● connected" : "● not connected"}</span></h2>
<table><tr><th>Name</th><th>Type</th><th class="muted">ID</th></tr>${
      chats[p]
        .map(
          (c) =>
            `<tr><td>${esc(c.topicId ? `↳ ${c.title}` : c.title)}</td><td>${esc(c.kind)}</td><td class="muted" dir="ltr">${esc(c.chatId)}${c.topicId ? `/${esc(c.topicId)}` : ""}</td></tr>`,
        )
        .join("") || '<tr><td colspan="3" class="muted">nothing yet — press Refresh</td></tr>'
    }</table></div>`;
  const ruleRows = rules
    .map(
      (r) =>
        `<tr><td>${r.enabled ? "🟢" : "⚪"} ${esc(describe(r, all))}<div class="muted">${esc(r.types.join(", "))}${r.showSender ? " • sender" : ""}${r.showPhone ? " + phone" : ""}</div></td>
<td><form method="post" action="${here}/rules/${r.id}/toggle"><button class="alt" style="color:inherit;border-color:var(--line)">${r.enabled ? "Pause" : "Resume"}</button></form></td>
<td><form method="post" action="${here}/rules/${r.id}/delete"><button class="alt">Delete</button></form></td></tr>`,
    )
    .join("");
  const typeBoxes = MESSAGE_TYPES.map(
    (t) =>
      `<label style="margin-inline-end:.8rem"><input type="checkbox" name="types" value="${t}" checked style="width:auto"> ${t}</label>`,
  ).join("");
  return page(
    "Bridge",
    `<h1>WhatsApp ⇄ Telegram bridge</h1>
${flash ? `<div class="flash${flash.err ? " err" : ""}">${esc(flash.text)}</div>` : ""}
<div class="card"><h2>Rules</h2><table>${ruleRows || '<tr><td class="muted">no rules yet</td></tr>'}</table></div>
<div class="card"><h2>New rule</h2>
<form method="post" action="${here}/rules">
<div class="row"><div><label>From<select name="src" required style="width:100%">${options}</select></label></div>
<div><label>To<select name="dst" required style="width:100%">${options}</select></label></div></div>
<p><label>Direction <select name="direction"><option value="forward">one way (From → To)</option><option value="both">both ways</option></select></label></p>
<p>${typeBoxes}</p>
<p><label style="margin-inline-end:1rem"><input type="checkbox" name="showSender" value="1" checked style="width:auto"> show sender name</label>
<label><input type="checkbox" name="showPhone" value="1" checked style="width:auto"> show phone number (when available)</label></p>
<p><button>Add rule</button></p></form></div>
<form method="post" action="${here}/refresh"><p><button>Refresh chat lists</button></p></form>
${table("whatsapp")}${table("telegram")}`,
  );
}

/** The bridge configuration page: two chat tables, the rules, and a form to add a rule. Plain forms, no scripts. */
export function createBridgeUi(deps: BridgeUiDeps): BridgeUi {
  const view = async (flash?: { text: string; err?: boolean }) => {
    const [rules, wa, tg] = await Promise.all([
      deps.store.rules(),
      deps.store.chats("whatsapp"),
      deps.store.chats("telegram"),
    ]);
    return {
      code: flash?.err ? 400 : 200,
      body: render(rules, { whatsapp: wa, telegram: tg }, deps.status(), flash),
    };
  };

  return async (req, sub) => {
    if (req.method === "GET" || req.method === "HEAD")
      return sub === "/" ? view() : { code: 404, body: "Not found" };
    if (req.method !== "POST") return { code: 405, body: "Method not allowed" };

    if (sub === "/refresh") {
      const r = await deps.refresh();
      return view({
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
        const cur = (await deps.store.rules()).find((r) => r.id === id);
        if (cur) await deps.store.setEnabled(id, !cur.enabled);
      }
      return { redirect: here };
    }
    if (sub === "/rules") {
      const form = new URLSearchParams((await readBody(req)) ?? "");
      const src = parseRef(form.get("src"));
      const dst = parseRef(form.get("dst"));
      const types = form
        .getAll("types")
        .filter((t): t is MessageType => (MESSAGE_TYPES as readonly string[]).includes(t));
      if (!src || !dst) return view({ text: "Pick a source and a destination.", err: true });
      if (src.platform === dst.platform && src.chatId === dst.chatId && src.topicId === dst.topicId)
        return view({ text: "Source and destination are the same chat.", err: true });
      if (types.length === 0) return view({ text: "Select at least one message type.", err: true });
      const all = [
        ...(await deps.store.chats(src.platform)),
        ...(await deps.store.chats(dst.platform)),
      ];
      const title = (x: typeof src) =>
        all.find(
          (c) =>
            c.platform === x.platform && c.chatId === x.chatId && (c.topicId ?? "") === x.topicId,
        )?.title ?? x.chatId;
      const base = {
        enabled: true,
        types,
        showSender: form.get("showSender") === "1",
        showPhone: form.get("showPhone") === "1",
      };
      const mk = (a: typeof src, b: typeof dst) => ({
        ...base,
        name: `${title(a)} → ${title(b)}`,
        srcPlatform: a.platform,
        srcChatId: a.chatId,
        srcTopicId: a.topicId,
        dstPlatform: b.platform,
        dstChatId: b.chatId,
        dstTopicId: b.topicId,
      });
      await deps.store.addRule(mk(src, dst));
      if (form.get("direction") === "both") await deps.store.addRule(mk(dst, src));
      return { redirect: here };
    }
    return { code: 404, body: "Not found" };
  };
}
