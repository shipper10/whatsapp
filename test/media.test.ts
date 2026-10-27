import { describe, expect, it } from "vitest";
import { withExtension } from "../src/delivery/fetchers.js";
import { planMedia } from "../src/providers/whatsapp/baileys/media.js";

const plan = (fileName: string, sizeBytes = 1000, mimeType?: string) =>
  planMedia({ filePath: `/tmp/x/${fileName}`, fileName, mimeType, sizeBytes, caption: "cap" });

describe("planMedia", () => {
  it("sends opus/ogg/mp3/m4a as audio messages with a type WhatsApp accepts, caption as follow-up text", () => {
    const p = plan("lecture.opus", 5_000_000, "application/octet-stream");
    expect(p.kind).toBe("audio");
    expect(p.content).toMatchObject({
      audio: { url: "/tmp/x/lecture.opus" },
      mimetype: "audio/ogg; codecs=opus",
      ptt: false,
    });
    expect(p.followUpText).toBe("cap");
    expect(plan("a.mp3").content).toMatchObject({ mimetype: "audio/mpeg" });
    expect(plan("a.m4a").content).toMatchObject({ mimetype: "audio/mp4" });
  });
  it("sends mp4 as video and jpg/png as image, each with its caption", () => {
    expect(plan("v.mp4").content).toMatchObject({
      video: { url: "/tmp/x/v.mp4" },
      mimetype: "video/mp4",
      caption: "cap",
    });
    expect(plan("p.JPG").content).toMatchObject({
      image: { url: "/tmp/x/p.JPG" },
      mimetype: "image/jpeg",
      caption: "cap",
    });
  });
  it("falls back to a document with the right type when the file is too big for an inline kind", () => {
    const big = plan("lecture.opus", 40 * 1024 * 1024);
    expect(big.kind).toBe("document");
    expect(big.content).toMatchObject({
      document: { url: "/tmp/x/lecture.opus" },
      mimetype: "audio/ogg",
      fileName: "lecture.opus",
    });
    expect(plan("movie.mp4", 200 * 1024 * 1024).kind).toBe("document");
  });
  it("sends office files and archives as documents with their real MIME type, not Telegram's guess", () => {
    expect(plan("Sheet.pdf", 1000, "application/octet-stream").content).toMatchObject({
      mimetype: "application/pdf",
      fileName: "Sheet.pdf",
    });
    expect(plan("S.docx").content).toMatchObject({
      mimetype: expect.stringContaining("wordprocessingml"),
    });
    expect(plan("all.zip").content).toMatchObject({ mimetype: "application/zip" });
    expect(plan("notes.xyz", 10, "text/x-weird").content).toMatchObject({
      mimetype: "text/x-weird",
    });
    expect(plan("noext", 10).content).toMatchObject({ mimetype: "application/octet-stream" });
  });
});

describe("withExtension", () => {
  it("adds an extension for nameless voice notes and photos only", () => {
    expect(withExtension("audio-5", "audio/ogg")).toBe("audio-5.ogg");
    expect(withExtension("photo-7", "image/jpeg")).toBe("photo-7.jpg");
    expect(withExtension("Sheet.pdf", "application/pdf")).toBe("Sheet.pdf");
    expect(withExtension("blob", "application/x-unknown")).toBe("blob");
  });
});
