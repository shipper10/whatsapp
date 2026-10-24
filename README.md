# WhatsApp Medical Library Bot

Metadata-only library bot: Telegram channel + Google Drive folders -> searchable library in WhatsApp
(private chats and groups, one independent session per participant).
Design plan: `whatsapp_medical_library_bot_implementation_plan.md`. Reuse decisions: `docs/ALTERNATIVES_AND_DECISIONS.md`.

## Stack (all free / open source)
OpenWA (WhatsApp gateway, Baileys engine) · teleproto (Telegram, maintained fork of GramJS) · googleapis (Drive) · PostgreSQL + Drizzle · zod · pino · vitest.

## Layout
```
src/config/      deployment env (secrets, restart-level) validated by zod
src/settings/    runtime settings: registry.ts (declare once) + service.ts (DB > env > default)
src/db/          Drizzle schema, client, migrations runner  (SQL in ./drizzle)
src/providers/   provider-neutral WhatsApp interface (OpenWA adapter next)
src/core/        normalization (Arabic/English), session key rules
test/            vitest
```

## Changing things without reprogramming
- **Secrets / deployment** -> `.env` (restart needed).
- **Everything else operational** (page size, TTL, intervals, size limits, group mode, welcome text, aliases,
  Drive sources, academic nodes) -> database tables. Settings are declared once in `src/settings/registry.ts`;
  add one entry to add a new editable setting.
- WhatsApp provider is behind `WhatsAppProvider`; swapping it does not touch bot logic.

## Develop
```
npm install
npm run typecheck && npm run lint && npm test
DATABASE_URL=... npm run db:migrate
```

## Deploy (free)
Any always-on Docker host. Best free fit: Oracle Cloud Always Free VM. Platforms that sleep or have
ephemeral disks (Render, Koyeb, Railway, Fly trial) are unsuitable for a persistent WhatsApp session.
```
cp .env.example .env   # fill values
docker compose up -d
# link the number: ssh -L 2785:localhost:2785 <host>, open http://localhost:2785, create session, scan QR
```
Back up the `pgdata` and `openwa-data` volumes (`pg_dump` + copy of openwa-data); the WhatsApp login lives there.

## Status
Slice 1 done: scaffold, config, settings, schema, session-key rule, normalization, Docker.
Slice 2 done: Telegram parser, idempotent resumable sync (teleproto source), login script (`npm run telegram:login`).
Slice 3 done: Drive metadata sync (service account, recursive, per-source isolation, `npm run drive:source`).
Slice 4 done: metadata-only classification (index tree -> semester/subject/topic, category tags, Drive matching), apply, search (FTS + aliases + trigram), browse. Tested on real Postgres (PGlite) with the full channel structure.
Next: wire syncs into scheduler, OpenWA adapter + conversation flow, delivery, admin commands.
