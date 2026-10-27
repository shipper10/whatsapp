import { describe, expect, it } from "vitest";
import { typeAllowed } from "../src/delivery/typeFilter.js";

describe("typeAllowed", () => {
  it("empty list allows everything", () => expect(typeAllowed(null, "a.x", [])).toBe(true));
  it("accepts pdf as a plain word, extension or MIME", () => {
    for (const f of ["pdf", ".pdf", "application/pdf", "PDF"]) {
      expect(typeAllowed("application/pdf", "a.pdf", [f])).toBe(true);
      expect(typeAllowed("audio/ogg", "a.opus", [f])).toBe(false);
    }
  });
  it("supports groups and falls back to the extension when the MIME is unknown", () => {
    expect(typeAllowed("audio/ogg", "a.opus", ["pdf", "audio"])).toBe(true);
    expect(typeAllowed(null, "a.pdf", ["pdf"])).toBe(true);
    expect(typeAllowed("video/mp4", "v.mp4", ["image"])).toBe(false);
    expect(typeAllowed("audio/mpeg", "a.mp3", ["audio/*"])).toBe(true);
  });
});

describe("word aliases", () => {
  it("doc/docs/word cover doc and docx", () => {
    expect(typeAllowed(null, "a.docx", ["docs"])).toBe(true);
    expect(typeAllowed(null, "a.doc", ["word"])).toBe(true);
    expect(typeAllowed(null, "a.pptx", ["docs"])).toBe(false);
  });
});
