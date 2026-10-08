"""The warning workflow (T3.07): a raised warning is acknowledged, assigned and resolved, with an
outcome (a true alarm, a false alarm, or unknown), and each step is kept in its activity.

The workflow is separate from whether the signal is still out (`ended_at`): a warning can be
resolved while its signal is still out, and a warning whose signal came back can still be waiting
for someone to look at it.

Revision ID: 0011
Revises: 0010
Create Date: 2026-10-08 13:20:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
ALTER TABLE warnings
    ADD COLUMN acknowledged_at  timestamptz,
    ADD COLUMN acknowledged_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN assignee_id      uuid REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN resolved_at      timestamptz,
    ADD COLUMN resolved_by      uuid REFERENCES users (id) ON DELETE SET NULL,
    ADD COLUMN outcome          text CHECK (outcome IN ('true_alarm', 'false_alarm', 'unknown')),
    ADD COLUMN resolution_note  text NOT NULL DEFAULT '',
    -- Resolved means it has an outcome, and was acknowledged on the way.
    ADD CONSTRAINT warnings_resolved_has_outcome CHECK ((resolved_at IS NULL) = (outcome IS NULL)),
    ADD CONSTRAINT warnings_resolved_was_acknowledged CHECK (resolved_at IS NULL OR acknowledged_at IS NOT NULL);
CREATE INDEX warnings_site_unresolved ON warnings (site_id, started_at DESC) WHERE resolved_at IS NULL;
CREATE INDEX warnings_assignee ON warnings (assignee_id) WHERE assignee_id IS NOT NULL AND resolved_at IS NULL;

CREATE TABLE warning_activity (
    id           bigserial PRIMARY KEY,
    warning_id   uuid NOT NULL REFERENCES warnings (id) ON DELETE CASCADE,
    at           timestamptz NOT NULL DEFAULT now(),
    actor_id     uuid REFERENCES users (id) ON DELETE SET NULL,
    action       text NOT NULL
                 CHECK (action IN ('acknowledged', 'assigned', 'unassigned', 'resolved', 'reopened', 'commented')),
    assignee_id  uuid REFERENCES users (id) ON DELETE SET NULL,  -- for assigned
    outcome      text CHECK (outcome IN ('true_alarm', 'false_alarm', 'unknown')),  -- for resolved
    note         text NOT NULL DEFAULT '' CHECK (length(note) <= 2000)
);
CREATE INDEX warning_activity_warning ON warning_activity (warning_id, id);
"""

DOWNGRADE = """
DROP TABLE warning_activity;
DROP INDEX warnings_assignee;
DROP INDEX warnings_site_unresolved;
ALTER TABLE warnings
    DROP CONSTRAINT warnings_resolved_was_acknowledged,
    DROP CONSTRAINT warnings_resolved_has_outcome,
    DROP COLUMN resolution_note,
    DROP COLUMN outcome,
    DROP COLUMN resolved_by,
    DROP COLUMN resolved_at,
    DROP COLUMN assignee_id,
    DROP COLUMN acknowledged_by,
    DROP COLUMN acknowledged_at;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
