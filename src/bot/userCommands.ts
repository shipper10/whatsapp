import { normalizeText } from "../core/normalize/text.js";
import { t } from "./messages.js";
import type { PrefsPort } from "./prefs.js";

const set = (...w: string[]) => new Set(w.map((x) => normalizeText(x)));
const HELP = set("help", "?", "commands");
const SUB = set("subscribe", "sub");
const UNSUB = set("unsubscribe", "unsub", "stop");

export interface UserCommandCtx {
  prefs?: PrefsPort;
  notifyEnabled: boolean;
  participantId: string;
  conversationId: string;
}

/**
 * Small personal commands that are not about navigating the library: help and new-file notices.
 * Whole-message matches only, so they never steal a search. Returns the reply, or null when the text
 * is not one of them.
 */
export async function userCommand(text: string, c: UserCommandCtx): Promise<string | null> {
  const w = normalizeText(text.trim());
  if (!w) return null;
  if (HELP.has(w)) return t("help");
  if (c.prefs && (SUB.has(w) || UNSUB.has(w))) {
    if (!c.notifyEnabled) return t("notifyOff");
    const on = await c.prefs.isSubscribed(c.conversationId);
    if (SUB.has(w)) {
      if (on) return t("alreadySubscribed");
      await c.prefs.subscribe(c.conversationId, c.participantId);
      return t("subscribed");
    }
    if (!on) return t("notSubscribed");
    await c.prefs.unsubscribe(c.conversationId);
    return t("unsubscribed");
  }
  return null;
}
