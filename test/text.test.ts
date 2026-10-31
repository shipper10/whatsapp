import { describe, expect, it } from "vitest";
import { extractHashtags, normalizeText, toAsciiDigits } from "../src/core/normalize/text.js";

describe("text normalization", () => {
  it("lowercases, strips accents and punctuation, collapses spaces", () => {
    expect(normalizeText("  Cell-Biology: Résumé!! ")).toBe("cell biology resume");
  });
  it("understands Arabic-Indic and Persian digits as numbers", () => {
    expect(toAsciiDigits("١٢٣ ۴۵۶ 789")).toBe("123 456 789");
    expect(normalizeText("Sheet ٣")).toBe("sheet 3");
  });
  it("extracts hashtags without the #", () => {
    expect(extractHashtags("#Cardio_MCQ and #Lec2 #Lec2")).toEqual(["cardio mcq", "lec2"]);
  });
});
