import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WAMessage } from "@whiskeysockets/baileys";
import { createAdminHook } from "./admin/commands.js";
import { adminChats } from "./admin/targets.js";
import { createHandler } from "./bot/handler.js";
import { DbPrefs } from "./bot/prefs.js";
import { ReplyTracker } from "./bot/replyTracker.js";
import { BridgeService } from "./bridge/service.js";
import { BridgeStore } from "./bridge/store.js";
import { TelegramBridgeEndpoint } from "./bridge/telegramEndpoint.js";
import { WhatsAppBridgeEndpoint } from "./bridge/whatsappEndpoint.js";
import { loadEnv } from "./config/env.js";
import { freeDiskMb, rssMb } from "./core/resources.js";
import { DbSessionStore } from "./core/session/store.js";
import { createDb } from "./db/client.js";
import { DbDeliveryLog } from "./delivery/dbLog.js";
import { DriveFetcher } from "./delivery/driveFetcher.js";
import { type FileFetcher, sweepTempDir } from "./delivery/fetchers.js";
import { FileDeliverer } from "./delivery/fileDeliverer.js";
import { TelegramFetcher } from "./delivery/telegramFetcher.js";
import { GoogleDriveClient, resolveCredentialPath } from "./drive/client.js";
import { materializeGoogleCredentials } from "./drive/credentials.js";
import { DbDriveStore } from "./drive/store.js";
import { syncDrive } from "./drive/sync.js";
import type { DriveClient } from "./drive/types.js";
import { createBridgeUi } from "./http/bridgePanel.js";
import { createPanel } from "./http/panel.js";
import { loadCounts } from "./http/panelData.js";
import { createAppServer } from "./http/server.js";
import { SyncAlerts } from "./jobs/alerts.js";
import { startKeepAlive } from "./jobs/keepalive.js";
import { SyncScheduler } from "./jobs/scheduler.js";
import { classifyAndApply } from "./library/apply.js";
import { DbLibrary } from "./library/dbLibrary.js";
import { createLogger } from "./logger.js";
import { sendNewFilesDigest } from "./notify/digest.js";
import { BaileysProvider } from "./providers/whatsapp/baileys/provider.js";
import { OpenWaProvider } from "./providers/whatsapp/openwa.js";
import type { IncomingMessage, WhatsAppProvider } from "./providers/whatsapp/types.js";
import { DbSettingsStore, SettingsService } from "./settings/service.js";
import { TelegramRuntime } from "./telegram/runtime.js";
import { DbTelegramStore } from "./telegram/store.js";
import { syncTelegram } from "./telegram/sync.js";

const env = loadEnv();
{
  const googleKeyPath = await materializeGoogleCredentials(
    env,
    join(tmpdir(), "library-bot-secrets"),
  );
  if (googleKeyPath) {
    env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH = googleKeyPath;
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH = googleKeyPath; // used by drive_sources "default"
  }
}
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
// Lite mode: Baileys inside this process, login kept in Postgres. Messages reach the handler via this late-bound hook.
let onIncoming: (id: string, msg: IncomingMessage) => Promise<void> = async () => undefined;
let bridgeTap: ((m: WAMessage) => void) | undefined;
const baileys =
  env.WHATSAPP_PROVIDER === "baileys"
    ? new BaileysProvider({
        db,
        logger: log,
        baileysLogger: createLogger("warn"),
        onMessage: (id, msg) => onIncoming(id, msg),
        onRawMessage: env.BRIDGE_ENABLED ? (m) => bridgeTap?.(m) : undefined,
        minSendGapMs: () => settings.get("whatsapp.minSendGapMs"),
      })
    : null;
const replies = new ReplyTracker();
const provider: WhatsAppProvider = replies.wrap(
  baileys ??
    new OpenWaProvider({
      baseUrl: env.OPENWA_BASE_URL,
      apiKey: env.OPENWA_API_KEY ?? "",
      sessionId: env.OPENWA_SESSION_ID ?? "",
    }),
);
const library = new DbLibrary(db);
const prefs = new DbPrefs(db);
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

