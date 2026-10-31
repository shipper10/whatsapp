import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSelection, resolveTyped } from "../src/bot/selection.js";
import { chunkText, cleanCaption, renderIndex } from "../src/library/indexView.js";
import { fromExport } from "../src/telegram/exportAdapter.js";

const raws = JSON.parse(readFileSync("test/fixtures/channel-full.json", "utf8"))
  .messages.map(fromExport)
  .filter(Boolean);
const index = (id: number) => {
  const m = raws.find((r: { id: number }) => r.id === id);
  return renderIndex({ text: m.text, entities: m.entities, username: "BahriMed" });
};

describe("renderIndex on the real channel indexes", () => {
  it("numbers every link, keeps the full text, and exposes kinds and ordinals", () => {
    const r = index(5); // Cell Biology
    expect(r.text).toContain("1 - Cell division\n🎙 Lecture【1】 | 📔 Sheet【2】 | 🎯 MCQ【3】");
    expect(r.text).toContain("🔬 Lab");
    expect(r.text).toContain("References");
    expect(r.entries[0]).toMatchObject({ n: 1, targetId: 45, kind: "lecture", ord: 1, block: 1 });
    expect(r.entries[1]).toMatchObject({ n: 2, targetId: 41, kind: "sheet", ord: 1 });
    expect(r.text).not.toMatch(/#Index|#Cell_Biology/); // trailing hashtag line dropped
  });

  it("shows external links (Drive, bots) as plain URLs without numbers", () => {
    const r = index(2);
    expect(r.text).toContain("https://t.me/UOB_COM_B13_Library_bot");
    expect(r.entries.map((e) => e.targetId)).toEqual([3, 4]);
  });

  it("hides Drive and Telegram URLs (and lines that only carried them) when asked", () => {
    const m = raws.find((r: { id: number }) => r.id === 4);
    const full = renderIndex({ text: m.text, entities: m.entities, username: "BahriMed" });
    expect(full.text).toContain("drive.google.com");
    const hidden = renderIndex(
      { text: m.text, entities: m.entities, username: "BahriMed" },
      { hideUrl: (u) => /drive\.google\.com/.test(u) },
    );
    expect(hidden.text).not.toContain("drive.google.com");
    expect(hidden.text).not.toContain("Google Drive Folder");
    expect(hidden.entries).toEqual(full.entries); // numbering is untouched
    const main = raws.find((r: { id: number }) => r.id === 2);
    const noTg = renderIndex(
      { text: main.text, entities: main.entities, username: "BahriMed" },
      { hideUrl: (u) => /t\.me/.test(u) },
    );
    expect(noTg.text).not.toContain("t.me/");
  });

  it("gives a link repeated on one line (icon + label) a single number", () => {
    const text = "6 - Gene expression\n🎙 Lecture | 📔 Sheet";
    const link = (needle: string, url: string) => ({
      type: "text_link" as const,
      offset: text.indexOf(needle),
      length: needle.length,
      url,
    });
    const r = renderIndex({
      text,
      entities: [
        link("🎙", "https://t.me/BahriMed/230"),
        link(" Lecture", "https://t.me/BahriMed/230"),
        link("📔 Sheet", "https://t.me/BahriMed/104"),
      ],
      username: "BahriMed",
    });
    expect(r.text).toBe("6 - Gene expression\n🎙【1】 Lecture | 📔 Sheet【2】");
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]).toMatchObject({ kind: "lecture", ord: 6 });
  });
});

describe("parseSelection", () => {
  it("parses numbers, ranges and lists (Arabic-Indic digits work too)", () => {
    expect(parseSelection("5")).toEqual({ kind: "numbers", nums: [5] });
    expect(parseSelection("1-5")).toEqual({ kind: "numbers", nums: [1, 2, 3, 4, 5] });
    expect(parseSelection("١ to ٣")).toEqual({ kind: "numbers", nums: [1, 2, 3] });
    expect(parseSelection("from 2 to 4")).toEqual({ kind: "numbers", nums: [2, 3, 4] });
    expect(parseSelection("1,3,5-6")).toEqual({ kind: "numbers", nums: [1, 3, 5, 6] });
    expect(parseSelection("1 and 3")).toEqual({ kind: "numbers", nums: [1, 3] });
    expect(parseSelection("5-3")).toEqual({ kind: "numbers", nums: [3, 4, 5] });
  });
  it("parses typed batches", () => {
    expect(parseSelection("sheet 1-5")).toEqual({
      kind: "typed",
      type: "sheet",
      nums: [1, 2, 3, 4, 5],
    });
    expect(parseSelection("sheets from 1 to 5")).toEqual({
      kind: "typed",
      type: "sheet",
      nums: [1, 2, 3, 4, 5],
    });
    expect(parseSelection("lecture 2")).toEqual({ kind: "typed", type: "lecture", nums: [2] });
    expect(parseSelection("lec 3-4")).toEqual({ kind: "typed", type: "lecture", nums: [3, 4] });
    expect(parseSelection("all sheets")).toEqual({ kind: "typed", type: "sheet", nums: null });
    expect(parseSelection("all mcq")).toEqual({ kind: "typed", type: "mcq", nums: null });
  });
  it("leaves ordinary text for search", () => {
    expect(parseSelection("chemistry sheet")).toBeNull();
    expect(parseSelection("sheet")).toBeNull();
    expect(parseSelection("sheet chemistry 1")).toBeNull();
    expect(parseSelection("hello")).toBeNull();
    expect(parseSelection("1-1000000")).toBeNull();
  });
});

describe("resolveTyped", () => {
  it("picks the main section first and only falls back to Lab/Notes when it has none", () => {
    const r = index(5);
    const sheets = resolveTyped(r.entries, { kind: "typed", type: "sheet", nums: [1, 2, 3] });
    expect(sheets.map((e) => e.ord)).toEqual([1, 2, 3]);
    expect(sheets.every((e) => e.block === 1)).toBe(true);
    const all = resolveTyped(r.entries, { kind: "typed", type: "lecture", nums: null });
    expect(all).toHaveLength(11);
    expect(resolveTyped(r.entries, { kind: "typed", type: "sheet", nums: [99] })).toEqual([]);
  });
  it("works on indexes where sheets/lectures have a different layout", () => {
    const r = index(296); // Biomolecules: lectures 01..08 with Sheet | Audio | MCQs
    expect(
      resolveTyped(r.entries, { kind: "typed", type: "sheet", nums: [2, 3] }).map((e) => e.ord),
    ).toEqual([2, 3]);
  });
});

describe("text helpers", () => {
  it("chunks long text on line boundaries", () => {
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const parts = chunkText(text, 1000);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join("\n")).toBe(text);
  });
  it("cleans captions of navigation lines and hashtags", () => {
    const c = cleanCaption(
      "📔 Sheet 3\nThe stem cell\n\n↩️ Return to Cell Biology Index\n#Cell_Biology #Sheet",
    );
    expect(c).toBe("📔 Sheet 3\nThe stem cell");
  });
});
