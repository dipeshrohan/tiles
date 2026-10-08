"""Streaming detection (T3.04): detectors watching a signal, and the warnings they raise.

A detector holds its settings (window, k, persist, direction, cooldown) and its
state between runs (the baseline window, the run of readings out, the open
warning), so each run of `tiles-detect` takes only new readings. A warning is
raised once and updated while it stays open; T3.07 adds who acknowledged,
assigned and resolved it, and the outcome.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-08 12:40:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE detectors (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id        uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    signal_id      uuid NOT NULL REFERENCES signals (id) ON DELETE CASCADE,
    name           text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
    config         jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
    state          jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(state) = 'object'),
    -- Readings newer than this many seconds wait for the next run, so late ones aren't passed over.
    lateness_s     double precision NOT NULL DEFAULT 300 CHECK (lateness_s >= 0),
    enabled        boolean NOT NULL DEFAULT true,
    done_until     timestamptz,
    last_run_at    timestamptz,
    last_readings  integer NOT NULL DEFAULT 0,
    created_by     uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, name)
);

CREATE TABLE warnings (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id      uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    detector_id  uuid NOT NULL REFERENCES detectors (id) ON DELETE CASCADE,
    signal_id    uuid NOT NULL REFERENCES signals (id) ON DELETE CASCADE,
    started_at   timestamptz NOT NULL,
    last_at      timestamptz NOT NULL,
    ended_at     timestamptz,  -- null while the signal is still out
    side         text NOT NULL CHECK (side IN ('above', 'below')),
    peak         double precision NOT NULL,
    baseline     double precision NOT NULL,
    threshold    double precision NOT NULL,
    readings     integer NOT NULL CHECK (readings > 0),
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (detector_id, started_at),
    CHECK (last_at >= started_at AND (ended_at IS NULL OR ended_at > last_at))
);
CREATE INDEX warnings_site_time ON warnings (site_id, started_at DESC);
"""

DOWNGRADE = """
DROP TABLE warnings;
DROP TABLE detectors;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
