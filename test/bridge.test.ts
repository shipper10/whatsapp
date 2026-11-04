import { mkdir } from "node:fs/promises";
import { Readable } from "node:stream";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { buildOutgoing, matchRules } from "../src/bridge/engine.js";
import { BridgeService } from "../src/bridge/service.js";
import { BridgeStore } from "../src/bridge/store.js";
import type {
  AlbumItem,
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

/** A real WebP file, like a sticker. */
async function makeWebp(name: string): Promise<string> {
  const dir = `./tmp/test-${name}`;
  await mkdir(dir, { recursive: true });
  const path = `${dir}/s.webp`;
  await sharp({ create: { width: 8, height: 8, channels: 4, background: "#ff0000" } })
    .webp()
    .toFile(path);
  return path;
}

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
  forwardEdits: true,
  forwardDeletes: true,
  logEnabled: true,
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
  edited: { messageId: string; text: string }[] = [];
  removed: string[] = [];
  albums: { items: AlbumItem[]; replyToId?: string }[] = [];
  withAlbums = false;
  hydrate = new Map<string, BridgeMessage>();
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
  async edit(_d: Destination, messageId: string, out: OutgoingBridge) {
    this.edited.push({ messageId, text: out.text });
    return true;
  }
  async remove(_d: Destination, messageId: string) {
    this.removed.push(messageId);
    return true;
  }
  async rehydrate(ref: unknown) {
    return this.hydrate.get((ref as { id: string }).id) ?? null;
  }
  get sendAlbum() {
    if (!this.withAlbums) return undefined;
    return async (_d: Destination, items: AlbumItem[], replyToId?: string) => {
      this.albums.push({ items, replyToId });
      return items.map(() => `${this.platform}-out-${++this.n}`);
    };
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
    inline: true,
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

  it("sends WhatsApp stickers to Telegram as pictures, with the sender as caption", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    const dl = () => makeWebp("wa-st");
    await svc.handle(msg({ type: "sticker", text: "", downloadMedia: dl }));
    expect(tg.sent.map((x) => x.out.type)).toEqual(["image"]);
    expect(tg.sent[0]?.out.filePath?.endsWith("sticker.png")).toBe(true);
    expect(tg.sent[0]?.out.text).toBe("Sara (+249111):");
  });

  it("sends Telegram stickers natively to WhatsApp, then as a picture, then as a document", async () => {
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
    const tgMsg = (id: string) =>
      msg({
        platform: "telegram",
        chatId: "-100",
        messageId: id,
        type: "sticker",
        text: "😀",
        downloadMedia: () => makeWebp(id),
      });
    await svc.handle(tgMsg("a1"));
    expect(wa.sent.map((x) => x.out.type)).toEqual(["text", "sticker"]);
    // WhatsApp refuses the sticker -> picture
    const orig = wa.send.bind(wa);
    wa.send = async (d, o) => {
      if (o.type === "sticker") throw new Error("sticker refused");
      return orig(d, o);
    };
    wa.sent.length = 0;
    await svc.handle(tgMsg("a2"));
    expect(wa.sent.map((x) => x.out.type)).toEqual(["text", "image"]);
    // and when pictures fail too, the original file goes as a document
    wa.send = async (d, o) => {
      if (o.type === "sticker" || o.type === "image") throw new Error("refused");
      return orig(d, o);
    };
    wa.sent.length = 0;
    await svc.handle(tgMsg("a3"));
    expect(wa.sent.map((x) => x.out.type)).toEqual(["text", "document"]);
  });

  it("falls back to a document when a video is refused, and to a note when everything fails", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    const orig = tg.send.bind(tg);
    tg.send = async (d, o) => {
      if (o.type === "video") throw new Error("bad video");
      return orig(d, o);
    };
    await svc.handle(msg({ type: "video", downloadMedia: async () => "/tmp/v.mp4" }));
    expect(tg.sent.map((x) => x.out.type)).toEqual(["document"]);
    tg.send = async (_d, o) => {
      if (o.type !== "text") throw new Error("nothing works");
      return orig(_d, o);
    };
    await svc.handle(
      msg({ messageId: "v2", type: "video", downloadMedia: async () => "/tmp/v.mp4" }),
    );
    expect(tg.sent.at(-1)?.out.text).toContain("video could not be sent: nothing works");
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
    expect(r.redirect).toMatch(/^\/admin\/panel\/bridge\/rules\/\d+$/);
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
    const get = (q: string, sub = "/chats") =>
      ui({ method: "GET" } as never, sub, new URL(`http://x/?${q}`));
    const search = await get("qw=anatomy");
    expect(search.body).toContain("Anatomy Community");
    expect(search.body).not.toContain("Batch 3<");
    const p1 = await get("");
    expect(p1.body).toContain("page 1 / 3");
    const kind = await get("kw=community");
    expect(kind.body).not.toContain("Batch 5<");
    const sys = (await get("", "/system")).body;
    expect(sys).toContain("Recent problems");
    expect(sys).toContain("Recent messages seen");
    expect(sys).toContain("Seen Chat");
    expect(sys).toContain("boom reason");
    const edit = await get("", `/rules/${id}/edit`);
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
    expect(r.redirect).toBe(`/admin/panel/bridge/rules/${id}`);
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
    for (const f of ["0006_bridge", "0007_bridge_v2", "0008_bridge_queue", "0009_bridge_logs"])
      for (const part of readFileSync(`drizzle/${f}.sql`, "utf8").split("--> statement-breakpoint"))
        await db.execute(sql.raw(part));
    expect(await new BridgeStore(db).rules()).toEqual([]);
  });
});

