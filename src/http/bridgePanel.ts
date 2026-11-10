import type { IncomingMessage as HttpReq } from "node:http";
import QRCode from "qrcode";
import type { AccountManager } from "../bridge/accounts.js";
import { ANY_TOPIC, contactRef, isContactRef, PRIVATE_CHATS } from "../bridge/engine.js";
import type { BridgeStore, NewRule } from "../bridge/store.js";
import {
  MESSAGE_TYPES,
  type MessageType,
  type Platform,
  SENDER_MODES,
  type SenderMode,
} from "../bridge/types.js";
import { accountConfirmView, accountsView, accountView } from "./bridge/accountsView.js";
import {
  type AccountInfo,
  type Chats,
  findChat,
  parseRef,
  type Ref,
  ref,
} from "./bridge/shared.js";
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

export { ref };

export interface BridgeUiDeps {
  store: BridgeStore;
  /** Connection of the two main accounts; `telegramConfigured` is false when no main Telegram session is set. */
  status: () => { whatsapp: boolean; telegram: boolean; telegramConfigured?: boolean };
  refresh: () => Promise<{ platform: Platform; count: number }[]>;
  /** Extra accounts (Accounts tab). Absent = only the main accounts exist. */
  accounts?: AccountManager;
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
  const chats = async (): Promise<Chats> => {
    const st = deps.status();
    const accounts: AccountInfo[] = [
      { platform: "whatsapp", id: 0, label: "Main", connected: st.whatsapp },
      { platform: "telegram", id: 0, label: "Main", connected: st.telegram },
      ...(deps.accounts ? await deps.accounts.views() : []).map((v) => ({
        platform: v.row.platform,
        id: v.row.id,
        label: v.row.label,
        connected: v.state === "connected",
      })),
    ];
    return { chats: await store.allChats(), accounts };
  };
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
    if (sub === "/accounts" || sub.startsWith("/accounts/")) return accountsPage(sub, q, flash);
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
      const src =
        q.get("src") || ref(rule.srcPlatform, rule.srcChatId, rule.srcTopicId, rule.srcAccountId);
      const dst =
        q.get("dst") || ref(rule.dstPlatform, rule.dstChatId, rule.dstTopicId, rule.dstAccountId);
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

  const accountsPage = async (
    sub: string,
    q: URLSearchParams,
    flash?: Flash,
  ): Promise<BridgeUiResult> => {
    const mgr = deps.accounts;
    if (!mgr) return NOT_FOUND;
    if (sub === "/accounts") {
      const st = deps.status();
      return {
        body: accountsView(
          await mgr.views(),
          {
            whatsapp: { present: true, connected: st.whatsapp },
            telegram: { present: st.telegramConfigured ?? true, connected: st.telegram },
          },
          mgr.telegramAvailable,
          flash,
        ),
      };
    }
    const m = /^\/accounts\/(\d+)(?:\/(confirm))?$/.exec(sub);
    if (!m) return NOT_FOUND;
    const v = await mgr.view(Number(m[1]));
    if (!v) return NOT_FOUND;
    const using = (await store.rulesOfAccount(v.row.platform, v.row.id)).length;
    if (m[2]) return { body: accountConfirmView(v, using) };
    const qr = v.qr
      ? String(await QRCode.toString(v.qr, { type: "svg", margin: 1, width: 280 }))
      : undefined;
    void q;
    return { body: accountView(v, qr, using, flash) };
  };

  const accountAction = async (sub: string, req: HttpReq): Promise<BridgeUiResult | undefined> => {
    const mgr = deps.accounts;
    if (!mgr) return NOT_FOUND;
    const form = new URLSearchParams((await readBody(req)) ?? "");
    if (sub === "/accounts/add-whatsapp" || sub === "/accounts/add-telegram") {
      const platform = sub.endsWith("whatsapp") ? "whatsapp" : "telegram";
      if (platform === "telegram" && !mgr.telegramAvailable)
        return {
          ...(await accountsPage("/accounts", new URLSearchParams(), {
            text: "Telegram API credentials are not set.",
            err: true,
          })),
          code: 400,
        };
      const id = await mgr.create(platform, form.get("label") ?? "");
      return { redirect: `${here}/accounts/${id}` };
    }
    const m = /^\/accounts\/(\d+)\/(rename|toggle|remove|pair|tg-phone|tg-code|tg-session)$/.exec(
      sub,
    );
    if (!m) return NOT_FOUND;
    const id = Number(m[1]);
    const row = await mgr.accounts.get(id);
    if (!row) return NOT_FOUND;
    const back = `${here}/accounts/${id}`;
    const again = async (text: string, err = false): Promise<BridgeUiResult> => ({
      ...(await accountsPage(`/accounts/${id}`, new URLSearchParams(), { text, err })),
      code: err ? 400 : 200,
    });
    try {
      switch (m[2]) {
        case "rename":
          await mgr.rename(id, form.get("label") ?? "");
          break;
        case "toggle":
          await mgr.setEnabled(id, !row.enabled);
          if (form.get("next") === "list") return { redirect: `${here}/accounts` };
          break;
        case "remove": {
          const paused = await mgr.remove(id);
          void paused;
          return { redirect: `${here}/accounts` };
        }
        case "pair": {
          const code = await mgr.pairingCode(id, form.get("phone") ?? "");
          return again(
            `Pairing code: ${code} — type it on the phone (Linked devices → Link with phone number).`,
          );
        }
        case "tg-phone": {
          const phone = (form.get("phone") ?? "").replace(/[^\d+]/g, "");
          if (phone.replace(/\D/g, "").length < 7)
            return again("Enter the phone number with its country code.", true);
          await mgr.telegramBegin(id, phone.startsWith("+") ? phone : `+${phone}`);
          break;
        }
        case "tg-code":
          if (!mgr.telegramAnswer(id, form.get("value") ?? ""))
            return again(
              "There is no login waiting for a code. Start again with the phone number.",
              true,
            );
          break;
        case "tg-session":
          await mgr.telegramImport(id, form.get("value") ?? "");
          break;
      }
    } catch (err) {
      return again(String((err as Error).message ?? err).slice(0, 200), true);
    }
    return { redirect: back };
  };

