import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { syncSequences } from "../src/db/migrate.js";
import { createTestDb } from "./helpers/pg.js";

describe("id counters after a database copy", () => {
  it("moves each counter past the rows that were copied in", async () => {
    const db = await createTestDb();
    const link = (id: number | undefined, m: string) =>
      sql.raw(
        `INSERT INTO bridge_links (${id ? "id, " : ""}platform, chat_id, message_id, src_platform, src_chat_id, src_message_id, rule_id) VALUES (${id ? `${id}, ` : ""}'telegram','c','${m}','whatsapp','s','${m}',1)`,
      );
    for (const id of [1, 2, 3]) await db.execute(link(id, `old${id}`)); // copied with their ids
    await expect(db.execute(link(undefined, "new"))).rejects.toThrow(); // counter still at 1
    await syncSequences(db as never);
    await db.execute(link(undefined, "new"));
    const r = (await db.execute(sql`SELECT count(*)::int AS n FROM bridge_links`)) as {
      rows: { n: number }[];
    };
    expect(r.rows[0]?.n).toBe(4);
  });
});
