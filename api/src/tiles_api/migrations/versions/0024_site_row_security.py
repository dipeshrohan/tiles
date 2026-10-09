"""Site-level permissions in the database (T5.04): row-level security on every table of a site's
data, so a query a request makes can't reach another site's rows even if it forgets to filter.

A request's transaction names its site with `SELECT set_config('tiles.site_id', <site>, true)`
(SiteContext does it): its rows are then the only ones visible, and the only ones it may write.
Without it (scheduled jobs, migrations, endpoints that aren't a site's, such as an edge agent's
own) every row is visible, as before: those name the rows they want. `''` clears the setting for
the rest of the transaction (`store.all_sites`), for the few counts that span an organisation.

Policies are forced, so they hold for the tables' owner. A superuser (or a role with BYPASSRLS)
skips them all the same, as Compose's database user is: the API then works as `tiles_app`, a role
made here that can't log in or skip them, granted every table (`store.open_pool` sets it). Child rows
follow their parent's site (a conversation's messages, a dataset's rows, a warning's activity),
through the parent's own policy. The `samples` hypertable can't have row security while it is
compressed (TimescaleDB): readings are reached only through `signals`, which has it.

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
    SELECT site IS NULL
        OR coalesce(current_setting('tiles.site_id', true), '') = ''
        OR site::text = current_setting('tiles.site_id', true)
$$;
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
    GRANT USAGE ON SCHEMA public TO tiles_app;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tiles_app;
    GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO tiles_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tiles_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO tiles_app;
EXCEPTION WHEN insufficient_privilege THEN
    -- A login that may not make roles isn't a superuser either: it owns the tables, and their
    -- forced policies hold for it as they are.
    RAISE NOTICE 'tiles_app not made (%): row security applies to this login itself', SQLERRM;
END
$$;
"""


def upgrade() -> None:
    op.execute(APP_ROLE)
    op.execute(FUNCTION)
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
        rule = f"{column} IN (SELECT id FROM {parent})"  # noqa: S608 - constants; the parent's policy decides
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
    op.execute("DROP FUNCTION tiles_site_visible(uuid)")
    # The role stays (other databases of the server may use it); this database's grants go.
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tiles_app') THEN
                ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM tiles_app;
                ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM tiles_app;
                REVOKE ALL ON ALL TABLES IN SCHEMA public FROM tiles_app;
                REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM tiles_app;
                REVOKE USAGE ON SCHEMA public FROM tiles_app;
            END IF;
        END
        $$;
        """
    )
