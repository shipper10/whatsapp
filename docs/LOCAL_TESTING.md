# Local testing steps

Requires Node 22+. Postgres is only needed for step 4.

1. `npm install` (expected: 0 vulnerabilities; two `@esbuild-kit` deprecation warnings come from drizzle-kit, a dev-only tool, and are harmless)
2. `npm run typecheck && npm run lint && npm test`  -> all green (20 tests)
3. Telegram login (once, needs internet access to Telegram):
   `cp .env.example .env`, fill `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`, then `npm run telegram:login`.
   Enter the phone number, the code and the 2FA password (if any). Copy the printed `TELEGRAM_SESSION_STRING=...` into `.env`.
4. Database: `docker run -d --name pg -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:16-alpine`, then
   `DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres npm run db:migrate`
