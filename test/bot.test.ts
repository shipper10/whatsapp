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

describe("stripTrigger", () => {
  it("handles Arabic variants, extra words and absence", () => {
    const tr = ["مكتبة", "library"];
    expect(stripTrigger("المكتبة", ["المكتبة"])).toBe("");
    expect(stripTrigger("مكتبه كيمياء", tr)).toBe("كيمياء");
    expect(stripTrigger("Library chemistry sheet", tr)).toBe("chemistry sheet");
    expect(stripTrigger("hello everyone", tr)).toBeNull();
  });
});

describe("private chat", () => {
  it("home -> semester -> subject -> resource delivers verified links", async () => {
    const bot = await makeBot();
    const run = async (t: string) => {
      const { id, m } = priv(A, t);
      await bot.handler.handle(id, m);
      return bot.provider.last();
    };
    const home = await run("0");
    expect(home).toContain("1. 📁 First Year 1st Semester");
    expect(home).toContain("🆕");
    expect(await run("1")).toContain("1. 📁 Cell Biology");
    const subject = await run("2"); // Chemistry
    expect(subject).toContain("Chemistry");
    bot.provider.clear();
    await run("1"); // first file in Chemistry
    const links = bot.provider.last();
    expect(links).toMatch(/Telegram: https:\/\/t\.me\/BahriMed\/\d+/);
    expect(links).not.toContain("Google Drive"); // no Drive copy exists: never invented
    // back returns to the semester list, home resets
    expect(await run("رجوع")).toContain("Chemistry");
    expect(await run("٠")).toContain("1. 📁");
  });

  it("free text searches (Arabic digits and commands work), pages, and reports no results", async () => {
    const bot = await makeBot();
    const run = async (t: string) => {
      const { id, m } = priv(B, t);
      await bot.handler.handle(id, m);
      return bot.provider.last();
    };
    const res = await run("chemistry sheet");
    expect(res).toContain("🔎");
    expect(res).toContain("1. 📄");
    expect(res).toContain("+ التالي");
    expect(await run("zzqq nothing")).toContain("لم أجد نتائج");
    expect(await run("99")).toContain("اختيار غير صحيح");
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
    expect(await send(restarted, "back")).toContain("1. 📁"); // stack restored from DB: back to home list
    await send(restarted, "1");
    t += 6 * 60_000; // expired
    const fresh = await send(restarted, "2"); // a bare number with no session => home, not an action on stale state
    expect(fresh).toContain("📚");
  });
});

describe("groups: independent sessions per participant", () => {
  it("stays silent unless addressed, then keeps each member's menu separate", async () => {
    const bot = await makeBot();
    const say = async (who: string, text: string) => {
      bot.provider.clear();
      const { id, m } = inGroup(who, text);
      await bot.handler.handle(id, m);
      return bot.provider.sent;
    };

    expect(await say(C, "good morning all")).toHaveLength(0); // not addressed
    const a1 = await say(A, "مكتبة");
    expect(a1).toHaveLength(1);
    expect(a1[0]?.conversationId).toBe(GROUP);
    expect(a1[0]?.quoteMessageId).toBeTruthy(); // reply quotes the asker
    await say(B, "library");

    // A opens semester 1, B opens semester 2: simultaneously, different views
    const [a2, b2] = await Promise.all(
      [say(A, "1"), say(B, "2")].map(async (p) => (await p)[0]?.text ?? ""),
    );
    expect(a2).toBeDefined();
    expect(b2).toBeDefined();

    const aView = (await say(A, "0"))[0]?.text ?? "";
    expect(aView).toContain("📚");
    // B still inside semester 2 even though A went home
    const bNext = (await say(B, "back"))[0]?.text ?? "";
    expect(bNext).toContain("📚");

    // C never started a session: numbers from C are ignored, A's session is untouched
    expect(await say(C, "1")).toHaveLength(0);
    const sess = await bot.db.query.userSessions.findMany();
    const keys = sess
      .filter((s) => s.conversationId === GROUP)
      .map((s) => s.participantId)
      .sort();
    expect(keys).toEqual([A, B]);
  });

  it("two members navigate to different places at the same time without crossover", async () => {
    const bot = await makeBot();
    const go = async (who: string, text: string) => {
      const { id, m } = inGroup(who, text);
      await bot.handler.handle(id, m);
    };
    await go(A, "مكتبة");
    await go(B, "مكتبة");
    bot.provider.clear();
    await Promise.all([go(A, "1"), go(B, "2")]);
    const sess = await bot.db.query.userSessions.findMany();
    const view = (p: string) =>
      (
        sess.find((s) => s.participantId === p && s.conversationId === GROUP)?.sessionDataJson as {
          view: { nodeId: number };
        }
      ).view;
    expect(view(A).nodeId).not.toBe(view(B).nodeId);
  });

  it("answers in a private-only policy with a pointer to private chat, and honours group.mode=disabled", async () => {
    const bot = await makeBot({ env: { GROUP_REPLY_MODE: "private_only" } });
    const { id, m } = inGroup(A, "مكتبة");
    await bot.handler.handle(id, m);
    expect(bot.provider.last()).toContain("الخاص");

    const off = await makeBot({ env: { GROUP_MODE: "disabled" } });
    const x = inGroup(A, "مكتبة");
    await off.handler.handle(x.id, x.m);
    expect(off.provider.sent).toHaveLength(0);
  });

  it("refuses to share state when the sender cannot be identified", async () => {
    const bot = await makeBot();
    const { id, m } = inGroup("", "مكتبة");
    await bot.handler.handle(id, m);
    expect(bot.provider.sent).toHaveLength(0);
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
