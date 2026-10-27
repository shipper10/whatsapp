import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { normalizeText } from "../core/normalize/arabic.js";
import type { Db } from "../db/client.js";
import {
  academicNodes,
  adminAuditLogs,
  deliveryLogs,
  driveFiles,
  driveSources,
  registeredUsers,
  resourceAliases,
  resourceNodeLinks,
  resources,
  syncRuns,
  telegramMessages,
  userSessions,
} from "../db/schema.js";
import { parseFolderId } from "../drive/url.js";
import type { SyncScheduler } from "../jobs/scheduler.js";
import { nodeInfo } from "../library/browse.js";
import type { IncomingMessage } from "../providers/whatsapp/types.js";
import { type SettingKey, settingsRegistry } from "../settings/registry.js";
import type { SettingsService } from "../settings/service.js";
import { idDigits, sameIdentity } from "./identity.js";

export interface AdminDeps {
  db: Db;
  settings: SettingsService;
  scheduler: Pick<SyncScheduler, "runNow" | "last" | "staleKinds">;
  bootstrapAdmins: string[];
  send: (msg: IncomingMessage, text: string) => Promise<void>;
}

const HELP = `Admin commands (private chat only)
/status  health, last syncs, source errors
/stats   counts and delivery results
/sync [telegram|drive|all]
/settings   list settings   |   /set <key> <value>   |   /reset <key>
/sources   |   /source add <label> <folder-url> [credential_ref]   |   /source on|off <id>
/review [page]   unresolved resources
/nodes [parentId]   |   /assign <resourceId> <nodeId>   |   /unlock <resourceId>
/alias add <nodeId|rResourceId> <text>   |   /alias list   |   /alias del <id>
/admins   |   /admin add|remove <whatsapp-number>
/audit [n]`;

