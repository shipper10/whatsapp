import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import pg from "pg";
import * as schema from "./schema.js";

export function createDb(databaseUrl: string, poolMax = Number(process.env.DB_POOL_MAX ?? 10)) {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: poolMax,
    idleTimeoutMillis: 10 * 60_000, // default 10 s: each reconnect costs a pooler auth round trip
    keepAlive: true,
  });
  return { db: drizzle(pool, { schema }), pool };
}
/** Driver-neutral: node-postgres in production, PGlite (real Postgres in WASM) in tests. */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
