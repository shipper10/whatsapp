import { describe, expect, it } from "vitest";
import { step } from "../src/bot/engine.js";
import type { BotConfig, LibraryPort } from "../src/bot/types.js";
import { makeBot, msg } from "./helpers/bot.js";

const who = (n: string) => ({ conversationId: `${n}@c.us`, participantId: `${n}@c.us` });

describe("personal commands through the handler", () => {
  it("answers help and handles subscriptions per chat", async () => {
    const { handler, provider } = await makeBot();
    const a = who("249911000001");
    let e = msg({ text: "help", ...a });
    await handler.handle(e.id, e.m);
    expect(provider.last()).toContain("How to use");
    e = msg({ text: "subscribe", ...a });
    await handler.handle(e.id, e.m);
    expect(provider.last()).toContain("Subscribed");
    e = msg({ text: "unsubscribe", ...a });
    await handler.handle(e.id, e.m);
    expect(provider.last()).toContain("stopped");
  });
});

describe("opening an index by name", () => {
  const cfg = {
    pageSize: 8,
    maxResults: 10,
    welcome: "w",
    cohort: "c",
    rootIndexId: 0,
    maxBatch: 10,
    showLinks: { telegram: true, drive: true },
  } as BotConfig;
  const lib = (found: { messageId: number; title: string; score: number }[]) =>
    ({
      findIndexes: async () => found,
      indexMessage: async () => null,
      search: async () => [],
    }) as unknown as LibraryPort;
  const first = (l: LibraryPort) => step(l, cfg, null, "x");

  it("opens the index straight away for a clear match", async () => {
    const l = lib([
      { messageId: 6, title: "Chemistry", score: 1 },
      { messageId: 7, title: "Biochemistry", score: 0.62 },
    ]);
    const turn = await step(l, cfg, (await first(l)).state, "chemistry");
    expect(turn.state.view).toEqual({ type: "index", messageId: 6 });
  });

  it("lists candidates, with a 'did you mean', when it is only a guess", async () => {
    const l = lib([{ messageId: 6, title: "Chemistry", score: 0.73 }]);
    const turn = await step(l, cfg, (await first(l)).state, "chemstry");
    expect(turn.state.view.type).toBe("indexes");
    expect(turn.replies[0]).toContain("Did you mean");
    expect(turn.replies[0]).toContain("Chemistry");
  });

  it("lists candidates when several match equally well", async () => {
    const l = lib([
      { messageId: 3, title: "First Year 1st Semester", score: 0.9 },
      { messageId: 4, title: "First Year 2nd Semester", score: 0.9 },
    ]);
    const turn = await step(l, cfg, (await first(l)).state, "year");
    expect(turn.state.view.type).toBe("indexes");
    expect(turn.replies[0]).not.toContain("Did you mean");
  });

  it("searches files when no index matches, and '? word' always searches files", async () => {
    let searched = "";
    const l = {
      ...lib([{ messageId: 6, title: "Chemistry", score: 1 }]),
      search: async (q: string) => {
        searched = q;
        return [];
      },
    } as unknown as LibraryPort;
    const s = (await first(l)).state;
    await step(l, cfg, s, "? chemistry");
    expect(searched).toBe("chemistry");
  });
});
