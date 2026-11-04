import type { IncomingMessage as HttpReq } from "node:http";
import type { BridgeStore, NewRule } from "../bridge/store.js";
import {
  MESSAGE_TYPES,
  type MessageType,
  type Platform,
  SENDER_MODES,
  type SenderMode,
} from "../bridge/types.js";
import { findChat, parseRef, type Ref } from "./bridge/shared.js";
import {
  builderView,
  chatsView,
  confirmView,
  rulesView,
  ruleView,
  type SystemData,
  systemView,
} from "./bridge/views.js";
import { readBody } from "./server.js";
import { BASE } from "./ui.js";

export { ref } from "./bridge/shared.js";

export interface BridgeUiDeps {
  store: BridgeStore;
  status: () => { whatsapp: boolean; telegram: boolean };
  refresh: () => Promise<{ platform: Platform; count: number }[]>;
  /** Latest messages the bridge saw, even ones no rule forwarded (newest first). */
  activity?: () => SystemData["activity"];
  queue?: () => Promise<{ pending: number; running: number; failed: number }>;
  failedJobs?: () => Promise<{ kind: string; lastError: string | null }[]>;
  problems?: () => SystemData["problems"];
}

export interface BridgeUiResult {
  code?: number;
  body?: string;
  redirect?: string;
}
export type BridgeUi = (req: HttpReq, sub: string, url: URL) => Promise<BridgeUiResult>;

const here = `${BASE}/bridge`;
const NOT_FOUND = { code: 404, body: "Not found" };

/**
 * Bridge pages (all server-rendered, no scripts):
 *   /            rules          /new, /rules/:id/edit   rule builder
 *   /rules/:id   rule + its log /chats                  chat tables
 *   /system      queue and diagnostics
 */
