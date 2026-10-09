"""Site-level permissions in the database (T5.04): row-level security on every table of a site's
data, so a query a request makes can't reach another site's rows even if it forgets to filter.

The setting `tiles.site_id` says whose rows a transaction may see and write:
- a site's id: that site's rows only (SiteContext sets it for a request on a site, before
  anything else; an edge agent's endpoints set it to the agent's site once its token is known);
- `*`: every site's rows (scheduled jobs and migrations connect with it; `store.all_sites` sets
  it for the few counts that span an organisation, and the agent's token lookup);
- unset: no rows. Code that names no site sees nothing, rather than everything.

Policies are forced, so they hold for the tables' owner. A superuser (or a role with BYPASSRLS)
skips them all the same, as Compose's database user is: the API then works as `tiles_app`, a role
made here that can't log in or skip them, granted every table (`store.act_as_app`; the migration
runner grants it new tables too). Child rows follow their parent's site (a conversation's
messages, a dataset's rows, a warning's activity), through the parent's own policy.

The `samples` hypertable can't have row security while it is compressed (TimescaleDB), so
`tiles_app` may not touch it: it reads `site_samples`, a view of the readings of the signals the
setting lets it see, and stores readings with `tiles_store_samples`, which keeps only those of
such signals.

Revision ID: 0024
Revises: 0023
Create Date: 2026-10-09 13:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0024"
down_revision: str | None = "0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Every table with a site_id column (tests/test_row_security.py keeps this list complete).
SITE_TABLES = (
    "audit_log",
    "change_request_comments",
    "change_requests",
    "commits",
    "conversations",
    "copilot_feedback",
    "copilot_usage",
    "datasets",
    "design_projects",
    "design_runs",
    "detectors",
    "edge_agents",
    "events",
    "imports",
    "insight_numbers",
    "insights",
    "model_bindings",
    "notification_prefs",
    "notifications",
    "ontology_edges",
    "ontology_nodes",
    "run_numbers",
    "runs",
    "signal_quality",
    "signals",
    "site_members",
    "site_notifications",
    "staged_ops",
    "sweeps",
    "warnings",
)
# Rows that belong to a site through their parent: (table, column, parent table).
CHILD_TABLES = (
    ("conversation_messages", "conversation_id", "conversations"),
    ("dataset_rows", "dataset_id", "datasets"),
    ("warning_activity", "warning_id", "warnings"),
)

FUNCTION = """
CREATE FUNCTION tiles_site_visible(site uuid) RETURNS boolean LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT coalesce(current_setting('tiles.site_id', true), '') = '*'
        OR site::text = current_setting('tiles.site_id', true)
$$;
"""

# The readings `tiles_app` may see: those of the signals the setting lets it see. A security
# barrier, so a caller's conditions can't look at rows before the filter has dropped them.
SITE_SAMPLES = """
CREATE VIEW site_samples WITH (security_barrier = true) AS
SELECT s.* FROM samples s
WHERE s.signal_id IN (SELECT g.id FROM signals g WHERE tiles_site_visible(g.site_id));
"""


# The role requests run as when the API's own login would skip row security. Roles belong to the
# whole server, so it may exist already (another database of it).
APP_ROLE = """
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tiles_app') THEN
        CREATE ROLE tiles_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
    END IF;
    EXECUTE 'GRANT tiles_app TO ' || quote_ident(current_user);
    PERFORM tiles_grant_app();
EXCEPTION WHEN insufficient_privilege THEN
    -- A login that may not make roles isn't a superuser either: it owns the tables, and their
    -- forced policies hold for it as they are.
    RAISE NOTICE 'tiles_app not made (%): row security applies to this login itself', SQLERRM;
END
$$;
"""


# Stores readings, skipping those already stored and those of signals the setting doesn't let the
# caller see; the number stored. It runs as its owner, who may write the hypertable.
STORE_SAMPLES = """
CREATE FUNCTION tiles_store_samples(
    ids uuid[], ats timestamptz[], vals float8[], texts text[], bools boolean[], qualities text[]
) RETURNS bigint LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    WITH stored AS (
        INSERT INTO samples (signal_id, at, value, value_text, value_bool, quality)
        SELECT u.signal_id, u.at, u.value, u.value_text, u.value_bool, coalesce(u.quality, 'good')
        FROM unnest(ids, ats, vals, texts, bools, qualities)
             AS u (signal_id, at, value, value_text, value_bool, quality)
        WHERE u.signal_id IN (SELECT g.id FROM signals g WHERE tiles_site_visible(g.site_id))
        ON CONFLICT (signal_id, at) DO NOTHING
        RETURNING 1
    )
    SELECT count(*) FROM stored
$$;
REVOKE ALL ON FUNCTION tiles_store_samples(uuid[], timestamptz[], float8[], text[], boolean[], text[]) FROM PUBLIC;
"""

# What `tiles_app` may do, granted again after every migration (db.upgrade) so new tables are
# covered whoever made them: every table, except reading the readings hypertable.
GRANT_APP = """
CREATE FUNCTION tiles_grant_app() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tiles_app') THEN
        RETURN;
    END IF;
    GRANT USAGE ON SCHEMA public TO tiles_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tiles_app;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO tiles_app;
    REVOKE ALL ON samples FROM tiles_app;
    GRANT EXECUTE ON FUNCTION tiles_store_samples(uuid[], timestamptz[], float8[], text[], boolean[], text[])
        TO tiles_app;
END
$$;
"""


def upgrade() -> None:
    op.execute(FUNCTION)
    op.execute(SITE_SAMPLES)
    op.execute(STORE_SAMPLES)
    op.execute(GRANT_APP)
    op.execute(APP_ROLE)
    for table in SITE_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY site_rows ON {table} USING (tiles_site_visible(site_id))"
            " WITH CHECK (tiles_site_visible(site_id))"
        )
    for table, column, parent in CHILD_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        # The parent's own policy decides; EXISTS looks the parent up by its key.
        rule = f"EXISTS (SELECT 1 FROM {parent} p WHERE p.id = {table}.{column})"  # noqa: S608 - constants
        op.execute(f"CREATE POLICY site_rows ON {table} USING ({rule}) WITH CHECK ({rule})")


def downgrade() -> None:
    for table, *_ in CHILD_TABLES:
        op.execute(f"DROP POLICY site_rows ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
    for table in SITE_TABLES:
        op.execute(f"DROP POLICY site_rows ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
    op.execute("DROP FUNCTION tiles_store_samples(uuid[], timestamptz[], float8[], text[], boolean[], text[])")
    op.execute("DROP VIEW site_samples")
    op.execute("DROP FUNCTION tiles_site_visible(uuid)")
    # The role stays (other databases of the server may use it); this database's grants go.
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tiles_app') THEN
                REVOKE ALL ON ALL TABLES IN SCHEMA public FROM tiles_app;
                REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM tiles_app;
                REVOKE USAGE ON SCHEMA public FROM tiles_app;
            END IF;
        END
        $$;
        """
    )
    op.execute("DROP FUNCTION tiles_grant_app()")
