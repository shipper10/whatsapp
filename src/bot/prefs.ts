import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { subscriptions, userPrefs } from "../db/schema.js";

type Lang = "ar" | "en";

/** Per-person language and per-chat subscription to new-file notices. */
export interface PrefsPort {
  getLang(participantId: string): Promise<Lang | null>;
  setLang(participantId: string, lang: Lang): Promise<void>;
  isSubscribed(conversationId: string): Promise<boolean>;
  subscribe(conversationId: string, by: string): Promise<void>;
  unsubscribe(conversationId: string): Promise<void>;
}

export class DbPrefs implements PrefsPort {
  constructor(private readonly db: Db) {}

  async getLang(participantId: string): Promise<Lang | null> {
    if (!participantId) return null;
    const [row] = await this.db
      .select()
      .from(userPrefs)
      .where(eq(userPrefs.participantId, participantId));
    return row?.lang === "ar" || row?.lang === "en" ? row.lang : null;
  }

  async setLang(participantId: string, lang: Lang): Promise<void> {
    await this.db
      .insert(userPrefs)
      .values({ participantId, lang })
      .onConflictDoUpdate({
        target: userPrefs.participantId,
        set: { lang, updatedAt: new Date() },
      });
  }

  async isSubscribed(conversationId: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.conversationId, conversationId));
    return rows.length > 0;
  }

  async subscribe(conversationId: string, by: string): Promise<void> {
    await this.db
      .insert(subscriptions)
      .values({ conversationId, subscribedBy: by })
      .onConflictDoNothing();
  }

  async unsubscribe(conversationId: string): Promise<void> {
    await this.db.delete(subscriptions).where(eq(subscriptions.conversationId, conversationId));
  }
}
