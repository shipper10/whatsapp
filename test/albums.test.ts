import { describe, expect, it } from "vitest";
import { mergeAlbums } from "../src/library/albums.js";
import { classifyAndApply } from "../src/library/apply.js";
import { albumMessageIds, telegramMessageDetail } from "../src/library/browse.js";
import type { TgRow } from "../src/library/classify.js";
import { parseMessage } from "../src/telegram/parse.js";
import { DbTelegramStore } from "../src/telegram/store.js";
import { syncTelegram } from "../src/telegram/sync.js";
import type { RawTelegramMessage } from "../src/telegram/types.js";
import { createTestDb } from "./helpers/pg.js";

const ctx = { chatId: 1n, username: "BahriMed" };
const file = (id: number, name: string, text = "", groupedId?: string): RawTelegramMessage => ({
  id,
  date: new Date(2026, 0, 1, 0, id),
  text,
  entities: [],
  media: { kind: "document", fileName: name, mimeType: "application/pdf", sizeBytes: 1000 + id },
  groupedId,
});

const row = (id: number, text: string, groupedId: string | null): TgRow => ({
  dbId: id,
  chatId: 1n,
  messageId: id,
  messageDate: new Date(),
  text,
  entities: [],
  hashtags: text ? ["#x"] : [],
  mediaType: "document",
  fileName: `f${id}.pdf`,
  fileSizeBytes: 1,
  permalink: null,
  isIndex: false,
  returnIndexId: null,
  groupedId,
});

describe("mergeAlbums", () => {
  it("keeps the first member, gives it the caption of whichever member has one, drops the rest", () => {
    const out = mergeAlbums([
      row(10, "", "g1"),
      row(11, "Medical Physics 2023 Mid-Term Exam model 1\nWith Answers", "g1"),
      row(12, "", "g1"),
      row(20, "single", null),
    ]);
    expect(out.map((r) => r.messageId)).toEqual([10, 20]);
    expect(out[0]?.text).toContain("Mid-Term Exam model 1");
    expect(out[0]?.hashtags).toEqual(["#x"]);
  });
  it("leaves non-album files and lone group members alone", () => {
    const rows = [row(1, "a", null), row(2, "b", "solo")];
    expect(mergeAlbums(rows)).toEqual(rows);
  });
});

describe("albums end to end", () => {
  it("stores album ids, merges the album into one resource and finds its members", async () => {
    const db = await createTestDb();
    const store = new DbTelegramStore(db);
    await store.upsertMany(
      [
        file(100, "model1.pdf", "", "A1"),
        file(101, "model2.pdf", "Medical Physics 2023 Mid-Term Exam model 1\nWith Answers", "A1"),
        file(102, "model3.pdf", "", "A1"),
        file(103, "other.pdf", "Another file"),
      ].map((m) => parseMessage(m, ctx)),
    );
    await classifyAndApply(db, "BahriMed");
    expect(await albumMessageIds(db, 102)).toEqual([100, 101, 102]);
    expect(await albumMessageIds(db, 103)).toEqual([]);
    const { resources } = await import("../src/db/schema.js");
    const rs = await db.select().from(resources);
    expect(rs.filter((r) => r.isActive).length).toBe(2); // album + single, not 4
    expect(rs.some((r) => r.searchText.includes("mid term exam model 1"))).toBe(true);
    const d = await telegramMessageDetail(db, 100);
    expect(d?.sources[0]?.telegramMessageId).toBe(100);
  });

  it("the one-time pass learns album ids of messages stored before albums were tracked", async () => {
    const db = await createTestDb();
    const store = new DbTelegramStore(db);
    const old = [file(1, "a.pdf"), file(2, "b.pdf", "caption")]; // stored without album info
    await store.upsertMany(old.map((m) => parseMessage(m, ctx)));
    const withAlbum = old.map((m) => ({ ...m, groupedId: "G" }));
    const source = {
      fetchBatch: async () => ({ messages: [], lastId: 2, exhausted: true }),
      fetchByIds: async (ids: number[]) => withAlbum.filter((m) => ids.includes(m.id)),
    };
    await syncTelegram(source, store, { sourceKey: "k", ctx });
    expect(await albumMessageIds(db, 1)).toEqual([1, 2]);
    // second run does not re-read everything
    let calls = 0;
    await syncTelegram(
      {
        ...source,
        fetchByIds: async (ids: number[]) => (calls++, withAlbum.filter((m) => ids.includes(m.id))),
      },
      store,
      { sourceKey: "k", ctx },
    );
    expect(calls).toBe(0);
  }, 60000);
});
