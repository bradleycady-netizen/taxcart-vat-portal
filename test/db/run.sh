#!/usr/bin/env bash
# Runs the schema, security and operations checks against a scratch database on any Postgres you can reach.
# Uses the standard PG* environment variables (PGHOST, PGPORT, PGUSER, PGPASSWORD).
# Needs a role that can create databases and roles. Do NOT point this at a real Supabase project.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
db="taxcart_schema_test"

dropdb --if-exists "$db"
createdb "$db"
trap 'dropdb --if-exists "$db"' EXIT

run() { psql -X -q -v ON_ERROR_STOP=1 -d "$db" -f "$1"; }

run "$here/auth_stub.sql"
for migration in "$here"/../../supabase/migrations/*.sql; do run "$migration"; done
run "$here/rls_checks.sql" | grep -E 'PASSED' || true
run "$here/ops_checks.sql" | grep -E 'PASSED' || true
run "$here/view_checks.sql" | grep -E 'PASSED' || true
run "$here/credential_checks.sql" | grep -E 'PASSED' || true
run "$here/logo_role_checks.sql" | grep -E 'PASSED' || true
run "$here/vat_checks.sql" | grep -E 'PASSED' || true
