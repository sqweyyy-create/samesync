#!/bin/sh
# Runs once, when the local Docker volume is first created.
# Creates the restricted runtime role with a login. Migrations only ever create it NOLOGIN
# (no passwords in migrations) and grant privileges to it.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v app_password="$APP_DB_PASSWORD" <<'EOSQL'
SELECT format('CREATE ROLE samesync_app LOGIN PASSWORD %L', :'app_password') \gexec
EOSQL
