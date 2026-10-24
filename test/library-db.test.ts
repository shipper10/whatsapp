import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import {
  academicNodes,
  driveFiles,
  driveSources,
  resourceAliases,
  resources,
  telegramMessages,
} from "../src/db/schema.js";
import { DbDriveStore } from "../src/drive/store.js";
import { classifyAndApply } from "../src/library/apply.js";
import {
  childNodes,
  recentResources,
  resourceDetail,
  resourcesInNode,
} from "../src/library/browse.js";
import { searchResources } from "../src/library/search.js";
import { DbTelegramStore } from "../src/telegram/store.js";
import { channelRecords, createTestDb, seedChannel } from "./helpers/pg.js";

let db: Db;
const count = async (d: Db, t: typeof resources | typeof telegramMessages | typeof driveFiles) =>
  (await d.select({ n: sql<number>`count(*)::int` }).from(t))[0]?.n ?? 0;
beforeAll(async () => {
  db = await createTestDb();
  await seedChannel(db);
}, 120_000);

describe("telegram store on real Postgres", () => {
  it("upsert is idempotent (second run inserts nothing)", async () => {
    const again = await new DbTelegramStore(db).upsertMany(channelRecords());
    expect(again.inserted).toBe(0);
    const n = await count(db, telegramMessages);
    expect(n).toBeGreaterThan(400);
  });
});

describe("classify + apply + search + browse", () => {
  it("applies the plan idempotently", async () => {
    const a = await classifyAndApply(db, "BahriMed");
    expect(a.created).toBeGreaterThan(400);
    const b = await classifyAndApply(db, "BahriMed");
    expect(b.created).toBe(0);
    expect(b.updated).toBe(a.created);
    const n = await count(db, resources);
    expect(n).toBe(a.created);
  });

  it("browses root > semester > subject > resources", async () => {
    const roots = await childNodes(db, null);
    expect(roots).toHaveLength(1);
    const semesters = await childNodes(db, roots[0]?.id ?? 0);
    expect(semesters.map((s) => s.name)).toEqual([
      "First Year 1st Semester",
      "First Year 2nd Semester",
    ]);
    const subjects = await childNodes(db, semesters[0]?.id ?? 0);
    const chem = subjects.find((s) => s.name === "Chemistry");
    expect(chem).toBeDefined();
    const files = await resourcesInNode(db, chem?.id ?? 0, { limit: 5, offset: 0 });
    expect(files.length).toBe(5);
  });

  it("finds files by English words, prefixes, and Arabic text", async () => {
    const chem = await searchResources(db, "chemistry sheet 7", { limit: 5 });
    expect(chem[0]?.displayName).toMatch(/Chemistry.*Sheet 7/);
    expect((await searchResources(db, "chemis", { limit: 3 })).length).toBeGreaterThan(0);
    const ar = await searchResources(db, "مهارات التفوق", { limit: 3 });
    expect(ar[0]?.displayName).toContain("مهارات التفوق");
  });

  it("tolerates typos through the trigram fallback", async () => {
    const hits = await searchResources(db, "chemestry", { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
  });

  it("expands admin aliases to a node's resources", async () => {
    const [bio] = await db
      .select()
      .from(academicNodes)
      .where(eq(academicNodes.name, "Biomolecules"));
    await db
      .insert(resourceAliases)
      .values({ nodeId: bio?.id, alias: "بايو كيم", aliasNormalized: "بايو كيم" });
    const hits = await searchResources(db, "بايو كيم", { limit: 5 });
    expect(hits.length).toBeGreaterThan(0);
    expect(await searchResources(db, "zzzz qqqq", { limit: 5 })).toEqual([]);
  });

  it("lists recent resources newest first", async () => {
    const rec = await recentResources(db, { limit: 3, offset: 0 });
    expect(rec).toHaveLength(3);
    expect((rec[0]?.sourceDate?.getTime() ?? 0) >= (rec[2]?.sourceDate?.getTime() ?? 0)).toBe(true);
  });

  it("returns delivery detail with verified links and ids", async () => {
    const [hit] = await searchResources(db, "chemistry sheet 7", { limit: 1 });
    const d = await resourceDetail(db, hit?.id ?? 0);
    expect(d?.path).toContain("Chemistry");
    const tg = d?.sources.find((s) => s.type === "telegram");
    expect(tg?.url).toMatch(/^https:\/\/t\.me\/BahriMed\/\d+$/);
    expect(tg?.telegramMessageId).toBeGreaterThan(0);
    expect(tg?.sizeBytes).toBeGreaterThan(0);
  });

  it("merges Drive metadata and keeps admin-locked classification across re-runs", async () => {
    const [src] = await db
      .insert(driveSources)
      .values({ label: "t", folderId: "folder123456", credentialRef: "default" })
      .returning();
    const [tg] = await db
      .select()
      .from(telegramMessages)
      .where(sql`${telegramMessages.fileName} like '%Chemical Composition%'`);
    await new DbDriveStore(db).upsertFiles(
      src?.id ?? 0,
      [
        {
          driveFileId: "drv1",
          name: tg?.fileName ?? "",
          mimeType: "application/pdf",
          sizeBytes: tg?.fileSizeBytes ?? null,
          modifiedTime: null,
          parentFolderId: "p",
          folderPath: "Chemistry",
          webViewLink: "https://drive.google.com/file/d/drv1/view",
        },
      ],
      new Date(),
    );
    await classifyAndApply(db, "BahriMed");
    const [hit] = await searchResources(db, "chemical composition", { limit: 1 });
    const d = await resourceDetail(db, hit?.id ?? 0);
    expect(d?.sources.map((s) => s.type).sort()).toEqual(["google_drive", "telegram"]);
    expect(d?.sources.find((s) => s.type === "google_drive")?.url).toBe(
      "https://drive.google.com/file/d/drv1/view",
    );

    // admin locks it onto another node; sync must not move it back
    const [other] = await db
      .select()
      .from(academicNodes)
      .where(eq(academicNodes.name, "Mathematics"));
    await db
      .update(resources)
      .set({ academicNodeId: other?.id, classificationLocked: true })
      .where(eq(resources.id, hit?.id ?? 0));
    await classifyAndApply(db, "BahriMed");
    const [after] = await db
      .select()
      .from(resources)
      .where(eq(resources.id, hit?.id ?? 0));
    expect(after?.academicNodeId).toBe(other?.id);
  });

  it("deactivates (never deletes) resources whose source disappeared", async () => {
    await db
      .update(telegramMessages)
      .set({ syncStatus: "missing" })
      .where(sql`${telegramMessages.fileName} like '%Chemical Composition%'`);
    const stats = await classifyAndApply(db, "BahriMed");
    expect(stats.deactivated).toBeGreaterThan(0);
    // the Telegram-based resource is inactive; the Drive copy lives on as its own resource
    const hits = await searchResources(db, "chemical composition", { limit: 5 });
    expect(hits).toHaveLength(1);
    const d = await resourceDetail(db, hits[0]?.id ?? 0);
    expect(d?.sources.map((x) => x.type)).toEqual(["google_drive"]);
    const n = await count(db, driveFiles);
    expect(n).toBe(1);
  });
});
