/**
 * Manage Drive sources (stored in the database; no redeploy needed).
 *   npm run drive:source -- add "Year 1 Sheets" "<folder url or id>" [credential_ref=default] [--no-recursive]
 *   npm run drive:source -- list
 *   npm run drive:source -- enable|disable <id>
 *   npm run drive:source -- check          (lists each source with the real Drive API, prints access errors)
 */
import { eq } from "drizzle-orm";
import { loadEnv } from "../src/config/env.js";
import { createDb } from "../src/db/client.js";
import { driveSources } from "../src/db/schema.js";
import { GoogleDriveClient, resolveCredentialPath } from "../src/drive/client.js";
import { parseFolderId } from "../src/drive/url.js";

const [cmd, ...args] = process.argv.slice(2);
const { db, pool } = createDb(loadEnv().DATABASE_URL);

try {
  if (cmd === "add") {
    const [label, url, ref = "default"] = args.filter((a) => !a.startsWith("--"));
    if (!label || !url) throw new Error('Usage: add "<label>" "<folder url or id>" [credential_ref]');
    const folderId = parseFolderId(url);
    await db
      .insert(driveSources)
      .values({ label, folderId, credentialRef: ref, recursiveScan: !args.includes("--no-recursive") })
      .onConflictDoUpdate({ target: driveSources.folderId, set: { label, credentialRef: ref } });
    console.log(`source saved: ${label} (${folderId})`);
  } else if (cmd === "list") {
    console.table(await db.select().from(driveSources));
  } else if (cmd === "enable" || cmd === "disable") {
    await db.update(driveSources).set({ enabled: cmd === "enable" }).where(eq(driveSources.id, Number(args[0])));
    console.log(`${cmd}d source ${args[0]}`);
  } else if (cmd === "check") {
    for (const s of await db.select().from(driveSources)) {
      try {
        const client = new GoogleDriveClient(resolveCredentialPath(s.credentialRef));
        const n = (await client.listChildren(s.folderId)).length;
        console.log(`OK    ${s.label}: ${n} direct items visible to ${client.identity}`);
      } catch (e) {
        console.log(`FAIL  ${s.label}: ${(e as Error).message}`);
      }
    }
  } else {
    console.log("Commands: add | list | enable | disable | check");
  }
} finally {
  await pool.end();
}
