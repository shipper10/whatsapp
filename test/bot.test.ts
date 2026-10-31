import { beforeAll, describe, expect, it } from "vitest";
import { stripTrigger } from "../src/bot/handler.js";
import { libraryDb, makeBot, msg } from "./helpers/bot.js";

beforeAll(async () => {
  await libraryDb();
});

const GROUP = "1203630000@g.us";
const A = "249911111111@c.us";
const B = "249922222222@c.us";
const C = "249933333333@c.us";
const inGroup = (who: string, text: string) =>
  msg({ conversationId: GROUP, participantId: who, isGroup: true, text });
const priv = (who: string, text: string) => msg({ conversationId: who, participantId: who, text });

/** The 【n】 number printed next to a label in an index text. */
const numOf = (text: string, label: string) => {
  const m = new RegExp(`${label}\\s*【(\\d+)】`).exec(text);
  if (!m?.[1]) throw new Error(`no number for "${label}" in:\n${text.slice(0, 600)}`);
  return m[1];
};

describe("stripTrigger", () => {
  it("handles symbol prefixes, word prefixes, extra words and absence", () => {
    expect(stripTrigger("!5", ["!"])).toBe("5");
    expect(stripTrigger("! sheet 1-5", ["!"])).toBe("sheet 1-5");
    expect(stripTrigger("!", ["!"])).toBe("");
    expect(stripTrigger("hello! all", ["!"])).toBeNull();
    const tr = ["lib", "library"];
    expect(stripTrigger("LIB", ["lib"])).toBe("");
    expect(stripTrigger("lib chemistry", tr)).toBe("chemistry");
    expect(stripTrigger("Library chemistry sheet", tr)).toBe("chemistry sheet");
    expect(stripTrigger("hello everyone", tr)).toBeNull();
  });
});

