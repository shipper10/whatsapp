# Operations guide

## Deploy on a free always-on VM (Oracle Cloud Always Free, or any Linux host with Docker)
1. Create the VM (Ubuntu), open **no** public ports except SSH. The bot's webhook port stays internal to Docker; OpenWA's dashboard is bound to `127.0.0.1`.
2. Install Docker + the compose plugin, then `git clone https://github.com/shipper10/whatsapp && cd whatsapp`.
3. `cp .env.example .env` and fill it: `POSTGRES_PASSWORD`, `OPENWA_API_KEY` (>= 32 random chars), `OPENWA_WEBHOOK_SECRET`, Telegram values, `ADMIN_IDS`, `GOOGLE_SERVICE_ACCOUNT_JSON_PATH`. Put the Drive key file on the VM and mount it into the `bot` service (add a `volumes:` line, e.g. `./secrets/drive.json:/run/secrets/drive.json:ro`, and set the env var to `/run/secrets/drive.json`).
4. Link WhatsApp: follow `docs/WHATSAPP_SETUP.md`. Telegram login: run `npm run telegram:login` once on any machine, paste the session string into `.env`.
5. `docker compose up -d --build`. Check: `docker compose ps`, `docker compose logs -f bot`, and from WhatsApp (admin number) send `/status`.
6. Add Drive folders from WhatsApp: `/source add Year_1 <folder-url>`, share each folder with the service-account email, then `/sync all`.

Update: `git pull && docker compose up -d --build` (migrations run on start). Pin the OpenWA image tag before relying on it.

## Day-to-day (admin, private chat with the bot)
`/status` health and last syncs · `/stats` counts · `/sync` run now · `/review` unresolved files and `/assign` to fix them (locked against re-sync) · `/set` and `/settings` change behaviour without redeploying · `/alias` synonyms · `/audit` who changed what. Full list: `/help`.
Admin commands work only in a private chat with the bot, only for `ADMIN_IDS` or users added with `/admin add`.

## Backups
The `backup` service writes to `./backups` every 24 h (`BACKUP_INTERVAL_HOURS`), keeps 14 days (`BACKUP_KEEP_DAYS`):
- `db-<time>.sql.gz` PostgreSQL dump, verified with `gzip -t` before it is kept.
- `openwa-<time>.tar.gz` the linked-WhatsApp login (copied live; if a restore of it fails, just re-scan the QR).
`./backups` lives on the same machine, so **also copy it elsewhere** (another host, or a free cloud drive with rclone). A backup that dies with the VM is not a backup.

### Restore drill (do it once before going live, then each quarter)
```
docker compose stop bot
docker compose exec -T backup sh -c '/scripts/restore.sh /backups/db-<time>.sql.gz --yes'
docker compose start bot
```
Then send `/stats` and a search from WhatsApp and compare with the numbers before. The automated test `test/backup.test.ts` proves a dump of a full library restores with identical data and working search; the shell scripts themselves must be exercised on your host (they were only syntax-checked here).

## What is NOT backed up / secrets
`.env`, the Drive key file and the Telegram session string are secrets: keep your own offline copy, never commit them. They are not in `./backups`.

## Troubleshooting
- No reply in WhatsApp: `docker compose logs bot` for "webhook rejected" (secret mismatch) and `docker compose logs openwa` for delivery errors (`SSRF_ALLOWED_HOSTS` must contain `bot`).
- `/status` shows a Drive source error: share the folder with the service-account email (Viewer).
- Telegram sync stuck: re-run `npm run telegram:login`, update `TELEGRAM_SESSION_STRING`, restart `bot`.
- Account/number restricted by WhatsApp: expected risk of unofficial clients; keep send rate low and use a dedicated number.
