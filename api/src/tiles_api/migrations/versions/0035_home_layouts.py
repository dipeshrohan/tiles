"""Home by role (U5.01): the cards each person chose for their home on a site, in their order. A
person with no row gets their role's cards.

Revision ID: 0035
Revises: 0034
Create Date: 2026-10-15 09:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0035"
down_revision: str | None = "0034"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Tables of a site's data (row security, T5.04): tests/test_row_security.py reads this.
SITE_TABLES = ("home_layouts",)

UPGRADE = """
CREATE TABLE home_layouts (
    site_id    uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    cards      text[] NOT NULL CHECK (cardinality(cards) <= 16),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, user_id)
);
"""

DOWNGRADE = """
DROP TABLE home_layouts;
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
