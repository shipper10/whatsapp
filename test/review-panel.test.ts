import { Readable } from "node:stream";
import { and, eq, like } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/client.js";
import {
  driveFiles,
  driveSources,
  resourceSources,
  resources,
  telegramMessages,
} from "../src/db/schema.js";
import { createReviewUi } from "../src/http/reviewPanel.js";
import { classifyAndApply } from "../src/library/apply.js";
import { indexTitles } from "../src/library/browse.js";
import { matchIndexes } from "../src/library/indexSearch.js";
import { looksLikeIndex } from "../src/telegram/parse.js";
import { createTestDb, seedChannel } from "./helpers/pg.js";

let db: Db;
beforeAll(async () => {
  db = await createTestDb();
  await seedChannel(db);
  await classifyAndApply(db, "BahriMed");
}, 120_000);

const flash = (r?: string) => new URL(r ?? "", "http://x").searchParams.get("f") ?? "";
const get = (ui: ReturnType<typeof createReviewUi>, path: string) =>
  ui({ method: "GET" } as never, path.split("?")[0] ?? "/", new URL(`http://x${path}`));
const post = (ui: ReturnType<typeof createReviewUi>, sub: string, form: Record<string, string>) => {
  const req = Readable.from([Buffer.from(new URLSearchParams(form).toString())]) as never as {
    method: string;
  };
  req.method = "POST";
  return ui(req as never, sub, new URL("http://x/"));
};

describe("index detection", () => {
  it("a single link is an index only when tagged #Index", () => {
    const base = { hasMedia: false, internalLinks: 1, hashtags: [] as string[] };
    expect(looksLikeIndex(base)).toBe(false);
    expect(looksLikeIndex({ ...base, hashtags: ["index"] })).toBe(true);
    expect(looksLikeIndex({ ...base, internalLinks: 2 })).toBe(true);
    expect(looksLikeIndex({ ...base, hasMedia: true, hashtags: ["index"] })).toBe(false);
  });

  it("an index that only says Soon is found by name and by its name in the semester list", async () => {
    const text =
      "📜 Basic Ethics and Professionalism Index\n\n──────────────────\n\n🔜 Soon 😀\n\n──────────────────\n\n↩️ Return to 2nd Year - 3rd Semeter Index\n#Index #Basic_Ethics_and_Professionalism";
    const link = "↩️ Return to 2nd Year - 3rd Semeter Index";
    const start = text.indexOf(link);
    await db.insert(telegramMessages).values({
      chatId: 1n,
      messageId: 900001,
      messageDate: new Date(),
      textOrCaption: text,
      entitiesJson: {
        entities: [
          {
            type: "text_link",
            offset: start,
            length: link.length,
            url: "https://t.me/BahriMed/624",
          },
        ],
        internalLinkIds: [624],
        isIndex: false,
      },
      hashtags: ["index", "basic_ethics_and_professionalism"],
    });
    const parent = "📜 Medical Professionalism · 2 CH";
    const label = "Medical Professionalism";
    await db.insert(telegramMessages).values({
      chatId: 1n,
      messageId: 900002,
      messageDate: new Date(),
      textOrCaption: `Semester Index\n${parent}\n🫀 Cardiology\n#Index`,
      entitiesJson: {
        entities: [
          {
            type: "text_link",
            offset: 15 + 2,
            length: label.length,
            url: "https://t.me/BahriMed/900001",
          },
          {
            type: "text_link",
            offset: 15 + parent.length + 4,
            length: 10,
            url: "https://t.me/BahriMed/900003",
          },
        ],
        internalLinkIds: [900001, 900003],
        isIndex: true,
      },
      hashtags: ["index"],
    });
    await classifyAndApply(db, "BahriMed");
    const titles = await indexTitles(db);
    expect(matchIndexes(titles, "basic eth")[0]?.messageId).toBe(900001);
    expect(matchIndexes(titles, "medical prof")[0]?.messageId).toBe(900001);
  });
});

describe("review panel", () => {
  const ui = () => createReviewUi({ db, reclassify: () => classifyAndApply(db, "BahriMed") });

  it("lists unplaced files and assigns one to a place", async () => {
    const page = await get(ui(), "/?kind=telegram");
    expect(page.body).toContain("Review");
    const [r] = await db
      .select({ id: resources.id })
      .from(resources)
      .where(
        and(
          like(resources.resourceKey, "tg:%"),
          eq(resources.classificationStatus, "uncategorized"),
        ),
      )
      .limit(1);
    expect(r).toBeTruthy();
    const label = /<option value="([^"]+)"/.exec(page.body ?? "")?.[1] ?? "";
    expect(label).not.toBe("");
    const bad = await post(ui(), "/assign", { id: String(r?.id), node: "nowhere" });
    expect(flash(bad.redirect)).toContain("!Pick a place");
    const ok = await post(ui(), "/assign", {
      id: String(r?.id),
      node: label.replace(/&amp;/g, "&"),
    });
    expect(flash(ok.redirect)).toContain("✅");
    const [after] = await db
      .select()
      .from(resources)
      .where(eq(resources.id, r?.id ?? 0));
    expect(after?.classificationStatus).toBe("classified");
    expect(after?.classificationLocked).toBe(true);
  });

  it("joins a Drive file to the Telegram upload it duplicates and keeps it across syncs", async () => {
    const [tg] = await db
      .select({ id: resources.id, name: resources.displayName })
      .from(resources)
      .where(like(resources.resourceKey, "tg:%"))
      .limit(1);
    const [src] = await db
      .insert(driveSources)
      .values({ label: "t", folderId: "f1", credentialRef: "x" })
      .returning();
    await db.insert(driveFiles).values({
      driveSourceId: src?.id ?? 0,
      driveFileId: "abc",
      name: `${tg?.name} (copy).pdf`,
      webViewLink: "https://drive.google.com/file/d/abc",
    });
    await classifyAndApply(db, "BahriMed");
    const [drv] = await db.select().from(resources).where(like(resources.resourceKey, "drive:%"));
    expect(drv).toBeTruthy();
    const page = await get(ui(), "/?kind=drive");
    expect(page.body).toContain("Drive");
    const res = await post(ui(), "/merge", { drive: String(drv?.id), telegram: String(tg?.id) });
    expect(flash(res.redirect)).toContain("✅");
    const gone = await db
      .select()
      .from(resources)
      .where(and(eq(resources.id, drv?.id ?? 0), eq(resources.isActive, true)));
    expect(gone).toHaveLength(0);
    const kinds = await db
      .select()
      .from(resourceSources)
      .where(eq(resourceSources.resourceId, tg?.id ?? 0));
    expect(kinds.map((k) => k.sourceType).sort()).toContain("google_drive");
    await classifyAndApply(db, "BahriMed");
    const again = await db
      .select()
      .from(resourceSources)
      .where(eq(resourceSources.resourceId, tg?.id ?? 0));
    expect(again.map((k) => k.sourceType)).toContain("google_drive");
  });
});
