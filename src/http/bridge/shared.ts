import type { BridgeRule, ChatInfo, Platform, SenderMode } from "../../bridge/types.js";
import { BASE, esc, page } from "../ui.js";

export const HERE = `${BASE}/bridge`;
export const LABEL: Record<Platform, string> = { whatsapp: "WhatsApp", telegram: "Telegram" };
export const SENDER_LABEL: Record<SenderMode, string> = {
  saved: "Name saved in my contacts (falls back to profile name)",
  profile: "Name the person chose for their own profile",
  custom: "A fixed name I type",
  none: "No name",
};
const SENDER_SHORT: Record<SenderMode, string> = {
  saved: "saved name",
  profile: "profile name",
  custom: "fixed name",
  none: "no name",
};

export const ref = (p: Platform, chatId: string, topicId = "") => `${p}|${chatId}|${topicId}`;

export function parseRef(v: string | null | undefined) {
  const [platform, chatId, topicId = ""] = (v ?? "").split("|");
  if ((platform !== "whatsapp" && platform !== "telegram") || !chatId) return null;
  return { platform: platform as Platform, chatId, topicId };
}
export type Ref = NonNullable<ReturnType<typeof parseRef>>;

export interface Chats {
  whatsapp: ChatInfo[];
  telegram: ChatInfo[];
}

export function chatLabel(c: ChatInfo, all: ChatInfo[]): string {
  const parent = c.parentId ? all.find((x) => x.chatId === c.parentId && !x.topicId) : undefined;
  const base = c.topicId && parent ? `${parent.title} › ${c.title}` : c.title;
  return `${base} (${c.kind})`;
}

export function findChat(all: ChatInfo[], r: Ref) {
  return all.find(
    (c) => c.platform === r.platform && c.chatId === r.chatId && (c.topicId ?? "") === r.topicId,
  );
}

/** "WhatsApp: Batch 20 → Telegram: Forum › Notes". */
export function endpointLabel(all: ChatInfo[], r: Ref) {
  const hit = findChat(all, r);
  return `${LABEL[r.platform]}: ${hit ? chatLabel(hit, all) : `${r.chatId}${r.topicId ? ` / topic ${r.topicId}` : ""}`}`;
}

export const ruleRoute = (rule: BridgeRule, all: ChatInfo[]) => ({
  from: endpointLabel(all, {
    platform: rule.srcPlatform,
    chatId: rule.srcChatId,
    topicId: rule.srcTopicId,
  }),
  to: endpointLabel(all, {
    platform: rule.dstPlatform,
    chatId: rule.dstChatId,
    topicId: rule.dstTopicId,
  }),
});

/** Short badges describing a rule's settings. */
export function ruleChips(r: BridgeRule): string {
  const chip = (t: string, cls = "") => `<span class="badge ${cls}">${esc(t)}</span>`;
  return `<div class="chips">${[
    chip(r.types.length === 10 ? "all types" : r.types.join(", ")),
    chip(
      `name: ${r.senderMode === "custom" ? `“${r.customName}”` : SENDER_SHORT[r.senderMode]}${r.showPhone && r.senderMode !== "none" ? " + phone" : ""}`,
    ),
    r.forwardOwn ? "" : chip("my own messages: off", "warn"),
    r.forwardEdits ? "" : chip("edits: off", "warn"),
    r.forwardDeletes ? "" : chip("deletes: off", "warn"),
    r.logEnabled ? "" : chip("log: off", "off"),
  ].join("")}</div>`;
}

export const utc = (d: Date) => d.toISOString().slice(5, 19).replace("T", " ");

const NAV: [string, string, string][] = [
  ["rules", "", "Rules"],
  ["new", "/new", "+ New rule"],
  ["chats", "/chats", "Chats"],
  ["system", "/system", "System"],
];

/** Every bridge page: tab bar, optional message, then the content. */
export function bridgePage(
  active: string,
  title: string,
  body: string,
  flash?: { text: string; err?: boolean },
) {
  const tabs = NAV.map(
    ([k, p, t]) => `<a href="${HERE}${p}"${k === active ? ' class="on"' : ""}>${t}</a>`,
  ).join("");
  return page(
    `${title} · Bridge`,
    `<h1>WhatsApp ⇄ Telegram bridge</h1><nav class="subnav">${tabs}</nav>${flash ? `<div class="flash${flash.err ? " err" : ""}">${esc(flash.text)}</div>` : ""}${body}`,
  );
}

export function pager(
  base: string,
  query: URLSearchParams,
  key: string,
  cur: number,
  pages: number,
  total: number,
) {
  const href = (n: number) => {
    const q = new URLSearchParams(query);
    if (n > 1) q.set(key, String(n));
    else q.delete(key);
    const s = q.toString();
    return `${base}${s ? `?${s}` : ""}`;
  };
  if (pages <= 1) return `<p class="muted">${total} in total</p>`;
  return `<div class="pager muted">${cur > 1 ? `<a href="${href(cur - 1)}">‹ prev</a>` : ""}<span>page ${cur} / ${pages} (${total})</span>${cur < pages ? `<a href="${href(cur + 1)}">next ›</a>` : ""}</div>`;
}
