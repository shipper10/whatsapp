import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  bridgeChats,
  bridgeContactTopics,
  bridgeJobs,
  bridgeLinks,
  bridgeLogs,
  bridgeRules,
} from "../db/schema.js";
import { contactRef } from "./engine.js";
import {
  type BridgeRule,
  type ChatInfo,
  MESSAGE_TYPES,
  type MessageType,
  type Platform,
  SENDER_MODES,
  type SenderMode,
} from "./types.js";

export type NewRule = Omit<BridgeRule, "id">;
export type LogLevel = "ok" | "skip" | "warn" | "error";
export type LogFilter = "all" | "done" | "skip" | "problems";

function logWhere(ruleId: number, filter: LogFilter = "all") {
  const rule = eq(bridgeLogs.ruleId, ruleId);
  if (filter === "done")
    return and(rule, eq(bridgeLogs.level, "ok"), ne(bridgeLogs.event, "queued"));
  if (filter === "skip") return and(rule, eq(bridgeLogs.level, "skip"));
  if (filter === "problems") return and(rule, inArray(bridgeLogs.level, ["warn", "error"]));
  return rule;
}

const toRule = (r: typeof bridgeRules.$inferSelect): BridgeRule => ({
  id: r.id,
  name: r.name,
  enabled: r.enabled,
  srcPlatform: r.srcPlatform as Platform,
  srcChatId: r.srcChatId,
  srcTopicId: r.srcTopicId,
  dstPlatform: r.dstPlatform as Platform,
  dstChatId: r.dstChatId,
  dstTopicId: r.dstTopicId,
  types: r.types.filter((t): t is MessageType => (MESSAGE_TYPES as readonly string[]).includes(t)),
  senderMode: (SENDER_MODES as readonly string[]).includes(r.senderMode)
    ? (r.senderMode as SenderMode)
    : "saved",
  customName: r.customName,
  showPhone: r.showPhone,
  forwardOwn: r.forwardOwn,
  forwardEdits: r.forwardEdits,
  forwardDeletes: r.forwardDeletes,
  logEnabled: r.logEnabled,
  forwardReactions: r.forwardReactions,
  srcAccountId: r.srcAccountId,
  dstAccountId: r.dstAccountId,
});

export class BridgeStore {
  constructor(private readonly db: Db) {}

  async rules(): Promise<BridgeRule[]> {
    return (await this.db.select().from(bridgeRules).orderBy(asc(bridgeRules.id))).map(toRule);
  }

  async addRule(r: NewRule): Promise<number> {
    const { id: _ignored, ...values } = r as NewRule & { id?: number };
    const [row] = await this.db
      .insert(bridgeRules)
      .values(values)
      .returning({ id: bridgeRules.id });
    return (row as { id: number }).id;
  }

  async updateRule(id: number, r: NewRule) {
    const { id: _ignored, ...values } = r as NewRule & { id?: number };
    await this.db.update(bridgeRules).set(values).where(eq(bridgeRules.id, id));
  }

  async rule(id: number): Promise<BridgeRule | undefined> {
    return (await this.rules()).find((r) => r.id === id);
  }

  async setEnabled(id: number, enabled: boolean) {
    await this.db.update(bridgeRules).set({ enabled }).where(eq(bridgeRules.id, id));
  }

  async deleteRule(id: number) {
    // A "private chats" rule owns its reply rule (topic -> person) and its topic map.
    const owned = (await this.rules())
      .filter((r) => r.dstChatId === contactRef(id))
      .map((r) => r.id);
    for (const rid of [id, ...owned]) {
      await this.db.delete(bridgeRules).where(eq(bridgeRules.id, rid));
      await this.db.delete(bridgeLogs).where(eq(bridgeLogs.ruleId, rid));
    }
    await this.db.delete(bridgeContactTopics).where(eq(bridgeContactTopics.ruleId, id));
  }

  // ---- "all private chats" rules: one topic per person

  async contactTopic(ruleId: number, peerChatId: string) {
    const [r] = await this.db
      .select()
      .from(bridgeContactTopics)
      .where(
        and(eq(bridgeContactTopics.ruleId, ruleId), eq(bridgeContactTopics.peerChatId, peerChatId)),
      );
    return r;
  }

  /** Which person a topic belongs to (for messages typed in the topic). */
  async contactOfTopic(ruleId: number, dstChatId: string, topicId: string) {
    const [r] = await this.db
      .select()
      .from(bridgeContactTopics)
      .where(
        and(
          eq(bridgeContactTopics.ruleId, ruleId),
          eq(bridgeContactTopics.dstChatId, dstChatId),
          eq(bridgeContactTopics.topicId, topicId),
        ),
      );
    return r;
  }

