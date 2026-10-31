import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { subscriptions } from "../db/schema.js";

/** Chats (people or groups) that asked to be told when new files arrive. */
export interface PrefsPort {
  isSubscribed(conversationId: string): Promise<boolean>;
  subscribe(conversationId: string, by: string): Promise<void>;
  unsubscribe(conversationId: string): Promise<void>;
}

export class DbPrefs implements PrefsPort {
  constructor(private readonly db: Db) {}

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
