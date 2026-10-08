"""Data-quality checks (T2.09): each signal's expected range and stuck limit, and its last check.

`signals.range_min`/`range_max` bound the values a signal may take; `stuck_after_s`
is how long a numeric signal may hold one value before it counts as stuck (null:
one hour). `signal_quality` keeps each signal's latest check: its badge and the
report behind it, so the catalogue can show badges without reading the samples.

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-08 12:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
ALTER TABLE signals
    ADD COLUMN range_min double precision CHECK (range_min NOT IN ('NaN', 'Infinity', '-Infinity')),
    ADD COLUMN range_max double precision CHECK (range_max NOT IN ('NaN', 'Infinity', '-Infinity')),
    ADD COLUMN stuck_after_s double precision CHECK (stuck_after_s > 0),
    ADD CONSTRAINT signals_range_order CHECK (range_min < range_max);

CREATE TABLE signal_quality (
    signal_id   uuid PRIMARY KEY REFERENCES signals (id) ON DELETE CASCADE,
    site_id     uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    badge       text NOT NULL CHECK (badge IN ('good', 'warn', 'bad', 'unknown')),
    checked_at  timestamptz NOT NULL,
    report      jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object')
);
CREATE INDEX signal_quality_badge ON signal_quality (site_id, badge);
"""

DOWNGRADE = """
DROP TABLE signal_quality;
ALTER TABLE signals DROP COLUMN range_min, DROP COLUMN range_max, DROP COLUMN stuck_after_s;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
