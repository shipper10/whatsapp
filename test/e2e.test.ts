import { type ChildProcess, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "../src/db/schema.js";
import { classifyAndApply } from "../src/library/apply.js";
import { seedChannel } from "./helpers/pg.js";

const SECRET = "e2e-secret-0123456789";
const sent: { path: string; body: { chatId: string; text: string; quotedMessageId?: string } }[] =
  [];
let app: ChildProcess;
let appPort = 0;
let fake: ReturnType<typeof createServer>;
let sock: PGLiteSocketServer;
let output = "";

const free = () =>
  new Promise<number>((res) => {
    const s = createServer().listen(0, () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });

beforeAll(async () => {
  const pg = new PGlite({ extensions: { pg_trgm } });
  const db = drizzle(pg, { schema });
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
  await migrate(db, { migrationsFolder: "./drizzle" });
  await seedChannel(db as never);
  await classifyAndApply(db as never, "BahriMed");

  const dbPort = await free();
  sock = new PGLiteSocketServer({ db: pg, port: dbPort, host: "127.0.0.1" });
  await sock.start();

  fake = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      sent.push({ path: req.url ?? "", body: JSON.parse(b || "{}") });
      res.writeHead(201, { "content-type": "application/json" }).end('{"messageId":"W1"}');
    });
  });
  await new Promise<void>((r) => fake.listen(0, r));
  appPort = await free();

  app = spawn("npx", ["tsx", "src/index.ts"], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      NODE_ENV: "test",
      DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${dbPort}/postgres`,
      DB_POOL_MAX: "1",
      OPENWA_BASE_URL: `http://127.0.0.1:${(fake.address() as AddressInfo).port}`,
      OPENWA_API_KEY: "k",
      OPENWA_SESSION_ID: "s1",
      OPENWA_WEBHOOK_SECRET: SECRET,
      PORT: String(appPort),
      ENABLE_SCHEDULER: "false",
      ADMIN_IDS: "249900000009@c.us",
      TEMP_FILE_DIR: "./tmp-e2e",
      LOG_LEVEL: "warn",
    },
  });
  app.stdout?.on("data", (d) => (output += d));
  app.stderr?.on("data", (d) => (output += d));
  for (let i = 0; i < 100; i++) {
    const ok = await fetch(`http://127.0.0.1:${appPort}/healthz`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`app did not start:\n${output}`);
}, 120_000);

afterAll(async () => {
  app?.kill("SIGTERM");
  fake?.close();
  await sock?.stop();
});

async function say(text: string, who = "249911111111@c.us", group?: string) {
  const before = sent.length;
  const body = JSON.stringify({
    event: "message.received",
    sessionId: "s1",
    idempotencyKey: `k-${Math.random()}`,
    data: {
      id: `m-${Math.random()}`,
      chatId: group ?? who,
      from: group ?? who,
      author: group ? who : undefined,
      body: text,
      type: "text",
      isGroup: !!group,
      kind: group ? "group" : "individual",
      fromMe: false,
      timestamp: Math.floor(Date.now() / 1000),
    },
  });
  const sig = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  const res = await fetch(`http://127.0.0.1:${appPort}/webhooks/openwa`, {
    method: "POST",
    body,
    headers: { "x-openwa-signature": sig },
  });
  expect(res.status).toBe(200);
  for (let i = 0; i < 100 && sent.length === before; i++)
    await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
  return sent.slice(before);
}

describe("admin over the running app", () => {
  it("admin gets command output in private chat; the same text from a stranger is just a search", async () => {
    const a = await say("/help", "249900000009@c.us");
    expect(a[0]?.body.text).toContain("Admin commands");
    const st = await say("/stats", "249900000009@c.us");
    expect(st[0]?.body.text).toContain("Resources:");
    const s = await say("/stats", "249988888888@c.us");
    expect(s[0]?.body.text).not.toContain("Resources:");
  });
});

describe("full application over HTTP with real Postgres and a fake OpenWA", () => {
  it("rejects unsigned requests", async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/webhooks/openwa`, {
      method: "POST",
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("answers the menu, navigates the channel's own index, and delivers files by number", async () => {
    const home = await say("0");
    expect(home[0]?.path).toBe("/api/sessions/s1/messages/send-text");
    expect(home[0]?.body.text).toContain("Main Index");
    const sem1 = (await say("1")).map((o) => o.body.text).join("\n");
    const chem = /Chemistry\s*【(\d+)】/.exec(sem1)?.[1];
    expect(chem).toBeTruthy();
    await say(chem as string);
    const out = await say("sheet 1-2");
    const links = out.map((o) => o.body.text).join("\n");
    expect(links).toMatch(/https:\/\/t\.me\/BahriMed\/\d+/);
  });

  it("serves two group members independently, quoting each asker, only when addressed", async () => {
    const G = "120363@g.us";
    const a = await say("!", "249922222222@c.us", G);
    expect(a[0]?.body.chatId).toBe(G);
    expect(a[0]?.body.quotedMessageId).toBeTruthy();
    await say("!", "249933333333@c.us", G);
    await say("!1", "249922222222@c.us", G);
    const b = await say("!2", "249933333333@c.us", G);
    expect(b.map((x) => x.body.text).join("\n")).toContain("Biomolecules");
    const silent = await say("hello all", "249944444444@c.us", G).catch(() => []);
    expect(silent).toHaveLength(0);
  });
});
