import { asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { bridgeAccounts } from "../db/schema.js";
import type { Platform } from "./types.js";

export interface AccountRow {
  id: number;
  platform: Platform;
  label: string;
  enabled: boolean;
  identity: string | null;
  /** Encrypted session (Telegram). */
  session: string | null;
}

const toRow = (r: typeof bridgeAccounts.$inferSelect): AccountRow => ({
  id: r.id,
  platform: r.platform as Platform,
  label: r.label,
  enabled: r.enabled,
  identity: r.identity,
  session: r.session,
});

export class AccountStore {
  constructor(private readonly db: Db) {}

  async list(): Promise<AccountRow[]> {
    return (await this.db.select().from(bridgeAccounts).orderBy(asc(bridgeAccounts.id))).map(toRow);
  }

  async get(id: number): Promise<AccountRow | undefined> {
    const [r] = await this.db.select().from(bridgeAccounts).where(eq(bridgeAccounts.id, id));
    return r ? toRow(r) : undefined;
  }

  async add(platform: Platform, label: string): Promise<number> {
    const [r] = await this.db
      .insert(bridgeAccounts)
      .values({ platform, label })
      .returning({ id: bridgeAccounts.id });
    return (r as { id: number }).id;
  }

  async rename(id: number, label: string) {
    await this.db.update(bridgeAccounts).set({ label }).where(eq(bridgeAccounts.id, id));
  }

  async setEnabled(id: number, enabled: boolean) {
    await this.db.update(bridgeAccounts).set({ enabled }).where(eq(bridgeAccounts.id, id));
  }

  async setSession(id: number, session: string | null) {
    await this.db.update(bridgeAccounts).set({ session }).where(eq(bridgeAccounts.id, id));
  }

  async setIdentity(id: number, identity: string | null) {
    await this.db.update(bridgeAccounts).set({ identity }).where(eq(bridgeAccounts.id, id));
  }

  async remove(id: number) {
    await this.db.delete(bridgeAccounts).where(eq(bridgeAccounts.id, id));
  }
}
