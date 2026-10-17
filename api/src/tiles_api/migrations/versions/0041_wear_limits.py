"""Remaining life (T9.01): a signal's wear limit, the level at which the component it measures is
worn out, and which way wear moves it (both or neither). The remaining-life report runs the wear check on every
signal with one (api_remaining_life.py).

Revision ID: 0041
Revises: 0040
Create Date: 2026-10-17 09:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0041"
down_revision: str | None = "0040"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
ALTER TABLE signals
    ADD COLUMN wear_limit      double precision CHECK (wear_limit IS NULL OR wear_limit BETWEEN -1e15 AND 1e15),
    ADD COLUMN wear_direction  text CHECK (wear_direction IN ('up', 'down')),
    -- A limit says which way wear moves the signal towards it.
    ADD CONSTRAINT signals_wear_limit_has_direction CHECK ((wear_limit IS NULL) = (wear_direction IS NULL));
"""

DOWNGRADE = """
ALTER TABLE signals DROP CONSTRAINT signals_wear_limit_has_direction, DROP COLUMN wear_direction,
    DROP COLUMN wear_limit;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
