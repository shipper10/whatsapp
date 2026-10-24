import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

describe("loadEnv", () => {
  it("fails with an actionable message when required values are missing", () => {
    expect(() => loadEnv({})).toThrow(/DATABASE_URL: is required/);
  });
  it("parses admin ids", () => {
    const env = loadEnv({
      DATABASE_URL: "postgres://x",
      OPENWA_API_KEY: "k",
      OPENWA_SESSION_ID: "s",
      OPENWA_WEBHOOK_SECRET: "0123456789abcdef",
      ADMIN_IDS: "1@c.us, 2@c.us",
    });
    expect(env.ADMIN_IDS).toEqual(["1@c.us", "2@c.us"]);
  });
});
