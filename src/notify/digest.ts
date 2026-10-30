import { and, asc, eq, gt, sql } from "drizzle-orm";
import { setTextOverrides, t } from "../bot/messages.js";
import type { PrefsPort } from "../bot/prefs.js";
import type { Db } from "../db/client.js";
import { resources, subscriptions, syncCursors } from "../db/schema.js";
import { cleanCaption } from "../library/indexView.js";
import type { WhatsAppProvider } from "../providers/whatsapp/types.js";
import type { SettingsService } from "../settings/service.js";

export interface DigestDeps {
  db: Db;
  provider: WhatsAppProvider;
  settings: SettingsService;
  prefs: PrefsPort;
  logger: { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void };
  now?: () => Date;
}

const CURSOR = { kind: "notify", sourceKey: "new-files" } as const;
const LIST_MAX = 5;

/**
 * After a sync: tells the people who subscribed that new files arrived. Cursor = the highest resource id
 * already announced, so each file is announced once. The first run only sets the cursor (no flood about
 * the whole library). Rate-limited by notify.minIntervalHours and notify.maxRecipients.
 */
export async function sendNewFilesDigest(d: DigestDeps): Promise<{ sent: number; files: number }> {
  const none = { sent: 0, files: 0 };
  if (!(await d.settings.get("notify.enabled"))) return none;
  const now = (d.now ?? (() => new Date()))();

  const [{ max } = { max: 0 }] = await d.db
    .select({ max: sql<number>`coalesce(max(${resources.id}), 0)::int` })
    .from(resources)
    .where(eq(resources.isActive, true));
  const [cur] = await d.db
    .select()
    .from(syncCursors)
    .where(and(eq(syncCursors.kind, CURSOR.kind), eq(syncCursors.sourceKey, CURSOR.sourceKey)));
  const save = (id: number) =>
    d.db
      .insert(syncCursors)
      .values({ ...CURSOR, cursor: String(id), updatedAt: now })
      .onConflictDoUpdate({
        target: [syncCursors.kind, syncCursors.sourceKey],
        set: { cursor: String(id), updatedAt: now },
      });

  if (!cur) {
    await save(max);
    return none;
  }
  const last = Number(cur.cursor ?? 0);
  if (max <= last) return none;

  const minHours = await d.settings.get("notify.minIntervalHours");
  if (now.getTime() - cur.updatedAt.getTime() < minHours * 3_600_000) return none; // bundle into a later message

  const fresh = await d.db
    .select({ id: resources.id, name: resources.displayName })
    .from(resources)
    .where(and(eq(resources.isActive, true), gt(resources.id, last)))
    .orderBy(asc(resources.id));
  if (fresh.length === 0) return none;

  const limit = await d.settings.get("notify.maxRecipients");
  const subs = limit > 0 ? await d.db.select().from(subscriptions).limit(limit) : [];
  setTextOverrides(await d.settings.get("text.overrides"));
  const defaultLang = await d.settings.get("bot.language");
  const userLanguage = await d.settings.get("bot.userLanguage");

  const names = fresh.slice(0, LIST_MAX).map((f) => `• ${cleanCaption(f.name, 70)}`);
  let sent = 0;
  for (const s of subs) {
    const lang = (userLanguage ? await d.prefs.getLang(s.conversationId) : null) ?? defaultLang;
    const more =
      fresh.length > LIST_MAX
        ? `\n${lang === "ar" ? `… و${fresh.length - LIST_MAX} أخرى` : `… and ${fresh.length - LIST_MAX} more`}`
        : "";
    const res = await d.provider.sendText({
      conversationId: s.conversationId,
      text: t("newFiles", lang)
        .replace("{n}", String(fresh.length))
        .replace("{list}", names.join("\n") + more),
    });
    if (res.confirmed) sent++;
    else d.logger.warn({ error: res.error }, "new-files notice not confirmed");
  }
  await save(max);
  d.logger.info({ files: fresh.length, sent }, "new-files notices sent");
  return { sent, files: fresh.length };
}
