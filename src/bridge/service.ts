import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { stickerToPng } from "./convert.js";
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
  downloadTimeoutMs?: number;
  uploadTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface BridgeProblem {
  at: Date;
  platform: Platform;
  type: string;
  stage: "download" | "send";
  error: string;
}

export interface BridgeActivity {
  at: Date;
  platform: Platform;
  chat: string;
  type: string;
  fromMe: boolean;
  /** Number of rules that matched; 0 means nothing was forwarded. */
  rules: number;
  note?: string;
}

const short = (err: unknown) =>
  String((err as Error)?.message ?? err)
    .replace(/\s+/g, " ")
    .slice(0, 200);

/** A stuck download or upload must surface as an error instead of silently hanging the message forever. */
function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(
      () => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)),
      ms,
    );
    t.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
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
  private readonly problems_: BridgeProblem[] = [];
  private readonly activity_: BridgeActivity[] = [];
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: BridgeDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /** The last few failures, newest first, so the dashboard can show why something did not arrive. */
  problems(): BridgeProblem[] {
    return [...this.problems_].reverse();
  }

  /** The last messages the bridge saw (even ones no rule matched), newest first: shows whether a type reaches it at all. */
  activity(): BridgeActivity[] {
    return [...this.activity_].reverse();
  }

  /** A message arrived that no mapper understands; shown in the dashboard instead of vanishing. */
  async noteUnrecognised(platform: Platform, chat: string, kinds: string[]) {
    const rules = await this.deps.store.rules();
    if (!rules.some((r) => r.srcPlatform === platform && r.srcChatId === chat)) return;
    this.seenMsg({
      at: new Date(),
      platform,
      chat,
      type: `? ${kinds.join(", ")}`,
      fromMe: false,
      rules: 0,
    });
  }

  private seenMsg(a: BridgeActivity) {
    this.activity_.push(a);
    if (this.activity_.length > 30) this.activity_.shift();
  }

  private note(p: BridgeProblem) {
    this.problems_.push(p);
    if (this.problems_.length > 30) this.problems_.shift();
  }

  /** Entry point for both platforms. Never throws for a single bad message. */
  async handle(msg: BridgeMessage): Promise<void> {
    const { store, logger } = this.deps;
    const first = `${msg.platform}:${msg.chatId}:${msg.messageId}`;
    if (this.seen.has(first)) return; // redelivered event
    this.seen.add(first);
    if (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.values().next().value as string);

    const allRules = await store.rules();
    // Telegram delivers every chat the account is in; only chats used as a source in some rule are of interest.
    if (!allRules.some((r) => r.srcPlatform === msg.platform && r.srcChatId === msg.chatId)) return;
    const rules = matchRules(msg, allRules);
    this.seenMsg({
      at: new Date(),
      platform: msg.platform,
      chat: msg.chatTitle || msg.chatId,
      type: msg.type,
      fromMe: msg.fromMe,
      rules: rules.length,
    });
    if (rules.length === 0) return;
    if (msg.type === "text" && !msg.text.trim()) return; // nothing to say: never forward a bare name header

    // Loop prevention: a message the bridge itself posted must never be forwarded again.
    if (msg.fromMe) {
      await this.sleep(this.deps.echoDelayMs ?? 2000);
      for (let i = 0; i < 240 && (this.inflight.get(`${msg.platform}:${msg.chatId}`) ?? 0) > 0; i++)
        await this.sleep(500); // a large upload can finish long after its echo arrived
    }
    if (await store.isBridged(msg.platform, msg.chatId, msg.messageId)) return;

    let mediaPath: string | undefined;
    let downloadError: string | undefined;
    const dir = join(
      this.deps.tempDir,
      `bridge-${msg.platform}-${msg.messageId}`.replace(/[^\w.-]/g, "_"),
    );
    try {
      const animatedSticker = msg.type === "sticker" && msg.mimeType === "application/x-tgsticker";
      if (isMediaType(msg.type) && msg.downloadMedia && !animatedSticker) {
        try {
          mediaPath = await withTimeout(
            msg.downloadMedia(dir),
            this.deps.downloadTimeoutMs ?? 90_000,
            "download",
          );
        } catch (err) {
          downloadError = short(err);
          this.note({
            at: new Date(),
            platform: msg.platform,
            type: msg.type,
            stage: "download",
            error: downloadError,
          });
          logger.warn({ err: String(err), type: msg.type }, "bridge: media download failed");
        }
      }
      await Promise.all(rules.map((r) => this.forward(msg, r, mediaPath, downloadError)));
    } finally {
      if (mediaPath) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private forward(
    msg: BridgeMessage,
    rule: BridgeRule,
    mediaPath?: string,
    downloadError?: string,
  ): Promise<void> {
    const lane = `${rule.dstPlatform}:${rule.dstChatId}:${rule.dstTopicId}`;
    const run = (this.lanes.get(lane) ?? Promise.resolve()).then(() =>
      this.deliver(msg, rule, mediaPath, downloadError).catch((err) => {
        this.note({
          at: new Date(),
          platform: rule.dstPlatform,
          type: msg.type,
          stage: "send",
          error: short(err),
        });
        this.deps.logger.error(
          { err: String(err), rule: rule.id, type: msg.type },
          "bridge: forwarding failed",
        );
      }),
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

  private async deliver(
    msg: BridgeMessage,
    rule: BridgeRule,
    mediaPath?: string,
    downloadError?: string,
  ) {
    const dst = this.deps.endpoints[rule.dstPlatform];
    if (!dst) throw new Error(`${rule.dstPlatform} is not connected`);
    const mediaWanted = isMediaType(msg.type);
    let out = buildOutgoing(msg, rule, await this.replyTarget(msg, rule), mediaPath);
    if (mediaWanted && !mediaPath) {
      // Media that could not be fetched still gets announced instead of vanishing.
      const what = msg.type === "sticker" ? `sticker ${msg.text}`.trim() : msg.type;
      out = {
        type: "text",
        text: `${out.text}\n[${what} could not be transferred${downloadError ? `: ${downloadError}` : ""}]`.trim(),
      };
    }
    const dest = { chatId: rule.dstChatId, topicId: rule.dstTopicId || undefined };
    const key = `${rule.dstPlatform}:${rule.dstChatId}`;
    this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
    try {
      try {
        if (out.filePath && out.type !== "text") await this.sendMedia(dst, dest, out, msg, rule);
        else await this.sendWithRetry(dst, dest, out, msg, rule);
      } catch (err) {
        if (out.type === "text") throw err;
        // Every way of sending this failed: leave a note with the reason instead of dropping it silently.
        this.deps.logger.warn(
          { err: String(err), type: out.type },
          "bridge: file not accepted, sending a note",
        );
        const text =
          out.type === "sticker"
            ? `${rule.senderMode === "none" ? "" : `${out.text}\n`}[sticker ${msg.text}]`.trim()
            : `${out.text}\n[${out.type} could not be sent: ${short(err)}]`.trim();
        await this.sendWithRetry(dst, dest, { type: "text", text }, msg, rule);
      }
    } finally {
      const n = (this.inflight.get(key) ?? 1) - 1;
      if (n <= 0) this.inflight.delete(key);
      else this.inflight.set(key, n);
    }
  }

  /**
   * Sends a file, trying the next-best form when the destination refuses it:
   * stickers go as pictures (Telegram never gets a native sticker), anything else falls back to a plain document.
   */
  private async sendMedia(
    dst: BridgeEndpoint,
    dest: { chatId: string; topicId?: string },
    out: OutgoingBridge,
    msg: BridgeMessage,
    rule: BridgeRule,
  ) {
    const file = out.filePath as string;
    const head = out.text;
    let headSent = false;
    const asDocument = (caption: string): OutgoingBridge => ({
      ...out,
      type: "document",
      text: caption,
      fileName: out.fileName ?? basename(file),
    });
    const steps: (() => Promise<OutgoingBridge>)[] = [];
    if (out.type === "sticker") {
      if (rule.dstPlatform !== "telegram")
        steps.push(async () => {
          if (head && !headSent) {
            await this.sendWithRetry(dst, dest, { type: "text", text: head }, msg, rule);
            headSent = true;
          }
          return { ...out, text: "" };
        });
      steps.push(async () => ({
        type: "image",
        text: headSent ? "" : head,
        filePath: await stickerToPng(file),
        fileName: "sticker.png",
        mimeType: "image/png",
        replyToId: out.replyToId,
      }));
      steps.push(async () => asDocument(headSent ? "" : head));
    } else {
      steps.push(async () => out);
      if (out.type !== "document") steps.push(async () => asDocument(head));
    }
    let first: unknown;
    for (const step of steps) {
      try {
        await this.sendWithRetry(dst, dest, await step(), msg, rule);
        return;
      } catch (err) {
        first ??= err;
        this.note({
          at: new Date(),
          platform: rule.dstPlatform,
          type: out.type,
          stage: "send",
          error: short(err),
        });
      }
    }
    throw first;
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
        const id = await withTimeout(
          dst.send(dest, out),
          out.filePath ? (this.deps.uploadTimeoutMs ?? 300_000) : 60_000,
          "send",
        );
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
