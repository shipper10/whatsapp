import { describe, expect, it } from "vitest";
import { SyncScheduler } from "../src/jobs/scheduler.js";

const logger = { info: () => {}, warn: () => {}, error: () => {} };
const mk = (over: Partial<ConstructorParameters<typeof SyncScheduler>[0]["run"]> = {}) => {
  const calls: string[] = [];
  const sched = new SyncScheduler({
    logger,
    intervalMinutes: async () => 10,
    run: {
      telegram: async () => (calls.push("tg"), { n: 1 }),
      drive: async () => (calls.push("drive"), { n: 2 }),
      ...over,
    },
    classify: async () => (calls.push("classify"), { ok: true }),
  });
  return { sched, calls };
};

describe("SyncScheduler", () => {
  it("runs the sync then classification and records the report", async () => {
    const { sched, calls } = mk();
    const r = await sched.runNow("telegram");
    expect(r).toMatchObject({ ok: true, summary: { n: 1 }, classified: { ok: true } });
    expect(calls).toEqual(["tg", "classify"]);
    expect(sched.last.get("telegram")?.ok).toBe(true);
  });

  it("does not overlap a kind with itself: concurrent calls share one run", async () => {
    let n = 0;
    const { sched } = mk({
      drive: async () => (n++, await new Promise((r) => setTimeout(r, 30)), {}),
    });
    await Promise.all([sched.runNow("drive"), sched.runNow("drive"), sched.runNow("drive")]);
    expect(n).toBe(1);
    await sched.runNow("drive");
    expect(n).toBe(2);
  });

  it("records a failure without throwing and without classifying; other kinds still run", async () => {
    const { sched, calls } = mk({
      telegram: async () => {
        throw new Error("boom");
      },
    });
    const bad = await sched.runNow("telegram");
    expect(bad).toMatchObject({ ok: false, error: "boom" });
    expect(calls).not.toContain("classify");
    expect((await sched.runNow("drive")).ok).toBe(true);
  });

  it("flags stale or never-run kinds", async () => {
    let t = new Date("2026-01-01T00:00:00Z");
    const sched = new SyncScheduler({
      logger,
      now: () => t,
      intervalMinutes: async () => 10,
      run: { telegram: async () => ({}), drive: async () => ({}) },
      classify: async () => ({}),
    });
    expect(await sched.staleKinds()).toEqual(["telegram", "drive"]);
    await sched.runNow("telegram");
    await sched.runNow("drive");
    expect(await sched.staleKinds()).toEqual([]);
    t = new Date(t.getTime() + 31 * 60_000);
    expect(await sched.staleKinds()).toEqual(["telegram", "drive"]);
  });

  it("loops and re-reads the interval each cycle, and stops cleanly", async () => {
    const waits: number[] = [];
    let intervals = [1, 5];
    let runs = 0;
    const sched = new SyncScheduler({
      logger,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length > 3) sched.stop();
        await new Promise((r) => setTimeout(r, 1));
      },
      intervalMinutes: async () => intervals.shift() ?? 5,
      run: { telegram: async () => (runs++, {}), drive: async () => ({}) },
      classify: async () => ({}),
    });
    sched.start(0);
    await new Promise((r) => setTimeout(r, 80));
    expect(runs).toBeGreaterThanOrEqual(1);
    expect(waits).toContain(60_000);
    expect(waits).toContain(300_000);
  });
});
