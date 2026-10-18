"""Recommendation outcomes (T11.03): what followed an applied recommendation against what the model
expected. A recommendation may name the signal that measures its outcome (a scrap rate, a porosity
reading) and how many days after it was applied to judge it; the outcome itself is worked out when
it is read, from that signal's readings and the machine's events before and after.

Revision ID: 0045
Revises: 0044
Create Date: 2026-10-18 18:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0045"
down_revision: str | None = "0044"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
ALTER TABLE recommendations
    ADD COLUMN outcome_signal_id uuid REFERENCES signals (id) ON DELETE SET NULL,
    ADD COLUMN outcome_days integer NOT NULL DEFAULT 7 CHECK (outcome_days BETWEEN 1 AND 90);
"""

DOWNGRADE = """
ALTER TABLE recommendations DROP COLUMN outcome_days, DROP COLUMN outcome_signal_id;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
