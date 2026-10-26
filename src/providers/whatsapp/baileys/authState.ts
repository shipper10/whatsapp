import type {
  AuthenticationCreds,
  SignalDataSet,
  SignalDataTypeMap,
  SignalKeyStore,
} from "@whiskeysockets/baileys";
import { BufferJSON, initAuthCreds, proto } from "@whiskeysockets/baileys";
import { inArray, like, sql } from "drizzle-orm";
import type { Db } from "../../../db/client.js";
import { waAuthState } from "../../../db/schema.js";

/**
 * Baileys auth state stored in PostgreSQL (same contract as useMultiFileAuthState, minus the disk).
 * Everything the bot needs to stay linked lives in the database, so a host with an ephemeral
 * filesystem can restart freely. Rows are secrets: never log them, back up the database privately.
 */
export async function useDbAuthState(db: Db, namespace = "default") {
  const ns = (name: string) => `${namespace}:${name}`;
  const encode = (v: unknown) => JSON.stringify(v, BufferJSON.replacer);
  const decode = <T>(s: string): T => JSON.parse(s, BufferJSON.reviver) as T;

  const [credsRow] = await db
    .select()
    .from(waAuthState)
    .where(inArray(waAuthState.name, [ns("creds")]));
  const creds: AuthenticationCreds = credsRow
    ? decode<AuthenticationCreds>(credsRow.value)
    : initAuthCreds();

  const keys: SignalKeyStore = {
    get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const out: { [id: string]: SignalDataTypeMap[T] } = {};
      if (ids.length === 0) return out;
      const rows = await db
        .select()
        .from(waAuthState)
        .where(
          inArray(
            waAuthState.name,
            ids.map((id) => ns(`${type}-${id}`)),
          ),
        );
      const byName = new Map(rows.map((r) => [r.name, r.value]));
      for (const id of ids) {
        const raw = byName.get(ns(`${type}-${id}`));
        if (raw === undefined) continue;
        let value = decode<SignalDataTypeMap[T]>(raw);
        if (type === "app-state-sync-key" && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(
            value as object,
          ) as unknown as SignalDataTypeMap[T];
        }
        out[id] = value;
      }
      return out;
    },
    set: async (data: SignalDataSet) => {
      const upserts: { name: string; value: string }[] = [];
      const removals: string[] = [];
      for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
        const entries = data[category] ?? {};
        for (const id of Object.keys(entries)) {
          const value = entries[id];
          const name = ns(`${category}-${id}`);
          if (value) upserts.push({ name, value: encode(value) });
          else removals.push(name);
        }
      }
      await db.transaction(async (tx) => {
        for (let i = 0; i < upserts.length; i += 200) {
          await tx
            .insert(waAuthState)
            .values(upserts.slice(i, i + 200))
            .onConflictDoUpdate({
              target: waAuthState.name,
              set: { value: sql`excluded.value`, updatedAt: new Date() },
            });
        }
        for (let i = 0; i < removals.length; i += 200) {
          await tx.delete(waAuthState).where(inArray(waAuthState.name, removals.slice(i, i + 200)));
        }
      });
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      await db
        .insert(waAuthState)
        .values({ name: ns("creds"), value: encode(creds) })
        .onConflictDoUpdate({
          target: waAuthState.name,
          set: { value: encode(creds), updatedAt: new Date() },
        });
    },
    /** Forget the linked device (after logout). */
    clear: async () => {
      await db.delete(waAuthState).where(like(waAuthState.name, `${namespace}:%`));
    },
  };
}
