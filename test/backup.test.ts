import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { pgDump } from "@electric-sql/pglite-tools/pg_dump";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { searchResources } from "../src/library/search.js";
import { libraryDb } from "./helpers/bot.js";

/**
 * Backup/restore drill on real Postgres semantics: dump the fully populated library with pg_dump,
 * restore it into an empty database, and prove the data AND the search indexes work again.
 */
describe("backup and restore", () => {
  it("a pg_dump of the library restores into an empty database with identical data and working search", async () => {
    const source = await libraryDb();
    const rawSource = (source as unknown as { $client: PGlite }).$client;
    const dump = await pgDump({ pg: rawSource });
    const sqlText = await dump.text();
    expect(sqlText).toContain("CREATE TABLE");

    const fresh = new PGlite({ extensions: { pg_trgm } });
    await fresh.exec("CREATE EXTENSION IF NOT EXISTS pg_trgm;");
    await fresh.exec(sqlText);
    await fresh.exec("SET search_path TO public"); // pg_dump clears it for the restoring session
    const restored = drizzle(fresh, { schema }) as unknown as Db;

    const count = async (db: Db, table: string) =>
      Number(
        (
          (await db.execute(sql.raw(`select count(*)::int as n from ${table}`))) as unknown as {
            rows: { n: number }[];
          }
        ).rows[0]?.n,
      );
    for (const table of [
      "telegram_messages",
      "resources",
      "academic_nodes",
      "resource_sources",
      "resource_tags",
      "user_sessions",
    ]) {
      expect(await count(restored, table)).toBe(await count(source, table));
    }
    expect(await count(restored, "resources")).toBeGreaterThan(400);

    const a = await searchResources(source, "chemistry sheet 7", { limit: 3 });
    const b = await searchResources(restored, "chemistry sheet 7", { limit: 3 });
    expect(b.map((x) => x.displayName)).toEqual(a.map((x) => x.displayName));
    expect(b.length).toBeGreaterThan(0);
  });
});
