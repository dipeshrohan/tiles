"""Model runner (T3.03): a model version bound to a site's signals, run on new data windows.

A binding names a registered model version (pinned: its `models` row), which of
the site's signals feeds each model input, the parameters, how readings are cut
into windows, and the derived signal each output is written to. `done_until` is
the end of the last window run, so each run only takes new data.

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-08 12:10:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE model_bindings (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id       uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    name          text NOT NULL CHECK (name ~ '^[a-z0-9][a-z0-9._-]{0,62}$'),
    model_id      uuid NOT NULL REFERENCES models (id) ON DELETE RESTRICT,
    -- {input name: signal id}; {param name: number}; {output name: derived signal id}
    inputs        jsonb NOT NULL CHECK (jsonb_typeof(inputs) = 'object'),
    params        jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(params) = 'object'),
    outputs       jsonb NOT NULL CHECK (jsonb_typeof(outputs) = 'object'),
    -- A window ends where readings pause for gap_s (a shot, a batch), or after window_s.
    window_kind   text NOT NULL CHECK (window_kind IN ('gap', 'fixed')),
    window_s      double precision NOT NULL CHECK (window_s > 0),
    enabled       boolean NOT NULL DEFAULT true,
    done_until    timestamptz,
    last_run_at   timestamptz,
    last_windows  integer NOT NULL DEFAULT 0,
    last_error    text,
    created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, name)
);
"""

DOWNGRADE = """
DROP TABLE model_bindings;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
