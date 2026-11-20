import { BufferJSON } from "@whiskeysockets/baileys";
import { eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { deliveryCache } from "../db/schema.js";
import type { CachedUpload } from "../providers/whatsapp/baileys/provider.js";

const KEEP_DAYS = 30;

/** Remembers uploaded files in the database, so the cache survives restarts and sleeping hosts. */
export class DbUploadCache {
  private saves = 0;
  constructor(private readonly db: Db) {}

  async load(key: string): Promise<CachedUpload | undefined> {
    const [row] = await this.db
      .select()
      .from(deliveryCache)
      .where(eq(deliveryCache.key, key))
      .limit(1);
    if (!row) return undefined;
    return {
      msg: JSON.parse(row.raw, BufferJSON.reviver),
      followUpText: row.followUpText ?? undefined,
      at: row.at.getTime(),
    };
  }

  async save(key: string, v: CachedUpload): Promise<void> {
    const values = {
      key,
      raw: JSON.stringify(v.msg, BufferJSON.replacer),
      followUpText: v.followUpText ?? null,
      at: new Date(v.at),
    };
    await this.db
      .insert(deliveryCache)
      .values(values)
      .onConflictDoUpdate({ target: deliveryCache.key, set: values });
    if (++this.saves % 50 === 0)
      await this.db
        .delete(deliveryCache)
        .where(lt(deliveryCache.at, sql`now() - interval '${sql.raw(String(KEEP_DAYS))} days'`));
  }

  async keysWith(prefix: string): Promise<string[]> {
    const rows = await this.db
      .select({ key: deliveryCache.key })
      .from(deliveryCache)
      .where(sql`${deliveryCache.key} LIKE ${`${prefix.replace(/[\\%_]/g, "\\$&")}%`}`);
    return rows.map((r) => r.key);
  }

  async remove(key: string): Promise<void> {
    await this.db.delete(deliveryCache).where(eq(deliveryCache.key, key));
  }
}
