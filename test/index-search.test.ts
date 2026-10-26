import { describe, expect, it } from "vitest";
import { indexTitle, matchIndexes } from "../src/library/indexSearch.js";

const items = [
  { messageId: 2, title: "College of Medicine - Batch 13 Main" },
  { messageId: 3, title: "1 First Year 1st Semester" },
  { messageId: 4, title: "1 First Year 2nd Semester" },
  { messageId: 6, title: "Chemistry" },
  { messageId: 5, title: "Cell Biology" },
  { messageId: 7, title: "Biochemistry Practical" },
  { messageId: 8, title: "Biomolecules" },
  { messageId: 300, title: "Human Biology" },
];
const aliases = [
  "الفصل الاول=1st semester",
  "الفصل الثاني=2nd semester",
  "كيمياء حيوية=biochemistry",
  "كيمياء=chemistry",
  "بيولوجيا بشرية=human biology",
];
const ids = (q: string) => matchIndexes(items, q, aliases).map((x) => x.messageId);

describe("indexTitle", () => {
  it("drops emoji and the word Index, joins two-line headers, stops at the separator", () => {
    expect(indexTitle("🧬 Cell Biology Index\n\n──────────────────\n1 - Cell division")).toBe(
      "Cell Biology",
    );
    expect(indexTitle("1️⃣ First Year\n🗓 2nd Semester Index\n\n──────────────────")).toBe(
      "1 First Year 2nd Semester",
    );
  });
});

describe("matchIndexes", () => {
  it("matches English names, partial words and Arabic aliases", () => {
    expect(ids("chemistry")).toEqual([6]); // the subject itself, not Biochemistry
    expect(ids("كيمياء")).toEqual([6]);
    expect(ids("الكيمياء")).toEqual([6]);
    expect(ids("كيمياء حيوية")).toEqual([7]);
    expect(ids("cell")).toEqual([5]);
    expect(ids("الفصل الثاني")).toEqual([4]);
    expect(ids("بيولوجيا بشرية")).toEqual([300]);
  });
  it("returns several candidates when ambiguous, best first, and nothing for unknown words", () => {
    expect(ids("bio")).toEqual([8, 5, 7, 300]); // shortest (most specific) title first
    expect(ids("semester").sort()).toEqual([3, 4]);
    expect(ids("zzqq")).toEqual([]);
    expect(ids("")).toEqual([]);
  });
});
