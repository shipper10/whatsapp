import { describe, expect, it } from "vitest";
import { MissingParticipantError, sessionKeyFor } from "../src/core/session/key.js";
import type { IncomingMessage } from "../src/providers/whatsapp/types.js";

const base: IncomingMessage = {
  provider: "openwa",
  conversationId: "123@g.us",
  participantId: "111@c.us",
  isGroup: true,
  messageId: "m1",
  text: "hi",
  timestamp: 1,
  fromMe: false,
  mentionedIds: [],
};

describe("sessionKeyFor", () => {
  it("separates two participants in the same group", () => {
    const a = sessionKeyFor(base);
    const b = sessionKeyFor({ ...base, participantId: "222@c.us" });
    expect(a).not.toEqual(b);
    expect(a.conversationId).toBe(b.conversationId);
  });
  it("refuses group messages without a real participant", () => {
    expect(() => sessionKeyFor({ ...base, participantId: "" })).toThrow(MissingParticipantError);
    expect(() => sessionKeyFor({ ...base, participantId: "123@g.us" })).toThrow(
      MissingParticipantError,
    );
  });
});