  async addContactTopic(t: {
    ruleId: number;
    peerChatId: string;
    peerName: string;
    dstChatId: string;
    topicId: string;
  }) {
    await this.db.insert(bridgeContactTopics).values(t).onConflictDoNothing();
    return (await this.contactTopic(t.ruleId, t.peerChatId)) as NonNullable<
      Awaited<ReturnType<BridgeStore["contactTopic"]>>
    >;
  }

  async contactTopics(ruleId: number) {
    return this.db
      .select()
      .from(bridgeContactTopics)
      .where(eq(bridgeContactTopics.ruleId, ruleId))
      .orderBy(desc(bridgeContactTopics.id));
  }

  /** The topic no longer exists on Telegram: forget it so the next message makes a new one. */
  async dropContactTopic(id: number) {
    await this.db.delete(bridgeContactTopics).where(eq(bridgeContactTopics.id, id));
  }

  /** An account was removed: its chats leave the tables and the rules that used it stop (they are kept, not deleted). */
  async forgetAccount(platform: Platform, accountId: number): Promise<number> {
    await this.db
      .delete(bridgeChats)
      .where(and(eq(bridgeChats.platform, platform), eq(bridgeChats.accountId, accountId)));
    const used = (await this.rules()).filter(
      (r) =>
        r.enabled &&
        ((r.srcPlatform === platform && r.srcAccountId === accountId) ||
          (r.dstPlatform === platform && r.dstAccountId === accountId)),
    );
    for (const r of used) await this.setEnabled(r.id, false);
    return used.length;
  }

  /** Rules that read from or write to this account. */
  async rulesOfAccount(platform: Platform, accountId: number): Promise<BridgeRule[]> {
    return (await this.rules()).filter(
      (r) =>
        (r.srcPlatform === platform && r.srcAccountId === accountId) ||
        (r.dstPlatform === platform && r.dstAccountId === accountId),
    );
  }

  async setLogEnabled(id: number, logEnabled: boolean) {
    await this.db.update(bridgeRules).set({ logEnabled }).where(eq(bridgeRules.id, id));
  }

  // ---- per-rule log

  /** Chats of every account. */
  async allChats(): Promise<ChatInfo[]> {
    const rows = await this.db.select().from(bridgeChats).orderBy(asc(bridgeChats.title));
    return rows.map((r) => ({
      platform: r.platform as Platform,
      accountId: r.accountId,
      chatId: r.chatId,
      topicId: r.topicId || undefined,
      title: r.title,
      kind: r.kind,
      parentId: r.parentId ?? undefined,
    }));
  }

  async addLog(e: {
    ruleId: number;
    level: LogLevel;
    event: string;
    msgType?: string;
    detail?: string;
  }) {
    await this.db.insert(bridgeLogs).values({
      ruleId: e.ruleId,
      level: e.level,
      event: e.event,
      msgType: e.msgType ?? "",
      detail: (e.detail ?? "").slice(0, 400),
    });
  }

  /** Newest first. `level` filters one level; `errors` shows warnings and errors together. */
  async logs(ruleId: number, o: { filter?: LogFilter; limit: number; offset: number }) {
    return this.db
      .select()
      .from(bridgeLogs)
      .where(logWhere(ruleId, o.filter))
      .orderBy(desc(bridgeLogs.id))
      .limit(o.limit)
      .offset(o.offset);
  }