export function createBridgeUi(deps: BridgeUiDeps): BridgeUi {
  const { store } = deps;
  const chats = async () => ({
    whatsapp: await store.chats("whatsapp"),
    telegram: await store.chats("telegram"),
  });
  const queueStats = () => (deps.queue ? deps.queue() : Promise.resolve(undefined));
  type Flash = { text: string; err?: boolean };

  const getPage = async (
    sub: string,
    q: URLSearchParams,
    flash?: Flash,
  ): Promise<BridgeUiResult> => {
    if (sub === "/")
      return {
        body: await rulesView(store, await chats(), deps.status(), await queueStats(), flash),
      };
    if (sub === "/chats") return { body: chatsView(await chats(), deps.status(), q, flash) };
    if (sub === "/system") {
      const stats = await queueStats();
      const queue = stats ? { ...stats, failedList: (await deps.failedJobs?.()) ?? [] } : undefined;
      return {
        body: systemView(
          deps.status(),
          { queue, problems: deps.problems?.() ?? [], activity: deps.activity?.() ?? [] },
          flash,
        ),
      };
    }
    if (sub === "/new")
      return {
        body: builderView(
          await chats(),
          deps.status(),
          q,
          { src: q.get("src") || undefined, dst: q.get("dst") || undefined },
          flash,
        ),
      };
    const m = /^\/rules\/(\d+)(?:\/(edit|confirm))?$/.exec(sub);
    if (!m) return NOT_FOUND;
    const rule = await store.rule(Number(m[1]));
    if (!rule) return NOT_FOUND;
    if (m[2] === "edit") {
      const src = q.get("src") || `${rule.srcPlatform}|${rule.srcChatId}|${rule.srcTopicId}`;
      const dst = q.get("dst") || `${rule.dstPlatform}|${rule.dstChatId}|${rule.dstTopicId}`;
      return {
        body: builderView(await chats(), deps.status(), q, { src, dst, edit: rule }, flash),
      };
    }
    if (m[2] === "confirm") {
      const action = q.get("do");
      return action === "delete" || action === "log-clear"
        ? { body: confirmView(rule, action) }
        : NOT_FOUND;
    }
    return { body: await ruleView(store, rule, await chats(), q, flash) };
  };

  const saveRule = async (form: URLSearchParams): Promise<BridgeUiResult> => {
    const editId = Number(form.get("edit")) || undefined;
    const back = new URLSearchParams();
    for (const k of ["src", "dst"]) if (form.get(k)) back.set(k, form.get(k) as string);
    const again = async (text: string): Promise<BridgeUiResult> => {
      const page = editId
        ? await getPage(`/rules/${editId}/edit`, back, { text, err: true })
        : await getPage("/new", back, { text, err: true });
      return { ...page, code: 400 };
    };
    const src = parseRef(form.get("src"));
    const dst = parseRef(form.get("dst"));
    const types = form
      .getAll("types")
      .filter((t): t is MessageType => (MESSAGE_TYPES as readonly string[]).includes(t));
    if (!src || !dst) return again("Pick a source (From) and a destination (To) from the tables.");
    if (src.platform === dst.platform && src.chatId === dst.chatId && src.topicId === dst.topicId)
      return again("Source and destination are the same chat.");
    if (types.length === 0) return again("Select at least one message type.");
    const mode = form.get("senderMode") as SenderMode;
    const senderMode: SenderMode = (SENDER_MODES as readonly string[]).includes(mode)
      ? mode
      : "saved";
    const customName = (form.get("customName") ?? "").trim().slice(0, 60);
    if (senderMode === "custom" && !customName)
      return again("Type the fixed name, or pick another sender option.");

    const all = [...(await store.chats(src.platform)), ...(await store.chats(dst.platform))];
    const title = (x: Ref) => findChat(all, x)?.title ?? x.chatId;
    const base = {
      enabled: true,
      types,
      senderMode,
      customName,
      showPhone: form.get("showPhone") === "1",
      forwardOwn: form.get("forwardOwn") === "1",
      forwardEdits: form.get("forwardEdits") === "1",
      forwardDeletes: form.get("forwardDeletes") === "1",
      logEnabled: form.get("logEnabled") === "1",
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
      const cur = await store.rule(editId);
      if (!cur) return { ...NOT_FOUND };
      await store.updateRule(editId, { ...mk(src, dst), enabled: cur.enabled });
      return { redirect: `${here}/rules/${editId}` };
    }
    const id = await store.addRule(mk(src, dst));
    if (form.get("direction") === "both") await store.addRule(mk(dst, src));
    return { redirect: `${here}/rules/${id}` };
  };

  return async (req, sub, url) => {
    if (req.method === "GET" || req.method === "HEAD") return getPage(sub, url.searchParams);
    if (req.method !== "POST") return { code: 405, body: "Method not allowed" };

    if (sub === "/refresh") {
      const r = await deps.refresh();
      const flash = {
        text: r.length
          ? `Refreshed — ${r.map((x) => `${x.platform}: ${x.count}`).join(" • ")}`
          : "Nothing is connected yet",
        err: r.length === 0,
      };
      return {
        ...(await getPage("/chats", new URLSearchParams(), flash)),
        code: flash.err ? 400 : 200,
      };
    }
    if (sub === "/rules") return saveRule(new URLSearchParams((await readBody(req)) ?? ""));

    const m = /^\/rules\/(\d+)\/(toggle|delete|log-toggle|log-clear)$/.exec(sub);
    if (!m) return NOT_FOUND;
    const id = Number(m[1]);
    const rule = await store.rule(id);
    if (!rule) return NOT_FOUND;
    switch (m[2]) {
      case "delete":
        await store.deleteRule(id);
        return { redirect: here };
      case "toggle": {
        await store.setEnabled(id, !rule.enabled);
        const next = new URLSearchParams((await readBody(req)) ?? "").get("next");
        if (next === "list") return { redirect: here };
        break;
      }
      case "log-toggle":
        await store.setLogEnabled(id, !rule.logEnabled);
        break;
      case "log-clear":
        await store.clearLogs(id);
        break;
    }
    return { redirect: `${here}/rules/${id}` };
  };
}
