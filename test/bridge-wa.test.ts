import { readFile, rm } from "node:fs/promises";
import type { WAMessage } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { whatsappToBridge } from "../src/bridge/whatsappEndpoint.js";

const base = (message: object, extra: object = {}): WAMessage =>
  ({
    key: {
      remoteJid: "g1@g.us",
      id: "ABC123",
      participant: "249111@s.whatsapp.net",
      fromMe: false,
    },
    pushName: "Sara",
    messageTimestamp: 1700000000,
    message,
    ...extra,
  }) as unknown as WAMessage;

const conv = (m: WAMessage) =>
  whatsappToBridge(
    m,
    () => "Group",
    async () => Buffer.from("FILEDATA"),
    () => "Sara Saved",
  );

describe("WhatsApp -> bridge mapping", () => {
  it.each([
    ["imageMessage", { imageMessage: { mimetype: "image/jpeg", caption: "cap" } }, "image", "jpg"],
    ["videoMessage", { videoMessage: { mimetype: "video/mp4" } }, "video", "mp4"],
    ["voice", { audioMessage: { mimetype: "audio/ogg; codecs=opus", ptt: true } }, "voice", "ogg"],
    ["audio", { audioMessage: { mimetype: "audio/mpeg" } }, "audio", "mp3"],
    [
      "document",
      { documentMessage: { mimetype: "application/pdf", fileName: "a.pdf" } },
      "document",
      "pdf",
    ],
    ["sticker", { stickerMessage: { mimetype: "image/webp" } }, "sticker", "webp"],
    [
      "view once",
      { viewOnceMessageV2: { message: { imageMessage: { mimetype: "image/jpeg" } } } },
      "image",
      "jpg",
    ],
  ])("%s", async (_n, content, type, ext) => {
    const m = conv(base(content));
    expect(m?.type).toBe(type);
    expect(m?.savedName).toBe("Sara Saved");
    expect(m?.senderPhone).toBe("249111");
    const path = await m?.downloadMedia?.("./tmp/test-bridge-wa");
    expect(path?.endsWith(`.${ext}`)).toBe(true);
    expect((await readFile(path as string)).toString()).toBe("FILEDATA");
    await rm("./tmp/test-bridge-wa", { recursive: true, force: true });
  });

  it("maps location, contact and poll without media", () => {
    expect(
      conv(base({ locationMessage: { degreesLatitude: 1, degreesLongitude: 2 } }))?.location,
    ).toEqual({ lat: 1, lng: 2, name: undefined });
    expect(
      conv(base({ contactMessage: { displayName: "Ali", vcard: "TEL;waid=249123:+249" } }))
        ?.contact,
    ).toEqual({ name: "Ali", phone: "249123" });
    expect(
      conv(base({ pollCreationMessage: { name: "Q", options: [{ optionName: "a" }] } }))?.poll
        ?.options,
    ).toEqual(["a"]);
  });
});
