import { describe, expect, it } from "vitest";
import { DbPrefs } from "../src/bot/prefs.js";
import { resources, subscriptions } from "../src/db/schema.js";
import { SyncAlerts } from "../src/jobs/alerts.js";
import type { JobReport } from "../src/jobs/scheduler.js";
import { sendNewFilesDigest } from "../src/notify/digest.js";
import { SettingsService } from "../src/settings/service.js";
import { FakeProvider, MemSettings } from "./helpers/bot.js";
import { createTestDb } from "./helpers/pg.js";

const rep = (ok: boolean, error?: string, kind: "telegram" | "drive" = "telegram"): JobReport => ({
  kind,
  ok,
  startedAt: new Date(),
  finishedAt: new Date(),
  error,
});

describe("SyncAlerts", () => {
  const make = (threshold = 3) => {
    const sent: string[] = [];
    const a = new SyncAlerts({
      threshold: async () => threshold,
      notifyAdmins: async (t) => void sent.push(t),
    });
    return { a, sent };
  };

  it("alerts once after N failures in a row and says when it recovers", async () => {
    const { a, sent } = make();
    await a.onReport(rep(false, "boom"));
    await a.onReport(rep(false, "boom"));
    expect(sent).toHaveLength(0);
    await a.onReport(rep(false, "boom"));
    await a.onReport(rep(false, "boom"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("3 مرات");
    await a.onReport(rep(true));
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain("عادت");
  });

  it("a success resets the count; threshold 0 disables", async () => {
    const { a, sent } = make();
    await a.onReport(rep(false, "x"));
    await a.onReport(rep(false, "x"));
    await a.onReport(rep(true));
    await a.onReport(rep(false, "x"));
    expect(sent).toHaveLength(0);
    const off = make(0);
    for (let i = 0; i < 5; i++) await off.a.onReport(rep(false, "x"));
    expect(off.sent).toHaveLength(0);
  });

  it("calls out a revoked Telegram login immediately", async () => {
    const { a, sent } = make();
    await a.onReport(rep(false, "AUTH_KEY_UNREGISTERED"));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("انتهت جلسة تيليجرام");
  });
});

describe("new-files notices", () => {
  async function setup(settings: Record<string, unknown> = {}) {
    const db = await createTestDb();
    const store = new MemSettings();
    Object.assign(store.data, { "notify.minIntervalHours": 0, ...settings });
    const provider = new FakeProvider();
    let nowMs = Date.parse("2026-10-31T10:00:00Z");
    const deps = {
      db,
      provider,
      settings: new SettingsService(store, {}, 0),
      prefs: new DbPrefs(db),
      logger: { info: () => {}, warn: () => {} },
      now: () => new Date(nowMs),
    };
    const addResource = (n: number) =>
      db.insert(resources).values({ resourceKey: `tg:1:${n}`, displayName: `Lecture ${n}` });
    return { db, provider, deps, addResource, advance: (ms: number) => void (nowMs += ms) };
  }

  it("the first run only sets the starting point, then new files are announced once to subscribers", async () => {
    const { db, provider, deps, addResource } = await setup();
    await addResource(1);
    await db.insert(subscriptions).values({ conversationId: "a@c.us" });
    expect(await sendNewFilesDigest(deps)).toEqual({ sent: 0, files: 0 });
    expect(provider.sent).toHaveLength(0);

    await addResource(2);
    await addResource(3);
    expect(await sendNewFilesDigest(deps)).toEqual({ sent: 1, files: 2 });
    expect(provider.sent[0]?.conversationId).toBe("a@c.us");
    expect(provider.sent[0]?.text).toContain("2 ملفات");
    expect(provider.sent[0]?.text).toContain("Lecture 3");

    expect(await sendNewFilesDigest(deps)).toEqual({ sent: 0, files: 0 }); // nothing new
  });

  it("bundles files that arrive inside the minimum interval and respects the recipient cap and the switch", async () => {
    const { db, provider, deps, addResource, advance } = await setup({
      "notify.minIntervalHours": 2,
      "notify.maxRecipients": 1,
    });
    await sendNewFilesDigest(deps); // sets cursor
    await db
      .insert(subscriptions)
      .values([{ conversationId: "a@c.us" }, { conversationId: "b@c.us" }]);
    await addResource(1);
    expect((await sendNewFilesDigest(deps)).sent).toBe(0); // too soon: held back
    advance(3 * 3600_000);
    expect(await sendNewFilesDigest(deps)).toEqual({ sent: 1, files: 1 }); // capped at one chat
    expect(provider.sent).toHaveLength(1);

    const off = await setup({ "notify.enabled": false });
    await off.addResource(1);
    expect(await sendNewFilesDigest(off.deps)).toEqual({ sent: 0, files: 0 });
  });
});
