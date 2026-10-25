#!/bin/sh
# Restore a database dump. STOP the bot first:  docker compose stop bot
# Usage: restore.sh <db-dump.sql.gz> --yes
set -eu
FILE="${1:-}"
[ -f "$FILE" ] || { echo "usage: $0 <db-YYYYMMDDTHHMMSSZ.sql.gz> --yes" >&2; exit 2; }
[ "${2:-}" = "--yes" ] || { echo "This REPLACES the current data. Re-run with --yes to confirm." >&2; exit 2; }
gzip -t "$FILE"
gunzip -c "$FILE" | psql -v ON_ERROR_STOP=1 "$DATABASE_URL"
echo "restore finished. Start the bot again:  docker compose start bot"
