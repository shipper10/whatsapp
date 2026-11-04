import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildOutgoing, matchRules } from "../src/bridge/engine.js";
import { BridgeService } from "../src/bridge/service.js";
import { BridgeStore } from "../src/bridge/store.js";
import type {
  BridgeEndpoint,
  BridgeMessage,
  BridgeRule,
  Destination,
  OutgoingBridge,
  Platform,
} from "../src/bridge/types.js";
import { MESSAGE_TYPES } from "../src/bridge/types.js";
import { createBridgeUi } from "../src/http/bridgePanel.js";
import { createTestDb } from "./helpers/pg.js";

const rule = (o: Partial<BridgeRule> = {}): BridgeRule => ({
  id: 1,
  name: "r",
  enabled: true,
  srcPlatform: "whatsapp",
  srcChatId: "g1@g.us",
  srcTopicId: "",
  dstPlatform: "telegram",
  dstChatId: "-100",
  dstTopicId: "7",
  types: [...MESSAGE_TYPES],
  senderMode: "profile",
  customName: "",
  showPhone: true,
  forwardOwn: true,
  ...o,
});

const msg = (o: Partial<BridgeMessage> = {}): BridgeMessage => ({
  platform: "whatsapp",
  chatId: "g1@g.us",
  messageId: "m1",
  chatTitle: "Group",
  senderId: "249111@s.whatsapp.net",
  senderName: "Sara",
  senderPhone: "249111",
  type: "text",
  text: "hello",
  timestamp: 1,
  fromMe: false,
  ...o,
});

class FakeEndpoint implements BridgeEndpoint {
  sent: { dest: Destination; out: OutgoingBridge }[] = [];
  failures: unknown[] = [];
  n = 0;
  constructor(
    readonly platform: Platform,
    private onSend?: (id: string) => void,
  ) {}
  ready() {
    return true;
  }
  async send(dest: Destination, out: OutgoingBridge) {
    const f = this.failures.shift();
    if (f) throw f;
    this.sent.push({ dest, out });
    const id = `${this.platform}-out-${++this.n}`;
    this.onSend?.(id);
    return id;
  }
  async listChats() {
    return [];
  }
}

describe("matchRules", () => {
  it("matches source chat, enabled flag, type and topic", () => {
    expect(matchRules(msg(), [rule()])).toHaveLength(1);
    expect(matchRules(msg(), [rule({ enabled: false })])).toHaveLength(0);
    expect(matchRules(msg({ type: "image" }), [rule({ types: ["text"] })])).toHaveLength(0);
    expect(matchRules(msg({ chatId: "other" }), [rule()])).toHaveLength(0);
    const tg = msg({ platform: "telegram", chatId: "-100", topicId: "5" });
    const r = rule({ srcPlatform: "telegram", srcChatId: "-100", srcTopicId: "5" });
    expect(matchRules(tg, [r])).toHaveLength(1);
    expect(matchRules({ ...tg, topicId: "6" }, [r])).toHaveLength(0);
    expect(matchRules({ ...tg, topicId: "6" }, [{ ...r, srcTopicId: "" }])).toHaveLength(1);
  });
});

describe("buildOutgoing", () => {
  it("adds name and phone, and respects the switches", () => {
    expect(buildOutgoing(msg(), rule()).text).toBe("Sara (+249111):\nhello");
    expect(buildOutgoing(msg(), rule({ showPhone: false })).text).toBe("Sara:\nhello");
    expect(buildOutgoing(msg(), rule({ senderMode: "none" })).text).toBe("hello");
    expect(buildOutgoing(msg({ senderPhone: undefined }), rule()).text).toBe("Sara:\nhello");
  });
  it("picks the name by sender mode", () => {
    const m = msg({ senderName: "Sara Profile", savedName: "Sara (Class rep)" });
    expect(buildOutgoing(m, rule({ senderMode: "profile", showPhone: false })).text).toBe(
      "Sara Profile:\nhello",
    );
    expect(buildOutgoing(m, rule({ senderMode: "saved", showPhone: false })).text).toBe(
      "Sara (Class rep):\nhello",
    );
    expect(
      buildOutgoing(msg({ savedName: undefined }), rule({ senderMode: "saved", showPhone: false }))
        .text,
    ).toBe("Sara:\nhello");
    expect(
      buildOutgoing(m, rule({ senderMode: "custom", customName: "Admin", showPhone: false })).text,
    ).toBe("Admin:\nhello");
  });
  it("keeps stickers caption-free", () => {
    const o = buildOutgoing(
      msg({ type: "sticker", text: "😀" }),
      rule({ showPhone: false }),
      undefined,
      "/x.webp",
    );
    expect(o.type).toBe("sticker");
    expect(o.text).toBe("Sara:");
  });
  it("can skip the account's own messages", () => {
    expect(matchRules(msg({ fromMe: true }), [rule({ forwardOwn: false })])).toHaveLength(0);
    expect(matchRules(msg({ fromMe: true }), [rule({ forwardOwn: true })])).toHaveLength(1);
    expect(matchRules(msg({ fromMe: false }), [rule({ forwardOwn: false })])).toHaveLength(1);
  });
  it("turns contacts and polls into readable text", () => {
    const c = buildOutgoing(
      msg({ type: "contact", text: "", contact: { name: "Ali", phone: "123" } }),
      rule(),
    );
    expect(c.type).toBe("text");
    expect(c.text).toContain("Ali");
    const p = buildOutgoing(
      msg({ type: "poll", text: "", poll: { question: "Q?", options: ["a", "b"] } }),
      rule(),
    );
    expect(p.text).toContain("1. a");
  });
});

