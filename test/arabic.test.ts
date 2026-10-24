import { describe, expect, it } from "vitest";
import { extractHashtags, normalizeText } from "../src/core/normalize/arabic.js";

describe("normalizeText", () => {
  it("unifies alef, ya, ta marbuta and strips tashkeel", () => {
    expect(normalizeText("أَمراض القَلب")).toBe(normalizeText("امراض القلب"));
    expect(normalizeText("مكتبة")).toBe(normalizeText("مكتبه"));
    expect(normalizeText("على")).toBe(normalizeText("علي"));
  });
  it("maps Arabic-Indic digits and punctuation", () => {
    expect(normalizeText("MCQ ١٢_Set-3.pdf")).toBe("mcq 12 set 3 pdf");
  });
});

describe("extractHashtags", () => {
  it("extracts unique normalized hashtags", () => {
    expect(extractHashtags("#Cardio_MCQ و #قلب #cardio_mcq")).toEqual(["cardio mcq", "قلب"]);
  });
});
