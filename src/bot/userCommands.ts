import { normalizeText } from "../core/normalize/arabic.js";
import { t } from "./messages.js";
import type { PrefsPort } from "./prefs.js";

type Lang = "ar" | "en";

const set = (...w: string[]) => new Set(w.map((x) => normalizeText(x)));
const HELP = set("مساعدة", "مساعده", "تعليمات", "help", "?", "؟");
const TO_AR = set("عربي", "عربى", "arabic", "ar");
const TO_EN = set("english", "انجليزي", "انجليزى", "en");
const SUB = set("اشتراك", "اشترك", "subscribe");
const UNSUB = set("الغاء الاشتراك", "الغاء اشتراك", "unsubscribe", "ايقاف الاشتراك");

export interface UserCommandCtx {
  prefs?: PrefsPort;
  /** Whether people may choose their own language. */
  userLanguage: boolean;
  notifyEnabled: boolean;
  lang: Lang;
  participantId: string;
  conversationId: string;
}

/**
 * Small personal commands that are not about navigating the library: help, language, subscription.
 * Whole-message matches only, so they never steal a search. Returns the reply, or null when the text
 * is not one of them.
 */
export async function userCommand(text: string, c: UserCommandCtx): Promise<string | null> {
  const w = normalizeText(text.trim());
  if (!w) return null;
  if (HELP.has(w)) return t("help", c.lang);
  if (c.prefs && c.userLanguage && c.participantId && (TO_AR.has(w) || TO_EN.has(w))) {
    const lang: Lang = TO_AR.has(w) ? "ar" : "en";
    await c.prefs.setLang(c.participantId, lang);
    return t("langSet", lang);
  }
  if (c.prefs && (SUB.has(w) || UNSUB.has(w))) {
    if (!c.notifyEnabled) return t("notifyOff", c.lang);
    const on = await c.prefs.isSubscribed(c.conversationId);
    if (SUB.has(w)) {
      if (on) return t("alreadySubscribed", c.lang);
      await c.prefs.subscribe(c.conversationId, c.participantId);
      return t("subscribed", c.lang);
    }
    if (!on) return t("notSubscribed", c.lang);
    await c.prefs.unsubscribe(c.conversationId);
    return t("unsubscribed", c.lang);
  }
  return null;
}
