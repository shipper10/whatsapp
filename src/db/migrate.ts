import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDb } from "./client.js";

export async function runMigrations(databaseUrl: string) {
  const { db, pool } = createDb(databaseUrl);
  try {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS unaccent`);
    await migrate(db, { migrationsFolder: "./drizzle" });
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
