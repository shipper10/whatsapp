import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { OpenWaProvider, parseWebhook, verifySignature } from "../src/providers/whatsapp/openwa.js";

const sign = (body: string, secret: string) =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const env = (data: object, over: object = {}) => ({
  event: "message.received",
  sessionId: "s1",
  idempotencyKey: "k1",
  data: {
    id: "A1",
    chatId: "249911@c.us",
    from: "249911@c.us",
    body: "hello",
    type: "text",
    isGroup: false,
    kind: "individual",
    fromMe: false,
    timestamp: 1,
    ...data,
  },
  ...over,
});

describe("verifySignature", () => {
  it("accepts only the exact HMAC", () => {
    const body = '{"a":1}';
    expect(verifySignature(body, sign(body, "secret-secret-1234"), "secret-secret-1234")).toBe(
      true,
    );
    expect(verifySignature(body, sign(body, "other"), "secret-secret-1234")).toBe(false);
    expect(
      verifySignature(`${body} `, sign(body, "secret-secret-1234"), "secret-secret-1234"),
    ).toBe(false);
    expect(verifySignature(body, undefined, "secret-secret-1234")).toBe(false);
  });
});

describe("parseWebhook", () => {
  it("private chat: participant is the chat itself", () => {
    const p = parseWebhook(env({}), "s1");
    expect(p?.message).toMatchObject({
      conversationId: "249911@c.us",
      participantId: "249911@c.us",
      isGroup: false,
      text: "hello",
    });
    expect(p?.eventId).toBe("k1");
  });
  it("group: participant is the author, never the group id", () => {
    const p = parseWebhook(
      env({
        chatId: "1203@g.us",
        from: "1203@g.us",
        author: "249922@c.us",
        isGroup: true,
        kind: "group",
      }),
      "s1",
    );
    expect(p?.message).toMatchObject({
      conversationId: "1203@g.us",
      participantId: "249922@c.us",
      isGroup: true,
    });
  });
  it("group with only a resolved phone for a privacy id", () => {
    const p = parseWebhook(
      env({
        chatId: "1203@g.us",
        isGroup: true,
        kind: "group",
        author: undefined,
        senderPhone: "249933",
      }),
      "s1",
    );
    expect(p?.message.participantId).toBe("249933@c.us");
  });
  it("group without any sender id yields an empty participant (session layer will refuse)", () => {
    const p = parseWebhook(env({ chatId: "1203@g.us", isGroup: true, kind: "group" }), "s1");
    expect(p?.message.participantId).toBe("");
  });
  it("ignores own messages, other events, other sessions, status, media-only and empty text", () => {
    expect(parseWebhook(env({ fromMe: true }), "s1")).toBeNull();
    expect(parseWebhook(env({}, { event: "message.sent" }), "s1")).toBeNull();
    expect(parseWebhook(env({}), "other")).toBeNull();
    expect(parseWebhook(env({ isStatusBroadcast: true }), "s1")).toBeNull();
    expect(parseWebhook(env({ kind: "status" }), "s1")).toBeNull();
    expect(parseWebhook(env({ type: "image" }), "s1")).toBeNull();
    expect(parseWebhook(env({ body: "   " }), "s1")).toBeNull();
    expect(parseWebhook(null, "s1")).toBeNull();
  });
});

describe("OpenWaProvider", () => {
  const mk = (fetchImpl: typeof fetch) =>
    new OpenWaProvider({ baseUrl: "http://x:1/", apiKey: "k", sessionId: "s1", fetchImpl });
  it("confirms only after an ok response and sends quote + api key", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const p = mk((async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ messageId: "W1" }), { status: 201 });
    }) as never);
    const r = await p.sendText({ conversationId: "1@g.us", text: "hi", quoteMessageId: "Q1" });
    expect(r).toEqual({ confirmed: true, providerMessageId: "W1" });
    expect(seen?.url).toBe("http://x:1/api/sessions/s1/messages/send-text");
    expect(JSON.parse(String(seen?.init.body))).toEqual({
      chatId: "1@g.us",
      text: "hi",
      quotedMessageId: "Q1",
    });
    expect((seen?.init.headers as Record<string, string>)["x-api-key"]).toBe("k");
  });
  it("retries 5xx with the same idempotency key, then reports unconfirmed", async () => {
    const keys: string[] = [];
    const p = mk((async (_u: string, init: RequestInit) => {
      keys.push((init.headers as Record<string, string>)["idempotency-key"] ?? "");
      return new Response("", { status: 503 });
    }) as never);
    const r = await p.sendText({ conversationId: "1@c.us", text: "x" });
    expect(r).toEqual({ confirmed: false, error: "HTTP 503" });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
  });
  it("does not retry client errors and survives network failures", async () => {
    let calls = 0;
    const bad = mk((async () => (calls++, new Response("", { status: 400 }))) as never);
    expect((await bad.sendText({ conversationId: "1@c.us", text: "x" })).confirmed).toBe(false);
    expect(calls).toBe(1);
    const down = mk((async () => {
      throw new TypeError("fetch failed");
    }) as never);
    expect((await down.sendText({ conversationId: "1@c.us", text: "x" })).confirmed).toBe(false);
  });
});
