# Backups and restore (T5.14)

This runbook covers how Tiles' data is backed up, how to bring it back to a point in time, and the drill that proves it works. It applies to the managed cloud and to customer-hosted installs.

## What to back up

| What | How | Notes |
|---|---|---|
| The database (PostgreSQL with TimescaleDB) | Point-in-time recovery: base backups plus archived WAL | Holds everything: the ontology and its history, signals and readings, models and runs, warnings, insights, conversations, the audit log, and sealed credentials |
| Data keys (`TILES_DATA_KEYS`) | In your secrets manager, backed up by it | Never stored with the database backups, since they open the sealed credentials. Without them, the restored Teams webhook URLs can't be opened. With the Helm chart's generated key, back up the Secret `<release>-generated` |
| Other secrets | In your secrets manager | Database password, SMTP password, Anthropic API key |
| The identity provider | Its own backups (Keycloak's database, or your IdP's) | Tiles keeps only users' issuer and subject |

Edge agents need no backup. Their buffer only holds readings the API hasn't accepted yet, and a new agent can be registered.

## Targets

| | Target | How |
|---|---|---|
| Recovery point (data lost at most) | 5 minutes | WAL is archived every 5 minutes at the latest (`archive_timeout = 300`), or continuously with streaming archiving |
| Recovery time | 1 hour for a site's first year of data | Measured by the drill: note the restore time each month |
| Retention | 35 days of point-in-time recovery, and 12 monthly full backups | Covers a mistake found weeks later, and the audit trail's needs |

Backups are encrypted (see [secrets and encryption](secrets-and-encryption.md)), kept in another region or site than the database, and readable only by the backup role.

## Managed PostgreSQL

Use a service that offers TimescaleDB and point-in-time recovery:

- Timescale Cloud;
- Azure Database for PostgreSQL Flexible Server, with the `timescaledb` extension allow-listed;
- a self-managed server, below.

Amazon RDS doesn't offer TimescaleDB.

On the service, set:

- 35-day backup retention, with geo-redundant backup storage;
- storage and backups encrypted with your KMS key.

To restore, the service creates a new server at the chosen time. Then follow [After a restore](#after-a-restore).

## Self-managed PostgreSQL: pgBackRest

[pgBackRest](https://pgbackrest.org) takes the base backups and archives WAL to object storage, encrypted:

```ini
# /etc/pgbackrest/pgbackrest.conf
[global]
repo1-type=s3
repo1-s3-bucket=tiles-backups
repo1-s3-region=eu-west-1
repo1-s3-endpoint=s3.eu-west-1.amazonaws.com
repo1-path=/tiles
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=<from your secrets manager>
repo1-retention-full-type=time
repo1-retention-full=35
archive-async=y
compress-type=zst

[tiles]
pg1-path=/var/lib/postgresql/data
```

```ini
# postgresql.conf
wal_level = replica
archive_mode = on
archive_command = 'pgbackrest --stanza=tiles archive-push %p'
archive_timeout = 300
```

1. **Set up:** `pgbackrest --stanza=tiles stanza-create`, then `pgbackrest --stanza=tiles check`.
2. **Schedule (cron):**
   - a full backup weekly (`backup --type=full`);
   - a differential one daily (`backup --type=diff`).
3. **Monitor:** alert when `pgbackrest info` shows no backup in the last 26 hours, or when `pg_stat_archiver.failed_count` grows.

The Helm chart's bundled database is for evaluation and has no backups. In production, set `database.bundled=false` and point Tiles at a database backed up as described here.

## Restoring to a point in time

When something was lost (a mistaken bulk delete, a bad import, a failed migration):

1. **Find the time just before it.** The audit log helps: `GET /sites/{id}/audit` lists who did what and when. Restore to a time in UTC.
2. **Stop the writers.** Scale the API and the jobs to zero (`kubectl scale deploy/tiles-api --replicas=0`, and suspend the CronJobs). Edge agents keep buffering on site meanwhile.
3. **Restore into a new data directory or server.** Keep the damaged one until the restore is checked.
   ```sh
   pgbackrest --stanza=tiles --type=time --target="2026-10-09 14:51:37+00" \
     --target-action=promote --pg1-path=/var/lib/postgresql/restore restore
   ```
   Then start PostgreSQL on it and wait until `SELECT pg_is_in_recovery()` returns `false`.
4. **Check it** before pointing Tiles at it:
   - `tiles-migrate current` shows the expected revision;
   - the data from before the target is there (a site's latest readings, the last ontology commit);
   - the mistake is not.
5. **Point Tiles at it.** Update `tiles_database_url` in the secrets, then bring the API and jobs back:
   - with the Helm chart, change `secrets.revision` in the same `helm upgrade`;
   - the API's start runs `tiles-migrate upgrade`, which does nothing when the database is already at head.

## After a restore

- **Lost readings:** readings stored after the target time are gone. Edge agents delete readings once the API accepts them, so these can't be re-sent. Re-import them from the source (the historian, or a CSV file through the Import data page) if they matter.
- **Jobs catch up:** model bindings and detectors restart from where the restored database says they were (`done_until`, the detectors' saved state). Their next runs recompute what was lost.
- **Record it:** add an entry to the incident log saying what was restored, to when, and why. The audit log no longer shows the actions after the target.
- **Sealed credentials:** check them with a test notification. If they can't be opened, the data keys don't match the backup's; restore the keys from the secrets manager.

To copy a database to another server rather than restore it, use `pg_dump` and `pg_restore`. With TimescaleDB, both servers need the same extension version. Run `SELECT timescaledb_pre_restore();` before the restore and `SELECT timescaledb_post_restore();` after it.

## The drill

`deploy/backup/pitr-drill.sh` runs a full point-in-time recovery on Docker in under a minute:

1. A TimescaleDB server archives its WAL, and gets Tiles' schema and the demo site.
2. Readings are written, a base backup is taken, and more readings are written.
3. A mistake deletes every reading, and the server is lost.
4. A new server restores the backup and replays the archive to just before the mistake.
5. The drill checks that every reading is back, that recovery stopped at the target, that the schema is at head with the API's role, and that the API reaches the server.

CI runs it on every pull request (the **Restore drill** job), so a change to the schema or the image that breaks recovery is caught.

**Every month**, also restore the real backups into a scratch server:

1. Run steps 3 and 4 of [Restoring to a point in time](#restoring-to-a-point-in-time) with pgBackRest, or with your service's restore.
2. Use a target time of yesterday.
3. Record the result below. A failed drill is an incident.

| Date (UTC) | Backup | Restore time | Checked |
|---|---|---|---|
| | | | |
