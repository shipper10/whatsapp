import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createPanel } from "../src/http/panel.js";
import type { Overview } from "../src/http/panelData.js";
import { createAppServer } from "../src/http/server.js";

const TOKEN = "panel-token-0123456789";
let servers: ReturnType<typeof createAppServer>[] = [];
afterEach(() => {
  for (const s of servers) s.close();
  servers = [];
});

const overview: Overview = {
  whatsapp: "Connected",
  syncs: [{ kind: "telegram", ok: false, at: new Date(), error: "boom <b>x</b>" }],
  load: { running: 1, queued: 2, inflightMb: 3, cached: 4, rssMb: 120, freeDiskMb: 900 },
  counts: { resources: 10, uncategorized: 1, nodes: 5, subscribers: 2 },
  delivery: [{ outcome: "file_sent", n: 7 }],
  sources: [],
  recentRuns: [],
};

async function start() {
  const server = createAppServer({
    panel: createPanel({
      token: TOKEN,
      logger: { warn: () => {} },
      overview: async () => overview,
    }),
    health: async () => true,
    logger: { warn: () => {}, error: () => {} },
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function login(url: string) {
  const r = await fetch(`${url}/admin/panel/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `token=${TOKEN}`,
    redirect: "manual",
  });
  expect(r.status).toBe(303);
  return (r.headers.get("set-cookie") ?? "").split(";")[0] as string;
}

describe("admin panel", () => {
  it("asks for the token, rejects a wrong one, then shows the overview with escaped content", async () => {
    const url = await start();
    expect((await fetch(`${url}/admin/panel`)).status).toBe(401);
    const bad = await fetch(`${url}/admin/panel/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "token=nope",
    });
    expect(bad.status).toBe(401);
    const cookie = await login(url);
    const page = await (await fetch(`${url}/admin/panel`, { headers: { cookie } })).text();
    expect(page).toContain("Overview");
    expect(page).toContain("120 MB");
    expect(page).not.toContain("<b>x</b>");
    expect(page).toContain("&#60;b&#62;x&#60;/b&#62;");
  });

  it("a link with ?token= signs in and strips the token from the address", async () => {
    const url = await start();
    const r = await fetch(`${url}/admin/panel?token=${TOKEN}`, { redirect: "manual" });
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toBe("/admin/panel");
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("rejects a forged session cookie and unknown pages", async () => {
    const url = await start();
    expect((await fetch(`${url}/admin/panel`, { headers: { cookie: "bp=wrong" } })).status).toBe(
      401,
    );
    const cookie = await login(url);
    expect((await fetch(`${url}/admin/panel/nope`, { headers: { cookie } })).status).toBe(404);
  });
});