describe("durable queue", () => {
  it("delivers a job left in the queue by a previous process (rehydrated from its handle)", async () => {
    const { store, tg, wa, svc } = await setup();
    const ruleId = await store.addRule(rule({ dstTopicId: "" }));
    wa.hydrate.set("m77", msg({ messageId: "m77", text: "survived a restart" }));
    await store.enqueue({
      kind: "send",
      ruleId,
      dedupeKey: `s:${ruleId}:whatsapp:g1@g.us:m77`,
      payload: { platform: "whatsapp", chatId: "g1@g.us", messageId: "m77", ref: { id: "m77" } },
    });
    await store.claimDue(10); // the old process had picked it up, then died
    await store.resetRunning(); // what a new process does first (BridgeService.start)
    await svc.processDue();
    expect(tg.sent).toHaveLength(1);
    expect(tg.sent[0]?.out.text).toContain("survived a restart");
    expect((await store.queueStats()).pending).toBe(0);
  });

  it("keeps a job that could not be delivered and retries it later; the same event never doubles", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    tg.failures.push(new Error("down"), new Error("down"), new Error("down"), new Error("down"));
    await svc.handle(msg());
    expect(tg.sent).toHaveLength(0);
    expect(await store.queueStats()).toMatchObject({ pending: 1, failed: 0 });
    // a duplicate event for the same message does not create a second job
    await svc.handle(msg());
    expect((await store.queueStats()).pending).toBe(1);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10_000 });
    try {
      await svc.processDue();
    } finally {
      vi.useRealTimers();
    }
    expect(tg.sent).toHaveLength(1);
    expect((await store.queueStats()).pending).toBe(0);
  });
});

