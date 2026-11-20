import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

/**
 * After a database is copied (dump/restore, data-only import) the id counters can restart at 1 while
 * the rows keep their old ids; every insert then collides, and "insert or ignore" writes (the bridge's
 * message links, for one) are silently dropped. Move each counter past the largest id in use.
 */
export async function syncSequences(db: {
  execute: (q: ReturnType<typeof sql>) => Promise<unknown>;
}) {
  await db.execute(sql`
    DO $$
    DECLARE r record;
    BEGIN
      FOR r IN
        SELECT c.table_name AS t, c.column_name AS col,
               pg_get_serial_sequence(format('%I.%I', c.table_schema, c.table_name), c.column_name) AS seq
        FROM information_schema.columns c
        WHERE c.table_schema = 'public' AND c.column_default LIKE 'nextval%'
      LOOP
        IF r.seq IS NOT NULL THEN
          EXECUTE format('SELECT setval(%L, COALESCE((SELECT MAX(%I) FROM %I), 0) + 1, false)', r.seq, r.col, r.t);
        END IF;
      END LOOP;
    END $$`);
}

export async function runMigrations(databaseUrl: string) {
  const { db, pool } = createDb(databaseUrl);
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS unaccent`);
    await migrate(db, { migrationsFolder: "./drizzle" });
    await syncSequences(db);
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL: is required (missing)");
  await runMigrations(url);
  console.log("migrations applied");
}
