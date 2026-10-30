import type { WAMessage } from "@whiskeysockets/baileys";
import { BufferJSON, initAuthCreds } from "@whiskeysockets/baileys";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import { useDbAuthState } from "../src/providers/whatsapp/baileys/authState.js";
import { extractIncoming } from "../src/providers/whatsapp/baileys/extract.js";
import { BaileysProvider, type SocketLike } from "../src/providers/whatsapp/baileys/provider.js";
import { createTestDb } from "./helpers/pg.js";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
}, 120_000);

const wa = (over: Record<string, unknown>): WAMessage =>
  ({ messageTimestamp: 1_700_000_000, ...over }) as unknown as WAMessage;

describe("extractIncoming", () => {
  it("maps a private text message", () => {
    const m = extractIncoming(
      wa({
        key: { remoteJid: "249@s.whatsapp.net", id: "A1", fromMe: false },
        message: { conversation: " مرحبا " },
      }),
    );
    expect(m).toMatchObject({
      provider: "baileys",
      conversationId: "249@s.whatsapp.net",
      participantId: "249@s.whatsapp.net",
      isGroup: false,
      text: "مرحبا",
    });
  });
  it("uses the real sender in groups, preferring the phone JID over a LID", () => {
    const m = extractIncoming(
      wa({
        key: {
          remoteJid: "g1@g.us",
          id: "A2",
          fromMe: false,
          participant: "999@lid",
          participantAlt: "249@s.whatsapp.net",
        },
        message: {
          extendedTextMessage: {
            text: "@bot بحث",
            contextInfo: { mentionedJid: ["bot@s.whatsapp.net"] },
          },
        },
      }),
    );
    expect(m).toMatchObject({
      conversationId: "g1@g.us",
      participantId: "249@s.whatsapp.net",
      isGroup: true,
      mentionedIds: ["bot@s.whatsapp.net"],
    });
  });
  it("keeps the LID when no phone is known, and leaves participant empty rather than using the group", () => {
    const lid = extractIncoming(
      wa({
        key: { remoteJid: "g1@g.us", id: "A3", participant: "999@lid" },
        message: { conversation: "x" },
      }),
    );
    expect(lid?.participantId).toBe("999@lid");
    const none = extractIncoming(
      wa({ key: { remoteJid: "g1@g.us", id: "A4" }, message: { conversation: "x" } }),
    );
    expect(none?.participantId).toBe("");
  });
  it("ignores own messages, status, newsletters and non-text", () => {
    const key = (o: object) => ({ remoteJid: "249@s.whatsapp.net", id: "Z", ...o });
    expect(
      extractIncoming(wa({ key: key({ fromMe: true }), message: { conversation: "x" } })),
    ).toBeNull();
    expect(
      extractIncoming(
        wa({ key: key({ remoteJid: "status@broadcast" }), message: { conversation: "x" } }),
      ),
    ).toBeNull();
    expect(
      extractIncoming(
        wa({ key: key({ remoteJid: "1@newsletter" }), message: { conversation: "x" } }),
      ),
    ).toBeNull();
    expect(extractIncoming(wa({ key: key({}), message: { imageMessage: {} } }))).toBeNull();
  });
});

describe("useDbAuthState", () => {
  it("persists creds and keys across loads, round-tripping Buffers, and clears", async () => {
    const a = await useDbAuthState(db, "t1");
    (a.state.creds as { registrationId: number }).registrationId = 4242;
    await a.saveCreds();
    await a.state.keys.set({
      "pre-key": { "7": { private: Buffer.from([1, 2, 3]), public: Buffer.from([4, 5]) } },
    });

    const b = await useDbAuthState(db, "t1");
    expect(b.state.creds.registrationId).toBe(4242);
    const got = await b.state.keys.get("pre-key", ["7", "8"]);
    expect(Buffer.from(got["7"]?.private as Uint8Array)).toEqual(Buffer.from([1, 2, 3]));
    expect(got["8"]).toBeUndefined();

    await b.state.keys.set({ "pre-key": { "7": null } });
    expect((await b.state.keys.get("pre-key", ["7"]))["7"]).toBeUndefined();

    const other = await useDbAuthState(db, "t2"); // namespaces are isolated
    expect(other.state.creds.registrationId).not.toBe(4242);
    await a.clear();
    const fresh = await useDbAuthState(db, "t1");
    expect(fresh.state.creds.registrationId).not.toBe(4242);
    expect(JSON.stringify(initAuthCreds(), BufferJSON.replacer)).toContain("noiseKey");
  });
});

class FakeSocket implements SocketLike {
  handlers = new Map<string, (arg: never) => void>();
  sent: { jid: string; content: unknown; opts?: unknown }[] = [];
  ended = false;
  failNext = false;
  withBody = false;
  ev = { on: (e: string, l: (arg: never) => void) => void this.handlers.set(e, l) };
  async sendMessage(jid: string, content: unknown, opts?: unknown) {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("boom");
    }
    this.sent.push({ jid, content, opts });
    return {
      key: { id: `out${this.sent.length}` },
      ...(this.withBody && {
        message: { documentMessage: { mediaKey: "mk", fileName: "a.pdf", caption: "x" } },
      }),
    } as WAMessage;
  }
  async requestPairingCode(p: string) {
    return `code-${p}`;
  }
  end() {
    this.ended = true;
  }
  emit(e: string, arg: unknown) {
    this.handlers.get(e)?.(arg as never);
  }
}