describe("private chat", () => {
  const session = async (who: string, bot?: Awaited<ReturnType<typeof makeBot>>) => {
    const b = bot ?? (await makeBot());
    const run = async (t: string) => {
      b.provider.clear();
      const { id, m } = priv(who, t);
      await b.handler.handle(id, m);
      return b.provider.sent.map((x) => x.text).join("\n");
    };
    return { b, run };
  };

  it("home shows the channel's main index; numbers open sub-indexes; typed batches send files", async () => {
    const { b, run } = await session(A);
    const home = await run("0");
    expect(home).toContain("Main Index");
    expect(home).toContain("1st Semester【1】");
    expect(home).toContain("2nd Semester【2】");

    const sem1 = await run("1");
    expect(sem1).toContain("Cell Biology");
    const chem = await run(numOf(sem1, "Chemistry"));
    expect(chem).toContain("Chemistry Index");

    const out = await run("sheet 1");
    expect(out).toContain("⏳"); // more than one file: a heads-up
    expect(b.provider.sent.map((x) => x.text).join("\n")).toMatch(/https:\/\/t\.me\/BahriMed\/\d+/);

    expect(await run("back")).toContain("Cell Biology"); // back to the semester index
    expect(await run("٠")).toContain("Main Index");
  });

  it("typing a subject or semester name (any case, with typos or unfinished) jumps straight to its index", async () => {
    const { run } = await session(A);
    expect(await run("CHEMISTRY")).toContain("Chemistry Index");
    expect(await run("second semester")).toContain("Biomolecules");
    expect(await run("chemistry")).toContain("Chemistry Index");
    const back = await run("-");
    expect(back).toContain("Biomolecules"); // [ - ] goes back to the previous screen
    expect(await run("? chemistry sheet")).toContain("🔎"); // forced file search
    expect(await run("chemstry")).toContain("Did you mean"); // a typo is a guess: shown as a choice
    expect(await run("1")).toContain("Chemistry Index");
  });

  it("the help footer uses plain punctuation, not emoji, for navigation", async () => {
    const { run } = await session(B);
    const home = await run("0");
    expect(home).toContain("[ 0 ] Home");
    expect(home).toContain("[ - ] Back");
    expect(home).not.toContain("↩️");
    expect(home).not.toContain("🏠");
  });

  it("semester 2 is browsable too", async () => {
    const { run } = await session(B);
    await run("0");
    const sem2 = await run("2");
    expect(sem2).toContain("Biomolecules");
    expect(sem2).toContain("Homeostasis");
    const sub = await run(numOf(sem2, "Biomolecules"));
    expect(sub).toContain("Biomolecules Index");
  });

  it("sends a numeric range of files, capped by delivery.maxBatch, and says what it skipped", async () => {
    const { b, run } = await session(C);
    await run("0");
    const sem1 = await run("1");
    const cell = await run(numOf(sem1, "Cell Biology"));
    const lectures = await run("lecture 1-3"); // typed range
    expect(lectures).toContain("3"); // "sending 3 files"
    const sentFiles = b.provider.sent.filter((s) => /t\.me\/BahriMed\/\d+/.test(s.text));
    expect(sentFiles.length).toBe(3);

    // plain numbers and ranges address the 【】 numbers
    b.provider.clear();
    await run("1-2");
    expect(b.provider.sent.filter((s) => /t\.me\/BahriMed\/\d+/.test(s.text)).length).toBe(2);

    await b.settings.set("delivery.maxBatch", 2, "test");
    const capped = await run("all sheets");
    expect(capped).toContain("2"); // first 2 only
    expect(cell).toContain("Cell division");
    expect(await run("sheet 99")).toContain("couldn't find");
  });

  it("free text searches (Arabic-Indic digits work too), pages, and reports no results", async () => {
    const bot = await makeBot();
    const run = async (t: string) => {
      const { id, m } = priv(B, t);
      await bot.handler.handle(id, m);
      return bot.provider.last();
    };
    const res = await run("chemistry sheet");
    expect(res).toContain("🔎");
    expect(res).toContain("1. 📄");
    expect(res).toContain("[ + ] Next");
    expect(await run("zzqq nothing")).toContain("No results");
    expect(await run("99")).toContain("Invalid choice");
  });

  it("session persists across a restart and expires after the TTL", async () => {
    let t = Date.now();
    const bot = await makeBot({ now: () => t, env: { SESSION_TTL_MINUTES: "5" } });
    const send = async (h: typeof bot.handler, text: string) => {
      const { id, m } = priv(C, text);
      m.timestamp = Math.floor(t / 1000);
      await h.handle(id, m);
      return bot.provider.last();
    };
    await send(bot.handler, "0");
    await send(bot.handler, "1"); // inside semester 1
    const restarted = bot.makeHandler(); // new process, same DB
    t += 60_000;
    expect(await send(restarted, "back")).toContain("Main Index"); // stack restored from DB
    await send(restarted, "1");
    t += 6 * 60_000; // expired
    const fresh = await send(restarted, "2"); // a bare number with no session => home, not an action on stale state
    expect(fresh).toContain("📚");
  });
});

