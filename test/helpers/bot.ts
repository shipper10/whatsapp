import { createHandler } from "../../src/bot/handler.js";
import { ReplyTracker } from "../../src/bot/replyTracker.js";
import { DbSessionStore } from "../../src/core/session/store.js";
import type { Db } from "../../src/db/client.js";
import { LinksOnlyDeliverer } from "../../src/delivery/linksOnly.js";
import { classifyAndApply } from "../../src/library/apply.js";
import { DbLibrary } from "../../src/library/dbLibrary.js";
import type {
  IncomingMessage,
  OutgoingDocument,
  OutgoingText,
  SendResult,
  WhatsAppProvider,
} from "../../src/providers/whatsapp/types.js";
import { SettingsService, type SettingsStore } from "../../src/settings/service.js";
import { createTestDb, seedChannel } from "./pg.js";

export class MemSettings implements SettingsStore {
  data: Record<string, unknown> = {};
  async loadAll() {
    return { ...this.data };
  }
  async save(k: string, v: unknown) {
    this.data[k] = v;
  }
  async remove(k: string) {
    delete this.data[k];
  }
}

export class FakeProvider implements WhatsAppProvider {
  readonly name = "fake";
  sent: OutgoingText[] = [];
  docs: OutgoingDocument[] = [];
  private counter = 0;
  async sendText(m: OutgoingText): Promise<SendResult> {
    this.sent.push(m);
    return { confirmed: true, providerMessageId: `out${++this.counter}` };
  }
  /** Id of the most recent message the bot sent (what a user would reply to). */
  lastId() {
    return `out${this.counter}`;
  }
  async sendDocument(m: OutgoingDocument): Promise<SendResult> {
    this.docs.push(m);
    if (m.cache) this.cached.set(m.cache.key, true);
    return { confirmed: true };
  }
  /** Keys remembered for re-sending, and the re-sends that happened. */
  cached = new Map<string, boolean>();
  resent: { key: string; caption?: string }[] = [];
  async sendCached(m: { cache: { key: string }; caption?: string }): Promise<SendResult | null> {
    if (!this.cached.has(m.cache.key)) return null;
    this.resent.push({ key: m.cache.key, caption: m.caption });
    return { confirmed: true };
  }
  last() {
    return this.sent[this.sent.length - 1]?.text ?? "";
  }
  clear() {
    this.sent = [];
  }
}

let ready: Promise<Db> | undefined;
/** One shared real-Postgres library (full channel classified) for all bot tests. */
export function libraryDb(): Promise<Db> {
  ready ??= (async () => {
    const db = await createTestDb();
    await seedChannel(db);
    await classifyAndApply(db, "BahriMed");
    return db;
  })();
  return ready;
}

export async function makeBot(opts: { env?: NodeJS.ProcessEnv; now?: () => number } = {}) {
  const db = await libraryDb();
  const provider = new FakeProvider();
  const store = new MemSettings();
  const settings = new SettingsService(store, opts.env ?? {}, 0);
  const library = new DbLibrary(db);
  const nowMs = opts.now ?? Date.now;
  const sessions = new DbSessionStore(db, () => new Date(nowMs()));
  const logs: string[] = [];
  const logger = {
    info: () => {},
    warn: (_: object, m?: string) => void logs.push(m ?? ""),
    error: (o: object, m?: string) => void logs.push(`${m ?? ""} ${JSON.stringify(o)}`),
  };
  const replies = new ReplyTracker();
  const tracked = replies.wrap(provider);
  const make = () =>
    createHandler({
      replies,
      provider: tracked,
      settings,
      sessions,
      library,
      deliverer: new LinksOnlyDeliverer(library, tracked, settings),
      logger,
      now: nowMs,
    });
  return { db, provider, settings, store, sessions, logs, handler: make(), makeHandler: make };
}

let n = 0;
export const msg = (
  over: Partial<IncomingMessage> & { text: string },
): { id: string; m: IncomingMessage } => {
  const id = `ev${++n}`;
  return {
    id,
    m: {
      provider: "openwa",
      conversationId: "249900000001@c.us",
      participantId: "249900000001@c.us",
      isGroup: false,
      messageId: `m${n}`,
      timestamp: Math.floor(Date.now() / 1000),
      fromMe: false,
      mentionedIds: [],
      ...over,
    },
  };
};
