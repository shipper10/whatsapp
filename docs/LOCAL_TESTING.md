# Local testing steps

Requires Node 22+. Postgres is only needed for step 4.

1. `npm install` (expected: 0 vulnerabilities; two `@esbuild-kit` deprecation warnings come from drizzle-kit, a dev-only tool, and are harmless)
2. `npm run typecheck && npm run lint && npm test`  -> all green (20 tests)
3. Telegram login (once, needs internet access to Telegram):
   `cp .env.example .env`, fill `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`, then `npm run telegram:login`.
   Enter the phone number, the code and the 2FA password (if any). Copy the printed `TELEGRAM_SESSION_STRING=...` into `.env`.
4. Database: `docker run -d --name pg -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16-alpine`, then
   `DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres npm run db:migrate`

## Google Drive (service account)
1. Google Cloud Console -> new project -> enable "Google Drive API" -> IAM -> Service Accounts -> create -> Keys -> add JSON key.
2. Save the JSON outside the repo (never commit it) and set `GOOGLE_SERVICE_ACCOUNT_JSON_PATH=/path/key.json` in `.env`.
3. Open each Drive folder -> Share -> add the service account email (`client_email` in the JSON) as **Viewer**. Folders owned by different Google accounts each need this share done by their owner.
4. `npm run drive:source -- add "Year 1" "<folder url>"` then `npm run drive:source -- check`.
   A folder that is not shared prints `FAIL ... Share the folder (Viewer) with <email>`.
5. Different service accounts per source: put another key path in a new env var and add the source with `env:THAT_VAR` as credential_ref.
The bot only requests the read-only metadata scope, so it cannot change files or read their content.
