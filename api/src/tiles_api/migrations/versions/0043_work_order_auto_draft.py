"""Work orders drafted by Tiles (T9.02): a site's `work_order_lead_days` (none: off) makes
`tiles-draft-work-orders` draft one for each component predicted to reach its wear limit within that
many days. A component has at most one open work order, however it was drafted.

Revision ID: 0043
Revises: 0042
Create Date: 2026-10-18 02:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0043"
down_revision: str | None = "0042"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
ALTER TABLE sites ADD COLUMN work_order_lead_days integer
    CHECK (work_order_lead_days IS NULL OR work_order_lead_days BETWEEN 1 AND 365);
CREATE UNIQUE INDEX work_orders_one_open_per_component ON work_orders (site_id, signal_id)
    WHERE source = 'remaining_life' AND status IN ('draft', 'approved', 'exported');
"""

DOWNGRADE = """
DROP INDEX work_orders_one_open_per_component;
ALTER TABLE sites DROP COLUMN work_order_lead_days;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
