#!/usr/bin/env bash
# Spins up a throwaway local PostgreSQL, applies the Supabase shim + all migrations,
# runs the DB test suite (RLS + Postgres repository), then destroys the cluster.
# Requires PostgreSQL >= 15 binaries (PG_BIN overrides auto-detection).
set -euo pipefail
cd "$(dirname "$0")/.."

PG_BIN="${PG_BIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
[ -x "$PG_BIN/initdb" ] || { echo "PostgreSQL binaries not found (set PG_BIN)"; exit 1; }
PORT="${PG_TEST_PORT:-54329}"
DATA="$(mktemp -d)"
run() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
[ "$(id -u)" = 0 ] && chown postgres "$DATA"

cleanup() { run "'$PG_BIN/pg_ctl' -D '$DATA' -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$DATA"; }
trap cleanup EXIT

run "'$PG_BIN/initdb' -D '$DATA' -U postgres --auth=trust -E UTF8 --locale=C.UTF-8" >/dev/null
run "'$PG_BIN/pg_ctl' -D '$DATA' -o '-p $PORT -k /tmp -c listen_addresses=127.0.0.1' -w -l '$DATA/log' start" >/dev/null

PSQL=(psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${PSQL[@]}" -d postgres -c 'create database app_test'
"${PSQL[@]}" -d app_test -f supabase/tests/local_supabase_shim.sql
for f in supabase/migrations/*.sql; do echo "migrate: $f"; "${PSQL[@]}" -d app_test -f "$f"; done

DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/app_test" npx vitest run tests/db --no-file-parallelism "$@"
