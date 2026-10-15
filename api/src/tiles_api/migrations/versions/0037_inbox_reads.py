"""Notification centre (U5.07): which items of their inbox each person has read. The inbox itself
is worked out from what waits for them (warnings assigned to them, change requests and insights to
review, imports that never finished); a read mark is kept by the item's key, which names its
version (a warning assigned again is a new item).

Revision ID: 0037
Revises: 0036
Create Date: 2026-10-15 15:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0037"
down_revision: str | None = "0036"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Tables of a site's data (row security, T5.04): tests/test_row_security.py reads this.
SITE_TABLES = ("inbox_reads",)

UPGRADE = """
CREATE TABLE inbox_reads (
    site_id  uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    user_id  uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    key      text NOT NULL CHECK (length(key) BETWEEN 1 AND 120),
    read_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, user_id, key)
);
CREATE INDEX inbox_reads_age ON inbox_reads (read_at);
"""

DOWNGRADE = """
DROP TABLE inbox_reads;
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
