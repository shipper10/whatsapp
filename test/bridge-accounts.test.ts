import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  type AccountFactories,
  type AccountHooks,
  AccountManager,
  type TgLoginClient,
  type WaRuntime,
} from "../src/bridge/accounts.js";
import { decryptSecret, encryptSecret } from "../src/bridge/secrets.js";
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
import { createBridgeUi } from "../src/http/bridgePanel.js";
import { createTestDb } from "./helpers/pg.js";

class Ep implements BridgeEndpoint {
  sent: { dest: Destination; out: OutgoingBridge }[] = [];
  constructor(
    readonly platform: Platform,
    readonly name: string,
    public up = true,
  ) {}
  ready() {
    return this.up;
  }
  async send(dest: Destination, out: OutgoingBridge) {
    this.sent.push({ dest, out });
    return `${this.name}-${this.sent.length}`;
  }
  async listChats() {
    return [
      {
        platform: this.platform,
        chatId: `chat-of-${this.name}`,
        title: `Chat ${this.name}`,
        kind: "group",
      },
    ];
  }
}

const rule = (o: Partial<BridgeRule> = {}): BridgeRule => ({
  id: 0,
  name: "r",
  enabled: true,
  srcPlatform: "whatsapp",
  srcAccountId: 0,
  srcChatId: "g@g.us",
  srcTopicId: "",
  dstPlatform: "telegram",
  dstAccountId: 0,
  dstChatId: "-100",
  dstTopicId: "",
  types: ["text"],
  senderMode: "none",
  customName: "",
  showPhone: false,
  forwardOwn: true,
  forwardEdits: true,
  forwardDeletes: true,
  logEnabled: true,
  forwardReactions: true,
  ...o,
});

const msg = (o: Partial<BridgeMessage> = {}): BridgeMessage => ({
  platform: "whatsapp",
  chatId: "g@g.us",
  chatTitle: "G",
  messageId: "m1",
  senderId: "s",
  senderName: "Sara",
  type: "text",
  text: "hello",
  timestamp: 1,
  fromMe: false,
  ...o,
});

const logger = { info() {}, warn() {}, error() {} };

async function world() {
  const db = await createTestDb();
  const store = new BridgeStore(db);
  const endpoints: Record<string, BridgeEndpoint | undefined> = {};
  const svc = new BridgeService({
    store,
    endpoints,
    tempDir: "./tmp",
    logger,
    echoDelayMs: 0,
    sleep: async () => undefined,
    inline: true,
  });
  return { db, store, endpoints, svc };
}

describe("rules with accounts", () => {
  it("only the account a rule names feeds it, and it sends through the account it names", async () => {
    const { store, endpoints, svc } = await world();
    const mainTg = new Ep("telegram", "main");
    const tg2 = new Ep("telegram", "tg2");
    endpoints.telegram = mainTg;
    endpoints["telegram:2"] = tg2;
    await store.addRule(rule({ dstAccountId: 2 }));
    await svc.handle(msg({ accountId: 1 })); // another WhatsApp account saw it: no rule
    expect(tg2.sent).toHaveLength(0);
    await svc.handle(msg({ messageId: "m2" })); // main account
    expect(tg2.sent).toHaveLength(1);
    expect(mainTg.sent).toHaveLength(0);
  });

  it("the same message seen by two accounts is handled once per account", async () => {
    const { store, endpoints, svc } = await world();
    const tg = new Ep("telegram", "main");
    endpoints.telegram = tg;
    await store.addRule(rule({ srcAccountId: 1 }));
    await store.addRule(rule({ srcAccountId: 2, dstChatId: "-200" }));
    await svc.handle(msg({ accountId: 1 }));
    await svc.handle(msg({ accountId: 2 }));
    expect(tg.sent.map((s) => s.dest.chatId).sort()).toEqual(["-100", "-200"]);
  });

  it("a missing account fails the job (retried later) instead of using another account", async () => {
    const { store, endpoints, svc } = await world();
    endpoints.telegram = new Ep("telegram", "main");
    await store.addRule(rule({ dstAccountId: 9 }));
    await svc.handle(msg());
    expect((endpoints.telegram as Ep).sent).toHaveLength(0);
    expect(await store.queueStats()).toMatchObject({ pending: 1 });
  });

  it("keeps the chats of each account apart", async () => {
    const { store } = await world();
    const c = { platform: "telegram" as const, chatId: "-100", title: "Same chat", kind: "group" };
    await store.upsertChats([
      { ...c, accountId: 0 },
      { ...c, accountId: 3, title: "Seen by 3" },
    ]);
    expect((await store.chats("telegram", 0))[0]?.title).toBe("Same chat");
    expect((await store.chats("telegram", 3))[0]?.title).toBe("Seen by 3");
    expect(await store.allChats()).toHaveLength(2);
  });

  it("refreshes the chat list of every connected account", async () => {
    const { store, endpoints, svc } = await world();
    endpoints.whatsapp = new Ep("whatsapp", "main");
    endpoints["whatsapp:4"] = new Ep("whatsapp", "w4");
    endpoints["telegram:5"] = new Ep("telegram", "t5", false); // not connected: skipped
    const res = await svc.refreshChats();
    expect(res.map((r) => `${r.platform}:${r.accountId}`).sort()).toEqual([
      "whatsapp:0",
      "whatsapp:4",
    ]);
    expect((await store.chats("whatsapp", 4))[0]?.chatId).toBe("chat-of-w4");
  });
});

