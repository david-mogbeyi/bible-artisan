#!/usr/bin/env bash
# Creates the dev and test databases on a native PostgreSQL (idempotent), then migrates both.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || cp .env.example .env
set -a; source .env; set +a

for url in "$DATABASE_URL" "$DATABASE_URL_TEST"; do
  db="${url##*/}"; db="${db%%\?*}"
  admin="${url%/*}/postgres"
  if ! psql "$admin" -Atc "SELECT 1 FROM pg_database WHERE datname = '$db'" | grep -q 1; then
    psql "$admin" -c "CREATE DATABASE \"$db\"" >/dev/null && echo "created $db"
  else
    echo "exists  $db"
  fi
done

pnpm --filter @bible-artisan/api db:migrate
DATABASE_URL="$DATABASE_URL_TEST" pnpm --filter @bible-artisan/api db:migrate
