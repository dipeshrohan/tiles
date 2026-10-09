"""Job runs (T5.13): each run of a scheduled job (tiles-detect, tiles-notify, …) with its outcome,
duration and items, so the API can report every job's last run as a gauge; a job process is too
short-lived to keep a counter of its own. Kept for 30 days. Also an index for the notifications
given up lately, which the API reports too.

Revision ID: 0026
Revises: 0025
Create Date: 2026-10-09 18:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0026"
down_revision: str | None = "0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE job_runs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    command text NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('ok', 'failed')),
    started_at timestamptz NOT NULL,
    finished_at timestamptz NOT NULL,
    items_ok integer NOT NULL DEFAULT 0,
    items_failed integer NOT NULL DEFAULT 0
);
CREATE INDEX job_runs_command ON job_runs (command, finished_at DESC);
CREATE INDEX notifications_given_up ON notifications (failed_at) WHERE failed_at IS NOT NULL;
"""

DOWNGRADE = """
DROP INDEX notifications_given_up;
DROP TABLE job_runs;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