  /** The settings every reply path (Telegram topic -> the WhatsApp person) uses. */
  const reversePart = (src: Ref) => ({
    senderMode: "none" as SenderMode,
    forwardOwn: true,
    types: [...MESSAGE_TYPES] as MessageType[],
    dstAccountId: src.accountId,
  });

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

    const priv = src.chatId === PRIVATE_CHATS;
    if (priv) {
      if (src.platform !== "whatsapp" || dst.platform !== "telegram")
        return again("“All private chats” goes from WhatsApp to a Telegram group.");
      const g = (await store.allChats()).find(
        (c) =>
          c.platform === "telegram" &&
          (c.accountId ?? 0) === dst.accountId &&
          c.chatId === dst.chatId &&
          !c.topicId,
      );
      if (!g || g.kind !== "forum" || dst.topicId)
        return again(
          "Pick the Telegram group itself under “To” — it must be a group with Topics turned on (refresh the chat lists if it is missing).",
        );
    }
    const all = await store.allChats();
    const title = (x: Ref) =>
      x.chatId === PRIVATE_CHATS ? "All private chats" : (findChat(all, x)?.title ?? x.chatId);
    const base = {
      enabled: true,
      types,
      senderMode: priv ? ("none" as SenderMode) : senderMode,
      customName,
      showPhone: form.get("showPhone") === "1",
      forwardOwn: form.get("forwardOwn") === "1",
      forwardEdits: form.get("forwardEdits") === "1",
      forwardDeletes: form.get("forwardDeletes") === "1",
      logEnabled: form.get("logEnabled") === "1",
      forwardReactions: form.get("forwardReactions") === "1",
      allowedSenders: "",
    };
    const mk = (a: Ref, b: Ref): NewRule => ({
      ...base,
      name: `${title(a)} → ${title(b)}`,
      srcPlatform: a.platform,
      srcAccountId: a.accountId,
      dstAccountId: b.accountId,
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
      if (priv) {
        const reply = (await store.rules()).find((r) => r.dstChatId === contactRef(editId));
        if (reply)
          await store.updateRule(reply.id, {
            ...mk(dst, { ...src, chatId: contactRef(editId), topicId: "" }),
            srcTopicId: ANY_TOPIC,
            ...reversePart(src),
            allowedSenders: reply.allowedSenders,
            enabled: reply.enabled,
          });
      }
      return { redirect: `${here}/rules/${editId}` };
    }
    const id = await store.addRule(mk(src, dst));
    if (priv && form.get("twoWay") === "1")
      await store.addRule({
        ...mk(dst, { ...src, chatId: contactRef(id), topicId: "" }),
        srcTopicId: ANY_TOPIC,
        ...reversePart(src),
        name: `↩ ${title(dst)} → WhatsApp (reply path of rule #${id})`,
      });
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
    if (sub.startsWith("/accounts/")) return accountAction(sub, req) as Promise<BridgeUiResult>;
    if (sub === "/rules") return saveRule(new URLSearchParams((await readBody(req)) ?? ""));

    const m = /^\/rules\/(\d+)\/(toggle|delete|log-toggle|log-clear|repliers)$/.exec(sub);
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
      case "repliers": {
        if (!isContactRef(rule.dstChatId)) break;
        const f = new URLSearchParams((await readBody(req)) ?? "");
        const who = f.get("who");
        const ids = (f.get("ids") ?? "").replace(/[\s,;]+/g, ",").replace(/^,|,$/g, "");
        const allowedSenders = who === "all" ? "*" : who === "list" ? ids : "";
        await store.updateRule(id, { ...rule, allowedSenders });
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
