import { mkdir } from "node:fs/promises";
import { createHandler } from "./bot/handler.js";
import { loadEnv } from "./config/env.js";
import { DbSessionStore } from "./core/session/store.js";
import { createDb } from "./db/client.js";
import { DbDeliveryLog } from "./delivery/dbLog.js";
import { DriveFetcher } from "./delivery/driveFetcher.js";
import { type FileFetcher, sweepTempDir } from "./delivery/fetchers.js";
import { FileDeliverer } from "./delivery/fileDeliverer.js";
import { TelegramFetcher } from "./delivery/telegramFetcher.js";
import { GoogleDriveClient, resolveCredentialPath } from "./drive/client.js";
import { DbDriveStore } from "./drive/store.js";
import { syncDrive } from "./drive/sync.js";
import type { DriveClient } from "./drive/types.js";
import { createAppServer } from "./http/server.js";
import { SyncScheduler } from "./jobs/scheduler.js";
import { classifyAndApply } from "./library/apply.js";
import { DbLibrary } from "./library/dbLibrary.js";
import { createLogger } from "./logger.js";
import { OpenWaProvider } from "./providers/whatsapp/openwa.js";
import { DbSettingsStore, SettingsService } from "./settings/service.js";
import { TelegramRuntime } from "./telegram/runtime.js";
import { DbTelegramStore } from "./telegram/store.js";
import { syncTelegram } from "./telegram/sync.js";

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);
const { db, pool } = createDb(env.DATABASE_URL);
const settings = new SettingsService(new DbSettingsStore(db));
await mkdir(env.TEMP_FILE_DIR, { recursive: true });

// --- Telegram (optional until configured)
const telegram =
  env.TELEGRAM_API_ID &&
  env.TELEGRAM_API_HASH &&
  env.TELEGRAM_CHANNEL &&
  env.TELEGRAM_SESSION_STRING
    ? new TelegramRuntime({
        apiId: env.TELEGRAM_API_ID,
        apiHash: env.TELEGRAM_API_HASH,
        channel: env.TELEGRAM_CHANNEL,
        sessionString: env.TELEGRAM_SESSION_STRING,
      })
    : null;
if (!telegram)
  log.warn({}, "Telegram not configured: sync disabled, attachments from Telegram unavailable");

// --- Drive clients (one per credential file)
const driveClients = new Map<string, DriveClient>();
const driveClientFor = (credentialRef: string) => {
  const path = resolveCredentialPath(credentialRef);
  let c = driveClients.get(path);
  if (!c) driveClients.set(path, (c = new GoogleDriveClient(path)));
  return c;
};

// --- WhatsApp + bot
const provider = new OpenWaProvider({
  baseUrl: env.OPENWA_BASE_URL,
  apiKey: env.OPENWA_API_KEY,
  sessionId: env.OPENWA_SESSION_ID,
});
const library = new DbLibrary(db);
const sessions = new DbSessionStore(db);

const fetchers: FileFetcher[] = [];
if (telegram) fetchers.push(new TelegramFetcher(telegram));
if (env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH) {
  fetchers.push(
    new DriveFetcher(env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH, () =>
      settings.get("delivery.driveDownload"),
    ),
  );
}

const deliverer = new FileDeliverer({
  library,
  provider,
  settings,
  fetchers,
  log: new DbDeliveryLog(db),
  tempDir: env.TEMP_FILE_DIR,
  concurrency: await settings.get("delivery.concurrency"),
  logger: log,
});

const handler = createHandler({ provider, settings, sessions, library, deliverer, logger: log });

// --- Sync scheduler
const channelUsername = async () => {
  if (env.TELEGRAM_CHANNEL && !/^-?\d+$/.test(env.TELEGRAM_CHANNEL)) return env.TELEGRAM_CHANNEL;
  return (await telegram?.identity())?.username ?? "";
};

const scheduler = new SyncScheduler({
  logger: log,
  intervalMinutes: (kind) =>
    settings.get(
      kind === "telegram" ? "sync.telegram.intervalMinutes" : "sync.drive.intervalMinutes",
    ),
  run: {
    telegram: async () => {
      if (!telegram) throw new Error("Telegram is not configured");
      const id = await telegram.identity();
      return syncTelegram(telegram, new DbTelegramStore(db), {
        sourceKey: String(id.chatId),
        ctx: { chatId: id.chatId, username: id.username },
        rescanWindow: await settings.get("sync.telegram.rescanWindow"),
      });
    },
    drive: async () => syncDrive(new DbDriveStore(db), (s) => driveClientFor(s.credentialRef)),
  },
  classify: async () => classifyAndApply(db, await channelUsername()),
});

const server = createAppServer({
  webhookSecret: env.OPENWA_WEBHOOK_SECRET,
  sessionId: env.OPENWA_SESSION_ID,
  health: async () => {
    await pool.query("select 1");
    return true;
  },
  onMessage: (id, msg) => handler.handle(id, msg),
  logger: log,
});

server.listen(env.PORT, async () => {
  log.info({ port: env.PORT, cohort: await settings.get("cohort.label") }, "server started");
});
if (env.ENABLE_SCHEDULER) scheduler.start();

const maintenance = setInterval(async () => {
  handler.prune();
  try {
    await sessions.purgeExpired();
    await sweepTempDir(
      env.TEMP_FILE_DIR,
      (await settings.get("delivery.tempFileTtlMinutes")) * 60_000,
    );
  } catch (e) {
    log.warn({ err: String(e) }, "maintenance failed");
  }
}, 10 * 60_000);
maintenance.unref();
await sweepTempDir(env.TEMP_FILE_DIR, 0).catch(() => undefined); // nothing survives a restart

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(maintenance);
    scheduler.stop();
    server.close();
    void Promise.allSettled([telegram?.close(), pool.end()]).then(() => process.exit(0));
  });
}