describe("BaileysProvider", () => {
  const setup = async (ns: string) => {
    const sockets: FakeSocket[] = [];
    const got: string[] = [];
    const sleeps: number[] = [];
    const p = new BaileysProvider({
      db,
      namespace: ns,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      baileysLogger: {},
      onMessage: async (id) => void got.push(id),
      minSendGapMs: async () => 500,
      sleep: async (ms) => void sleeps.push(ms),
      backoffMs: () => 0,
      socketFactory: async () => {
        const s = new FakeSocket();
        sockets.push(s);
        return s;
      },
    });
    await p.start();
    return { p, sockets, got, sleeps };
  };
  const tick = () => new Promise((r) => setTimeout(r, 30));

  it("shows a QR, connects, delivers notify messages and quotes the asker", async () => {
    const { p, sockets, got } = await setup("p1");
    const s = sockets[0] as FakeSocket;
    expect(await p.sendText({ conversationId: "c", text: "x" })).toMatchObject({
      confirmed: false,
    });
    s.emit("connection.update", { qr: "QRDATA" });
    expect(p.status()).toMatchObject({ state: "qr", qr: "QRDATA" });
    s.emit("connection.update", { connection: "open" });
    expect(p.status().state).toBe("open");

    const message = {
      key: { remoteJid: "249@s.whatsapp.net", id: "M1" },
      message: { conversation: "hi" },
    };
    s.emit("messages.upsert", { type: "append", messages: [message] });
    s.emit("messages.upsert", { type: "notify", messages: [message] });
    await tick();
    expect(got).toEqual(["M1"]);

    const r = await p.sendText({
      conversationId: "249@s.whatsapp.net",
      text: "ok",
      quoteMessageId: "M1",
    });
    expect(r).toEqual({ confirmed: true, providerMessageId: "out1" });
    expect((s.sent[0]?.opts as { quoted: WAMessage }).quoted.key.id).toBe("M1");
    await p.stop();
  });

  it("spaces sends by the minimum gap and reports failures instead of throwing", async () => {
    const { p, sockets, sleeps } = await setup("p2");
    const s = sockets[0] as FakeSocket;
    s.emit("connection.update", { connection: "open" });
    await p.sendText({ conversationId: "c", text: "1" });
    await p.sendText({ conversationId: "c", text: "2" });
    expect(sleeps.some((x) => x > 0 && x <= 500)).toBe(true);
    s.failNext = true;
    expect(await p.sendText({ conversationId: "c", text: "3" })).toMatchObject({
      confirmed: false,
      error: "boom",
    });
    const d = await p.sendDocument({
      conversationId: "c",
      filePath: "/tmp/a.pdf",
      fileName: "a.pdf",
      mimeType: "application/pdf",
    });
    expect(d.confirmed).toBe(true);
    expect(s.sent.at(-1)?.content).toMatchObject({
      document: { url: "/tmp/a.pdf" },
      fileName: "a.pdf",
    });
    await p.stop();
  });

  it("re-forwards a cached upload with the new caption and falls back when it is gone", async () => {
    const { p, sockets } = await setup("p4");
    const s = sockets[0] as FakeSocket;
    s.emit("connection.update", { connection: "open" });
    s.withBody = true;
    const doc = {
      conversationId: "c",
      filePath: "/tmp/a.pdf",
      fileName: "a.pdf",
      mimeType: "application/pdf",
      caption: "first",
      cache: { key: "k", ttlMs: 60_000 },
    };
    expect(await p.sendCached({ conversationId: "d", cache: doc.cache })).toBeNull();
    await p.sendDocument(doc);
    expect(p.cacheSize()).toBe(1);
    const r = await p.sendCached({
      conversationId: "d",
      cache: doc.cache,
      caption: "second",
      quoteMessageId: undefined,
    });
    expect(r?.confirmed).toBe(true);
    const fwd = s.sent.at(-1)?.content as {
      forward: { message: { documentMessage: Record<string, unknown> } };
    };
    expect(fwd.forward.message.documentMessage.caption).toBe("second");
    expect(fwd.forward.message.documentMessage.mediaKey).toBe("mk");
    // expired entries are dropped
    expect(await p.sendCached({ conversationId: "d", cache: { key: "k", ttlMs: -1 } })).toBeNull();
    expect(p.cacheSize()).toBe(0);
    await p.stop();
  });

  it("reconnects after a drop and starts over after logout, wiping credentials", async () => {
    const { p, sockets } = await setup("p3");
    (sockets[0] as FakeSocket).emit("connection.update", { connection: "open" });
    (sockets[0] as FakeSocket).emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 408 } } },
    });
    await tick();
    expect(sockets.length).toBe(2);
    const first = await useDbAuthState(db, "p3");
    (first.state.creds as { registrationId: number }).registrationId = 777;
    await first.saveCreds();
    (sockets[1] as FakeSocket).emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });
    await new Promise((r) => setTimeout(r, 1200));
    expect(sockets.length).toBe(3);
    expect((await useDbAuthState(db, "p3")).state.creds.registrationId).not.toBe(777);
    await p.stop();
  });

  it("does not reconnect when another client replaced the session", async () => {
    const { p, sockets } = await setup("p4");
    (sockets[0] as FakeSocket).emit("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 440 } } },
    });
    await tick();
    expect(sockets.length).toBe(1);
    expect(p.status().state).toBe("replaced");
    await p.stop();
  });
});