async function setup() {
  const db = await createTestDb();
  const store = new BridgeStore(db);
  const wa = new FakeEndpoint("whatsapp");
  const tg = new FakeEndpoint("telegram");
  const svc = new BridgeService({
    store,
    endpoints: { whatsapp: wa, telegram: tg },
    tempDir: "./tmp",
    logger: { info() {}, warn() {}, error() {} },
    echoDelayMs: 0,
    sleep: async () => undefined,
  });
  return { store, wa, tg, svc };
}

describe("BridgeService", () => {
  it("forwards to the chosen Telegram topic and records the link", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    await svc.handle(msg());
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]?.dest).toEqual({ chatId: "-100", topicId: "7" });
    expect(await store.isBridged("telegram", "-100", "telegram-out-1")).toBe(true);
  });

  it("does not echo a bridged message back (both-ways rules)", async () => {
    const { store, wa, tg, svc } = await setup();
    await store.addRule(rule({ dstTopicId: "" }));
    await store.addRule(
      rule({
        srcPlatform: "telegram",
        srcChatId: "-100",
        dstPlatform: "whatsapp",
        dstChatId: "g1@g.us",
        dstTopicId: "",
      }),
    );
    await svc.handle(msg());
    expect(tg.sent).toHaveLength(1);
    // Telegram reports our own post as a new outgoing message
    await svc.handle(
      msg({
        platform: "telegram",
        chatId: "-100",
        messageId: "telegram-out-1",
        fromMe: true,
        senderName: "Me",
      }),
    );
    expect(wa.sent).toHaveLength(0);
    // a genuine Telegram message still goes through
    await svc.handle(msg({ platform: "telegram", chatId: "-100", messageId: "x9", text: "hi" }));
    expect(wa.sent).toHaveLength(1);
  });

  it("ignores a redelivered event and unmatched chats", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    await svc.handle(msg());
    await svc.handle(msg());
    await svc.handle(msg({ chatId: "nope@g.us", messageId: "z" }));
    expect(tg.sent).toHaveLength(1);
  });

  it("forwards view-once style media like any media", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    await svc.handle(
      msg({ type: "image", text: "cap", downloadMedia: async () => "/tmp/does-not-matter.jpg" }),
    );
    expect(tg.sent[0]?.out.filePath).toBe("/tmp/does-not-matter.jpg");
    expect(tg.sent[0]?.out.text).toContain("cap");
  });

  it("announces media it could not fetch instead of dropping it", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    await svc.handle(
      msg({ type: "video", downloadMedia: async () => Promise.reject(new Error("gone")) }),
    );
    expect(tg.sent[0]?.out.type).toBe("text");
    expect(tg.sent[0]?.out.text).toContain("could not be transferred");
  });

  it("sends the sender line separately and falls back to a note when a sticker is refused", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    await svc.handle(
      msg({ type: "sticker", text: "😀", downloadMedia: async () => "/tmp/s.webp" }),
    );
    expect(tg.sent.map((x) => x.out.type)).toEqual(["text", "sticker"]);
    expect(tg.sent[1]?.out.text).toBe("");
    // a refused sticker still leaves a note
    const { store: st2, tg: tg2, svc: svc2 } = await setup();
    await st2.addRule(rule());
    const origSend = tg2.send.bind(tg2);
    tg2.send = async (d, o) => {
      if (o.type === "sticker") throw new Error("bad format");
      return origSend(d, o);
    };
    await svc2.handle(
      msg({
        messageId: "s2",
        type: "sticker",
        text: "😀",
        downloadMedia: async () => "/tmp/s.webp",
      }),
    );
    expect(tg2.sent.at(-1)?.out.text).toContain("[sticker 😀]");
  });

  it("does not try to download animated Telegram stickers for WhatsApp", async () => {
    const { store, wa, svc } = await setup();
    await store.addRule(
      rule({
        srcPlatform: "telegram",
        srcChatId: "-100",
        srcTopicId: "",
        dstPlatform: "whatsapp",
        dstChatId: "g1@g.us",
        dstTopicId: "",
      }),
    );
    let downloaded = false;
    await svc.handle(
      msg({
        platform: "telegram",
        chatId: "-100",
        type: "sticker",
        text: "😀",
        mimeType: "application/x-tgsticker",
        downloadMedia: async () => {
          downloaded = true;
          return "/x";
        },
      }),
    );
    expect(downloaded).toBe(false);
    expect(wa.sent[0]?.out.text).toContain("could not be transferred");
  });

  it("explains why a file did not arrive, in the chat and in the problems list", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    const orig = tg.send.bind(tg);
    tg.send = async (d, o) => {
      if (o.filePath) throw new Error("upload exploded");
      return orig(d, o);
    };
    await svc.handle(msg({ type: "image", downloadMedia: async () => "/tmp/p.jpg" }));
    expect(tg.sent.at(-1)?.out.text).toContain("image could not be sent: upload exploded");
    await svc.handle(
      msg({
        messageId: "m9",
        type: "video",
        downloadMedia: async () => Promise.reject(new Error("403 expired")),
      }),
    );
    expect(tg.sent.at(-1)?.out.text).toContain("403 expired");
    const stages = svc.problems().map((p) => p.stage);
    expect(stages).toContain("download");
    expect(stages).toContain("send");
  });

  it("turns a hanging download into a visible error", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    (svc as unknown as { deps: { downloadTimeoutMs: number } }).deps.downloadTimeoutMs = 20;
    await svc.handle(msg({ type: "image", downloadMedia: () => new Promise<string>(() => {}) }));
    expect(tg.sent.at(-1)?.out.text).toContain("download timed out");
  });

  it("ignores chats that no rule uses, and keeps them out of the activity list", async () => {
    const { store, svc } = await setup();
    await store.addRule(rule());
    await svc.handle(msg({ platform: "telegram", chatId: "-999", messageId: "n1" }));
    expect(svc.activity()).toHaveLength(0);
    await svc.handle(msg({ messageId: "n2", type: "image" }));
    expect(svc.activity()[0]?.type).toBe("image");
  });

  it("never forwards a bare name header for an empty text message", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    await svc.handle(msg({ messageId: "e1", type: "text", text: "  " }));
    expect(tg.sent).toHaveLength(0);
  });

  it("lists content it does not recognise", async () => {
    const { store, svc } = await setup();
    await svc.noteUnrecognised("whatsapp", "g1@g.us", ["albumMessage"]);
    expect(svc.activity()).toHaveLength(0); // no rule uses this chat: not of interest
    await store.addRule(rule());
    await svc.noteUnrecognised("whatsapp", "g1@g.us", ["albumMessage"]);
    expect(svc.activity()[0]?.type).toContain("albumMessage");
  });

  it("retries after a FloodWait and then succeeds", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    tg.failures.push(Object.assign(new Error("FLOOD"), { seconds: 3 }));
    await svc.handle(msg());
    expect(tg.sent).toHaveLength(1);
  });

  it("threads a reply onto the copy of the original", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    await svc.handle(msg());
    await svc.handle(msg({ messageId: "m2", replyToId: "m1", text: "re" }));
    expect(tg.sent[1]?.out.replyToId).toBe("telegram-out-1");
  });
});

