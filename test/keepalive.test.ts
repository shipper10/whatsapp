import { describe, expect, it } from "vitest";
import { keepAliveTick } from "../src/jobs/keepalive.js";

const logs: string[] = [];
const logger = { warn: (_: object, m?: string) => void logs.push(m ?? "") };

describe("keepAliveTick", () => {
  it("reads the database and requests its own /healthz", async () => {
    let touched = 0;
    const urls: string[] = [];
    const r = await keepAliveTick({
      url: "https://bot.onrender.com/",
      touchDb: async () => void touched++,
      intervalMinutes: async () => 10,
      logger,
      fetchImpl: (async (u: string) => (urls.push(u), { ok: true })) as never,
    });
    expect(r).toEqual({ db: true, http: true });
    expect(touched).toBe(1);
    expect(urls).toEqual(["https://bot.onrender.com/healthz"]);
  });
  it("without a URL it only touches the database, and failures never throw", async () => {
    expect(
      await keepAliveTick({ touchDb: async () => {}, intervalMinutes: async () => 10, logger }),
    ).toEqual({ db: true, http: null });
    const bad = await keepAliveTick({
      url: "https://x.example",
      touchDb: async () => {
        throw new Error("db down");
      },
      intervalMinutes: async () => 10,
      logger,
      fetchImpl: (async () => {
        throw new Error("net");
      }) as never,
    });
    expect(bad).toEqual({ db: false, http: false });
    expect(logs.join(" ")).toContain("keep-alive");
  });
});
