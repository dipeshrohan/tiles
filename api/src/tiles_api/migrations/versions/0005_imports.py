"""File imports (T2.07): each bulk import of readings (a CSV or historian export), who ran it and what it stored.

The readings themselves go into `samples` like any others; this table keeps one
row per import, so the backfill is attributable and its counts are visible.

Revision ID: 0005
Revises: 0004
Create Date: 2026-10-08 09:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE imports (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id      uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    created_by   uuid REFERENCES users (id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    received     bigint NOT NULL DEFAULT 0 CHECK (received >= 0),
    stored       bigint NOT NULL DEFAULT 0 CHECK (stored >= 0 AND stored <= received),
    finished_at  timestamptz
);
CREATE INDEX imports_site ON imports (site_id, created_at DESC);
"""

DOWNGRADE = """
DROP TABLE imports;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
