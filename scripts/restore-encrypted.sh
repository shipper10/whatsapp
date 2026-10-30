#!/bin/sh
# Restore a backup made by .github/workflows/backup.yml.
# Usage: BACKUP_PASSPHRASE=... DATABASE_URL=... restore-encrypted.sh db-YYYYMMDDTHHMMSSZ.sql.gz.enc --yes
# STOP the bot first (Render: Suspend). WhatsApp must be linked again afterwards (the login is not in backups).
set -eu
FILE="${1:-}"
[ -f "$FILE" ] || { echo "usage: $0 <db-....sql.gz.enc> --yes" >&2; exit 2; }
[ "${2:-}" = "--yes" ] || { echo "This REPLACES the current data. Re-run with --yes to confirm." >&2; exit 2; }
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE}" "${DATABASE_URL:?set DATABASE_URL}"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$FILE" | gunzip | psql -v ON_ERROR_STOP=1 "$DATABASE_URL"
echo "restore finished. Start the bot and open /admin/link to link WhatsApp again."
