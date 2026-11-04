import { rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { stickerToPng } from "./convert.js";
import { buildOutgoing, isMediaType, matchRules, rulesForChat, skipReason } from "./engine.js";
import type { BridgeStore, JobRow, LogLevel } from "./store.js";
import type {
  AlbumItem,
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
  /** Process jobs right inside handle() (tests). Production runs the worker loop instead. */
  inline?: boolean;
  /** How long to wait for the rest of an album before sending it. */
  albumWaitMs?: number;
  /** Worker poll interval. */
  pollMs?: number;
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
const LOG_KEEP = 500;

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
  /** Messages still in memory for queued jobs (avoids rebuilding them; after a restart they are rehydrated). */
  private readonly live = new Map<string, BridgeMessage>();
  private readonly albums = new Map<
    string,
    { msgs: BridgeMessage[]; rules: BridgeRule[]; timer?: NodeJS.Timeout }
  >();
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private lastPurge = 0;

  constructor(private readonly deps: BridgeDeps) {
    this.sleep = deps.sleep ?? defaultSleep;
  }

  /** Starts the queue worker. Jobs left "running" by a previous process go back to the queue first. */
  async start() {
    await this.deps.store.resetRunning();
    this.timer = setInterval(() => void this.tick(), this.deps.pollMs ?? 1000);
    this.timer.unref?.();
    void this.tick();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    for (const a of this.albums.values()) if (a.timer) clearTimeout(a.timer);
  }

  private kick() {
    if (!this.deps.inline) setImmediate(() => void this.tick());
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

  private logCount = new Map<number, number>();

  /** Writes one line to the rule's own log (when the rule keeps one). Logging never breaks forwarding. */
  private async log(
    rule: Pick<BridgeRule, "id" | "logEnabled">,
    level: LogLevel,
    event: string,
    msgType = "",
    detail = "",
  ) {
    if (!rule.logEnabled) return;
    try {
      await this.deps.store.addLog({ ruleId: rule.id, level, event, msgType, detail });
      const n = (this.logCount.get(rule.id) ?? 0) + 1;
      this.logCount.set(rule.id, n);
      if (n % 50 === 0) await this.deps.store.trimLogs(rule.id, LOG_KEEP);
    } catch (err) {
      this.deps.logger.warn({ err: String(err) }, "bridge: could not write log line");
    }
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
    for (const r of rulesForChat(msg, allRules)) {
      const why = skipReason(msg, r);
      if (why) await this.log(r, "skip", "skipped", msg.type, why);
    }
    if (rules.length === 0) return;
    if (msg.type === "text" && !msg.text.trim()) {
      // nothing to say: never forward a bare name header
      for (const r of rules) await this.log(r, "skip", "skipped", msg.type, "empty text message");
      return;
    }

    // Loop prevention: a message the bridge itself posted must never be forwarded again.
    if (msg.fromMe) {
      await this.sleep(this.deps.echoDelayMs ?? 2000);
      for (let i = 0; i < 240 && (this.inflight.get(`${msg.platform}:${msg.chatId}`) ?? 0) > 0; i++)
        await this.sleep(500); // a large upload can finish long after its echo arrived
    }
    if (await store.isBridged(msg.platform, msg.chatId, msg.messageId)) {
      for (const r of rules)
        await this.log(
          r,
          "skip",
          "skipped",
          msg.type,
          "copy made by the bridge itself (loop guard)",
        );
      return;
    }

    if (msg.albumId && (msg.type === "image" || msg.type === "video")) {
      this.bufferAlbum(msg, rules);
      return;
    }
    await this.enqueueSend(msg, rules);
    if (this.deps.inline) await this.processDue();
  }

  private liveKey = (m: { platform: Platform; chatId: string; messageId: string }) =>
    `${m.platform}:${m.chatId}:${m.messageId}`;

  private async enqueueSend(msg: BridgeMessage, rules: BridgeRule[]) {
    this.live.set(this.liveKey(msg), msg);
    if (this.live.size > 500) this.live.delete(this.live.keys().next().value as string);
    for (const r of rules) {
      await this.log(r, "ok", "queued", msg.type, `from ${msg.senderName || msg.senderId || "?"}`);
      await this.deps.store.enqueue({
        kind: "send",
        ruleId: r.id,
        dedupeKey: `s:${r.id}:${msg.platform}:${msg.chatId}:${msg.messageId}`,
        payload: {
          platform: msg.platform,
          chatId: msg.chatId,
          messageId: msg.messageId,
          ref: msg.ref ?? null,
        },
      });
    }
    this.kick();
  }

  // ---- albums: members arrive as separate messages; wait briefly, then forward them together

  private bufferAlbum(msg: BridgeMessage, rules: BridgeRule[]) {
    const key = `${msg.platform}:${msg.chatId}:${msg.albumId}`;
    const cur = this.albums.get(key) ?? { msgs: [], rules };
    cur.msgs.push(msg);
    cur.rules = rules;
    if (cur.timer) clearTimeout(cur.timer);
    if (!this.deps.inline) {
      cur.timer = setTimeout(() => void this.flushAlbum(key), this.deps.albumWaitMs ?? 1500);
      cur.timer.unref?.();
    }
    this.albums.set(key, cur);
  }

  /** Sends every buffered album now (also used by tests). */
  async flushAlbums() {
    for (const key of [...this.albums.keys()]) await this.flushAlbum(key);
    if (this.deps.inline) await this.processDue();
  }

  private async flushAlbum(key: string) {
    const a = this.albums.get(key);
    if (!a) return;
    this.albums.delete(key);
    const msgs = [...a.msgs].sort(
      (x, y) => x.timestamp - y.timestamp || Number(x.messageId) - Number(y.messageId) || 0,
    );
    if (msgs.length === 1) return this.enqueueSend(msgs[0] as BridgeMessage, a.rules);
    for (const m of msgs) this.live.set(this.liveKey(m), m);
    const first = msgs[0] as BridgeMessage;
    for (const r of a.rules) {
      await this.log(r, "ok", "queued", "album", `${msgs.length} items`);
      await this.deps.store.enqueue({
        kind: "album",
        ruleId: r.id,
        dedupeKey: `a:${r.id}:${first.platform}:${first.chatId}:${first.messageId}`,
        payload: {
          members: msgs.map((m) => ({
            platform: m.platform,
            chatId: m.chatId,
            messageId: m.messageId,
            ref: m.ref ?? null,
          })),
        },
      });
    }
    this.kick();
  }

  // ---- edits and deletions of source messages

  /** The source message was edited: update the copies the bridge made (text and captions only). */
  async handleEdit(msg: BridgeMessage, editKey: string): Promise<void> {
    const { store } = this.deps;
    if (await store.isBridged(msg.platform, msg.chatId, msg.messageId)) return; // our own edit of a copy
    const rules = matchRules(msg, await store.rules()).filter((r) => r.forwardEdits);
    if (rules.length === 0) return;
    this.seenMsg({
      at: new Date(),
      platform: msg.platform,
      chat: msg.chatTitle || msg.chatId,
      type: "edit",
      fromMe: msg.fromMe,
      rules: rules.length,
    });
    for (const r of rules) {
      const out = buildOutgoing(msg, r);
      await this.log(r, "ok", "queued", "edit", "source message was edited");
      await store.enqueue({
        kind: "edit",
        ruleId: r.id,
        dedupeKey: `e:${r.id}:${msg.platform}:${msg.chatId}:${msg.messageId}:${editKey}`,
        payload: {
          srcPlatform: msg.platform,
          srcChatId: msg.chatId,
          srcMessageId: msg.messageId,
          type: out.type,
          text: out.text,
        },
      });
    }
    this.kick();
    if (this.deps.inline) await this.processDue();
  }

  /** The source message was deleted: delete its copies. `chatId` may be unknown (Telegram, ordinary chats). */
  async handleDelete(
    platform: Platform,
    chatId: string | undefined,
    messageId: string,
  ): Promise<void> {
    const { store } = this.deps;
    const rules = (await store.rules()).filter(
      (r) =>
        r.forwardDeletes &&
        r.srcPlatform === platform &&
        (chatId === undefined || r.srcChatId === chatId),
    );
    if (rules.length === 0) return;
    const known = chatId
      ? await store.copiesOf(platform, chatId, messageId)
      : await store.copiesOfAnyChat(platform, messageId);
    let n = 0;
    for (const r of rules) {
      // Without a chat id, only act when a copy exists; otherwise the id may belong to an unrelated chat.
      if (chatId === undefined && !known.some((c) => c.ruleId === r.id)) continue;
      n++;
      await this.log(r, "ok", "queued", "delete", "source message was deleted");
      await store.enqueue({
        kind: "delete",
        ruleId: r.id,
        dedupeKey: `d:${r.id}:${platform}:${chatId ?? "?"}:${messageId}`,
        payload: {
          srcPlatform: platform,
          srcChatId: chatId ?? known.find((c) => c.ruleId === r.id)?.srcChatId ?? r.srcChatId,
          srcMessageId: messageId,
        },
      });
    }
    if (n === 0) return;
    this.seenMsg({
      at: new Date(),
      platform,
      chat: chatId ?? "?",
      type: "delete",
      fromMe: false,
      rules: n,
    });
    this.kick();
    if (this.deps.inline) await this.processDue();
  }

  // ---- the worker

  /** Runs every job that is due, to completion. */
  async processDue(): Promise<void> {
    for (let guard = 0; guard < 50; guard++) {
      const jobs = await this.deps.store.claimDue(25);
      if (jobs.length === 0) return;
      await this.runJobs(jobs);
    }
  }

  private async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.processDue();
      if (Date.now() - this.lastPurge > 3_600_000) {
        this.lastPurge = Date.now();
        await this.deps.store.purgeJobs(3 * 86_400_000);
      }
    } catch (err) {
      this.deps.logger.error({ err: String(err) }, "bridge: queue tick failed");
    } finally {
      this.ticking = false;
    }
  }

  /** Jobs for different destination chats run side by side; jobs for the same chat keep their order. */
  private async runJobs(jobs: JobRow[]) {
    const rules = new Map((await this.deps.store.rules()).map((r) => [r.id, r]));
    const lanes = new Map<string, JobRow[]>();
    for (const j of jobs) {
      const r = rules.get(j.ruleId);
      const lane = r ? `${r.dstPlatform}:${r.dstChatId}:${r.dstTopicId}` : "orphan";
      lanes.set(lane, [...(lanes.get(lane) ?? []), j]);
    }
    await Promise.all(
      [...lanes.values()].map(async (list) => {
        for (const j of list) await this.runJob(j, rules.get(j.ruleId));
      }),
    );
  }

  private async runJob(job: JobRow, rule: BridgeRule | undefined) {
    const { store, logger } = this.deps;
    try {
      if (!rule || !rule.enabled) return void (await store.complete(job.id)); // rule removed or paused meanwhile
      if (job.kind === "send") await this.runSend(job, rule);
      else if (job.kind === "album") await this.runAlbum(job, rule);
      else if (job.kind === "edit") await this.runEdit(job, rule);
      else await this.runDelete(job, rule);
      await store.complete(job.id);
    } catch (err) {
      const quick = job.kind === "edit" || job.kind === "delete";
      const max = quick ? 4 : 5;
      const delays = quick
        ? [5_000, 10_000, 20_000, 40_000]
        : [5_000, 30_000, 120_000, 600_000, 1_800_000];
      const giveUp = job.attempts + 1 >= max;
      if (rule)
        await this.log(
          rule,
          giveUp && !quick ? "error" : "warn",
          giveUp ? (quick ? "dropped" : "failed") : "retry",
          job.kind,
          `${short(err)}${giveUp ? "" : ` (attempt ${job.attempts + 1}/${max})`}`,
        );
      this.note({
        at: new Date(),
        platform: rule?.dstPlatform ?? "telegram",
        type: job.kind,
        stage: "send",
        error: short(err),
      });
      logger.warn(
        { err: String(err), job: job.id, kind: job.kind, attempts: job.attempts },
        "bridge: job failed",
      );
      if (giveUp && quick)
        await store.complete(job.id); // an edit whose copy never appeared is simply dropped
      else
        await store.retryLater(
          job.id,
          short(err),
          delays[Math.min(job.attempts, delays.length - 1)] ?? 60_000,
          giveUp,
        );
    }
  }

  /** A job finished: its message no longer needs to be kept in memory. */
  private forget(m: { platform: Platform; chatId: string; messageId: string }) {
    this.live.delete(this.liveKey(m));
  }

  private async messageFor(m: {
    platform: Platform;
    chatId: string;
    messageId: string;
    ref?: unknown;
  }): Promise<BridgeMessage | null> {
    const hit = this.live.get(this.liveKey(m));
    if (hit) return hit;
    const ep = this.deps.endpoints[m.platform];
    return m.ref ? ((await ep?.rehydrate?.(m.ref)) ?? null) : null;
  }

  private async runSend(job: JobRow, rule: BridgeRule) {
    const p = job.payload as {
      platform: Platform;
      chatId: string;
      messageId: string;
      ref?: unknown;
    };
    const msg = await this.messageFor(p);
    if (!msg) {
      this.note({
        at: new Date(),
        platform: p.platform,
        type: "send",
        stage: "download",
        error: "original message is no longer available",
      });
      await this.log(rule, "error", "failed", "send", "original message is no longer available");
      return;
    }
    const { mediaPath, downloadError, dir } = await this.fetchMedia(msg);
    try {
      await this.deliver(msg, rule, mediaPath, downloadError);
      this.forget(msg); // kept after a failure so the retry does not need to rebuild it
      await this.log(
        rule,
        downloadError ? "warn" : "ok",
        "sent",
        msg.type,
        downloadError ? `sent without the file: ${downloadError}` : `to ${rule.dstPlatform}`,
      );
    } finally {
      if (mediaPath) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async fetchMedia(msg: BridgeMessage) {
    const dir = join(
      this.deps.tempDir,
      `bridge-${msg.platform}-${msg.messageId}`.replace(/[^\w.-]/g, "_"),
    );
    let mediaPath: string | undefined;
    let downloadError: string | undefined;
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
        this.deps.logger.warn(
          { err: String(err), type: msg.type },
          "bridge: media download failed",
        );
      }
    }
    return { mediaPath, downloadError, dir };
  }

  private async runEdit(job: JobRow, rule: BridgeRule) {
    const p = job.payload as {
      srcPlatform: Platform;
      srcChatId: string;
      srcMessageId: string;
      type: OutgoingBridge["type"];
      text: string;
    };
    const dst = this.deps.endpoints[rule.dstPlatform];
    if (!dst?.edit) return;
    const copy = await this.deps.store.copyOf(
      p.srcPlatform,
      p.srcChatId,
      p.srcMessageId,
      rule.dstChatId,
    );
    if (!copy) throw new Error("the copy does not exist yet");
    const dest = { chatId: rule.dstChatId, topicId: rule.dstTopicId || undefined };
    const ok = await dst.edit(dest, copy, { type: p.type, text: p.text });
    if (!ok) {
      this.note({
        at: new Date(),
        platform: rule.dstPlatform,
        type: "edit",
        stage: "send",
        error: `${rule.dstPlatform} cannot edit this kind of message`,
      });
      await this.log(
        rule,
        "warn",
        "edit",
        p.type,
        `${rule.dstPlatform} cannot edit this kind of message`,
      );
    } else await this.log(rule, "ok", "edit", p.type, "copy updated");
  }

  private async runDelete(job: JobRow, rule: BridgeRule) {
    const p = job.payload as { srcPlatform: Platform; srcChatId: string; srcMessageId: string };
    const dst = this.deps.endpoints[rule.dstPlatform];
    if (!dst?.remove) return;
    const copy = await this.deps.store.copyOf(
      p.srcPlatform,
      p.srcChatId,
      p.srcMessageId,
      rule.dstChatId,
    );
    if (!copy) throw new Error("the copy does not exist yet");
    await dst.remove({ chatId: rule.dstChatId, topicId: rule.dstTopicId || undefined }, copy);
    await this.log(rule, "ok", "delete", "", "copy deleted");
  }

  /** Forwards an album as one album where the destination supports it, otherwise one by one. */
  private async runAlbum(job: JobRow, rule: BridgeRule) {
    const refs = (
      job.payload as {
        members: { platform: Platform; chatId: string; messageId: string; ref?: unknown }[];
      }
    ).members;
    const msgs: BridgeMessage[] = [];
    for (const r of refs) {
      const m = await this.messageFor(r);
      if (m) msgs.push(m);
    }
    if (msgs.length === 0) return;
    const dst = this.deps.endpoints[rule.dstPlatform];
    if (!dst) throw new Error(`${rule.dstPlatform} is not connected`);
    const fetched = [];
    for (const m of msgs) fetched.push({ m, ...(await this.fetchMedia(m)) });
    const key = `${rule.dstPlatform}:${rule.dstChatId}`;
    this.inflight.set(key, (this.inflight.get(key) ?? 0) + 1);
    try {
      const allReady = fetched.every(
        (f) => f.mediaPath && (f.m.type === "image" || f.m.type === "video"),
      );
      if (dst.sendAlbum && allReady) {
        const first = msgs[0] as BridgeMessage;
        const head = buildOutgoing({ ...first, text: "" }, rule).text;
        const caption = [head, ...msgs.map((m) => m.text.trim())].filter(Boolean).join("\n");
        const items: AlbumItem[] = fetched.map((f, i) => ({
          type: f.m.type as "image" | "video",
          filePath: f.mediaPath as string,
          fileName: f.m.fileName,
          text: i === 0 ? caption : "",
        }));
        try {
          const ids = await withTimeout(
            dst.sendAlbum(
              { chatId: rule.dstChatId, topicId: rule.dstTopicId || undefined },
              items,
              await this.replyTarget(first, rule),
            ),
            (this.deps.uploadTimeoutMs ?? 300_000) * 2,
            "album send",
          );
          for (let i = 0; i < msgs.length; i++) {
            const id = ids[i];
            const m = msgs[i] as BridgeMessage;
            if (id)
              await this.deps.store.addLink({
                platform: rule.dstPlatform,
                chatId: rule.dstChatId,
                messageId: id,
                srcPlatform: m.platform,
                srcChatId: m.chatId,
                srcMessageId: m.messageId,
                ruleId: rule.id,
              });
          }
          for (const f of fetched) this.forget(f.m);
          await this.log(rule, "ok", "sent", "album", `${msgs.length} items as one album`);
          return;
        } catch (err) {
          this.note({
            at: new Date(),
            platform: rule.dstPlatform,
            type: "album",
            stage: "send",
            error: short(err),
          });
          await this.log(
            rule,
            "warn",
            "album",
            "album",
            `album refused, sending one by one: ${short(err)}`,
          );
        }
      }
      // One by one: the name goes on the first picture only.
      for (let i = 0; i < fetched.length; i++) {
        const f = fetched[i] as (typeof fetched)[number];
        await this.deliver(
          f.m,
          i === 0 ? rule : { ...rule, senderMode: "none" },
          f.mediaPath,
          f.downloadError,
        );
      }
      for (const f of fetched) this.forget(f.m);
      await this.log(rule, "ok", "sent", "album", `${msgs.length} items one by one`);
    } finally {
      const n = (this.inflight.get(key) ?? 1) - 1;
      if (n <= 0) this.inflight.delete(key);
      else this.inflight.set(key, n);
      for (const f of fetched)
        if (f.mediaPath) await rm(f.dir, { recursive: true, force: true }).catch(() => undefined);
    }
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
        await this.log(rule, "warn", "fallback", out.type, `${short(err)} — trying another form`);
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
