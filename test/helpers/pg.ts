import { readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "../../src/db/client.js";
import * as schema from "../../src/db/schema.js";
import { fromExport } from "../../src/telegram/exportAdapter.js";
import { parseMessage } from "../../src/telegram/parse.js";
import { DbTelegramStore } from "../../src/telegram/store.js";
import type { TelegramRecord } from "../../src/telegram/types.js";

/** A real in-process Postgres with the production migrations applied. */
export async function createTestDb(): Promise<Db> {
  const client = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle(client, { schema });
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await migrate(db, { migrationsFolder: "./drizzle" });
  return db as unknown as Db;
}

export function channelRecords(): TelegramRecord[] {
  const f = JSON.parse(readFileSync("test/fixtures/channel-full.json", "utf8"));
  return f.messages
    .map(fromExport)
    .filter(Boolean)
    .map((raw: never) => parseMessage(raw, { chatId: 3448452098n, username: "BahriMed" }));
}

export async function seedChannel(db: Db) {
  await new DbTelegramStore(db).upsertMany(channelRecords());
}
