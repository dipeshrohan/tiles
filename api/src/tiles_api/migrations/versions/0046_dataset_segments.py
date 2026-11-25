"""Batch tables' segments (review H-11): for each text or true/false column, its values as split
segments (`correlate.segment_of`: a missing value is "(blank)"), at most 51 of them (one more than a
split may have, so "too many" is known). Kept as rows are appended, from those rows alone, so the
columns worth splitting by are known without reading every row again.

Revision ID: 0046
Revises: 0045
Create Date: 2026-11-25 08:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0046"
down_revision: str | None = "0045"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
ALTER TABLE datasets ADD COLUMN segments jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE datasets d SET segments = coalesce((
    SELECT jsonb_object_agg(c.name, (
        SELECT coalesce(jsonb_agg(s.segment ORDER BY s.segment), '[]'::jsonb) FROM (
            SELECT DISTINCT CASE
                WHEN r.row -> c.name IS NULL OR r.row -> c.name = 'null'::jsonb THEN '(blank)'
                ELSE r.row ->> c.name
            END AS segment
            FROM dataset_rows r WHERE r.dataset_id = d.id
            LIMIT 51
        ) s
    ))
    FROM jsonb_to_recordset(d.columns) AS c (name text, kind text)
    WHERE c.kind <> 'number'
), '{}'::jsonb);
"""

DOWNGRADE = """
ALTER TABLE datasets DROP COLUMN segments;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
