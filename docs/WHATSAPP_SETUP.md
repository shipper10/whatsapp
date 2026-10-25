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

Groups: add the bot number to the group. Members start with a trigger word (`مكتبة` / `library`, editable in the
`group.triggers` setting). Each member then has their own menu; the bot replies by quoting that member.

Notes
- `SSRF_ALLOWED_HOSTS=bot` in docker-compose.yml is required, otherwise OpenWA refuses to call the bot container.
- The WhatsApp login is stored in the `openwa-data` volume: back it up, never commit it.
