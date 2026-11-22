#!/usr/bin/env bash
# Rebuilds a local Postgres test database from the migrations.
# usage: scripts/test/rebuild-local-db.sh <dbname>   (PGHOST/PGPORT/PGUSER from env)
set -euo pipefail
DB=${1:-portal_test}
cd "$(dirname "$0")/../.."
psql -q -c "drop database if exists $DB" -c "create database $DB"
for f in supabase/tests/00_local_auth_stub.sql supabase/migrations/*.sql; do
  psql -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f" >/dev/null
done
echo "rebuilt $DB"
