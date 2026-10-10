"""UX analytics, privacy first (U1.09): an organisation opts in (off by default), then its sites
record what people do in the browser as events: a page viewed, a task done, the command palette
used, help opened, an error shown. An event is a kind, a name from a fixed vocabulary, a time and a
hashed session; never a user, a record's id or free text. Kept 90 days.

Revision ID: 0033
Revises: 0032
Create Date: 2026-10-10 19:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0033"
down_revision: str | None = "0032"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Tables of a site's data (row security, T5.04): tests/test_row_security.py reads this.
SITE_TABLES = ("ux_events",)

UPGRADE = """
ALTER TABLE orgs ADD COLUMN ux_analytics boolean NOT NULL DEFAULT false;

CREATE TABLE ux_events (
    id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    site_id uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    at      timestamptz NOT NULL DEFAULT now(),
    kind    text NOT NULL CHECK (kind IN ('page', 'task', 'palette', 'help', 'error')),
    name    text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
    session text NOT NULL CHECK (session ~ '^[0-9a-f]{16}$')
);
CREATE INDEX ux_events_site_at ON ux_events (site_id, at);
"""

DOWNGRADE = """
DROP TABLE ux_events;
ALTER TABLE orgs DROP COLUMN ux_analytics;
"""


def upgrade() -> None:
    op.execute(UPGRADE)
    for table in SITE_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY site_rows ON {table} USING (tiles_site_visible(site_id))"
            " WITH CHECK (tiles_site_visible(site_id))"
        )


def downgrade() -> None:
    op.execute(DOWNGRADE)
