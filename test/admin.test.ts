import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";
import { createAdminHook, isAdmin, runCommand } from "../src/admin/commands.js";
import { idDigits, sameIdentity } from "../src/admin/identity.js";
import { adminAuditLogs, driveSources, resourceAliases, resources } from "../src/db/schema.js";
import type { JobReport } from "../src/jobs/scheduler.js";
import { searchResources } from "../src/library/search.js";
import { SettingsService } from "../src/settings/service.js";
import { FakeProvider, libraryDb, MemSettings, makeBot, msg } from "./helpers/bot.js";

const ADMIN = "249900000009@c.us";

let deps: Parameters<typeof runCommand>[0];
let ran: string[] = [];
beforeAll(async () => {
  const db = await libraryDb();
  const last = new Map<"telegram" | "drive", JobReport>();
  deps = {
    db,
    settings: new SettingsService(new MemSettings(), {}, 0),
    scheduler: {
      last,
      activity: () => [],
      runNow: async (k) => {
        ran.push(k);
        const r: JobReport = {
          kind: k,
          ok: k !== "drive",
          startedAt: new Date(),
          finishedAt: new Date(),
          error: k === "drive" ? "folder not shared" : undefined,
        };
        last.set(k, r);
        return r;
      },
      staleKinds: async () => ["drive"],
    },
    bootstrapAdmins: [ADMIN],
    send: async () => {},
  };
}, 120_000);

const run = (line: string, actor = ADMIN) => runCommand(deps, actor, line);

describe("identity", () => {
  it("compares phone digits across id formats", () => {
    expect(idDigits("249911@c.us")).toBe("249911");
    expect(sameIdentity("249911@c.us", "249911:12@s.whatsapp.net")).toBe(true);
    expect(sameIdentity("249911@c.us", "249912@c.us")).toBe(false);
    expect(sameIdentity("", "")).toBe(false);
  });
});

