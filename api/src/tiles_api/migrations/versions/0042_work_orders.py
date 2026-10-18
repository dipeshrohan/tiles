"""Work orders out (T9.02): a warning or a component's remaining life drafts a work order for the
plant's CMMS, numbered per site (`work_order_numbers`). A person approves it (not the one who drafted
it, unless an admin), it is exported (CSV first; a CMMS API later), and its outcome is recorded.
Tiles only sends work orders out; it never reads or changes the CMMS.

Revision ID: 0042
Revises: 0041
Create Date: 2026-10-18 01:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0042"
down_revision: str | None = "0041"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Tables of a site's data (row security, T5.04): tests/test_row_security.py reads this.
SITE_TABLES = ("work_order_numbers", "work_orders")

UPGRADE = """
CREATE TABLE work_order_numbers (
    site_id uuid PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
    last    integer NOT NULL
);

CREATE TABLE work_orders (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id       uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    number        integer NOT NULL CHECK (number > 0),
    source        text NOT NULL CHECK (source IN ('warning', 'remaining_life', 'manual')),
    warning_id    uuid REFERENCES warnings (id) ON DELETE SET NULL,
    signal_id     uuid REFERENCES signals (id) ON DELETE SET NULL,  -- the component's wear signal
    asset         text CHECK (asset IS NULL OR length(asset) BETWEEN 1 AND 100),
    title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    description   text NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
    priority      text NOT NULL CHECK (priority IN ('low', 'medium', 'high')),
    due_at        timestamptz,
    status        text NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'approved', 'exported', 'done', 'cancelled')),
    drafted_by_id uuid REFERENCES users (id) ON DELETE SET NULL,
    drafted_by    text NOT NULL,
    drafted_at    timestamptz NOT NULL DEFAULT now(),
    approved_by   text,
    approved_at   timestamptz,
    exported_at   timestamptz,
    export_ref    text,  -- the export it went out in (a CSV's name; a CMMS's own number later)
    outcome       text CHECK (outcome IN ('done', 'not_needed')),
    outcome_note  text NOT NULL DEFAULT '' CHECK (length(outcome_note) <= 2000),
    closed_at     timestamptz,
    UNIQUE (site_id, number),
    CHECK ((status = 'done') = (outcome IS NOT NULL)),
    CHECK (status IN ('draft', 'cancelled') OR approved_at IS NOT NULL)
);
CREATE INDEX work_orders_status ON work_orders (site_id, status, number DESC);
CREATE INDEX work_orders_warning ON work_orders (warning_id) WHERE warning_id IS NOT NULL;
"""

DOWNGRADE = """
DROP TABLE work_orders;
DROP TABLE work_order_numbers;
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