describe("bridge dashboard", () => {
  it("adds a both-ways rule from the form and renders both chat tables", async () => {
    const db = await createTestDb();
    const store = new BridgeStore(db);
    await store.upsertChats([
      { platform: "whatsapp", chatId: "c@g.us", title: "Batch 20", kind: "community" },
      { platform: "telegram", chatId: "-100", title: "Forum", kind: "forum" },
      {
        platform: "telegram",
        chatId: "-100",
        topicId: "7",
        title: "Notes",
        kind: "topic",
        parentId: "-100",
      },
    ]);
    const ui = createBridgeUi({
      store,
      status: () => ({ whatsapp: true, telegram: true }),
      refresh: async () => [],
    });
    const post = (sub: string, body: string) => {
      const req = Object.assign(new Readable({ read() {} }), { method: "POST" });
      req.push(body);
      req.push(null);
      return ui(req as never, sub, new URL("http://x/"));
    };
    const r = await post(
      "/rules",
      "src=whatsapp%7Cc%40g.us%7C&dst=telegram%7C-100%7C7&direction=both&types=text&types=image&senderMode=saved&showPhone=1&forwardOwn=1",
    );
    expect(r.redirect).toBe("/admin/panel/bridge");
    const rules = await store.rules();
    expect(rules).toHaveLength(2);
    expect(rules[0]?.dstTopicId).toBe("7");
    expect(rules[1]?.srcTopicId).toBe("7");
    expect(rules[0]?.types).toEqual(["text", "image"]);
    const page = await ui({ method: "GET" } as never, "/", new URL("http://x/"));
    expect(page.body).toContain("Batch 20");
    expect(page.body).toContain("Forum › Notes");
  });

  it("edits an existing rule, searches and paginates the chat tables", async () => {
    const db = await createTestDb();
    const store = new BridgeStore(db);
    await store.upsertChats([
      ...Array.from({ length: 40 }, (_, i) => ({
        platform: "whatsapp" as const,
        chatId: `g${i}@g.us`,
        title: `Batch ${i}`,
        kind: "group",
      })),
      { platform: "whatsapp", chatId: "c@g.us", title: "Anatomy Community", kind: "community" },
      { platform: "telegram", chatId: "-100", title: "Forum", kind: "forum" },
    ]);
    const id = await store.addRule(rule({ srcChatId: "g1@g.us", dstTopicId: "" }));
    const ui = createBridgeUi({
      store,
      status: () => ({ whatsapp: true, telegram: true }),
      refresh: async () => [],
      activity: () => [
        {
          at: new Date(),
          platform: "whatsapp",
          chat: "Seen Chat",
          type: "image",
          fromMe: false,
          rules: 1,
        },
      ],
      problems: () => [
        {
          at: new Date(),
          platform: "telegram",
          type: "image",
          stage: "send",
          error: "boom reason",
        },
      ],
    });
    const get = (q: string) => ui({ method: "GET" } as never, "/", new URL(`http://x/?${q}`));
    const search = await get("qw=anatomy");
    expect(search.body).toContain("Anatomy Community");
    expect(search.body).not.toContain("Batch 3<");
    const p1 = await get("");
    expect(p1.body).toContain("page 1 / 3");
    const kind = await get("kw=community");
    expect(kind.body).not.toContain("Batch 5<");
    expect(p1.body).toContain("Recent problems");
    expect(p1.body).toContain("Recent messages seen");
    expect(p1.body).toContain("Seen Chat");
    expect(p1.body).toContain("boom reason");
    const edit = await get(`edit=${id}`);
    expect(edit.body).toContain(`Edit rule #${id}`);
    const post = (sub: string, body: string) => {
      const req = Object.assign(new Readable({ read() {} }), { method: "POST" });
      req.push(body);
      req.push(null);
      return ui(req as never, sub, new URL("http://x/"));
    };
    const r = await post(
      "/rules",
      `edit=${id}&src=whatsapp%7Cg1%40g.us%7C&dst=telegram%7C-100%7C&types=text&senderMode=custom&customName=Admin`,
    );
    expect(r.redirect).toBe("/admin/panel/bridge");
    const upd = await store.rule(id);
    expect(upd?.senderMode).toBe("custom");
    expect(upd?.customName).toBe("Admin");
    expect(upd?.forwardOwn).toBe(false);
    expect(upd?.types).toEqual(["text"]);
    expect((await store.rules()).length).toBe(1);
    const bad = await post(
      "/rules",
      `src=whatsapp%7Cg1%40g.us%7C&dst=telegram%7C-100%7C&types=text&senderMode=custom`,
    );
    expect(bad.code).toBe(400);
  });
});

describe("bridge migrations", () => {
  it("can be run again on a database that already has the tables", async () => {
    const { readFileSync } = await import("node:fs");
    const { sql } = await import("drizzle-orm");
    const db = await createTestDb();
    for (const f of ["0006_bridge", "0007_bridge_v2"])
      for (const part of readFileSync(`drizzle/${f}.sql`, "utf8").split("--> statement-breakpoint"))
        await db.execute(sql.raw(part));
    expect(await new BridgeStore(db).rules()).toEqual([]);
  });
});
