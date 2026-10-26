import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createAppServer } from "../src/http/server.js";
import type { IncomingMessage } from "../src/providers/whatsapp/types.js";

const SECRET = "0123456789abcdef";
const body = JSON.stringify({
  event: "message.received",
  sessionId: "s1",
  idempotencyKey: "k9",
  data: { id: "A", chatId: "1@c.us", body: "hi", type: "text", fromMe: false, timestamp: 1 },
});
const sig = (b: string) => `sha256=${createHmac("sha256", SECRET).update(b).digest("hex")}`;

let servers: ReturnType<typeof createAppServer>[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

async function start() {
  const got: { id: string; msg: IncomingMessage }[] = [];
  const server = createAppServer({
    webhook: {
      secret: SECRET,
      sessionId: "s1",
      onMessage: async (id, msg) => void got.push({ id, msg }),
    },
    health: async () => true,
    logger: { warn: () => {}, error: () => {} },
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, r));
  return { got, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

describe("http server", () => {
  it("rejects bad signatures and bad json, accepts valid webhooks", async () => {
    const { got, url } = await start();
    const post = (b: string, s?: string) =>
      fetch(`${url}/webhooks/openwa`, {
        method: "POST",
        body: b,
        headers: s ? { "x-openwa-signature": s } : {},
      });
    expect((await post(body)).status).toBe(401);
    expect((await post(body, "sha256=00")).status).toBe(401);
    expect((await post("{bad", sig("{bad"))).status).toBe(400);
    expect((await post(body, sig(body))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(got).toHaveLength(1);
    expect(got[0]?.id).toBe("k9");
    expect(got[0]?.msg.text).toBe("hi");
  });
  it("serves health and 404", async () => {
    const { url } = await start();
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
    expect((await fetch(`${url}/nope`)).status).toBe(404);
  });
  it("rejects oversized bodies", async () => {
    const { url } = await start();
    const res = await fetch(`${url}/webhooks/openwa`, {
      method: "POST",
      body: "x".repeat(1_100_000),
      headers: { "x-openwa-signature": "sha256=0" },
    }).catch(() => null);
    expect(res === null || res.status === 413).toBe(true);
  });
});

describe("lite-mode link admin", () => {
  async function startLink(state: { state: string; qr?: string }) {
    const server = createAppServer({
      link: {
        token: "t".repeat(20),
        status: () => state,
        pairingCode: async (p) =>
          p === "249912345678" ? "ABCD-1234" : Promise.reject(new Error("already linked")),
      },
      health: async () => true,
      logger: { warn: () => {}, error: () => {} },
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("requires the token, never serves the webhook, renders a QR", async () => {
    const url = await startLink({ state: "qr", qr: "2@abc,def,ghi" });
    expect((await fetch(`${url}/admin/link`)).status).toBe(401);
    expect((await fetch(`${url}/admin/link?token=wrong`)).status).toBe(401);
    const ok = await fetch(`${url}/admin/link?token=${"t".repeat(20)}`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toContain("<svg");
    expect((await fetch(`${url}/webhooks/openwa`, { method: "POST", body: "{}" })).status).toBe(
      404,
    );
    expect((await fetch(`${url}/healthz`)).status).toBe(200);
  });

  it("issues pairing codes with Bearer auth and validates the phone", async () => {
    const url = await startLink({ state: "qr", qr: "x" });
    const h = { authorization: `Bearer ${"t".repeat(20)}` };
    const good = await fetch(`${url}/admin/link/pair?phone=249912345678`, { headers: h });
    expect(await good.text()).toContain("ABCD-1234");
    expect((await fetch(`${url}/admin/link/pair?phone=abc`, { headers: h })).status).toBe(400);
    expect((await fetch(`${url}/admin/link/pair?phone=249900000000`, { headers: h })).status).toBe(
      409,
    );
  });
});
