import { rm } from "node:fs/promises";
import { join } from "node:path";
import { buildOutgoing, isMediaType, matchRules } from "./engine.js";
import type { BridgeStore } from "./store.js";
import type {
  BridgeEndpoint,
  BridgeMessage,
  BridgeRule,
  OutgoingBridge,
  Platform,
} from "./types.js";

interface Logger {
  info: (o: object, m?: string) => void;
  warn: (o: object, m?: string) => void;
  error: (o: object, m?: string) => void;
}

export interface BridgeDeps {
  store: BridgeStore;
  endpoints: Partial<Record<Platform, BridgeEndpoint>>;
  tempDir: string;
  logger: Logger;
  /** Own-account messages arrive as events slightly before we have recorded the send; wait before judging them. */
  echoDelayMs?: number;
  maxMediaBytes?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SEEN_MAX = 5000;

/** Telegram tells clients to back off with a FloodWait; everything else gets a short exponential retry. */
function retryDelayMs(err: unknown, attempt: number): number | null {
  const seconds = (err as { seconds?: number }).seconds;
  if (typeof seconds === "number") return (seconds + 1) * 1000;
  if (attempt >= 3) return null;
  return 1500 * 2 ** attempt;
}

export class BridgeService {
  private readonly seen = new Set<string>();
  /** Keeps the order of messages per destination chat. */
  private readonly lanes = new Map<string, Promise<unknown>>();
  /** Sends in progress per destination chat; an own-account event for that chat may be the echo of one. */
  private readonly inflight = new Map<string, number>();
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: BridgeDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /** Entry point for both platforms. Never throws for a single bad message. */
  async handle(msg: BridgeMessage): Promise<void> {
    const { store, logger } = this.deps;
    const first = `${msg.platform}:${msg.chatId}:${msg.messageId}`;
    if (this.seen.has(first)) return; // redelivered event
    this.seen.add(first);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);

    const rules = matchRules(msg, await store.rules());
    if (rules.length === 0) return;

    // Loop prevention: a message the bridge itself posted must never be forwarded again.
    if (msg.fromMe) {
      await this.sleep(this.deps.echoDelayMs ?? 2000);
      for (let i = 0; i < 240 && (this.inflight.get(`${msg.platform}:${msg.chatId}`) ?? 0) > 0; i++)
        await this.sleep(500); // a large upload can finish long after its echo arrived
    }
    if (await store.isBridged(msg.platform, msg.chatId, msg.messageId)) return;

