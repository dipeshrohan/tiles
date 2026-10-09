#!/usr/bin/env bash
# Point-in-time recovery drill (T5.14), on Docker: proves a Tiles database can be brought back to
# the moment before a mistake from a base backup and its archived WAL.
#
#   deploy/backup/pitr-drill.sh            (from the repository root; needs Docker and uv)
#
# 1. A TimescaleDB server archives its WAL; Tiles' migrations and the demo site are applied.
# 2. Readings are written, a base backup taken, more readings written: the good state.
# 3. A mistake: every reading deleted. The server is then lost, volume and all.
# 4. A new server restores the base backup and replays the archive to just before the mistake.
# 5. Checks: every reading of the good state is back, the mistake isn't, the schema is at head
#    and the API's own checks pass against it. Timings are printed (and kept in $DRILL_REPORT).
#
# The same steps, with your backup tool's commands, are the monthly drill in
# docs/runbooks/backups.md.
set -euo pipefail

IMAGE=${TILES_DB_IMAGE:-timescale/timescaledb:2.30.2-pg17}
PORT=${DRILL_PORT:-55433}
REPORT=${DRILL_REPORT:-}
RUN=tiles-drill-$$
PASSWORD=drill-$(od -An -N12 -tx1 /dev/urandom | tr -d ' \n')
URL="postgresql://tiles:${PASSWORD}@127.0.0.1:${PORT}/tiles"
cd "$(dirname "$0")/../.."