describe("secrets", () => {
  it("round-trips and refuses a different key or damaged data", () => {
    const enc = encryptSecret("1BVtsOK-session", "a-long-secret-value-1");
    expect(enc).not.toContain("session");
    expect(decryptSecret(enc, "a-long-secret-value-1")).toBe("1BVtsOK-session");
    expect(decryptSecret(enc, "another-secret-value-22")).toBeNull();
    const parts = enc.split(".");
    parts[3] = `${parts[3]?.[0] === "A" ? "B" : "A"}${parts[3]?.slice(1)}`;
    expect(decryptSecret(parts.join("."), "a-long-secret-value-1")).toBeNull();
    expect(decryptSecret("garbage", "a-long-secret-value-1")).toBeNull();
  });
});

// ---- the account manager, with fake connections

class FakeWa {
  state = "qr";
  me: string | undefined;
  stopped = false;
  cleared = false;
  hooks!: AccountHooks;
  ep: Ep;
  constructor(readonly id: number) {
    this.ep = new Ep("whatsapp", `wa${id}`);
  }
  runtime(): WaRuntime {
    return {
      endpoint: this.ep,
      start: async () => undefined,
      stop: async () => {
        this.stopped = true;
      },
      status: () => ({ state: this.state as never, qr: "QR-PAYLOAD", me: this.me }),
      pairingCode: async (p) => `CODE-${p}`,
      clearAuth: async () => {
        this.cleared = true;
      },
    };
  }
}

function factories() {
  const was = new Map<number, FakeWa>();
  const tgStarts: string[] = [];
  const login = {
    answers: [] as string[],
    needPassword: false,
    fail: undefined as string | undefined,
  };
  const f: AccountFactories = {
    whatsapp(id, hooks) {
      const w = was.get(id) ?? new FakeWa(id);
      w.hooks = hooks;
      was.set(id, w);
      return w.runtime();
    },
    telegram(session) {
      tgStarts.push(session);
      const ep = new Ep("telegram", `tg-${tgStarts.length}`);
      return { endpoint: ep, start: async () => undefined, stop: async () => undefined };
    },
    telegramLogin(): TgLoginClient {
      return {
        start: async (p) => {
          const phone = await p.phoneNumber();
          if (login.fail) throw new Error(login.fail);
          login.answers.push(phone, await p.phoneCode(true));
          if (login.needPassword) login.answers.push(await p.password());
        },
        session: () => "SESSION-STRING-123456789",
        who: async () => "@study",
        disconnect: async () => undefined,
      };
    },
  };
  return { f, was, tgStarts, login };
}

