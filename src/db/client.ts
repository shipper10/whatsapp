import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema.js";

export function createDb(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return { db: drizzle(pool, { schema }), pool };
}
/** Driver-neutral: node-postgres in production, PGlite (real Postgres in WASM) in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