describe("edits and deletions", () => {
  it("mirrors an edit onto the copy, but never an edit of the copy itself", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    await svc.handle(msg());
    await svc.handleEdit(msg({ text: "hello (edited)" }), "t1");
    expect(tg.edited).toEqual([
      { messageId: "telegram-out-1", text: "Sara (+249111):\nhello (edited)" },
    ]);
    await svc.handleEdit(msg({ text: "again" }), "t1"); // same event twice
    expect(tg.edited).toHaveLength(1);
    // Telegram reports our own edit of the copy: must not bounce back
    await svc.handleEdit(
      msg({ platform: "telegram", chatId: "-100", messageId: "telegram-out-1", text: "x" }),
      "t2",
    );
    expect(tg.edited).toHaveLength(1);
  });

  it("does not mirror edits when the rule says no", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule({ forwardEdits: false }));
    await svc.handle(msg());
    await svc.handleEdit(msg({ text: "changed" }), "t1");
    expect(tg.edited).toHaveLength(0);
  });

  it("mirrors a deletion, even when the platform does not say which chat it came from", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    await svc.handle(msg());
    await svc.handle(msg({ messageId: "m2" }));
    await svc.handleDelete("whatsapp", "g1@g.us", "m1");
    expect(tg.removed).toEqual(["telegram-out-1"]);
    await svc.handleDelete("whatsapp", undefined, "m2");
    expect(tg.removed).toEqual(["telegram-out-1", "telegram-out-2"]);
    await svc.handleDelete("whatsapp", undefined, "unrelated"); // nothing known: ignored
    expect(tg.removed).toHaveLength(2);
  });

  it("does not delete when the rule says no", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule({ forwardDeletes: false }));
    await svc.handle(msg());
    await svc.handleDelete("whatsapp", "g1@g.us", "m1");
    expect(tg.removed).toHaveLength(0);
  });
});

describe("albums", () => {
  const pic = (id: string, text = "") =>
    msg({
      messageId: id,
      type: "image",
      text,
      albumId: "alb1",
      downloadMedia: async () => `/tmp/${id}.jpg`,
    });

  it("sends members together as one album with the name and captions on the first item", async () => {
    const { store, tg, svc } = await setup();
    tg.withAlbums = true;
    await store.addRule(rule());
    await svc.handle(pic("p1", "first"));
    await svc.handle(pic("p2", "second"));
    expect(tg.sent).toHaveLength(0); // still waiting for the rest of the album
    await svc.flushAlbums();
    expect(tg.sent).toHaveLength(0);
    expect(tg.albums).toHaveLength(1);
    expect(tg.albums[0]?.items.map((i) => i.filePath)).toEqual(["/tmp/p1.jpg", "/tmp/p2.jpg"]);
    expect(tg.albums[0]?.items[0]?.text).toBe("Sara (+249111):\nfirst\nsecond");
    expect(tg.albums[0]?.items[1]?.text).toBe("");
    // every member is linked, so edits/deletes/replies find their copy
    expect(await store.copyOf("whatsapp", "g1@g.us", "p2", "-100")).toBeDefined();
  });

  it("sends one by one when the destination has no album support, name on the first only", async () => {
    const { store, tg, svc } = await setup();
    await store.addRule(rule());
    await svc.handle(pic("p1", "a"));
    await svc.handle(pic("p2", "b"));
    await svc.flushAlbums();
    expect(tg.sent).toHaveLength(2);
    expect(tg.sent[0]?.out.text).toContain("Sara");
    expect(tg.sent[1]?.out.text).toBe("b");
  });

  it("a lone picture with an album id is just a normal message", async () => {
    const { store, tg, svc } = await setup();
    tg.withAlbums = true;
    await store.addRule(rule());
    await svc.handle(pic("solo", "x"));
    await svc.flushAlbums();
    expect(tg.albums).toHaveLength(0);
    expect(tg.sent).toHaveLength(1);
  });

  it("falls back to one by one when the album send fails", async () => {
    const { store, tg, svc } = await setup();
    tg.withAlbums = true;
    Object.defineProperty(tg, "sendAlbum", {
      get: () => async () => {
        throw new Error("album refused");
      },
    });
    await store.addRule(rule());
    await svc.handle(pic("p1"));
    await svc.handle(pic("p2"));
    await svc.flushAlbums();
    expect(tg.sent).toHaveLength(2);
    expect(svc.problems().some((p) => p.type === "album")).toBe(true);
  });
});

