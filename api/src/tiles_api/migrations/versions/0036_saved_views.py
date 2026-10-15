"""Saved views (U5.06): a page's filters, sort and columns kept under a name by a person, for
themselves or shared with everyone on the site.

Revision ID: 0036
Revises: 0035
Create Date: 2026-10-15 12:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0036"
down_revision: str | None = "0035"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Tables of a site's data (row security, T5.04): tests/test_row_security.py reads this.
SITE_TABLES = ("saved_views",)

UPGRADE = """
CREATE TABLE saved_views (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id    uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    owner_id   uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    page       text NOT NULL CHECK (page IN ('warnings', 'signals', 'documents')),
    name       text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
    query      jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(query) = 'object'),
    table_prefs jsonb CHECK (table_prefs IS NULL OR jsonb_typeof(table_prefs) = 'object'),
    shared     boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, owner_id, page, name)
);
CREATE INDEX saved_views_shared ON saved_views (site_id, page) WHERE shared;
"""

DOWNGRADE = """
DROP TABLE saved_views;
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
