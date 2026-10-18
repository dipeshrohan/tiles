"""Setpoint recommendations (T11.02) and their guard rails (T11.04): engineers set limits per model
parameter (`recommendation_limits`); a sweep of a design model over the line's live state, within
those limits, proposes a change, numbered per site (`recommendation_numbers`); someone other than
its proposer approves or rejects it, the line applies it by hand and says so. Tiles never writes
to a PLC. A recommendation keeps the state it was swept on, the limits it was swept within and what
the model expected, as they were.

Revision ID: 0044
Revises: 0043
Create Date: 2026-10-18 16:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0044"
down_revision: str | None = "0043"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Tables of a site's data (row security, T5.04): tests/test_row_security.py reads this.
SITE_TABLES = ("recommendation_limits", "recommendation_numbers", "recommendations")

UPGRADE = """
CREATE TABLE recommendation_limits (
    site_id    uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    model      text NOT NULL CHECK (length(model) BETWEEN 1 AND 63),
    param      text NOT NULL CHECK (length(param) BETWEEN 1 AND 63),
    min        double precision NOT NULL,
    max        double precision NOT NULL,
    set_by_id  uuid REFERENCES users (id) ON DELETE SET NULL,
    set_by     text NOT NULL,
    set_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, model, param),
    CHECK (min <= max)
);

CREATE TABLE recommendation_numbers (
    site_id uuid PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
    last    integer NOT NULL
);

CREATE TABLE recommendations (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id        uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    number         integer NOT NULL CHECK (number > 0),
    model          text NOT NULL,
    version        text NOT NULL,
    objective      text NOT NULL,  -- the model's output the sweep lowered
    asset          text CHECK (asset IS NULL OR length(asset) BETWEEN 1 AND 100),
    state          jsonb NOT NULL,  -- every parameter as swept on: {param: value}
    sources        jsonb NOT NULL,  -- the parameters read from signals: {param: {signal_id, tag, at, readings}}
    proposal       jsonb NOT NULL,  -- the settable parameters' new values: {param: value}
    limits         jsonb NOT NULL,  -- the limits swept within: {param: {min, max}}
    expected       jsonb NOT NULL,  -- the model's outputs: {"now": {...}, "proposed": {...}}
    status         text NOT NULL DEFAULT 'proposed'
                   CHECK (status IN ('proposed', 'approved', 'rejected', 'applied')),
    proposed_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
    proposed_by    text NOT NULL,
    proposed_at    timestamptz NOT NULL DEFAULT now(),
    decided_by_id  uuid REFERENCES users (id) ON DELETE SET NULL,
    decided_by     text,
    decided_at     timestamptz,
    decision_note  text NOT NULL DEFAULT '' CHECK (length(decision_note) <= 2000),
    applied_by     text,
    applied_at     timestamptz,
    applied_note   text NOT NULL DEFAULT '' CHECK (length(applied_note) <= 2000),
    UNIQUE (site_id, number),
    CHECK ((status = 'proposed') = (decided_at IS NULL)),
    CHECK ((status = 'applied') = (applied_at IS NOT NULL))
);
CREATE INDEX recommendations_status ON recommendations (site_id, status, number DESC);
CREATE INDEX recommendations_asset ON recommendations (site_id, asset, number DESC);
"""

DOWNGRADE = """
DROP TABLE recommendations;
DROP TABLE recommendation_numbers;
DROP TABLE recommendation_limits;
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