const PAGE = 10;
const clip = (s: string, n = 60) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ago = (d: Date | null | undefined) => {
  if (!d) return "never";
  const m = Math.round((Date.now() - d.getTime()) / 60_000);
  return m < 1 ? "just now" : m < 120 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

export async function isAdmin(
  d: Pick<AdminDeps, "db" | "bootstrapAdmins">,
  participantId: string,
): Promise<boolean> {
  if (d.bootstrapAdmins.some((a) => sameIdentity(a, participantId))) return true;
  const rows = await d.db
    .select()
    .from(registeredUsers)
    .where(and(eq(registeredUsers.isAdmin, true), eq(registeredUsers.enabled, true)));
  return rows.some((r) => sameIdentity(r.participantId, participantId));
}

function parseValue(key: SettingKey, raw: string): unknown {
  let v: unknown = raw;
  try {
    v = JSON.parse(raw);
  } catch {
    /* plain string */
  }
  const def = settingsRegistry[key];
  const isArray = def.schema.safeParse([]).success && !def.schema.safeParse("x").success;
  if (isArray && typeof v === "string")
    return v
      .split(/[,،\s]+/)
      .map((x) => x.trim())
      .filter(Boolean);
  return v;
}

/** Runs one admin command and returns the reply text. Throws only for programmer errors. */
export async function runCommand(d: AdminDeps, actor: string, line: string): Promise<string> {
  const [cmd = "", ...args] = line.trim().split(/\s+/);
  const rest = line.trim().slice(cmd.length).trim();
  const audit = (action: string, detail: object = {}) =>
    d.db.insert(adminAuditLogs).values({ actor: idDigits(actor), action, detail });

  switch (cmd.toLowerCase()) {
    case "/help":
      return HELP;

    case "/status": {
      const lines = ["📊 Status"];
      for (const kind of ["telegram", "drive"] as const) {
        const r = d.scheduler.last.get(kind);
        lines.push(
          `• ${kind}: ${r ? `${r.ok ? "✅" : "❌"} ${ago(r.finishedAt)}${r.error ? ` — ${clip(r.error, 80)}` : ""}` : "no run since start"}`,
        );
      }
      const stale = await d.scheduler.staleKinds();
      if (stale.length) lines.push(`⚠️ stale: ${stale.join(", ")}`);
      const srcs = await d.db.select().from(driveSources).orderBy(asc(driveSources.id));
      lines.push("", "Drive sources:");
      if (srcs.length === 0) lines.push("(none) — add with /source add");
      for (const s of srcs)
        lines.push(
          `${s.id}. ${s.enabled ? "🟢" : "⚪"} ${s.label} — ${s.syncStatus}, synced ${ago(s.lastSyncAt)}${s.lastError ? `\n   ❗ ${clip(s.lastError, 110)}` : ""}`,
        );
      const [lastRun] = await d.db.select().from(syncRuns).orderBy(desc(syncRuns.id)).limit(1);
      if (lastRun)
        lines.push(
          "",
          `Last logged run: ${lastRun.kind} ${lastRun.status} ${ago(lastRun.finishedAt ?? lastRun.startedAt)}`,
        );
      return lines.join("\n");
    }

    case "/stats": {
      const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
      const count = sql<number>`count(*)::int`;
      const [tg, dfA, dfM, resA, nodes, sess] = await Promise.all([
        n(
          d.db
            .select({ n: count })
            .from(telegramMessages)
            .where(eq(telegramMessages.syncStatus, "active")),
        ),
        n(d.db.select({ n: count }).from(driveFiles).where(eq(driveFiles.syncStatus, "active"))),
        n(d.db.select({ n: count }).from(driveFiles).where(eq(driveFiles.syncStatus, "missing"))),
        n(d.db.select({ n: count }).from(resources).where(eq(resources.isActive, true))),
        n(d.db.select({ n: count }).from(academicNodes)),
        n(
          d.db
            .select({ n: count })
            .from(userSessions)
            .where(sql`${userSessions.expiresAt} > now()`),
        ),
      ]);
      const byStatus = await d.db
        .select({ s: resources.classificationStatus, n: count })
        .from(resources)
        .where(eq(resources.isActive, true))
        .groupBy(resources.classificationStatus);
      const dup = await n(
        d.db
          .select({ n: count })
          .from(resources)
          .where(
            sql`${resources.resourceKey} like 'drive:%' and ${resources.classificationStatus} = 'needs_review'`,
          ),
      );
      const del = await d.db
        .select({ o: deliveryLogs.outcome, n: count })
        .from(deliveryLogs)
        .where(sql`${deliveryLogs.at} > now() - interval '7 days'`)
        .groupBy(deliveryLogs.outcome);
      const fmt = (rows: { n: number }[], key: (r: never) => string) =>
        rows.map((r) => `${key(r as never)} ${r.n}`).join(", ") || "none";
      return [
        "📈 Stats",
        `Telegram messages: ${tg}`,
        `Drive files: ${dfA} active, ${dfM} missing`,
        `Resources: ${resA} (${fmt(byStatus, (r: { s: string }) => r.s)})`,
        `Possible Drive duplicates/unmatched in review: ${dup}`,
        `Academic nodes: ${nodes}`,
        `Active sessions: ${sess}`,
        `Deliveries, last 7 days: ${fmt(del, (r: { o: string }) => r.o)}`,
      ].join("\n");
    }

    case "/sync": {
      const which = (args[0] ?? "all").toLowerCase();
      if (!["telegram", "drive", "all"].includes(which)) return "Usage: /sync [telegram|drive|all]";
      await audit("sync", { which });
      const kinds =
        which === "all" ? (["telegram", "drive"] as const) : ([which] as ("telegram" | "drive")[]);
      const reports = await Promise.all(kinds.map((k) => d.scheduler.runNow(k)));
      return reports
        .map((r) => `${r.kind}: ${r.ok ? "✅ done" : `❌ ${clip(r.error ?? "failed", 150)}`}`)
        .join("\n");
    }

    case "/settings": {
      const all = await d.settings.describeAll();
      return [
        "⚙️ Settings (* = changed by admin, ↻ = needs restart)",
        ...all.map(
          (s) =>
            `${s.overridden ? "*" : " "}${s.restart ? "↻" : " "} ${s.key} = ${clip(JSON.stringify(s.value), 60)}`,
        ),
      ].join("\n");
    }

    case "/set": {
      const key = args[0] as SettingKey | undefined;
      if (!key || !(key in settingsRegistry) || args.length < 2)
        return "Usage: /set <key> <value>   (see /settings)";
      const value = rest.slice(rest.indexOf(args[0] as string) + (args[0] as string).length).trim();
      try {
        const { restartRequired } = await d.settings.set(
          key,
          parseValue(key, value),
          idDigits(actor),
        );
        await audit("set", { key, value });
        return `✅ ${key} updated${restartRequired ? " (takes effect after restart)" : ""}`;
      } catch (e) {
        return `❌ ${(e as Error).message}`;
      }
    }

    case "/reset": {
      const key = args[0] as SettingKey | undefined;
      if (!key || !(key in settingsRegistry)) return "Usage: /reset <key>";
      await d.settings.reset(key);
      await audit("reset", { key });
      return `✅ ${key} back to default`;
    }

    case "/sources": {
      const srcs = await d.db.select().from(driveSources).orderBy(asc(driveSources.id));
      return srcs.length
        ? srcs
            .map(
              (s) =>
                `${s.id}. ${s.enabled ? "🟢" : "⚪"} ${s.label} (${s.recursiveScan ? "recursive" : "top level"}, ${s.credentialRef})`,
            )
            .join("\n")
        : "No Drive sources. Add: /source add <label> <folder-url>";
    }

    case "/source": {
      const sub = args[0];
      if (sub === "add") {
        const label = args[1];
        const url = args[2];
        if (!label || !url)
          return "Usage: /source add <label-without-spaces> <folder-url> [credential_ref]";
        const folderId = parseFolderId(url);
        const ref = args[3] ?? "default";
        await d.db
          .insert(driveSources)
          .values({ label: label.replace(/_/g, " "), folderId, credentialRef: ref })
          .onConflictDoUpdate({
            target: driveSources.folderId,
            set: { label: label.replace(/_/g, " "), credentialRef: ref, enabled: true },
          });
        await audit("source.add", { label, folderId, ref });
        return `✅ source saved (${folderId}). Share the folder with the service account, then /sync drive`;
      }
      if ((sub === "on" || sub === "off") && /^\d+$/.test(args[1] ?? "")) {
        const res = await d.db
          .update(driveSources)
          .set({ enabled: sub === "on" })
          .where(eq(driveSources.id, Number(args[1])))
          .returning({ id: driveSources.id });
        if (!res.length) return "No such source id.";
        await audit("source.toggle", { id: Number(args[1]), enabled: sub === "on" });
        return `✅ source ${args[1]} ${sub === "on" ? "enabled" : "disabled"}`;
      }
      return "Usage: /source add <label> <folder-url> [credential_ref]  |  /source on|off <id>";
    }

    case "/review": {
      const page = Math.max(1, Number(args[0]) || 1);
      const rows = await d.db
        .select({
          id: resources.id,
          name: resources.displayName,
          status: resources.classificationStatus,
          node: resources.academicNodeId,
          key: resources.resourceKey,
        })
        .from(resources)
        .where(
          and(
            eq(resources.isActive, true),
            inArray(resources.classificationStatus, ["needs_review", "uncategorized"]),
          ),
        )
        .orderBy(asc(resources.classificationStatus), asc(resources.id))
        .limit(PAGE + 1)
        .offset((page - 1) * PAGE);
      if (rows.length === 0) return page === 1 ? "✅ Nothing to review." : "No more items.";
      const lines = [`🔎 Review queue (page ${page})`];
      for (const r of rows.slice(0, PAGE)) {
        const hint = r.node
          ? ` → suggested: ${(await nodeInfo(d.db, r.node))?.path.slice(-2).join(" › ")}`
          : "";
        lines.push(
          `#${r.id} [${r.status}${r.key.startsWith("drive:") ? ", drive" : ""}] ${clip(r.name, 50)}${hint}`,
        );
      }
      if (rows.length > PAGE) lines.push(`… /review ${page + 1}`);
      lines.push("", "Fix: /assign <resourceId> <nodeId>   (find ids with /nodes)");
      return lines.join("\n");
    }

    case "/nodes": {
      const parent = args[0] && /^\d+$/.test(args[0]) ? Number(args[0]) : null;
      const rows = await d.db
        .select()
        .from(academicNodes)
        .where(
          parent === null
            ? sql`${academicNodes.parentId} is null`
            : eq(academicNodes.parentId, parent),
        )
        .orderBy(asc(academicNodes.sortOrder))
        .limit(40);
      if (rows.length === 0) return "No nodes here.";
      return [
        parent === null ? "Top-level nodes:" : `Children of ${parent}:`,
        ...rows.map(
          (n) => `${n.id}. [${n.nodeType}] ${clip(n.name)}${n.enabled ? "" : " (disabled)"}`,
        ),
      ].join("\n");
    }

    case "/assign": {
      const [rid, nid] = args.map(Number);
      if (!rid || !nid) return "Usage: /assign <resourceId> <nodeId>";
      const node = await nodeInfo(d.db, nid);
      const [res] = await d.db
        .select({ id: resources.id })
        .from(resources)
        .where(eq(resources.id, rid));
      if (!node || !res) return "Unknown resource or node id.";
      await d.db.transaction(async (tx) => {
        await tx
          .update(resources)
          .set({
            academicNodeId: nid,
            classificationStatus: "classified",
            classificationLocked: true,
            updatedAt: new Date(),
          })
          .where(eq(resources.id, rid));
        await tx.delete(resourceNodeLinks).where(eq(resourceNodeLinks.resourceId, rid));
        await tx.insert(resourceNodeLinks).values({ resourceId: rid, nodeId: nid });
      });
      await audit("assign", { resourceId: rid, nodeId: nid });
      return `✅ #${rid} → ${node.path.slice(-3).join(" › ")} (locked: sync won't move it)`;
    }

    case "/unlock": {
      const rid = Number(args[0]);
      if (!rid) return "Usage: /unlock <resourceId>";
      const res = await d.db
        .update(resources)
        .set({ classificationLocked: false })
        .where(eq(resources.id, rid))
        .returning({ id: resources.id });
      if (!res.length) return "Unknown resource id.";
      await audit("unlock", { resourceId: rid });
      return `✅ #${rid} unlocked: the next sync may re-classify it`;
    }

    case "/alias": {
      const sub = args[0];
      if (sub === "list") {
        const rows = await d.db
          .select()
          .from(resourceAliases)
          .orderBy(desc(resourceAliases.id))
          .limit(30);
        return rows.length
          ? rows
              .map(
                (a) =>
                  `${a.id}. "${a.alias}" → ${a.nodeId ? `node ${a.nodeId}` : `resource ${a.resourceId}`}`,
              )
              .join("\n")
          : "No aliases.";
      }
      if (sub === "add") {
        const target = args[1] ?? "";
        const text = args.slice(2).join(" ").trim();
        const isRes = /^r\d+$/i.test(target);
        const id = Number(isRes ? target.slice(1) : target);
        if (!id || !text) return "Usage: /alias add <nodeId|rResourceId> <text>";
        const exists = isRes
          ? (await d.db.select({ id: resources.id }).from(resources).where(eq(resources.id, id)))
              .length
          : (
              await d.db
                .select({ id: academicNodes.id })
                .from(academicNodes)
                .where(eq(academicNodes.id, id))
            ).length;
        if (!exists) return "Unknown id.";
        const norm = normalizeText(text);
        if (!norm) return "Alias has no searchable text.";
        await d.db.insert(resourceAliases).values({
          alias: text,
          aliasNormalized: norm,
          ...(isRes ? { resourceId: id } : { nodeId: id }),
        });
        await audit("alias.add", { target, text });
        return `✅ "${text}" now finds ${isRes ? `resource ${id}` : `everything under node ${id}`}`;
      }
      if (sub === "del" && /^\d+$/.test(args[1] ?? "")) {
        const res = await d.db
          .delete(resourceAliases)
          .where(eq(resourceAliases.id, Number(args[1])))
          .returning({ id: resourceAliases.id });
        if (!res.length) return "No such alias.";
        await audit("alias.del", { id: Number(args[1]) });
        return "✅ alias removed";
      }
      return "Usage: /alias add <nodeId|rResourceId> <text>  |  /alias list  |  /alias del <id>";
    }

    case "/admins": {
      const rows = await d.db
        .select()
        .from(registeredUsers)
        .where(eq(registeredUsers.isAdmin, true));
      return [
        "Admins:",
        ...d.bootstrapAdmins.map((a) => `• ${idDigits(a)} (from environment)`),
        ...rows.map((r) => `• ${idDigits(r.participantId)}${r.enabled ? "" : " (disabled)"}`),
      ].join("\n");
    }

    case "/admin": {
      const [sub, who] = args;
      const digits = idDigits(who ?? "");
      if (!["add", "remove"].includes(sub ?? "") || digits.length < 8)
        return "Usage: /admin add|remove <whatsapp-number-with-country-code>";
      if (sub === "add") {
        const id = `${digits}@c.us`;
        await d.db
          .insert(registeredUsers)
          .values({ participantId: id, isAdmin: true, enabled: true })
          .onConflictDoUpdate({
            target: registeredUsers.participantId,
            set: { isAdmin: true, enabled: true },
          });
      } else {
        if (d.bootstrapAdmins.some((a) => sameIdentity(a, digits)))
          return "That admin comes from the environment (ADMIN_IDS); remove it there.";
        if (sameIdentity(actor, digits)) return "You cannot remove yourself.";
        await d.db
          .update(registeredUsers)
          .set({ isAdmin: false })
          .where(eq(registeredUsers.participantId, `${digits}@c.us`));
      }
      await audit(`admin.${sub}`, { who: digits });
      return `✅ ${sub === "add" ? "added" : "removed"} ${digits}`;
    }

    case "/audit": {
      const n = Math.min(30, Math.max(1, Number(args[0]) || 10));
      const rows = await d.db
        .select()
        .from(adminAuditLogs)
        .orderBy(desc(adminAuditLogs.id))
        .limit(n);
      return rows.length
        ? rows
            .map(
              (r) =>
                `${r.at.toISOString().slice(5, 16).replace("T", " ")} ${r.actor} ${r.action} ${clip(JSON.stringify(r.detail ?? {}), 80)}`,
            )
            .join("\n")
        : "No admin actions yet.";
    }

    default:
      return "Unknown command. Send /help";
  }
}

/** Plugs into the message handler: consumes "/command" messages from admins in private chats only. */
export function createAdminHook(d: AdminDeps) {
  return async (msg: IncomingMessage): Promise<boolean> => {
    const text = msg.text.trim();
    if (!text.startsWith("/") || msg.isGroup) return false;
    if (!(await isAdmin(d, msg.participantId))) return false; // non-admins just get a normal search
    let reply: string;
    try {
      reply = await runCommand(d, msg.participantId, text);
    } catch (e) {
      reply = `❌ Command failed: ${(e as Error).name}`;
    }
    await d.send(msg, reply);
    return true;
  };
}
