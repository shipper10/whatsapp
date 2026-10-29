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
GOOGLE_SERVICE_ACCOUNT_JSON_BASE64=<base64 of the key file>   (optional; or GOOGLE_SERVICE_ACCOUNT_JSON / _JSON_PATH)
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


## 5. Keep it awake (Render free)
A free Render web service sleeps after ~15 minutes without incoming web traffic. The bot handles this two ways:
- **Self-ping**: on Render it reads `RENDER_EXTERNAL_URL` (set automatically) and pings itself every `keepalive.intervalMinutes` (default 10; env `KEEPALIVE_INTERVAL_MINUTES`, 0 disables; set `KEEPALIVE_URL` for other hosts). Each tick also reads the database, so Supabase never counts the project as inactive.
- **UptimeRobot** (extra safety): create a monitor of type *HTTP(s)*, URL `https://<your-service>.onrender.com/healthz`, interval 5 minutes. (The bare domain also answers now; the old 404 is gone.) Do not use the `/admin/link` URL.
Render's free tier gives 750 instance-hours per month: enough for one always-on service per account.

## 6. Sending behaviour
- Audio/video/image files are sent as proper WhatsApp media with correct MIME types (this fixes `.opus` "unusual format" errors); everything else is a document. WhatsApp's own limits apply (documents up to 2 GB).
- `links.telegram` / `links.drive`: show or hide each kind of link independently (env `SHOW_TELEGRAM_LINKS`, `SHOW_DRIVE_LINKS`).
- Progress and queue: requests wait in a FIFO queue (`delivery.concurrency`, default 2; use 1 on small hosts). A status message is edited with queue position, download percent and "sending" (`delivery.progress`, `delivery.progressMinMb`). Each transfer needs temporary disk of about 2x the file size, so with several 1 GB requests keep concurrency at 1. The timeout (`delivery.timeoutSeconds`) now counts only time without progress. WhatsApp gives no upload percentage; the message shows elapsed time while sending.

## 7. Admin commands for sending (send them to the bot from an admin number)
- `/settings` lists every setting; `/set <key> <value>`; `/reset <key>`.
- File types sent as real files (others get links only): `/set delivery.allowedMediaTypes pdf,audio` (words: pdf, docx, audio, video, image, document; extensions like `.mp3`; MIME like `application/pdf` or `audio/*`). Back to everything: `/reset delivery.allowedMediaTypes`.
- Sound files: arrive as playable audio messages (Ogg/Opus is detected from the file's bytes and sent as `.ogg`). If they still fail on a phone: `/set delivery.audioMode document`.
- Status message edits are limited on purpose (10% steps, at least 4 s apart, at most 40 edits, none after ~14 min) to stay far from anything that looks like spam.
- Audio over 16 MB (WhatsApp cannot play more inline): the bot sends an explanation (with the links), then the parts in order ("Part 2 of 5"). Parts are cut by copying bytes (no re-encoding, no CPU load) for mp3, aac, ogg/opus, amr and wav; m4a cannot be cut safely and gets links only. To turn splitting off and give links only: `/set delivery.splitLargeAudio false`.
- Opus files that carry an embedded cover picture inside their tags (a typical cause of "audio is not available") are sent as a copy with the picture removed; the sound itself is untouched.
- Download check: every downloaded file's size must equal the size the source reports (Telegram/Drive). A mismatch triggers one re-download; if the copies still differ, the bot sends links instead of a possibly damaged file.
- `/set delivery.audioPartMb 8` makes split parts smaller (2 to 15 MB) if a long part stops playing midway.
