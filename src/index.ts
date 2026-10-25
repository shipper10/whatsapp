import { createHandler } from "./bot/handler.js";
import { loadEnv } from "./config/env.js";
import { DbSessionStore } from "./core/session/store.js";
import { createDb } from "./db/client.js";
import { LinksOnlyDeliverer } from "./delivery/linksOnly.js";
import { createAppServer } from "./http/server.js";
import { DbLibrary } from "./library/dbLibrary.js";
import { createLogger } from "./logger.js";
import { OpenWaProvider } from "./providers/whatsapp/openwa.js";
import { DbSettingsStore, SettingsService } from "./settings/service.js";

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);
const { db, pool } = createDb(env.DATABASE_URL);
const settings = new SettingsService(new DbSettingsStore(db));

const provider = new OpenWaProvider({
  baseUrl: env.OPENWA_BASE_URL,
  apiKey: env.OPENWA_API_KEY,
  sessionId: env.OPENWA_SESSION_ID,
});
const library = new DbLibrary(db);
const sessions = new DbSessionStore(db);
const handler = createHandler({
  provider,
  settings,
  sessions,
  library,
  deliverer: new LinksOnlyDeliverer(library, provider, settings),
  logger: log,
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

const cleanup = setInterval(() => {
  handler.prune();
  void sessions.purgeExpired().catch((e) => log.warn({ err: String(e) }, "session purge failed"));
}, 10 * 60_000);
cleanup.unref();

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    clearInterval(cleanup);
    server.close();
    void pool.end().then(() => process.exit(0));
  });
}
