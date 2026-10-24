import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { fromExport } from "../src/telegram/exportAdapter.js";
import { parseMessage } from "../src/telegram/parse.js";

const fixture = JSON.parse(readFileSync("test/fixtures/channel-sample.json", "utf8"));
const ctx = { chatId: 3448452098n, username: "BahriMed" };
const byId = (id: number) => {
  const raw = fromExport(fixture.messages.find((m: { id: number }) => m.id === id));
  if (!raw) throw new Error(`fixture ${id} missing`);
  return parseMessage(raw, ctx);
};

describe("parseMessage on real channel structure", () => {
  it("skips service messages", () => {
    expect(fromExport(fixture.messages.find((m: { id: number }) => m.id === 1))).toBeNull();
  });
  it("recognises the main index and its internal links", () => {
    const r = byId(2);
    expect(r.isIndex).toBe(true);
    expect(r.internalLinkIds).toEqual(expect.arrayContaining([3, 4]));
    expect(r.permalink).toBe("https://t.me/BahriMed/2");
  });
  it("recognises a semester index", () => {
    const r = byId(3);
    expect(r.isIndex).toBe(true);
    expect(r.internalLinkIds).toEqual(expect.arrayContaining([5, 6, 7]));
  });
  it("extracts file metadata, hashtags and the return-to-index link", () => {
    const r = byId(59);
    expect(r.mediaType).toBe("document");
    expect(r.fileName).toBe("11 - مهارات التفوق الدراسي.pdf");
    expect(r.mimeType).toBe("application/pdf");
    expect(r.fileSizeBytes).toBe(5990373);
    expect(r.hashtags).toEqual(expect.arrayContaining(["university study skills", "sheet"]));
    expect(r.returnIndexId).toBe(11);
    expect(r.isIndex).toBe(false);
  });
  it("is deterministic (idempotent input -> identical record)", () => {
    expect(byId(160)).toEqual(byId(160));
  });
  it("maps audio and video kinds", () => {
    const kinds = fixture.messages
      .map((m: never) => fromExport(m))
      .filter(Boolean)
      .map((r: { media?: { kind: string } }) => r.media?.kind);
    expect(kinds).toEqual(expect.arrayContaining(["audio", "video"]));
  });
});
