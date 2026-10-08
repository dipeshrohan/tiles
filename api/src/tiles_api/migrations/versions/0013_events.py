"""Events (T3.10): downtime and scrap from the MES, joined to warnings.

An event is a reading on a signal marked as an event stream (`event_kind`: downtime, scrap or
other), however it arrived: from the edge agent's SQL connector polling the MES, MQTT, or a file
import. Its value is the event's code. Signals and detectors name the `asset` (as the MES names it,
e.g. a machine) they belong to; a detector's warnings are matched to its asset's events.

Revision ID: 0013
Revises: 0012
Create Date: 2026-10-08 15:40:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
ALTER TABLE signals
    ADD COLUMN event_kind text CHECK (event_kind IN ('downtime', 'scrap', 'other')),
    ADD COLUMN asset text CHECK (length(asset) BETWEEN 1 AND 100);
ALTER TABLE detectors
    ADD COLUMN asset text CHECK (length(asset) BETWEEN 1 AND 100);
CREATE INDEX signals_events ON signals (site_id, asset) WHERE event_kind IS NOT NULL;
"""

DOWNGRADE = """
DROP INDEX signals_events;
ALTER TABLE detectors DROP COLUMN asset;
ALTER TABLE signals DROP COLUMN asset, DROP COLUMN event_kind;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