    let mediaPath: string | undefined;
    const dir = join(
      this.deps.tempDir,
      `bridge-${msg.platform}-${msg.messageId}`.replace(/[^\w.-]/g, "_"),
    );
    try {
      const animatedSticker =
        msg.type === "sticker" &&
        ["application/x-tgsticker", "video/webm"].includes(msg.mimeType ?? "");
      if (isMediaType(msg.type) && msg.downloadMedia && !animatedSticker) {
        try {
          mediaPath = await msg.downloadMedia(dir);
        } catch (err) {
          logger.warn({ err: String(err), type: msg.type }, "bridge: media download failed");
        }
      }
      await Promise.all(rules.map((r) => this.forward(msg, r, mediaPath)));
    } finally {
      if (mediaPath) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private forward(msg: BridgeMessage, rule: BridgeRule, mediaPath?: string): Promise<void> {
    const lane = `${rule.dstPlatform}:${rule.dstChatId}:${rule.dstTopicId}`;
    const run = (this.lanes.get(lane) ?? Promise.resolve()).then(() =>
      this.deliver(msg, rule, mediaPath).catch((err) =>
        this.deps.logger.error(
          { err: String(err), rule: rule.id, type: msg.type },
          "bridge: forwarding failed",
        ),
      ),
    );
    this.lanes.set(lane, run);
    void run.finally(() => {
      if (this.lanes.get(lane) === run) this.lanes.delete(lane);
    });
    return run;
  }

  private async replyTarget(msg: BridgeMessage, rule: BridgeRule): Promise<string | undefined> {
    if (!msg.replyToId) return undefined;
    const { store } = this.deps;
    // Replying to something we forwarded earlier -> reply to that copy.
    const copy = await store.copyOf(msg.platform, msg.chatId, msg.replyToId, rule.dstChatId);
    if (copy) return copy;
    // Replying to a bridged message -> reply to its original, if it lives in the destination chat.
    const orig = await store.originalOf(msg.platform, msg.chatId, msg.replyToId);
    return orig && orig.chatId === rule.dstChatId ? orig.id : undefined;
  }

  private async deliver(msg: BridgeMessage, rule: BridgeRule, mediaPath?: string) {
    const dst = this.deps.endpoints[rule.dstPlatform];
    if (!dst) throw new Error(`${rule.dstPlatform} is not connected`);
    const mediaWanted = isMediaType(msg.type);
    let out = buildOutgoing(msg, rule, await this.replyTarget(msg, rule), mediaPath);
    if (mediaWanted && !mediaPath) {
      // Media that could not be fetched still gets announced instead of vanishing.
      const what = msg.type === "sticker" ? `sticker ${msg.text}`.trim() : msg.type;
      out = { type: "text", text: `${out.text}\n[${what} could not be transferred]`.trim() };
    }
    const dest = { chatId: rule.dstChatId, topicId: rule.dstTopicId || undefined };
    const key = `${rule.dstPlatform}:${rule.dstChatId}`;
    const stickerHead = out.type === "sticker" && out.filePath && out.text ? out.text : "";
    if (stickerHead) out = { ...out, text: "" };
    this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
    try {
      if (stickerHead)
        await this.sendWithRetry(dst, dest, { type: "text", text: stickerHead }, msg, rule);
      try {
        await this.sendWithRetry(dst, dest, out, msg, rule);
      } catch (err) {
        if (out.type !== "sticker") throw err;
        // The other platform refused this sticker (format): say so instead of dropping it.
        this.deps.logger.warn({ err: String(err) }, "bridge: sticker not accepted, sending a note");
        await this.sendWithRetry(
          dst,
          dest,
          { type: "text", text: `[sticker ${msg.text}]`.trim() },
          msg,
          rule,
        );
      }
    } finally {
      const n = (this.inflight.get(key) ?? 1) - 1;
      if (n <= 0) this.inflight.delete(key);
      else this.inflight.set(key, n);
    }
  }

  private async sendWithRetry(
    dst: BridgeEndpoint,
    dest: { chatId: string; topicId?: string },
    out: OutgoingBridge,
    msg: BridgeMessage,
    rule: BridgeRule,
  ) {
    for (let attempt = 0; ; attempt++) {
      try {
        const id = await dst.send(dest, out);
        if (id)
          await this.deps.store.addLink({
            platform: rule.dstPlatform,
            chatId: rule.dstChatId,
            messageId: id,
            srcPlatform: msg.platform,
            srcChatId: msg.chatId,
            srcMessageId: msg.messageId,
            ruleId: rule.id,
          });
        return;
      } catch (err) {
        const wait = retryDelayMs(err, attempt);
        if (wait === null) throw err;
        this.deps.logger.warn({ err: String(err), waitMs: wait }, "bridge: send failed, retrying");
        await this.sleep(wait);
      }
    }
  }

  /** Refreshes the two chat tables from whichever platforms are connected. */
  async refreshChats(): Promise<{ platform: Platform; count: number }[]> {
    const res: { platform: Platform; count: number }[] = [];
    for (const ep of Object.values(this.deps.endpoints)) {
      if (!ep?.ready()) continue;
      try {
        const chats = await ep.listChats();
        await this.deps.store.upsertChats(chats);
        res.push({ platform: ep.platform, count: chats.length });
      } catch (err) {
        this.deps.logger.warn(
          { err: String(err), platform: ep.platform },
          "bridge: chat refresh failed",
        );
      }
    }
    return res;
  }
}
