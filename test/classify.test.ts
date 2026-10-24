import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type DriveRow, planLibrary, type TgRow } from "../src/library/classify.js";
import { fromExport } from "../src/telegram/exportAdapter.js";
import { parseMessage } from "../src/telegram/parse.js";

const fixture = JSON.parse(readFileSync("test/fixtures/channel-full.json", "utf8"));
const ctx = { chatId: 3448452098n, username: "BahriMed" };

function rows(): TgRow[] {
  const out: TgRow[] = [];
  for (const m of fixture.messages) {
    const raw = fromExport(m);
    if (!raw) continue;
    const r = parseMessage(raw, ctx);
    out.push({
      dbId: r.messageId,
      chatId: r.chatId,
      messageId: r.messageId,
      messageDate: r.messageDate,
      text: r.textOrCaption,
      entities: r.entities,
      hashtags: r.hashtags,
      mediaType: r.mediaType,
      fileName: r.fileName,
      fileSizeBytes: r.fileSizeBytes,
      permalink: r.permalink,
      isIndex: r.isIndex,
      returnIndexId: r.returnIndexId,
    });
  }
  return out;
}

describe("planLibrary on the real channel", () => {
  const plan = planLibrary({ username: "BahriMed", telegram: rows(), drive: [] });
  const node = (name: string) => plan.nodes.find((n) => n.name === name);

  it("builds root > semester > subject from the index messages", () => {
    const root = plan.nodes.find((n) => n.type === "root");
    expect(root?.name).toMatch(/Batch 13/);
    const sem1 = plan.nodes.find((n) => n.type === "semester" && /1st Semester/.test(n.name));
    expect(sem1?.name).toMatch(/First Year/);
    expect(sem1?.parentKey).toBe(root?.key);
    const chem = node("Chemistry");
    expect(chem?.type).toBe("subject");
    expect(chem?.parentKey).toBe(sem1?.key);
    expect(node("Biomolecules")?.parentKey).toMatch(/^tg:/);
  });

  it("keeps node keys unique and parents resolvable", () => {
    const keys = plan.nodes.map((n) => n.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const n of plan.nodes) if (n.parentKey) expect(keys).toContain(n.parentKey);
  });

  it("classifies the large majority of files via index links", () => {
    const files = plan.resources;
    const classified = files.filter((r) => r.status === "classified").length;
    expect(files.length).toBeGreaterThan(300);
    expect(classified / files.length).toBeGreaterThan(0.9);
  });

  it("attaches a chemistry sheet to the Chemistry subject with category tags", () => {
    const r = plan.resources.find((x) => x.displayName.includes("Chemical Composition"));
    expect(r?.status).toBe("classified");
    expect(r?.nodeKey).toBe(node("Chemistry")?.key);
    expect(r?.searchText).toContain("chemistry");
    expect(r?.sources[0]).toMatchObject({ type: "telegram", preferred: true });
  });

  it("is deterministic", () => {
    expect(planLibrary({ username: "BahriMed", telegram: rows(), drive: [] })).toEqual(plan);
  });

  it("never assigns a random subject: unresolved items are uncategorized or needs_review", () => {
    for (const r of plan.resources) {
      if (r.status === "classified") expect(r.nodeKey).not.toBeNull();
      if (r.status === "uncategorized") expect(r.nodeKey).toBeNull();
    }
  });
});

describe("Drive matching", () => {
  const tg = rows();
  const sheet = tg.find((r) => r.fileName?.includes("Chemical Composition"));
  if (!sheet?.fileName) throw new Error("fixture changed");
  const d = (over: Partial<DriveRow>): DriveRow => ({
    dbId: 1,
    sourceId: 1,
    driveFileId: "d1",
    name: sheet.fileName ?? "",
    sizeBytes: sheet.fileSizeBytes,
    modifiedTime: null,
    folderPath: "Chemistry",
    webViewLink: "https://drive.google.com/file/d/d1/view",
    ...over,
  });

  it("merges a Drive file into the Telegram resource on a unique name+size match", () => {
    const plan = planLibrary({ username: "BahriMed", telegram: tg, drive: [d({})] });
    const r = plan.resources.find((x) => x.key === `tg:3448452098:${sheet.messageId}`);
    expect(r?.sources.map((s) => s.type)).toEqual(["telegram", "google_drive"]);
    expect(plan.resources.some((x) => x.key.startsWith("drive:"))).toBe(false);
  });

  it("does not merge when sizes differ; standalone resource goes to review via folder name", () => {
    const plan = planLibrary({ username: "BahriMed", telegram: tg, drive: [d({ sizeBytes: 1 })] });
    const standalone = plan.resources.find((x) => x.key.startsWith("drive:"));
    expect(standalone?.sources).toHaveLength(1);
    expect(standalone?.status).toBe("needs_review");
    expect(standalone?.tags).not.toContain("possible-duplicate");
  });

  it("keeps same-named Drive files in different folders as separate resources", () => {
    const plan = planLibrary({
      username: "BahriMed",
      telegram: tg,
      drive: [d({}), d({ dbId: 2, driveFileId: "d2", folderPath: "Other" })],
    });
    expect(plan.resources.filter((x) => x.key.startsWith("drive:"))).toHaveLength(2);
  });

  it("uncategorized when nothing matches", () => {
    const plan = planLibrary({
      username: "BahriMed",
      telegram: [],
      drive: [d({ name: "zzz.pdf", folderPath: "Unknown" })],
    });
    expect(plan.resources[0]).toMatchObject({ status: "uncategorized", nodeKey: null });
  });
});
