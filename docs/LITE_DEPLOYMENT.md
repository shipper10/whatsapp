# Lite deployment (no Docker, no credit card, no phone-side tooling)

One Node process: WhatsApp (Baileys) + Telegram sync + Drive sync + bot. Everything that must survive restarts
(library, sessions, settings, **WhatsApp login**) lives in an external free PostgreSQL. The host can wipe its disk freely.

## 1. Free PostgreSQL (pick one, no card)
- **Neon** (neon.tech): create a project, copy the connection string (`postgresql://...?sslmode=require`).
- **Supabase**: Project settings > Database > connection string (use the *session pooler* string if direct IPv6 fails). Free projects pause after about a week of inactivity; the bot's constant traffic prevents that.

Free tiers have ~0.5 GB, enough for a metadata-only library. The app creates `pg_trgm` and `unaccent` itself (both are available on Neon and Supabase).

## 2. Host the process (no card)
Use a free bot host that runs Node 22 from a Git repo or uploaded files (bot-hosting.net, Wispbyte, or similar). Settings:
- Build/install: `npm ci && npm run build`
- Start command: `npm start` (this applies DB migrations, then starts the bot)
- Node version: 22
- Keep memory low: set `DB_POOL_MAX=3`.

## 3. Environment variables
```
NODE_ENV=production
DATABASE_URL=<neon/supabase string>
DB_POOL_MAX=3
WHATSAPP_PROVIDER=baileys
ADMIN_HTTP_TOKEN=<long random string, 16+ chars>
ADMIN_IDS=<your WhatsApp id after linking, e.g. 2499xxxxxxx@s.whatsapp.net>
TEMP_FILE_DIR=/tmp/bot
TELEGRAM_API_ID / TELEGRAM_API_HASH / TELEGRAM_CHANNEL / TELEGRAM_SESSION_STRING   (see docs/LOCAL_TESTING.md for the one-time login)
GOOGLE_SERVICE_ACCOUNT_JSON_PATH=<path to uploaded key file>   (optional)
```
Store these in the host's secret/environment panel, never in the repo. Tunables (reply mode, page size, send gap `WHATSAPP_MIN_SEND_GAP_MS`, intervals...) are runtime settings changed from WhatsApp admin commands.

## 4. Link WhatsApp (from any browser, even on the same phone)
1. Open `https://<your-host-url>/admin/link?token=<ADMIN_HTTP_TOKEN>`. The page shows a QR and refreshes itself.
2. On the phone that owns the bot number: WhatsApp > Linked devices > Link a device > scan.
   - Only one phone and cannot scan its own screen? Type the number (digits with country code) in the form on the same page, press *Get pairing code*, then WhatsApp > Linked devices > Link with phone number instead, and enter the code.
3. The page shows "Linked". The login is now stored in Postgres; restarts and redeploys need no re-scan.
4. If the host has no public URL, check its port/domain setting; `PORT` is read from the environment.

Use a dedicated number for the bot (it can be a spare SIM kept only for WhatsApp). The ban risk of unofficial clients is accepted.

## 5. Behaviour you should know
- Logged out from the phone: the bot wipes its stored login and shows a fresh QR on the same page.
- "Session replaced" in logs: another client used this login; the bot stays offline until restarted (avoids a fight loop).
- Disconnects reconnect automatically with backoff (2s up to 60s).
- Sends are spaced by `whatsapp.minSendGapMs` (default 800 ms).
- Temporary attachment files go to `TEMP_FILE_DIR` and are deleted after sending.

## 6. Backups
`wa_auth_state` is a secret (it is the logged-in session). Back up only privately, e.g. `pg_dump "$DATABASE_URL" > backup.sql` run by hand and stored on your own device. Do **not** upload dumps as CI artifacts of a public repository. The library itself is rebuilt from Telegram/Drive if lost, so losing the DB costs only sessions, settings and re-linking.

## 7. Limits of this mode
- Memory: about 140 MB RSS measured idle; Telegram/Drive syncs and file sends add to it. Lower `sync.concurrency` and `delivery.concurrency` if the host kills the process.
- Free bot hosts may require periodic renewal (bot-hosting.net: every few days) and may sleep; the bot reconnects on its own.
- File delivery downloads each file to disk first; `delivery.maxAttachmentMb` caps size (default keeps links-only for large files).
