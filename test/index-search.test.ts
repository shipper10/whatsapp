import { describe, expect, it } from "vitest";
import { indexTitle } from "../src/library/indexSearch.js";

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