say() { printf '\n== %s\n' "$*"; }
cleanup() {
  docker rm -f "$RUN-primary" "$RUN-restored" >/dev/null 2>&1 || true
  docker volume rm "$RUN-data" "$RUN-archive" "$RUN-base" "$RUN-restore" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql_in() { # container, SQL: one value, unaligned
  docker exec "$1" psql -X -v ON_ERROR_STOP=1 -U tiles -d tiles -Atc "$2"
}
wait_ready() { # container: accepting connections over TCP, out of recovery
  for _ in $(seq 1 180); do
    if docker exec "$1" pg_isready -q -h 127.0.0.1 -U tiles -d tiles 2>/dev/null \
      && [ "$(psql_in "$1" 'SELECT pg_is_in_recovery()' 2>/dev/null)" = f ]; then
      return 0
    fi
    sleep 1
  done
  docker logs "$1" | tail -40
  echo "$1 didn't become ready" >&2
  return 1
}
count() { # container, tag prefix: readings of the drill's signals
  psql_in "$1" "SELECT count(*) FROM samples x JOIN signals g ON g.id = x.signal_id WHERE g.tag LIKE '$2%'"
}

say "A server that archives its WAL ($IMAGE)"
for v in data archive base restore; do docker volume create "$RUN-$v" >/dev/null; done
docker run --rm -v "$RUN-archive:/archive" -v "$RUN-base:/backup" "$IMAGE" chown postgres:postgres /archive /backup
docker run -d --name "$RUN-primary" -p "127.0.0.1:$PORT:5432" \
  -e POSTGRES_USER=tiles -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=tiles \
  -v "$RUN-data:/var/lib/postgresql/data" -v "$RUN-archive:/archive" -v "$RUN-base:/backup" "$IMAGE" \
  postgres -c wal_level=replica -c archive_mode=on -c archive_timeout=60 \
  -c 'archive_command=test ! -f /archive/%f && cp %p /archive/%f' >/dev/null
wait_ready "$RUN-primary"

say "Tiles' schema and the demo site"
(cd api && TILES_DATABASE_URL="$URL" uv run --quiet tiles-migrate upgrade && TILES_DATABASE_URL="$URL" uv run --quiet tiles-seed)
SITE=$(psql_in "$RUN-primary" "SELECT s.id FROM sites s JOIN orgs o ON o.id = s.org_id WHERE o.slug = 'demo' LIMIT 1")
write() { # tag, readings: one a second, ending now
  psql_in "$RUN-primary" "
    WITH s AS (INSERT INTO signals (site_id, tag) VALUES ('$SITE', '$1') RETURNING id)
    INSERT INTO samples (signal_id, at, value)
    SELECT s.id, now() - make_interval(secs => i), i FROM s, generate_series(1, $2) i" >/dev/null
}
write drill.before-backup 5000

say "Base backup"
started=$(date +%s)
docker exec "$RUN-primary" pg_basebackup -U tiles -D /backup/base -X stream -c fast
echo "took $(( $(date +%s) - started ))s"

say "More readings after the backup: the good state"
write drill.after-backup 3000
GOOD=$(psql_in "$RUN-primary" 'SELECT now()')
echo "recover to $GOOD"
sleep 2 # the mistake commits strictly later

say "The mistake, then the server is lost"
psql_in "$RUN-primary" "DELETE FROM samples" >/dev/null
test "$(count "$RUN-primary" drill.)" = 0
LAST=$(psql_in "$RUN-primary" 'SELECT pg_walfile_name(pg_switch_wal())')
for _ in $(seq 1 60); do # the WAL holding the mistake is archived: recovery has to see past it
  [ "$(psql_in "$RUN-primary" "SELECT coalesce(last_archived_wal >= '$LAST', false) FROM pg_stat_archiver")" = t ] && break
  sleep 1
done
docker rm -f "$RUN-primary" >/dev/null
docker volume rm "$RUN-data" >/dev/null

say "Restore: the base backup, then the archive up to $GOOD"
started=$(date +%s)
docker run --rm -v "$RUN-base:/backup:ro" -v "$RUN-restore:/var/lib/postgresql/data" "$IMAGE" sh -euc "
  cp -a /backup/base/. /var/lib/postgresql/data/
  chown -R postgres:postgres /var/lib/postgresql/data && chmod 700 /var/lib/postgresql/data
  touch /var/lib/postgresql/data/recovery.signal
  cat >> /var/lib/postgresql/data/postgresql.auto.conf <<CONF
restore_command = 'cp /archive/%f %p'
recovery_target_time = '$GOOD'
recovery_target_action = 'promote'
archive_mode = off
CONF"
docker run -d --name "$RUN-restored" -p "127.0.0.1:$PORT:5432" \
  -v "$RUN-restore:/var/lib/postgresql/data" -v "$RUN-archive:/archive:ro" "$IMAGE" >/dev/null
wait_ready "$RUN-restored"
RESTORE_S=$(( $(date +%s) - started ))
echo "took ${RESTORE_S}s"

say "Checks"
before=$(count "$RUN-restored" drill.before-backup)
after=$(count "$RUN-restored" drill.after-backup)
echo "readings: $before from before the backup, $after from after it (5000 and 3000 written)"
test "$before" = 5000
test "$after" = 3000
docker logs "$RUN-restored" 2>&1 | grep -q 'recovery stopping before commit' \
  || { echo "recovery didn't stop at the target" >&2; exit 1; }
(cd api && TILES_DATABASE_URL="$URL" uv run --quiet tiles-migrate current) | grep '^Rev:' | tee /dev/stderr | grep -q '(head)'
# The API's row security role came back with the rest (migration 0024).
test "$(psql_in "$RUN-restored" "SELECT count(*) FROM pg_roles WHERE rolname = 'tiles_app'")" = 1
(cd api && TILES_DATABASE_URL="$URL" uv run --quiet python -c '
from tiles_api.readiness import check_database
from tiles_api.settings import Settings
check_database(Settings(_env_file=None))
print("the API reaches it")')

say "Restored to $GOOD in ${RESTORE_S}s: every reading of the good state is back, the mistake isn't"
if [ -n "$REPORT" ]; then
  printf '| %s | %s | %ss | 8000 of 8000 readings |\n' "$(date -u +%Y-%m-%dT%H:%MZ)" "$IMAGE" "$RESTORE_S" >> "$REPORT"
fi
