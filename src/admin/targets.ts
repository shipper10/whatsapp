import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { registeredUsers } from "../db/schema.js";
import { idDigits } from "./identity.js";

/**
 * Chats to message when the admins must be told something: registered admins (their real chat ids) plus
 * the bootstrap numbers from ADMIN_IDS that are not registered yet (`suffix` is the provider's id suffix).
 */
export async function adminChats(db: Db, bootstrap: string[], suffix: string): Promise<string[]> {
  const rows = await db
    .select()
    .from(registeredUsers)
    .where(and(eq(registeredUsers.isAdmin, true), eq(registeredUsers.enabled, true)));
  const chats = rows.map((r) => r.participantId);
  const known = new Set(chats.map(idDigits));
  for (const b of bootstrap) {
    const d = idDigits(b);
    if (d && !known.has(d)) {
      known.add(d);
      chats.push(`${d}@${suffix}`);
    }
  }
  return chats;
}
