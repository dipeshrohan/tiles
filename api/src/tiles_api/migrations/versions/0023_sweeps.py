"""Parameter sweeps as background jobs (T4.12): a design model version run over a grid of one or
two parameters, the others held. A sweep is queued, run in chunks that report progress and can be
cancelled, and its result kept; an identical sweep later gets that result (`cache_key`).

Revision ID: 0023
Revises: 0022
Create Date: 2026-10-09 12:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0023"
down_revision: str | None = "0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE sweeps (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id           uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    project_id        uuid,
    model_id          uuid NOT NULL REFERENCES models (id),
    model_key         text NOT NULL,
    version           text NOT NULL,
    params            jsonb NOT NULL,
    x                 jsonb NOT NULL,
    y                 jsonb,
    cache_key         text NOT NULL,
    status            text NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued', 'running', 'done', 'cancelled', 'failed')),
    total             integer NOT NULL CHECK (total > 0),
    done              integer NOT NULL DEFAULT 0,
    result            jsonb,
    error             text,
    cancel_requested  boolean NOT NULL DEFAULT false,
    created_by_id     uuid REFERENCES users (id) ON DELETE SET NULL,
    created_by        text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    started_at        timestamptz,
    heartbeat_at      timestamptz,
    finished_at       timestamptz,
    FOREIGN KEY (site_id, project_id) REFERENCES design_projects (site_id, id)
);

CREATE INDEX sweeps_site ON sweeps (site_id, created_at DESC);
CREATE INDEX sweeps_cache ON sweeps (site_id, cache_key) WHERE status = 'done';
CREATE INDEX sweeps_waiting ON sweeps (created_at) WHERE status IN ('queued', 'running');
"""

DOWNGRADE = """
DROP TABLE sweeps;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
