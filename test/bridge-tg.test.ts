import { Api } from "teleproto";
import { describe, expect, it } from "vitest";
import { TelegramBridgeEndpoint, telegramType } from "../src/bridge/telegramEndpoint.js";
import type { BridgeMessage } from "../src/bridge/types.js";

const photo = () =>
  new Api.MessageMediaPhoto({
    photo: new Api.Photo({
      id: 1 as never,
      accessHash: 1 as never,
      fileReference: Buffer.alloc(1),
      date: 1,
      sizes: [],
      dcId: 2,
    }),
  });

describe("Telegram message mapping", () => {
  it("recognises photos and documents", () => {
    expect(
      telegramType(
        new Api.Message({
          id: 1,
          peerId: new Api.PeerUser({ userId: 1 as never }),
          message: "",
          date: 1,
          media: photo(),
        }),
      ),
    ).toBe("image");
    const doc = new Api.Document({
      id: 1 as never,
      accessHash: 1 as never,
      fileReference: Buffer.alloc(1),
      date: 1,
      mimeType: "video/mp4",
      size: 1 as never,
      dcId: 2,
      attributes: [new Api.DocumentAttributeVideo({ duration: 1, w: 1, h: 1 })],
    });
    expect(
      telegramType(
        new Api.Message({
          id: 2,
          peerId: new Api.PeerUser({ userId: 1 as never }),
          message: "",
          date: 1,
          media: new Api.MessageMediaDocument({ document: doc }),
        }),
      ),
    ).toBe("video");
  });

  it("builds a media BridgeMessage from an incoming photo", async () => {
    const got: BridgeMessage[] = [];
    const ep = new TelegramBridgeEndpoint(
      { apiId: 1, apiHash: "x", sessionString: "" },
      { info() {}, warn() {}, error() {} },
      async (m) => void got.push(m),
    );
    (ep as unknown as { client: unknown }).client = {};
    const m = new Api.Message({
      id: 7,
      peerId: new Api.PeerChat({ chatId: 5 as never }),
      message: "hi",
      date: 1,
      media: photo(),
      out: false,
    });
    Object.assign(m, {
      getChat: async () => ({ title: "G" }),
      getSender: async () => ({ firstName: "Ali", lastName: "K" }),
    });
    await (ep as unknown as { handle(e: unknown): Promise<void> }).handle({ message: m });
    expect(got[0]?.type).toBe("image");
    expect(got[0]?.text).toBe("hi");
    expect(typeof got[0]?.downloadMedia).toBe("function");
  });
});
