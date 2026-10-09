"""Datasets (T3.11): batch tables from the MES or quality systems (one row per batch: its settings,
measurements and whether it passed), uploaded for the correlation finder.

A dataset declares its columns (number, text or true/false); each row is a JSON object of them,
kept in upload order.

Revision ID: 0014
Revises: 0013
Create Date: 2026-10-09 05:45:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0014"
down_revision: str | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE datasets (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id      uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    description  text NOT NULL DEFAULT '',
    columns      jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
    row_count    integer NOT NULL DEFAULT 0,
    created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, name)
);

CREATE TABLE dataset_rows (
    dataset_id  uuid NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
    i           integer NOT NULL,
    row         jsonb NOT NULL CHECK (jsonb_typeof(row) = 'object'),
    PRIMARY KEY (dataset_id, i)
);
"""

DOWNGRADE = """
DROP TABLE dataset_rows;
DROP TABLE datasets;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