// --- Sync scheduler
const channelUsername = async () => {
  if (env.TELEGRAM_CHANNEL && !/^-?\d+$/.test(env.TELEGRAM_CHANNEL)) return env.TELEGRAM_CHANNEL;
  return (await telegram?.identity())?.username ?? "";
};

const syncNotes = new Map<string, string>();
const alerts = new SyncAlerts({
  threshold: () => settings.get("alerts.syncFailures"),
  notifyAdmins: async (text) => {
    const suffix = baileys ? "s.whatsapp.net" : "c.us";
    for (const conversationId of await adminChats(db, env.ADMIN_IDS, suffix))
      await provider.sendText({ conversationId, text });
  },
});
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
        onProgress: (st) =>
          syncNotes.set("telegram", `${st.fetched} messages read, ${st.inserted} new`),
        sourceKey: String(id.chatId),
        ctx: { chatId: id.chatId, username: id.username },
        rescanWindow: await settings.get("sync.telegram.rescanWindow"),
      });
    },
    drive: async () => syncDrive(new DbDriveStore(db), (s) => driveClientFor(s.credentialRef)),
  },
  note: (kind) => syncNotes.get(kind),
  onReport: async (report) => {
    await alerts.onReport(report);
    if (report.ok) await sendNewFilesDigest({ db, provider, settings, logger: log });
  },
  classify: async () => classifyAndApply(db, await channelUsername()),
});

const adminHook = createAdminHook({
  db,
  settings,
  scheduler,
  bootstrapAdmins: env.ADMIN_IDS,
  load: async () => {
    const st = deliverer.stats();
    return {
      running: st.running,
      queued: st.queued,
      inflightMb: Math.round(st.inflightBytes / 1048576),
      cached: st.cached,
      rssMb: rssMb(),
      freeDiskMb: await freeDiskMb(env.TEMP_FILE_DIR),
    };
  },
  send: async (msg, text) => {
    await provider.sendText({ conversationId: msg.conversationId, text });
  },
});
const handler = createHandler({
  replies,
  provider,
  settings,
  sessions,
  library,
  deliverer,
  logger: log,
  adminHook,
  prefs,
});

onIncoming = (id, msg) => handler.handle(id, msg);

// --- WhatsApp <-> Telegram bridge (off unless BRIDGE_ENABLED=true; never touches the library bot's own flow)
let bridgeTelegram: TelegramBridgeEndpoint | null = null;
let bridgeUi: ReturnType<typeof createBridgeUi> | undefined;
let bridgeRefresh: (() => Promise<unknown>) | undefined;
if (env.BRIDGE_ENABLED && baileys) {
  const store = new BridgeStore(db);
  const endpoints: ConstructorParameters<typeof BridgeService>[0]["endpoints"] = {};
  const svc = new BridgeService({ store, endpoints, tempDir: env.TEMP_FILE_DIR, logger: log });
  const wa = new WhatsAppBridgeEndpoint(
    baileys,
    (m) => svc.handle(m),
    (err) => log.error({ err: String(err) }, "bridge: WhatsApp message failed"),
    (chat, kinds) => void svc.noteUnrecognised("whatsapp", chat, kinds).catch(() => undefined),
  );
  endpoints.whatsapp = wa;
  bridgeTap = wa.tap;
  if (env.TELEGRAM_API_ID && env.TELEGRAM_API_HASH && env.BRIDGE_TELEGRAM_SESSION_STRING) {
    bridgeTelegram = new TelegramBridgeEndpoint(
      {
        apiId: env.TELEGRAM_API_ID,
        apiHash: env.TELEGRAM_API_HASH,
        sessionString: env.BRIDGE_TELEGRAM_SESSION_STRING,
      },
      log,
      (m) => svc.handle(m),
    );
    endpoints.telegram = bridgeTelegram;
  } else {
    log.warn(
      {},
      "bridge: BRIDGE_TELEGRAM_SESSION_STRING (+ TELEGRAM_API_ID/HASH) missing: Telegram side is off",
    );
  }
  bridgeRefresh = () => svc.refreshChats();
  bridgeUi = createBridgeUi({
    store,
    status: () => ({ whatsapp: wa.ready(), telegram: !!bridgeTelegram?.ready() }),
    refresh: () => svc.refreshChats(),
    problems: () => svc.problems(),
    activity: () => svc.activity(),
  });
}