describe("per-rule log", () => {
  const lines = async (
    store: BridgeStore,
    id: number,
    filter?: "all" | "done" | "skip" | "problems",
  ) => store.logs(id, { filter, limit: 50, offset: 0 });

  it("records what happened to each message, separately for each rule", async () => {
    const { store, tg, svc } = await setup();
    const a = await store.addRule(rule({ types: ["text"] }));
    const b = await store.addRule(rule({ types: ["text", "image"], dstChatId: "-200" }));
    await svc.handle(msg());
    await svc.handle(msg({ messageId: "m2", type: "image" }));
    expect(tg.sent).toHaveLength(3);
    const logA = await lines(store, a);
    expect(logA.map((l) => `${l.event}:${l.level}`)).toEqual(
      expect.arrayContaining(["queued:ok", "sent:ok", "skipped:skip"]),
    );
    expect(logA.find((l) => l.event === "skipped")?.detail).toContain('type "image"');
    // rule B takes images, so it has no skip line
    expect((await lines(store, b, "skip")).length).toBe(0);
    expect((await lines(store, b, "done")).length).toBe(2);
    expect(await store.logSummary(a)).toEqual({ done: 1, skipped: 1, problems: 0 });
  });

  it("logs failures with the reason, and the final give-up as an error", async () => {
    const { store, tg, svc } = await setup();
    const id = await store.addRule(rule());
    tg.failures.push(new Error("down"), new Error("down"), new Error("down"), new Error("down"));
    await svc.handle(msg());
    const problems = await lines(store, id, "problems");
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]?.detail).toContain("down");
    expect(problems[0]?.level).toBe("warn");
  });

  it("can be stopped per rule and cleared", async () => {
    const { store, svc } = await setup();
    const id = await store.addRule(rule({ logEnabled: false }));
    await svc.handle(msg());
    expect(await store.logCount(id)).toBe(0);
    await store.setLogEnabled(id, true);
    await svc.handle(msg({ messageId: "m2" }));
    expect(await store.logCount(id)).toBeGreaterThan(0);
    await store.clearLogs(id);
    expect(await store.logCount(id)).toBe(0);
  });

  it("keeps only the newest lines and removes them with the rule", async () => {
    const { store } = await setup();
    const id = await store.addRule(rule());
    for (let i = 0; i < 30; i++)
      await store.addLog({ ruleId: id, level: "ok", event: "sent", detail: `n${i}` });
    await store.trimLogs(id, 10);
    const left = await store.logs(id, { limit: 50, offset: 0 });
    expect(left).toHaveLength(10);
    expect(left[0]?.detail).toBe("n29");
    await store.deleteRule(id);
    expect(await store.logCount(id)).toBe(0);
  });

  it("is shown on the rule page with filters, and the stop/clear buttons work", async () => {
    const { store, svc } = await setup();
    const id = await store.addRule(rule({ types: ["text"] }));
    await svc.handle(msg());
    await svc.handle(msg({ messageId: "m2", type: "image" }));
    const ui = createBridgeUi({
      store,
      status: () => ({ whatsapp: true, telegram: true }),
      refresh: async () => [],
    });
    const get = (sub: string, q = "") =>
      ui({ method: "GET" } as never, sub, new URL(`http://x/?${q}`));
    const all = await get(`/rules/${id}`);
    expect(all.body).toContain("is not selected in this rule");
    expect(all.body).toContain("recording");
    const skipped = await get(`/rules/${id}`, "f=skip");
    expect(skipped.body).toContain("is not selected");
    const done = await get(`/rules/${id}`, "f=done");
    expect(done.body).not.toContain("is not selected");
    expect((await get("/")).body).toContain("1 done");
    expect((await get(`/rules/${id}/confirm`, "do=log-clear")).body).toContain("Clear");
    expect((await get("/rules/999")).code).toBe(404);

    const post = (sub: string, body = "") => {
      const req = Object.assign(new Readable({ read() {} }), { method: "POST" });
      req.push(body);
      req.push(null);
      return ui(req as never, sub, new URL("http://x/"));
    };
    await post(`/rules/${id}/log-toggle`);
    expect((await store.rule(id))?.logEnabled).toBe(false);
    expect((await get(`/rules/${id}`)).body).toContain("Logging is stopped");
    await post(`/rules/${id}/log-clear`);
    expect(await store.logCount(id)).toBe(0);
    const t = await post(`/rules/${id}/toggle`, "next=list");
    expect(t.redirect).toBe("/admin/panel/bridge");
    expect((await store.rule(id))?.enabled).toBe(false);
    await post(`/rules/${id}/delete`);
    expect(await store.rules()).toEqual([]);
  });
});
