#!/bin/sh
# Daily backup: PostgreSQL dump (+ the WhatsApp login volume when mounted). Runs inside the `backup` service.
set -eu
DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$DIR"

TMP="$DIR/.db-$TS.sql.gz.part"
pg_dump --no-owner --clean --if-exists "$DATABASE_URL" | gzip > "$TMP"
gzip -t "$TMP"                                   # refuse to keep a corrupt archive
mv "$TMP" "$DIR/db-$TS.sql.gz"
echo "backup ok: db-$TS.sql.gz ($(wc -c < "$DIR/db-$TS.sql.gz") bytes)"

if [ -d /openwa-data ]; then
  tar -czf "$DIR/.openwa-$TS.tar.gz.part" -C /openwa-data . && mv "$DIR/.openwa-$TS.tar.gz.part" "$DIR/openwa-$TS.tar.gz"
  echo "backup ok: openwa-$TS.tar.gz"
fi

find "$DIR" -maxdepth 1 \( -name 'db-*.sql.gz' -o -name 'openwa-*.tar.gz' \) -mtime +"$KEEP_DAYS" -delete