  async logCount(ruleId: number, filter?: LogFilter): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(bridgeLogs)
      .where(logWhere(ruleId, filter));
    return r?.n ?? 0;
  }

  /** What happened in the last day: finished, skipped on purpose, and problems. */
  async logSummary(ruleId: number): Promise<{ done: number; skipped: number; problems: number }> {
    const rows = await this.db
      .select({ level: bridgeLogs.level, event: bridgeLogs.event, n: sql<number>`count(*)::int` })
      .from(bridgeLogs)
      .where(
        and(eq(bridgeLogs.ruleId, ruleId), gte(bridgeLogs.at, new Date(Date.now() - 86_400_000))),
      )
      .groupBy(bridgeLogs.level, bridgeLogs.event);
    const out = { done: 0, skipped: 0, problems: 0 };
    for (const r of rows) {
      if (r.level === "skip") out.skipped += r.n;
      else if (r.level === "warn" || r.level === "error") out.problems += r.n;
      else if (r.event !== "queued") out.done += r.n;
    }
    return out;
  }

  async clearLogs(ruleId: number) {
    await this.db.delete(bridgeLogs).where(eq(bridgeLogs.ruleId, ruleId));
  }

  /** Keeps only the newest `keep` rows of a rule's log. */
  async trimLogs(ruleId: number, keep: number) {
    await this.db.execute(
      sql`DELETE FROM bridge_logs WHERE rule_id = ${ruleId} AND id < COALESCE((SELECT id FROM bridge_logs WHERE rule_id = ${ruleId} ORDER BY id DESC OFFSET ${keep - 1} LIMIT 1), 0)`,
    );
  }

  /** Failed and giving-up entries of every rule, for the overview. */
  async recentErrors(limit: number) {
    return this.db
      .select()
      .from(bridgeLogs)
      .where(eq(bridgeLogs.level, "error"))
      .orderBy(desc(bridgeLogs.id))
      .limit(limit);
  }

  async upsertChats(chats: ChatInfo[]) {
    for (const c of chats) {
      await this.db
        .insert(bridgeChats)
        .values({
          platform: c.platform,
          chatId: c.chatId,
          topicId: c.topicId ?? "",
          accountId: c.accountId ?? 0,
          title: c.title,
          kind: c.kind,
          parentId: c.parentId ?? null,
        })
        .onConflictDoUpdate({
          target: [
            bridgeChats.accountId,
            bridgeChats.platform,
            bridgeChats.chatId,
            bridgeChats.topicId,
          ],
          set: {
            title: c.title,
            kind: c.kind,
            parentId: c.parentId ?? null,
            updatedAt: new Date(),
          },
        });
    }
  }

  async chats(platform: Platform, accountId = 0): Promise<ChatInfo[]> {
    const rows = await this.db
      .select()
      .from(bridgeChats)
      .where(and(eq(bridgeChats.platform, platform), eq(bridgeChats.accountId, accountId)))
      .orderBy(asc(bridgeChats.title));
    return rows.map((r) => ({
      platform,
      accountId: r.accountId,
      chatId: r.chatId,
      topicId: r.topicId || undefined,
      title: r.title,
      kind: r.kind,
      parentId: r.parentId ?? undefined,
    }));
  }

  async addLink(l: {
    platform: Platform;
    chatId: string;
    messageId: string;
    srcPlatform: Platform;
    srcChatId: string;
    srcMessageId: string;
    ruleId: number;
  }) {
    await this.db.insert(bridgeLinks).values(l).onConflictDoNothing();
  }

  /** True when this message was produced by the bridge itself (an echo that must not be forwarded again). */
  async isBridged(platform: Platform, chatId: string, messageId: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: bridgeLinks.id })
      .from(bridgeLinks)
      .where(
        and(
          eq(bridgeLinks.platform, platform),
          eq(bridgeLinks.chatId, chatId),
          eq(bridgeLinks.messageId, messageId),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** The copy of a source message that already exists in `dstChatId`, for threading replies. */
  async copyOf(
    srcPlatform: Platform,
    srcChatId: string,
    srcMessageId: string,
    dstChatId: string,
  ): Promise<string | undefined> {
    const rows = await this.db
      .select({ messageId: bridgeLinks.messageId })
      .from(bridgeLinks)
      .where(
        and(
          eq(bridgeLinks.srcPlatform, srcPlatform),
          eq(bridgeLinks.srcChatId, srcChatId),
          eq(bridgeLinks.srcMessageId, srcMessageId),
          eq(bridgeLinks.chatId, dstChatId),
        ),
      )
      .limit(1);
    return rows[0]?.messageId;
  }

  /** Reverse lookup: a reply to a bridged message points at the original on the other platform. */
  async originalOf(platform: Platform, chatId: string, messageId: string) {
    const rows = await this.db
      .select({
        id: bridgeLinks.srcMessageId,
        chatId: bridgeLinks.srcChatId,
        platform: bridgeLinks.srcPlatform,
        ruleId: bridgeLinks.ruleId,
      })
      .from(bridgeLinks)
      .where(
        and(
          eq(bridgeLinks.platform, platform),
          eq(bridgeLinks.chatId, chatId),
          eq(bridgeLinks.messageId, messageId),
        ),
      )
      .limit(1);
    return rows[0];
  }

  /** Every copy the bridge made of a source message (one per matching rule). */
  async copiesOf(srcPlatform: Platform, srcChatId: string, srcMessageId: string) {
    return this.db
      .select({
        platform: bridgeLinks.platform,
        chatId: bridgeLinks.chatId,
        messageId: bridgeLinks.messageId,
        ruleId: bridgeLinks.ruleId,
        srcChatId: bridgeLinks.srcChatId,
      })
      .from(bridgeLinks)
      .where(
        and(
          eq(bridgeLinks.srcPlatform, srcPlatform),
          eq(bridgeLinks.srcChatId, srcChatId),
          eq(bridgeLinks.srcMessageId, srcMessageId),
        ),
      );
  }

  /** Telegram does not always say which chat a deletion came from; ids of ordinary chats are unique per account. */
  async copiesOfAnyChat(srcPlatform: Platform, srcMessageId: string) {
    return this.db
      .select({
        platform: bridgeLinks.platform,
        chatId: bridgeLinks.chatId,
        messageId: bridgeLinks.messageId,
        ruleId: bridgeLinks.ruleId,
        srcChatId: bridgeLinks.srcChatId,
      })
      .from(bridgeLinks)
      .where(
        and(eq(bridgeLinks.srcPlatform, srcPlatform), eq(bridgeLinks.srcMessageId, srcMessageId)),
      );
  }

  // ---- durable queue

  /** Adds a job; returns false when the same job already exists (duplicate event). */
  async enqueue(job: {
    kind: JobKind;
    ruleId: number;
    dedupeKey: string;
    payload: unknown;
    delayMs?: number;
  }): Promise<boolean> {
    const rows = await this.db
      .insert(bridgeJobs)
      .values({
        kind: job.kind,
        ruleId: job.ruleId,
        dedupeKey: job.dedupeKey,
        payload: job.payload,
        nextAttemptAt: new Date(Date.now() + (job.delayMs ?? 0)),
      })
      .onConflictDoNothing()
      .returning({ id: bridgeJobs.id });
    return rows.length > 0;
  }

  /** Status of the job with this key (pending/running/done/failed), if any. */
  async jobState(dedupeKey: string): Promise<string | undefined> {
    const [r] = await this.db
      .select({ status: bridgeJobs.status })
      .from(bridgeJobs)
      .where(eq(bridgeJobs.dedupeKey, dedupeKey))
      .limit(1);
    return r?.status;
  }

  /** Takes the oldest due jobs and marks them running. */
  async claimDue(limit: number): Promise<JobRow[]> {
    const due = await this.db
      .select()
      .from(bridgeJobs)
      .where(and(eq(bridgeJobs.status, "pending"), lte(bridgeJobs.nextAttemptAt, new Date())))
      .orderBy(asc(bridgeJobs.id))
      .limit(limit);
    if (due.length === 0) return [];
    // Only rows still pending are flipped, so two workers can never take the same job.
    const taken = await this.db
      .update(bridgeJobs)
      .set({ status: "running", updatedAt: new Date() })
      .where(
        and(
          inArray(
            bridgeJobs.id,
            due.map((j) => j.id),
          ),
          eq(bridgeJobs.status, "pending"),
        ),
      )
      .returning();
    return taken.sort((a, b) => a.id - b.id).map(toJob);
  }

  async complete(id: number) {
    await this.db
      .update(bridgeJobs)
      .set({ status: "done", updatedAt: new Date() })
      .where(eq(bridgeJobs.id, id));
  }

  /** Put back for another try, or mark failed for good. */
  async retryLater(id: number, error: string, delayMs: number, giveUp: boolean) {
    await this.db
      .update(bridgeJobs)
      .set({
        status: giveUp ? "failed" : "pending",
        attempts: sql`${bridgeJobs.attempts} + 1`,
        lastError: error.slice(0, 500),
        nextAttemptAt: new Date(Date.now() + delayMs),
        updatedAt: new Date(),
      })
      .where(eq(bridgeJobs.id, id));
  }

  /** After a restart nothing is really running: those jobs go back to the queue. */
  async resetRunning() {
    await this.db
      .update(bridgeJobs)
      .set({ status: "pending", updatedAt: new Date() })
      .where(eq(bridgeJobs.status, "running"));
  }

  async queueStats() {
    const rows = await this.db
      .select({ status: bridgeJobs.status, n: sql<number>`count(*)::int` })
      .from(bridgeJobs)
      .groupBy(bridgeJobs.status);
    const get = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    return {
      pending: get("pending"),
      running: get("running"),
      failed: get("failed"),
      done: get("done"),
    };
  }

  async failedJobs(limit = 10): Promise<JobRow[]> {
    const rows = await this.db
      .select()
      .from(bridgeJobs)
      .where(eq(bridgeJobs.status, "failed"))
      .orderBy(sql`${bridgeJobs.id} desc`)
      .limit(limit);
    return rows.map(toJob);
  }

  /** Forget finished jobs after a few days so the table stays small. */
  async purgeJobs(olderThanMs: number) {
    await this.db
      .delete(bridgeJobs)
      .where(
        and(
          eq(bridgeJobs.status, "done"),
          lte(bridgeJobs.updatedAt, new Date(Date.now() - olderThanMs)),
        ),
      );
  }
}

export type JobKind = "send" | "album" | "edit" | "delete" | "react";

export interface JobRow {
  id: number;
  kind: JobKind;
  ruleId: number;
  dedupeKey: string;
  payload: Record<string, unknown>;
  attempts: number;
  lastError: string | null;
}

const toJob = (r: typeof bridgeJobs.$inferSelect): JobRow => ({
  id: r.id,
  kind: r.kind as JobKind,
  ruleId: r.ruleId,
  dedupeKey: r.dedupeKey,
  payload: r.payload as Record<string, unknown>,
  attempts: r.attempts,
  lastError: r.lastError,
});
