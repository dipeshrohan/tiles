"""Detector templates (T7.02): a machine type's detector set up once (the kind of machine, the
signal it watches and the settings to try) and applied to every machine of that kind under a place,
each detector tuned by a backtest on its own machine's history and downtime. `detector_backtests`
keeps the backtest each detector was chosen by, with its report.

Revision ID: 0040
Revises: 0039
Create Date: 2026-10-16 23:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0040"
down_revision: str | None = "0039"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Tables of a site's data (row security, T5.04): tests/test_row_security.py reads this.
SITE_TABLES = ("detector_templates", "detector_backtests")

UPGRADE = """
CREATE TABLE detector_templates (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id       uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    name          text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9._-]{0,39}$'),
    machine_kind  text NOT NULL CHECK (length(machine_kind) BETWEEN 1 AND 100),  -- a Machine node's `kind`
    measure       text NOT NULL CHECK (length(measure) BETWEEN 1 AND 100),  -- a Signal node's `measure`
    grid          jsonb NOT NULL,  -- the values to try for each detection setting
    horizon_s     double precision NOT NULL CHECK (horizon_s > 0),
    codes         text[] NOT NULL DEFAULT '{}',  -- the downtime codes it should warn of (none: all)
    lateness_s    double precision NOT NULL CHECK (lateness_s >= 0),
    created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, name)
);

CREATE TABLE detector_backtests (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id        uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    detector_id    uuid NOT NULL REFERENCES detectors (id) ON DELETE CASCADE,
    template_id    uuid REFERENCES detector_templates (id) ON DELETE SET NULL,
    config         jsonb NOT NULL,  -- the setting chosen
    readings       integer NOT NULL,
    events         integer NOT NULL,
    recall         double precision,
    precision      double precision,
    false_per_day  double precision,
    report         text NOT NULL,  -- Markdown
    created_by     uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX detector_backtests_detector ON detector_backtests (detector_id, created_at DESC);
"""

DOWNGRADE = """
DROP TABLE detector_backtests;
DROP TABLE detector_templates;
"""


def upgrade() -> None:
    op.execute(UPGRADE)
    for table in SITE_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY site_rows ON {table} USING (tiles_site_visible(site_id))"
            " WITH CHECK (tiles_site_visible(site_id))"
        )


def downgrade() -> None:
    op.execute(DOWNGRADE)
