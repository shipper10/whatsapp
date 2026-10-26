# Linking the WhatsApp number (OpenWA)

Run on the host (all commands use the OpenWA API key = `OPENWA_API_KEY` in `.env`; the dashboard/API listens on
`127.0.0.1:2785`, reach it from your computer with `ssh -L 2785:localhost:2785 <host>`).

1. `docker compose up -d`
2. Create the session (use a dedicated number; the name must equal `OPENWA_SESSION_ID`):
   `curl -X POST localhost:2785/api/sessions -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"name":"library"}'`
   Put the returned session id in `.env` as `OPENWA_SESSION_ID`, then `docker compose up -d bot`.
3. Start it and scan the QR (WhatsApp > Linked devices), or use the dashboard at http://localhost:2785:
   `curl -X POST localhost:2785/api/sessions/<id>/start -H "X-API-Key: $KEY"`
   `curl localhost:2785/api/sessions/<id>/qr -H "X-API-Key: $KEY"`
4. Register the webhook (secret must equal `OPENWA_WEBHOOK_SECRET`):
   `curl -X POST localhost:2785/api/sessions/<id>/webhooks -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"url":"http://bot:3000/webhooks/openwa","events":["message.received"],"secret":"<OPENWA_WEBHOOK_SECRET>"}'`
   Test it: `POST /api/sessions/<id>/webhooks/<webhookId>/test`.
5. Send `0` to the number from another phone: the main menu should answer.

Groups: add the bot number to the group. In a group the bot answers **only** when addressed: a message starting with `!` (e.g. `!`, `!1`, `!كيمياء`; editable in the `group.triggers` setting). The person who asked may also continue by replying to the bot's answer, but only with a command (a number, `0`, `-`, `+`); free text in a reply is ignored, and a reply from anyone else is ignored (they must use `!`). Everything else is ignored, so the bot never answers ordinary chat. Each member has their own menu; the bot replies by quoting that member.

Using the bot (private chat, or with `!` in groups): the home screen is the channel's own main index; every file or sub-index has a 【number】.
- `5` opens/sends it; `1-5` or `3,7,9` send several; by type `شيت 1-5`, `محاضرة 2-4`, `كل الشيتات` (at most `delivery.maxBatch` files per request, default 15).
- Typing a subject or semester name jumps straight to its index (`كيمياء`, `chemistry`, `الفصل الثاني`). Arabic names map to the English index titles through the `library.indexAliases` setting (edit it with `/set`).
- `[ 0 ]` home, `[ - ]` back, `[ + ]` / `[ < ]` next / previous page, `[ ؟ كلمة ]` search files by name.
- Each file arrives with the channel's own text as its caption (plus its Google Drive link when a Drive copy is known).

Keeping it current: every sync re-reads all index messages, so editing an old index (new sheet, new lecture) or adding a new year/semester index, linked from the main index, appears on its own within one sync interval (default 10 minutes). Nothing needs reclassifying. Indexes that use the same layout (lines `N - title` followed by `Lecture | Sheet | MCQ` links) also work with typed batches; other layouts still work with plain numbers.

Notes
- `SSRF_ALLOWED_HOSTS=bot` in docker-compose.yml is required, otherwise OpenWA refuses to call the bot container.
- The WhatsApp login is stored in the `openwa-data` volume: back it up, never commit it.