const server = createAppServer({
  webhook: baileys
    ? undefined
    : {
        secret: env.OPENWA_WEBHOOK_SECRET ?? "",
        sessionId: env.OPENWA_SESSION_ID ?? "",
        onMessage: (id, msg) => handler.handle(id, msg),
      },
  link:
    baileys && env.ADMIN_HTTP_TOKEN
      ? {
          token: env.ADMIN_HTTP_TOKEN,
          status: () => baileys.status(),
          pairingCode: (phone) => baileys.requestPairingCode(phone),
        }
      : undefined,
  panel: env.ADMIN_HTTP_TOKEN
    ? createPanel({
        token: env.ADMIN_HTTP_TOKEN,
        logger: log,
        bridge: bridgeUi,
        overview: async () => {
          const st = deliverer.stats();
          const w = baileys?.status();
          const base = await loadCounts(db);
          return {
            ...base,
            whatsapp: baileys
              ? w?.state === "open"
                ? "Connected"
                : `⚠️ ${w?.state ?? "?"}`
              : "OpenWA",
            syncs: (["telegram", "drive"] as const).map((kind) => {
              const r = scheduler.last.get(kind);
              const run = scheduler.activity().find((a) => a.kind === kind);
              return {
                kind,
                ok: r ? r.ok : null,
                at: r?.finishedAt ?? null,
                error: r?.error,
                running: run ? (syncNotes.get(kind) ?? "running now") : undefined,
              };
            }),
            load: {
              running: st.running,
              queued: st.queued,
              inflightMb: Math.round(st.inflightBytes / 1048576),
              cached: st.cached,
              rssMb: rssMb(),
              freeDiskMb: await freeDiskMb(env.TEMP_FILE_DIR),
            },
          };
        },
      })
    : undefined,
  health: async () => {
    await pool.query("select count(*) from app_settings"); // a real table read, not just a ping
    return true;
  },
  logger: log,
});

server.listen(env.PORT, async () => {
  log.info({ port: env.PORT, cohort: await settings.get("cohort.label") }, "server started");
});
if (baileys) {
  await baileys.start();
  log.info({}, "WhatsApp (Baileys) starting; open /admin/link?token=... to link if not linked yet");
}
if (bridgeTelegram) {
  void bridgeTelegram
    .start()
    .catch((e) =>
      log.error({ err: String(e) }, "bridge: Telegram failed to start; the bridge stays one-sided"),
    );
}
let bridgeTimer: NodeJS.Timeout | undefined;
if (bridgeRefresh) {
  const refresh = bridgeRefresh;
  setTimeout(() => void refresh(), 30_000).unref();
  bridgeTimer = setInterval(() => void refresh(), 30 * 60_000);
  bridgeTimer.unref();
}
if (env.ENABLE_SCHEDULER) scheduler.start();
const keepAlive = startKeepAlive({
  url: env.KEEPALIVE_URL ?? env.RENDER_EXTERNAL_URL,
  touchDb: async () => void (await pool.query("select count(*) from app_settings")),
  intervalMinutes: () => settings.get("keepalive.intervalMinutes"),
  logger: log,
});

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
    if (bridgeTimer) clearInterval(bridgeTimer);
    keepAlive.stop();
    scheduler.stop();
    server.close();
    void Promise.allSettled([
      baileys?.stop(),
      telegram?.close(),
      bridgeTelegram?.stop(),
      pool.end(),
    ]).then(() => process.exit(0));
  });
}
