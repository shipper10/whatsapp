import { describe, expect, it } from "vitest";
import type { PrefsPort } from "../src/bot/prefs.js";
import { userCommand } from "../src/bot/userCommands.js";

function memPrefs(): PrefsPort & { langs: Map<string, string>; subs: Set<string> } {
  const langs = new Map<string, string>();
  const subs = new Set<string>();
  return {
    langs,
    subs,
    getLang: async (p) => (langs.get(p) as "ar" | "en") ?? null,
    setLang: async (p, l) => void langs.set(p, l),
    isSubscribed: async (c) => subs.has(c),
    subscribe: async (c) => void subs.add(c),
    unsubscribe: async (c) => void subs.delete(c),
  };
}
const ctx = (prefs: PrefsPort, over = {}) => ({
  prefs,
  userLanguage: true,
  notifyEnabled: true,
  lang: "ar" as const,
  participantId: "p1",
  conversationId: "c1",
  ...over,
});

describe("personal commands", () => {
  it("shows help in the person's language", async () => {
    const p = memPrefs();
    expect(await userCommand("مساعدة", ctx(p))).toContain("كيف أستعمل");
    expect(await userCommand("help", ctx(p, { lang: "en" }))).toContain("How to use");
  });

  it("switches language per person and only when allowed", async () => {
    const p = memPrefs();
    expect(await userCommand("english", ctx(p))).toContain("Language changed");
    expect(p.langs.get("p1")).toBe("en");
    expect(await userCommand("عربي", ctx(p))).toContain("العربية");
    expect(await userCommand("english", ctx(p, { userLanguage: false }))).toBeNull();
  });

  it("subscribes and unsubscribes the chat", async () => {
    const p = memPrefs();
    expect(await userCommand("اشتراك", ctx(p))).toContain("تم الاشتراك");
    expect(p.subs.has("c1")).toBe(true);
    expect(await userCommand("اشتراك", ctx(p))).toContain("مشترك بالفعل");
    expect(await userCommand("الغاء الاشتراك", ctx(p))).toContain("إيقاف");
    expect(await userCommand("الغاء الاشتراك", ctx(p))).toContain("لست مشتركًا");
    expect(await userCommand("اشتراك", ctx(p, { notifyEnabled: false }))).toContain("متوقفة");
  });

  it("never steals ordinary searches", async () => {
    const p = memPrefs();
    expect(await userCommand("كيمياء", ctx(p))).toBeNull();
    expect(await userCommand("5", ctx(p))).toBeNull();
    expect(await userCommand("help me with anatomy", ctx(p))).toBeNull();
  });
});
