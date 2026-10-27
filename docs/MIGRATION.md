# Moving the bot to another host or account

Nothing important lives on the host. Everything that identifies the bot is in two places:

| What | Where | Needed on the new host |
|---|---|---|
| WhatsApp login, library, sessions, settings | PostgreSQL (`DATABASE_URL`) | the **same** `DATABASE_URL` |
| Telegram login | `TELEGRAM_SESSION_STRING` env var | the same value (+ `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_CHANNEL`) |
| Google Drive key | `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64` (or `_JSON`) env var | the same value |

So: no new WhatsApp QR scan, no new Telegram login, no re-sync, no lost settings.

## Steps
1. **Stop the old instance first** (suspend/delete the old service). Two instances using the same WhatsApp login fight each other and can get the number logged out.
2. On the new host/account (Render: *New > Blueprint* with this repo's `render.yaml`, or a normal Web Service: build `npm ci && npm run build`, start `npm start`, Node 22), enter the same variables:
   `DATABASE_URL`, `ADMIN_HTTP_TOKEN`, `ADMIN_IDS`, `WHATSAPP_PROVIDER=baileys`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_CHANNEL`, `TELEGRAM_SESSION_STRING`, `GOOGLE_SERVICE_ACCOUNT_JSON_BASE64`, `DB_POOL_MAX=3`, `TEMP_FILE_DIR=/tmp/bot`.
3. Deploy. On start it migrates (nothing to change), loads the WhatsApp login from the DB and reconnects by itself.
4. Update the UptimeRobot monitor to the new `https://<new-service>.onrender.com/healthz`.

Tip: to make the base64 value from the key file: `base64 -w0 key.json` (Linux) or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("key.json"))` (PowerShell).

If the database itself must move (Neon/Supabase account change): `pg_dump "$OLD_URL" | psql "$NEW_URL"`, then use the new URL. Without a dump you would re-link WhatsApp and re-sync Telegram/Drive, which is also fine.

Keep a private copy of these variables (password manager) so a move is a copy-paste job.
