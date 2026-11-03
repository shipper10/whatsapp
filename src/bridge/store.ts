import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bridgeChats, bridgeLinks, bridgeRules } from "../db/schema.js";
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
    await this.db.delete(bridgeRules).where(eq(bridgeRules.id, id));
  }

  async upsertChats(chats: ChatInfo[]) {
    for (const c of chats) {
      await this.db
        .insert(bridgeChats)
        .values({
          platform: c.platform,
          chatId: c.chatId,
          topicId: c.topicId ?? "",
          title: c.title,
          kind: c.kind,
          parentId: c.parentId ?? null,
        })
        .onConflictDoUpdate({
          target: [bridgeChats.platform, bridgeChats.chatId, bridgeChats.topicId],
          set: {
            title: c.title,
            kind: c.kind,
            parentId: c.parentId ?? null,
            updatedAt: new Date(),
          },
        });
    }
  }

  async chats(platform: Platform): Promise<ChatInfo[]> {
    const rows = await this.db
      .select()
      .from(bridgeChats)
      .where(eq(bridgeChats.platform, platform))
      .orderBy(asc(bridgeChats.title));
    return rows.map((r) => ({
      platform,
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
      .select({ id: bridgeLinks.srcMessageId, chatId: bridgeLinks.srcChatId })
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
}
