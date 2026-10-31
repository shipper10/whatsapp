import { describe, expect, it } from "vitest";
import type { PrefsPort } from "../src/bot/prefs.js";
import { userCommand } from "../src/bot/userCommands.js";

function memPrefs(): PrefsPort & { subs: Set<string> } {
  const subs = new Set<string>();
  return {
    subs,
    isSubscribed: async (c) => subs.has(c),
    subscribe: async (c) => void subs.add(c),
    unsubscribe: async (c) => void subs.delete(c),
  };
}
const ctx = (prefs: PrefsPort, over = {}) => ({
  prefs,
  notifyEnabled: true,
  participantId: "p1",
  conversationId: "c1",
  ...over,
});

describe("personal commands", () => {
  it("shows help", async () => {
    const p = memPrefs();
    expect(await userCommand("help", ctx(p))).toContain("How to use");
    expect(await userCommand("  HELP ", ctx(p))).toContain("How to use");
  });

  it("subscribes and unsubscribes the chat", async () => {
    const p = memPrefs();
    expect(await userCommand("subscribe", ctx(p))).toContain("Subscribed");
    expect(p.subs.has("c1")).toBe(true);
    expect(await userCommand("subscribe", ctx(p))).toContain("already subscribed");
    expect(await userCommand("unsubscribe", ctx(p))).toContain("stopped");
    expect(await userCommand("unsubscribe", ctx(p))).toContain("not subscribed");
    expect(await userCommand("subscribe", ctx(p, { notifyEnabled: false }))).toContain("off");
  });

  it("never steals ordinary searches", async () => {
    const p = memPrefs();
    expect(await userCommand("chemistry", ctx(p))).toBeNull();
    expect(await userCommand("5", ctx(p))).toBeNull();
    expect(await userCommand("help me with anatomy", ctx(p))).toBeNull();
  });
});
