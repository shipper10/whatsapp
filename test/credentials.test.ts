import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { materializeGoogleCredentials } from "../src/drive/credentials.js";

const KEY = JSON.stringify({ client_email: "a@b.iam", private_key: "k" });

describe("materializeGoogleCredentials", () => {
  it("prefers an explicit path and writes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cred-"));
    expect(
      await materializeGoogleCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON_PATH: "/x.json" }, dir),
    ).toBe("/x.json");
  });
  it("writes raw JSON or base64 to a file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cred-"));
    const p1 = await materializeGoogleCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: KEY }, dir);
    expect(await readFile(p1 as string, "utf8")).toBe(KEY);
    const p2 = await materializeGoogleCredentials(
      { GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: Buffer.from(KEY).toString("base64") },
      dir,
    );
    expect(await readFile(p2 as string, "utf8")).toBe(KEY);
  });
  it("returns undefined when unset and rejects invalid JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cred-"));
    expect(await materializeGoogleCredentials({}, dir)).toBeUndefined();
    await expect(
      materializeGoogleCredentials({ GOOGLE_SERVICE_ACCOUNT_JSON: "{oops" }, dir),
    ).rejects.toThrow();
  });
});
