import { describe, expect, it } from "vitest";
import {
  canonWord,
  editDistance,
  rank,
  scoreTitle,
  wordScore,
  words,
} from "../src/library/fuzzy.js";
import { matchIndexes } from "../src/library/indexSearch.js";

describe("canonWord", () => {
  it("ignores case, accents, plurals and spells ordinals the same way", () => {
    expect(canonWord("Sheets")).toBe("sheet");
    expect(canonWord("Physics")).toBe(canonWord("physic"));
    expect(canonWord("2nd")).toBe("2");
    expect(canonWord("Second")).toBe("2");
    expect(canonWord("٢")).toBe("2");
    expect(canonWord("Café")).toBe("cafe");
    expect(words("1st Semester!")).toEqual(["1", "semester"]);
  });
});

describe("editDistance", () => {
  it("counts a missing, extra, wrong and swapped letter as one", () => {
    expect(editDistance("anatomy", "anatomy")).toBe(0);
    expect(editDistance("anatmy", "anatomy")).toBe(1);
    expect(editDistance("anatomyy", "anatomy")).toBe(1);
    expect(editDistance("anatamy", "anatomy")).toBe(1);
    expect(editDistance("anatomy", "anotamy")).toBe(2);
    expect(editDistance("abcdef", "uvwxyz", 2)).toBeGreaterThan(2);
  });
});

describe("wordScore", () => {
  it("ranks exact > beginning > typo > inside, and never matches different numbers", () => {
    const exact = wordScore("cell", "cell");
    const start = wordScore("bio", "biology");
    const typo = wordScore("biologi", "biology");
    const inside = wordScore("chem", "biochemistry");
    expect(exact).toBe(1);
    expect(exact).toBeGreaterThan(start);
    expect(start).toBeGreaterThan(inside);
    expect(typo).toBeGreaterThan(0.7);
    expect(wordScore("1", "13")).toBe(0);
    expect(wordScore("2", "2")).toBe(1);
  });
  it("allows no typos in very short words", () => {
    expect(wordScore("cel", "cat")).toBe(0);
    expect(wordScore("abc", "abd")).toBe(0);
  });
});

describe("scoreTitle", () => {
  it("needs every typed word to match a different title word", () => {
    expect(scoreTitle(["cell", "biology"], "Cell Biology")).toBeGreaterThan(0.95);
    expect(scoreTitle(["cell", "cell"], "Cell Biology")).toBe(0);
    expect(scoreTitle(["zebra"], "Cell Biology")).toBe(0);
  });
  it("understands words typed together and initials", () => {
    expect(scoreTitle(["cellbiology"], "Cell Biology")).toBeGreaterThan(0.8);
    expect(scoreTitle(["cb"], "Cell Biology")).toBeGreaterThan(0.8);
    expect(scoreTitle(["cb"], "Cell")).toBe(0);
  });
});

const items = [
  { messageId: 2, title: "College of Medicine - Batch 13 Main" },
  { messageId: 3, title: "1 First Year 1st Semester" },
  { messageId: 4, title: "1 First Year 2nd Semester" },
  { messageId: 6, title: "Chemistry" },
  { messageId: 5, title: "Cell Biology" },
  { messageId: 7, title: "Biochemistry Practical" },
  { messageId: 8, title: "Biomolecules" },
  { messageId: 300, title: "Human Biology" },
  { messageId: 9, title: "Anatomy" },
  { messageId: 10, title: "Medical Terminology" },
];
const ids = (q: string) => matchIndexes(items, q).map((x) => x.messageId);

describe("matchIndexes", () => {
  it("is not bothered by letter case or extra spaces", () => {
    expect(ids("CHEMISTRY")[0]).toBe(6);
    expect(ids("  cElL   bIoLoGy ")).toEqual([5]);
  });
  it("finds an index from its first letters", () => {
    expect(ids("anat")[0]).toBe(9);
    expect(ids("term")[0]).toBe(10);
    expect(ids("c")).toContain(6);
  });
  it("forgives typos and missing or extra letters", () => {
    expect(ids("chemstry")[0]).toBe(6);
    expect(ids("anatmy")[0]).toBe(9);
    expect(ids("anatomi")[0]).toBe(9);
    expect(ids("biolgy")).toContain(5);
    expect(ids("medicl terminology")[0]).toBe(10);
    expect(ids("termnology")[0]).toBe(10);
  });
  it("understands ordinals and digits typed either way", () => {
    expect(ids("second semester")).toEqual([4]);
    expect(ids("2nd semester")).toEqual([4]);
    expect(ids("semester 2")).toEqual([4]);
    expect(ids("year 1 sem ٢")[0]).toBe(4);
    expect(ids("batch 13")).toEqual([2]);
    expect(ids("batch 1")).toEqual([]);
  });
  it("ignores filler words like 'index' and 'subject'", () => {
    expect(ids("chemistry index")[0]).toBe(6);
    expect(ids("subject anatomy")).toEqual([9]);
  });
  it("matches words typed together or as initials", () => {
    expect(ids("cellbiology")[0]).toBe(5);
    expect(ids("hb")[0]).toBe(300);
    expect(ids("mt")[0]).toBe(10);
  });
  it("ranks the exact subject above names that merely contain it, and short titles first", () => {
    expect(ids("chemistry")[0]).toBe(6);
    expect(matchIndexes(items, "chemistry")[1]?.score ?? 0).toBeLessThan(0.75); // Biochemistry only contains it
    expect(ids("chem")[0]).toBe(6);
    expect(ids("bio")).toEqual(expect.arrayContaining([8, 5, 7, 300]));
  });
  it("returns nothing for unknown words and empty input", () => {
    expect(ids("zzqq")).toEqual([]);
    expect(ids("")).toEqual([]);
    expect(ids("index")).toEqual([]);
  });
  it("reports a score so callers can tell a sure match from a guess", () => {
    const exact = matchIndexes(items, "chemistry")[0]?.score ?? 0;
    const guess = matchIndexes(items, "chemstry")[0]?.score ?? 0;
    expect(exact).toBeGreaterThan(0.95);
    expect(guess).toBeLessThan(exact);
    expect(guess).toBeGreaterThan(0.55);
  });
});

describe("rank", () => {
  it("is generic: works on any items with a title", () => {
    const r = rank([{ t: "Alpha Beta" }, { t: "Gamma" }], (x) => x.t, "alpa");
    expect(r.map((x) => x.item.t)).toEqual(["Alpha Beta"]);
  });
});