async function manager(over: Partial<ConstructorParameters<typeof AccountManager>[0]> = {}) {
  const w = await world();
  const fx = factories();
  const mgr = new AccountManager({
    db: w.db,
    bridgeStore: w.store,
    svc: w.svc,
    endpoints: w.endpoints,
    logger,
    factories: fx.f,
    secret: "a-long-secret-value-1",
    telegramAvailable: true,
    ...over,
  });
  return { ...w, ...fx, mgr };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("AccountManager", () => {
  it("adds a WhatsApp account, shows its QR, registers it once it is connected, and tags its messages", async () => {
    const { mgr, endpoints, was, store } = await manager();
    const id = await mgr.create("whatsapp", "Biology");
    expect(endpoints[`whatsapp:${id}`]).toBeDefined();
    expect((await mgr.view(id))?.state).toBe("waiting_qr");
    expect((await mgr.view(id))?.qr).toBe("QR-PAYLOAD");
    const w = was.get(id) as FakeWa;
    w.state = "open";
    w.me = "249123456:7@s.whatsapp.net";
    const v = await mgr.view(id);
    expect(v?.state).toBe("connected");
    expect(v?.row.identity).toBe("+249123456");
    // a message from that account carries its id into the service
    const tg = new Ep("telegram", "main");
    endpoints.telegram = tg;
    await store.addRule(rule({ srcAccountId: id }));
    await w.hooks.onMessage(msg());
    expect(tg.sent).toHaveLength(1);
  });

  it("refuses a number that is already linked (main or another account) so neither gets kicked off", async () => {
    const { mgr, was, endpoints } = await manager({ mainWhatsAppPhone: () => "249111" });
    const id = await mgr.create("whatsapp", "Dup");
    const w = was.get(id) as FakeWa;
    w.state = "open";
    w.me = "249111:3@s.whatsapp.net";
    const v = await mgr.view(id);
    expect(v?.state).toBe("error");
    expect(v?.error).toContain("already linked");
    expect(w.stopped).toBe(true);
    expect(endpoints[`whatsapp:${id}`]).toBeUndefined();
  });

  it("logs in to Telegram step by step from the page and stores the session encrypted", async () => {
    const { mgr, db, endpoints, tgStarts, login } = await manager();
    const id = await mgr.create("telegram", "Study");
    expect((await mgr.view(id))?.tgStep).toBe("phone");
    await mgr.telegramBegin(id, "+249111222333");
    await tick();
    expect((await mgr.view(id))?.tgStep).toBe("code");
    expect(mgr.telegramAnswer(id, "12345")).toBe(true);
    await tick();
    expect(login.answers).toEqual(["+249111222333", "12345"]);
    const v = await mgr.view(id);
    expect(v?.state).toBe("connected");
    expect(v?.row.identity).toBe("@study");
    expect(endpoints[`telegram:${id}`]).toBeDefined();
    expect(tgStarts).toEqual(["SESSION-STRING-123456789"]);
    const { sql } = await import("drizzle-orm");
    const raw = JSON.stringify(await db.execute(sql`select session from bridge_accounts`));
    expect(raw).not.toContain("SESSION-STRING");
  });

  it("asks for the 2FA password when Telegram wants it, and reports a failed login", async () => {
    const a = await manager();
    a.login.needPassword = true;
    const id = await a.mgr.create("telegram", "2fa");
    await a.mgr.telegramBegin(id, "+249111222333");
    await tick();
    a.mgr.telegramAnswer(id, "1");
    await tick();
    expect((await a.mgr.view(id))?.tgStep).toBe("password");
    a.mgr.telegramAnswer(id, "secret");
    await tick();
    expect((await a.mgr.view(id))?.state).toBe("connected");

    const b = await manager();
    b.login.fail = "PHONE_NUMBER_INVALID";
    const id2 = await b.mgr.create("telegram", "bad");
    await b.mgr.telegramBegin(id2, "+249111222333");
    await tick();
    const v = await b.mgr.view(id2);
    expect(v?.tgStep).toBe("failed");
    expect(v?.error).toContain("PHONE_NUMBER_INVALID");
  });

  it("restarts saved accounts on boot, and marks one whose session cannot be decrypted", async () => {
    const a = await manager();
    const id = await a.mgr.create("telegram", "Saved");
    await a.mgr.telegramImport(id, "IMPORTED-SESSION-STRING-123");
    await a.mgr.stopAll();
    expect(a.endpoints[`telegram:${id}`]).toBeUndefined();
    await a.mgr.startAll();
    expect(a.endpoints[`telegram:${id}`]).toBeDefined();
    expect(a.tgStarts.at(-1)).toBe("IMPORTED-SESSION-STRING-123");
    // same database, but the key changed
    const other = new AccountManager({
      db: a.db,
      bridgeStore: a.store,
      svc: a.svc,
      endpoints: {},
      logger,
      factories: a.f,
      secret: "a-different-secret-value",
      telegramAvailable: true,
    });
    await other.startAll();
    const v = await other.view(id);
    expect(v?.state).toBe("error");
    expect(v?.error).toContain("cannot be decrypted");
  });

  it("pausing disconnects; removing forgets the login, its chats, and pauses (not deletes) its rules", async () => {
    const { mgr, endpoints, was, store } = await manager();
    const id = await mgr.create("whatsapp", "Temp");
    await store.upsertChats([
      { platform: "whatsapp", accountId: id, chatId: "x@g.us", title: "X", kind: "group" },
    ]);
    const ruleId = await store.addRule(rule({ srcAccountId: id }));
    await mgr.setEnabled(id, false);
    expect(endpoints[`whatsapp:${id}`]).toBeUndefined();
    expect((await mgr.view(id))?.state).toBe("paused");
    await mgr.setEnabled(id, true);
    expect(endpoints[`whatsapp:${id}`]).toBeDefined();
    const paused = await mgr.remove(id);
    expect(paused).toBe(1);
    expect(endpoints[`whatsapp:${id}`]).toBeUndefined();
    expect((was.get(id) as FakeWa).cleared).toBe(true);
    expect((await store.rule(ruleId))?.enabled).toBe(false);
    expect(await store.chats("whatsapp", id)).toEqual([]);
    expect(await mgr.view(id)).toBeUndefined();
  });
});

describe("Accounts pages", () => {
  const post = (ui: ReturnType<typeof createBridgeUi>, sub: string, body = "") => {
    const req = Object.assign(new Readable({ read() {} }), { method: "POST" });
    req.push(body);
    req.push(null);
    return ui(req as never, sub, new URL("http://x/"));
  };
  const get = (ui: ReturnType<typeof createBridgeUi>, sub: string) =>
    ui({ method: "GET" } as never, sub, new URL("http://x/"));

  it("adds accounts, shows the QR and the Telegram steps, and lets rules pick a chat of an account", async () => {
    const { mgr, store, endpoints, svc } = await manager();
    const ui = createBridgeUi({
      store,
      status: () => ({ whatsapp: true, telegram: false, telegramConfigured: false }),
      refresh: () => svc.refreshChats(),
      accounts: mgr,
    });
    const list = await get(ui, "/accounts");
    expect(list.body).toContain("Main accounts");
    expect(list.body).toContain("not configured"); // no main Telegram session

    const added = await post(ui, "/accounts/add-whatsapp", "label=Biology");
    const waId = Number(/accounts\/(\d+)$/.exec(added.redirect ?? "")?.[1]);
    const page = await get(ui, `/accounts/${waId}`);
    expect(page.body).toContain("<svg"); // the QR
    expect(page.body).toContain('http-equiv="refresh"');
    const pair = await post(ui, `/accounts/${waId}/pair`, "phone=249111");
    expect(pair.body).toContain("CODE-249111");

    const t = await post(ui, "/accounts/add-telegram", "label=Study");
    const tgId = Number(/accounts\/(\d+)$/.exec(t.redirect ?? "")?.[1]);
    expect((await get(ui, `/accounts/${tgId}`)).body).toContain("Send login code");
    await post(ui, `/accounts/${tgId}/tg-phone`, "phone=%2B249111222333");
    await tick();
    expect((await get(ui, `/accounts/${tgId}`)).body).toContain("Confirm code");
    const bad = await post(ui, `/accounts/${tgId}/tg-phone`, "phone=12");
    expect(bad.code).toBe(400);
    await post(ui, `/accounts/${tgId}/tg-code`, "value=12345");
    await tick();
    expect((await get(ui, `/accounts/${tgId}`)).body).toContain("Logged in");

    // chats of the new accounts appear as their own tables and can be chosen in a rule
    await svc.refreshChats();
    endpoints[`whatsapp:${waId}`] = Object.assign(new Ep("whatsapp", "w"), {});
    const chats = await get(ui, "/chats");
    expect(chats.body).toContain("Biology");
    expect(chats.body).toContain("Study");
    const dst = `telegram%7Cchat-of-tg-1%7C%7C${tgId}`;
    const src = `whatsapp%7Cg%40g.us%7C`;
    const made = await post(ui, "/rules", `src=${src}&dst=${dst}&types=text&senderMode=none`);
    expect(made.redirect).toMatch(/rules\/\d+$/);
    const [r] = await store.rules();
    expect(r?.dstAccountId).toBe(tgId);
    expect(r?.srcAccountId).toBe(0);
    const rules = await get(ui, "/");
    expect(rules.body).toContain("Telegram (Study)");

    const confirm = await get(ui, `/accounts/${tgId}/confirm`);
    expect(confirm.body).toContain("1 rule");
    await post(ui, `/accounts/${tgId}/remove`);
    expect((await store.rules())[0]?.enabled).toBe(false);
    expect((await get(ui, `/accounts/${tgId}`)).code).toBe(404);
  });

  it("works without the manager (only main accounts)", async () => {
    const { store } = await manager();
    const ui = createBridgeUi({
      store,
      status: () => ({ whatsapp: true, telegram: true }),
      refresh: async () => [],
    });
    expect((await get(ui, "/accounts")).code).toBe(404);
    expect((await get(ui, "/chats")).code ?? 200).toBe(200);
  });
});
