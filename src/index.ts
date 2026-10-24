import { createServer } from "node:http";
import { loadEnv } from "./config/env.js";
import { createDb } from "./db/client.js";
import { createLogger } from "./logger.js";
import { DbSettingsStore, SettingsService } from "./settings/service.js";

const env = loadEnv();
const log = createLogger(env.LOG_LEVEL);
const { db, pool } = createDb(env.DATABASE_URL);
const settings = new SettingsService(new DbSettingsStore(db));

const server = createServer(async (req, res) => {
  if (req.url === "/healthz") {
    try {
      await pool.query("select 1");
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    } catch {
      res.writeHead(503, { "content-type": "application/json" }).end('{"ok":false}');
    }
    return;
  }
  res.writeHead(404).end();
});

server.listen(env.PORT, async () => {
  log.info({ port: env.PORT, cohort: await settings.get("cohort.label") }, "server started");
});

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.close();
    void pool.end().then(() => process.exit(0));
  });
}
