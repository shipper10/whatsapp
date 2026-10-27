import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Lets the Google service-account key travel as an environment variable (plain JSON or base64),
 * so moving to another host needs no secret files. Returns the path to use for
 * GOOGLE_SERVICE_ACCOUNT_JSON_PATH (an explicit path wins), or undefined when none is configured.
 */
export async function materializeGoogleCredentials(
  vars: {
    GOOGLE_SERVICE_ACCOUNT_JSON_PATH?: string;
    GOOGLE_SERVICE_ACCOUNT_JSON?: string;
    GOOGLE_SERVICE_ACCOUNT_JSON_BASE64?: string;
  },
  dir: string,
): Promise<string | undefined> {
  if (vars.GOOGLE_SERVICE_ACCOUNT_JSON_PATH) return vars.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;
  let json = vars.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (!json && vars.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64) {
    json = Buffer.from(vars.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64.trim(), "base64").toString("utf8");
  }
  if (!json) return undefined;
  try {
    JSON.parse(json);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON(_BASE64) is not valid JSON");
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "google-service-account.json");
  await writeFile(path, json, { mode: 0o600 });
  return path;
}
