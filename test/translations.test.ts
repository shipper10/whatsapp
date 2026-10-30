import { describe, expect, it } from "vitest";
import { normalizeText } from "../src/core/normalize/arabic.js";
import {
  expandQuery,
  formatPairs,
  parsePairs,
  removePair,
  untranslatedWords,
  upsertPair,
} from "../src/library/translations.js";

const pairs = parsePairs(["كيمياء حيوية=biochemistry", "تشريح=Anatomy", "bad line", "=x", "y="]);

describe("translation dictionary", () => {
  it("parses pairs and ignores malformed lines", () => {
    expect(pairs).toEqual([
      { ar: "كيمياء حيوية", en: "biochemistry" },
      { ar: "تشريح", en: "Anatomy" },
    ]);
    expect(formatPairs(pairs)).toEqual(["كيمياء حيوية=biochemistry", "تشريح=Anatomy"]);
  });

  it("replaces the old translation of the same Arabic word (ignoring 'ال' and spelling variants)", () => {
    const next = upsertPair(pairs, { ar: "التشريح", en: "gross anatomy" });
    expect(next.filter((p) => p.ar.includes("شريح"))).toEqual([
      { ar: "التشريح", en: "gross anatomy" },
    ]);
    expect(upsertPair(pairs, { ar: " ", en: "x" })).toBe(pairs);
    expect(removePair(pairs, "تشريح")).toHaveLength(1);
  });

  it("expands a query in both directions", () => {
    expect(expandQuery("كيمياء حيوية", pairs)).toContain("biochemistry");
    expect(expandQuery("Biochemistry notes", pairs)).toContain(
      `${normalizeText("كيمياء حيوية")} notes`,
    );
    expect(expandQuery("physics", pairs)).toEqual(["physics"]);
    expect(expandQuery("   ", pairs)).toEqual([]);
  });

  it("lists English title words that have no Arabic equivalent, most frequent first", () => {
    const titles = ["Biochemistry Index", "Histology 1st Semester", "Histology Lab", "Embryology"];
    const out = untranslatedWords(titles, pairs);
    expect(out.map((o) => o.word)).toEqual(["histology", "embryology", "lab"]);
    expect(out[0]?.n).toBe(2);
  });
});
