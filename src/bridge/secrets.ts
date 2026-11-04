import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/** AES-256-GCM for the Telegram sessions kept in the database. Format: v1.<iv>.<tag>.<data> (base64url). */
const keyOf = (secret: string) => scryptSync(secret, "bridge-accounts-v1", 32);

export function encryptSecret(plain: string, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const data = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv, c.getAuthTag(), data]
    .map((x) => (typeof x === "string" ? x : x.toString("base64url")))
    .join(".");
}

/** Returns null when the value was encrypted with another secret (e.g. the token was rotated) or is damaged. */
export function decryptSecret(value: string, secret: string): string | null {
  try {
    const [v, iv, tag, data] = value.split(".");
    if (v !== "v1" || !iv || !tag || !data) return null;
    const d = createDecipheriv("aes-256-gcm", keyOf(secret), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