describe("groups: addressed only by prefix or by replying to the bot", () => {
  const harness = async (env?: NodeJS.ProcessEnv) => {
    const bot = await makeBot({ env });
    const say = async (who: string, text: string, extra: object = {}) => {
      bot.provider.clear();
      const { id, m } = msg({
        conversationId: GROUP,
        participantId: who,
        isGroup: true,
        text,
        ...extra,
      });
      await bot.handler.handle(id, m);
      return bot.provider.sent;
    };
    return { bot, say };
  };

  it("ignores everything except !prefix messages and replies to the bot", async () => {
    const { bot, say } = await harness();
    expect(await say(C, "good morning all")).toHaveLength(0);
    expect(await say(C, "1")).toHaveLength(0);

    const a1 = await say(A, "!");
    expect(a1.length).toBeGreaterThan(0);
    expect(a1[0]?.conversationId).toBe(GROUP);
    expect(a1[0]?.quoteMessageId).toBeTruthy(); // reply quotes the asker

    // an active session no longer makes the bot answer every message of that person
    expect(await say(A, "thanks everyone")).toHaveLength(0);
    expect(await say(A, "1")).toHaveLength(0);

    const viaPrefix = await say(A, "!1");
    expect(viaPrefix.map((x) => x.text).join("\n")).toContain("Cell Biology");

    // the person who asked can continue by replying to the bot's answer, with a navigation command
    const botMsgId = bot.provider.lastId();
    const viaReply = await say(A, "0", { replyToMessageId: botMsgId });
    expect(viaReply.map((x) => x.text).join("\n")).toContain("Main Index");

    // ...but not with free text (that would be a search the person never asked for)
    const again = bot.provider.lastId();
    expect(await say(A, "chemistry", { replyToMessageId: again })).toHaveLength(0);

    // someone else replying to A's answer is not addressed to the bot
    expect(await say(B, "0", { replyToMessageId: again })).toHaveLength(0);
    expect(await say(B, "1", { replyToMessageId: again })).toHaveLength(0);
    // replying to a message that is not the bot's is not addressed to it either
    expect(await say(A, "0", { replyToMessageId: "someone-else" })).toHaveLength(0);
  });

  it("keeps each member's menu separate", async () => {
    const { bot, say } = await harness();
    await say(A, "!");
    await say(B, "!");
    await Promise.all([say(A, "!1"), say(B, "!2")]);
    const sess = await bot.db.query.userSessions.findMany();
    const view = (p: string) =>
      (
        sess.find((s) => s.participantId === p && s.conversationId === GROUP)?.sessionDataJson as {
          view: { messageId: number };
        }
      ).view;
    expect(view(A).messageId).not.toBe(view(B).messageId);
    const keys = sess
      .filter((s) => s.conversationId === GROUP)
      .map((s) => s.participantId)
      .sort();
    expect(keys).toEqual([A, B]);
  });

  it("answers in a private-only policy with a pointer to private chat, and honours group.mode=disabled", async () => {
    const { bot, say } = await harness({ GROUP_REPLY_MODE: "private_only" });
    await say(A, "!");
    expect(bot.provider.last()).toContain("privately");

    const off = await harness({ GROUP_MODE: "disabled" });
    expect(await off.say(A, "!")).toHaveLength(0);
  });

  it("refuses to share state when the sender cannot be identified", async () => {
    const { bot, say } = await harness();
    expect(await say("", "!")).toHaveLength(0);
    expect(bot.logs.join(" ")).toContain("without participant id");
  });
});

describe("robustness", () => {
  it("rapid repeated messages are processed in order without corrupting the session", async () => {
    const bot = await makeBot();
    const first = priv(A, "0");
    await bot.handler.handle(first.id, first.m);
    const burst = ["1", "back", "1", "back", "2", "back"].map((t) => priv(A, t));
    await Promise.all(burst.map((b) => bot.handler.handle(b.id, b.m)));
    const sess = (await bot.db.query.userSessions.findMany()).find((s) => s.conversationId === A);
    expect((sess?.sessionDataJson as { view: { type: string } }).view.type).toBe("home");
  });

  it("ignores redelivered events and stale messages, rate limits with a single warning", async () => {
    const bot = await makeBot({ env: {}, now: () => Date.now() });
    const one = priv(B, "0");
    await bot.handler.handle(one.id, one.m);
    await bot.handler.handle(one.id, one.m); // same event id
    expect(bot.provider.sent).toHaveLength(1);

    const old = priv(B, "0");
    old.m.timestamp = Math.floor(Date.now() / 1000) - 3600;
    await bot.handler.handle(old.id, old.m);
    expect(bot.provider.sent).toHaveLength(1);

    const limited = await makeBot();
    await limited.settings.set("rateLimit.perParticipantPerMinute", 3, "test");
    for (let i = 0; i < 8; i++) {
      const x = priv(C, "0");
      await limited.handler.handle(x.id, x.m);
    }
    const texts = limited.provider.sent.map((s) => s.text);
    expect(texts.filter((x) => x.includes("⏳"))).toHaveLength(1);
    expect(texts.length).toBe(4); // 3 answers + 1 warning, the rest dropped
  });
});
