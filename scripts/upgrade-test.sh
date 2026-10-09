#!/usr/bin/env bash
# Upgrade test (T6.04): a database made and filled by an older version must work with this one,
# and roll back to it.
#
#   scripts/upgrade-test.sh <older ref> <admin database URL>
#
# 1. The older version (a release tag, or main for a pull request) migrates a new database, makes
#    the demo site and puts data in through its API (scripts/upgrade_check.py write).
# 2. This version migrates it to head and reads the data back through its API.
# 3. This version migrates back down to the older version's revision, and the older version reads
#    the data again: the rollback path in docs/releasing.md.
#
# Needs git, uv and a PostgreSQL + TimescaleDB server whose user may create databases.
set -euo pipefail

FROM=${1:?usage: upgrade-test.sh <older ref> <admin database URL>}
ADMIN_URL=${2:?usage: upgrade-test.sh <older ref> <admin database URL>}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$(mktemp -d)
DB="tiles_upgrade_$$"
URL=$(python3 -c 'import sys, urllib.parse as u; p = u.urlsplit(sys.argv[1]); print(p._replace(path="/" + sys.argv[2]).geturl())' "$ADMIN_URL" "$DB")

say() { printf '\n== %s\n' "$*"; }
admin() { (cd "$ROOT/api" && uv run --quiet python -c "import psycopg, sys; psycopg.connect(sys.argv[1], autocommit=True).execute(sys.argv[2])" "$ADMIN_URL" "$1"); }
cleanup() {
  admin "DROP DATABASE IF EXISTS $DB WITH (FORCE)" || true
  git -C "$ROOT" worktree remove --force "$WORK/older" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

as() { # version (older|this), command…: run against the test database from an empty directory
  local project=$ROOT/api
  [ "$1" = older ] && project=$WORK/older/api
  shift
  (cd "$WORK" && TILES_ENV=development TILES_LOG_LEVEL=WARNING TILES_DATABASE_URL="$URL" uv run --quiet --project "$project" "$@")
}

say "The older version: $FROM ($(git -C "$ROOT" rev-parse --short "$FROM"))"
git -C "$ROOT" worktree add --detach "$WORK/older" "$FROM" >/dev/null
(cd "$WORK/older/api" && uv sync --quiet --locked)
admin "CREATE DATABASE $DB"
as older tiles-migrate upgrade
as older tiles-seed >/dev/null
OLD_HEAD=$(as older python -c "
import psycopg, os
print(psycopg.connect(os.environ['TILES_DATABASE_URL']).execute('SELECT version_num FROM alembic_version').fetchone()[0])")
echo "its schema: $OLD_HEAD"
as older python "$ROOT/scripts/upgrade_check.py" write

say "Upgrade with this version"
as this tiles-migrate upgrade
as this tiles-migrate current | grep '^Rev:'
as this python "$ROOT/scripts/upgrade_check.py" read

say "Roll back to $OLD_HEAD, and the older version reads it"
as this tiles-migrate downgrade "$OLD_HEAD"
as older python "$ROOT/scripts/upgrade_check.py" read

say "Upgraded from $FROM and rolled back, with the data intact"
