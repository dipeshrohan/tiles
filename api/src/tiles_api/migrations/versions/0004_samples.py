"""Samples (T2.06): every reading from the plant, in a TimescaleDB hypertable.

One row per signal and time; the primary key makes a re-sent reading a no-op
(edge agents send at least once). A reading is a number, text or true/false,
in exactly one of three columns. Chunks are one day; after 7 days they are
compressed (column store, segmented by signal), and after 5 years they are
dropped. Change either policy with TimescaleDB's own calls, e.g.
`SELECT remove_retention_policy('samples'); SELECT add_retention_policy('samples', INTERVAL '10 years');`

Revision ID: 0004
Revises: 0003
Create Date: 2026-10-07 22:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE samples (
    signal_id   uuid NOT NULL REFERENCES signals (id) ON DELETE CASCADE,
    at          timestamptz NOT NULL,
    value       double precision CHECK (value = value AND value NOT IN ('Infinity', '-Infinity')),
    value_text  text,
    value_bool  boolean,
    quality     text NOT NULL DEFAULT 'good' CHECK (quality IN ('good', 'uncertain', 'bad')),
    CHECK (num_nonnulls(value, value_text, value_bool) = 1),
    PRIMARY KEY (signal_id, at)
);
SELECT create_hypertable('samples', by_range('at', INTERVAL '1 day'));
ALTER TABLE samples SET (
    timescaledb.enable_columnstore,
    timescaledb.segmentby = 'signal_id',
    timescaledb.orderby = 'at'
);
CALL add_columnstore_policy('samples', after => INTERVAL '7 days');
SELECT add_retention_policy('samples', drop_after => INTERVAL '5 years');
"""

DOWNGRADE = """
DROP TABLE samples;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
