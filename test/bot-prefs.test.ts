import { describe, expect, it } from "vitest";
import { step } from "../src/bot/engine.js";
import { setTextOverrides } from "../src/bot/messages.js";
import type { BotConfig, LibraryPort } from "../src/bot/types.js";
import { makeBot, msg } from "./helpers/bot.js";

const who = (n: string) => ({ conversationId: `${n}@c.us`, participantId: `${n}@c.us` });

describe("personal commands through the handler", () => {
  it("remembers each person's language and uses it for later replies", async () => {
    const { handler, provider } = await makeBot();
    const a = who("249911000001");
    const b = who("249911000002");
    let e = msg({ text: "english", ...a });
    await handler.handle(e.id, e.m);
    expect(provider.last()).toContain("Language changed");
    e = msg({ text: "help", ...a });
    await handler.handle(e.id, e.m);
    expect(provider.last()).toContain("How to use");
    e = msg({ text: "مساعدة", ...b }); // someone else keeps the default
    await handler.handle(e.id, e.m);
    expect(provider.last()).toContain("كيف أستعمل");
  });

  it("subscribing works and the admin's own wording replaces the built-in text", async () => {
    const { handler, provider, store } = await makeBot();
    const c = who("249911000003");
    store.data["text.overrides"] = { "subscribed.ar": "تم! ستصلك الجديد" };
    const e = msg({ text: "اشتراك", ...c });
    await handler.handle(e.id, e.m);
    expect(provider.last()).toBe("تم! ستصلك الجديد");
    setTextOverrides({});
  });
});

describe("search through the dictionary", () => {
  const cfg = {
    pageSize: 8,
    maxResults: 10,
    welcome: "w",
    cohort: "c",
    lang: "ar",
    rootIndexId: 0,
    maxBatch: 10,
    aliases: ["كيمياء حيوية=biochemistry"],
    showLinks: { telegram: true, drive: true },
  } as BotConfig;

  it("also searches the other-language spelling and merges without repeats", async () => {
    const asked: string[] = [];
    const lib = {
      findIndexes: async () => [],
      search: async (q: string) => {
        asked.push(q);
        return q.includes("biochemistry")
          ? [
              { id: 2, displayName: "Biochem Sheet" },
              { id: 1, displayName: "Shared" },
            ]
          : [{ id: 1, displayName: "Shared" }];
      },
    } as unknown as LibraryPort;
    const first = await step(lib, cfg, null, "x");
    const turn = await step(lib, cfg, first.state, "؟ كيمياء حيوية");
    expect(asked.some((q) => q.includes("biochemistry"))).toBe(true);
    expect(turn.state.items.map((i) => i.id).sort()).toEqual([1, 2]);
  });
});