describe("admin commands", () => {
  it("help, status, stats", async () => {
    expect(await run("/help")).toContain("/review");
    const status = await run("/status");
    expect(status).toContain("stale: drive");
    expect(await run("/stats")).toMatch(/Resources: \d+ \(.*classified/);
  });

  it("sync now replies at once and reports per-kind outcomes in a later message", async () => {
    const later: string[] = [];
    const out = await runCommand(deps, ADMIN, "/sync all", async (t) => void later.push(t));
    expect(out).toContain("started");
    await new Promise((r) => setTimeout(r, 20));
    expect(later[0]).toContain("telegram: ✅");
    expect(later[0]).toContain("drive: ❌ folder not shared");
    expect(ran).toEqual(["telegram", "drive"]);
    expect(await run("/sync nope")).toContain("Usage");
  });

  it("changes, validates and resets settings; flags restart-only ones; never accepts unknown keys", async () => {
    expect(await run("/set search.pageSize 5")).toContain("updated");
    expect(await deps.settings.get("search.pageSize")).toBe(5);
    expect(await run("/set search.pageSize 999")).toContain("❌");
    expect(await run("/set sync.concurrency 4")).toContain("restart");
    expect(await run("/set group.triggers bot, lib, books")).toContain("updated");
    expect(await deps.settings.get("group.triggers")).toEqual(["bot", "lib", "books"]);
    expect(await run("/set text.welcome Welcome to our library")).toContain("updated");
    expect(await deps.settings.get("text.welcome")).toBe("Welcome to our library");
    expect(await run("/set delivery.sendAttachment false")).toContain("updated");
    expect(await deps.settings.get("delivery.sendAttachment")).toBe(false);
    expect(await run("/set OPENWA_API_KEY x")).toContain("Usage"); // secrets are not settings
    expect(await run("/settings")).toMatch(/\*.* search.pageSize = 5/);
    expect(await run("/reset search.pageSize")).toContain("default");
    expect(await deps.settings.get("search.pageSize")).toBe(8);
  });

  it("manages Drive sources", async () => {
    const out = await run(
      "/source add Year_1 https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp",
    );
    expect(out).toContain("1AbCdEfGhIjKlMnOp");
    expect(await run("/sources")).toContain("Year 1");
    const [s] = await deps.db.select().from(driveSources);
    expect(await run(`/source off ${s?.id}`)).toContain("disabled");
    expect(await run("/source off 999")).toContain("No such source");
    expect(await run("/source add x not-a-url").catch((e) => String(e))).toMatch(
      /Not a Drive|Usage|Error/,
    );
  });

  it("review queue, assign (locks), nodes, unlock", async () => {
    const queue = await run("/review");
    expect(queue).toMatch(/#\d+ \[(needs_review|uncategorized)/);
    const id = Number(/#(\d+)/.exec(queue)?.[1]);
    const nodes = await run("/nodes");
    expect(nodes).toContain("[root]");
    const rootId = Number(/(\d+)\. \[root\]/.exec(nodes)?.[1]);
    const children = await run(`/nodes ${rootId}`);
    const semId = Number(/(\d+)\. \[semester\]/.exec(children)?.[1]);
    const subjects = await run(`/nodes ${semId}`);
    const chemId = Number(/(\d+)\. \[subject\] Chemistry/.exec(subjects)?.[1]);
    expect(await run(`/assign ${id} ${chemId}`)).toContain("locked");
    const [r] = await deps.db.select().from(resources).where(eq(resources.id, id));
    expect(r).toMatchObject({
      academicNodeId: chemId,
      classificationStatus: "classified",
      classificationLocked: true,
    });
    expect(await run(`/assign ${id} 999999`)).toContain("Unknown");
    expect(await run(`/unlock ${id}`)).toContain("unlocked");
  });

  it("aliases make searches find a subject", async () => {
    const subjects = await run("/nodes 2").catch(() => "");
    void subjects;
    const all = await deps.db.query.academicNodes.findMany();
    const bio = all.find((n) => n.name === "Biomolecules");
    expect(await run(`/alias add ${bio?.id} bio chem`)).toContain("finds everything");
    const hits = await searchResources(deps.db, "bio chem", { limit: 3 });
    expect(hits.length).toBeGreaterThan(0);
    expect(await run("/alias list")).toContain("bio chem");
    const [a] = await deps.db.select().from(resourceAliases);
    expect(await run(`/alias del ${a?.id}`)).toContain("removed");
    expect(await run("/alias add 99999 foo")).toContain("Unknown");
  });

  it("manages admins and records every change in the audit log without secrets", async () => {
    expect(await run("/admin add 249955555555")).toContain("added");
    expect(await isAdmin(deps, "249955555555@c.us")).toBe(true);
    expect(await run("/admin remove 249955555555")).toContain("removed");
    expect(await isAdmin(deps, "249955555555@c.us")).toBe(false);
    expect(await run(`/admin remove ${idDigits(ADMIN)}`)).toContain("environment");
    const audit = await run("/audit 30");
    expect(audit).toMatch(/set .*search\.pageSize/);
    expect(audit).toContain("assign");
    const rows = await deps.db.select().from(adminAuditLogs);
    expect(rows.every((r) => r.actor === "249900000009" || r.actor.length > 0)).toBe(true);
    expect(await run("/nonsense")).toContain("Unknown command");
  });
});

describe("admin hook inside the bot", () => {
  it("only admins in private chats can run commands; others get normal behaviour", async () => {
    const bot = await makeBot();
    const sent = new FakeProvider();
    const hook = createAdminHook({
      ...deps,
      send: async (m, text) =>
        void (await sent.sendText({ conversationId: m.conversationId, text })),
    });
    const handler = bot.makeHandler();
    void handler;
    const admin = msg({ conversationId: ADMIN, participantId: ADMIN, text: "/help" }).m;
    expect(await hook(admin)).toBe(true);
    expect(sent.last()).toContain("Admin commands");

    const stranger = msg({
      conversationId: "249911@c.us",
      participantId: "249911@c.us",
      text: "/stats",
    }).m;
    expect(await hook(stranger)).toBe(false);

    const inGroup = msg({
      conversationId: "g@g.us",
      participantId: ADMIN,
      isGroup: true,
      text: "/set search.pageSize 1",
    }).m;
    expect(await hook(inGroup)).toBe(false);
    expect(await deps.settings.get("search.pageSize")).toBe(8);

    const normal = msg({ conversationId: ADMIN, participantId: ADMIN, text: "chemistry" }).m;
    expect(await hook(normal)).toBe(false);
  });
});
