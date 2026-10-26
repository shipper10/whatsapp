# Ready-made alternatives and build decisions (free options only)

Date: 2026-10-23. Scope: free / open-source only. Paid tiers (Meta Cloud API template billing) are skipped for now.
Goal: do not build from scratch. Reuse a maintained project for every layer; write only the glue and the library-specific logic.

## 1. Section-by-section decision

| Plan section | Decision | Reuse | Custom code still needed |
|---|---|---|---|
| WhatsApp transport (plan §3 #6, §8) | **Adopt OpenWA** as a self-hosted gateway (Docker). The bot talks to it over REST + signed webhooks. | [rmyndharis/OpenWA](https://github.com/rmyndharis/OpenWA), MIT, NestJS, engines: whatsapp-web.js or Baileys, Postgres/SQLite | Thin `WhatsAppProvider` adapter (webhook in, `send-text` / `send-document` out) |
| Telegram ingestion (§4) | **teleproto** (MIT, maintained fork of GramJS, same API; GramJS is archived) with a dedicated login. | npm `teleproto` | Cursor, idempotent upsert, edit detection, parser for index messages |
| Drive indexing (§5) | **Official `googleapis`** Drive v3, metadata only (`files.list`, `fields=` whitelist). | npm `googleapis` | Source config, per-source credentials, recursive walk, cursors |
| Database + ORM (§6) | **PostgreSQL + Drizzle ORM** (one ORM only). | drizzle-orm, drizzle-kit migrations | Schema from plan §6 |
| Search (§10) | **Postgres FTS + `pg_trgm` + `unaccent`**. No extra search server. | built into Postgres | Arabic normalization (alef/ya/ta-marbuta/tashkeel), alias table |
| Queue / scheduler (§9, §13) | **In-process loops + Semaphore/KeyedMutex** (single-process deployment; intervals re-read from settings each cycle). pg-boss was considered and deferred: it adds nothing while there is one process. | none | `src/jobs/scheduler.ts` |
| Sessions (§8) | Plain Postgres table `user_sessions`, unique `(provider, conversation_id, participant_id)`. | none needed | Menu state machine |
| Config validation (§11) | **zod** schema over env + DB-backed runtime settings table. | zod | Settings layer |
| Admin (§12) | WhatsApp admin commands (allowlisted ids) + OpenWA dashboard for session/QR. No custom web UI in v1. | OpenWA dashboard | Admin command handlers |
| Logging / health | **pino** + `/healthz`. | pino | none |
| Tests | **vitest**. | vitest | Fixtures from `result.json` structure |
| Backups (§13) | `pg_dump` cron script + documented restore. | postgres tools | Script + doc |

## 2. WhatsApp: what was verified

Checked in the OpenWA source (shallow clone, last commit 2026-10-21, v0.25.0):

- License MIT. Actively maintained (frequent commits). Docker images, Postgres supported, Swagger/OpenAPI included.
- Engines: whatsapp-web.js 1.34.7 or Baileys 7.0.0-rc14, selectable per session.
- **Group sender identity is exposed.** `IncomingMessage` has `chatId`/`from` (the group) and `author` (the real sender WID) for group messages. This satisfies the plan §8 requirement `provider + conversation_id + participant_id`.
- Caveat: some senders arrive as privacy ids (`@lid`). OpenWA resolves a phone as `senderPhone` on the inbound path. The session key must use one stable id consistently (`author`, falling back to `senderPhone` only if `author` is absent). Needs a live test with two real group members.
- Sending: `send-text`, `send-document`, `send-image`, ... plus `quotedMessageId` for replying to the asker inside a group, and an `Idempotency-Key` header.
- Webhooks: HMAC signed, events `message.received`, `session.status`, ...
- Official limits stated by the project itself: unofficial client, non-zero ban risk, use a dedicated number; Baileys is riskier than whatsapp-web.js; not recommended as-is for regulated uses. A medical-college study library is not a regulated healthcare use, but the risk still applies.

### Alternatives considered

| Option | Verdict |
|---|---|
| Meta WhatsApp Cloud API | Official, but billed per template message and group support is not confirmed for this use. Skipped (paid). Adapter keeps it possible later. |
| whatsapp-web.js / Baileys directly | Free, but then we rebuild REST, webhooks, session storage, QR, reconnect. OpenWA already wraps both. Rejected as "from scratch". |
| WPPConnect (+ wppconnect-server) | LGPL-3.0, same unofficial risk. Fallback if OpenWA is dropped. |
| Evolution API, WAHA | Not inspected in this pass. Candidates if OpenWA fails the two-member group test. WAHA's free tier is limited, so verify before relying on it. |
| whatsmeow (Go) | Good library, but a different language from the rest of the stack. Not chosen. |

## 3. Telegram

- **GramJS** is chosen to keep one language (TypeScript). Telethon (Python) and TDLib are equally capable but add a second runtime.
- Needs `api_id` / `api_hash` from my.telegram.org (free) and a logged-in account that can read the channel. Use a dedicated account, never commit the session string.
- The channel is public (`t.me/BahriMed`). A login-free path (parsing `t.me/s/BahriMed`) may exist for metadata. It could not be tested from this sandbox (proxy returned 403 for t.me). Not relied on. It also cannot download files, so file delivery would still need MTProto or Drive.
- `result.json` stays a test fixture only.

## 4. Drive

- Official API is free (quota based). OAuth per owner account, or a service account for folders explicitly shared with it. Per-source `credential_ref` points to env/secret files.
- No ready-made indexer is needed. `rclone lsjson` was considered as a metadata lister, but it adds a binary and a second auth system, so the Node client is simpler.

## 5. Delivery

- Telegram file -> temporary bounded download via GramJS -> OpenWA `send-document` -> delete temp. Links to Telegram and Drive are always appended. If send fails, links only.
- Drive files can be sent only if the service identity can download them. That counts as transfer for delivery, not for indexing. Metadata-only rule for indexing is unchanged.

## 6. Blockers and risks to confirm with the owner before building the bot logic

1. **Accept the risk of an unofficial WhatsApp client** (possible number ban). Plan says this must be explicit. Recommend a dedicated SIM and whatsapp-web.js engine (lower ban risk than Baileys), with low send rate.
2. **A dedicated WhatsApp number** that will be the bot.
3. **A Telegram account** able to read the channel, and `api_id` / `api_hash`.
4. **Google access**: which accounts own the Drive folders, OAuth vs sharing to a service account.
5. **Hosting**: needs an always-on machine (free tiers sleep; OpenWA with whatsapp-web.js needs Chromium and roughly 1 GB RAM). Not decided.
6. Live two-member group test of `author` stability (`@lid`) once a number is linked.

## 7. Proposed revised build order

1. Repo scaffold: TypeScript, zod config, Drizzle schema + migration, pino, vitest, docker-compose (Postgres + OpenWA), `.env.example`.
2. Telegram sync (GramJS) + parser tested against `result.json` shape.
3. Drive sync (googleapis).
4. Classification + search (Postgres FTS/trgm, Arabic normalization).
5. Provider adapter + session state machine + webhook receiver (per-participant key).
6. Delivery with link fallback.
7. Admin commands, backups, docs.

## 8. Update 2026-10-26: lite mode (direct Baileys)

Decision: free hosts that need no card (bot-hosting.net, Wispbyte) cannot run Docker or a separate OpenWA container, and Oracle sign-up was not possible. Added `WHATSAPP_PROVIDER=baileys`: the bot uses `@whiskeysockets/baileys` directly behind the same `WhatsAppProvider` interface, with the login and Signal keys stored in Postgres (`wa_auth_state`), so ephemeral disks are fine. OpenWA mode is unchanged and remains the recommended setup where Docker is available. Ban risk is accepted by the owner. Measured idle RSS about 140 MB (no Telegram/Drive activity), so a 256 MB host is plausible but unproven under sync load.
