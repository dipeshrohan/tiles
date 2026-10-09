"""Design projects (T4.14): a site's shared projects in the Design Studio. A run belongs to one
project (or to none, as runs made before projects), and a run's parent is in the same project.

Revision ID: 0022
Revises: 0021
Create Date: 2026-10-09 11:30:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE design_projects (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id      uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    description  text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
    created_by   text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, id)
);

CREATE UNIQUE INDEX design_projects_name ON design_projects (site_id, lower(name));

-- Adding a column updates no row, so the trigger that keeps runs unchanged doesn't fire; runs
-- made before projects have none.
ALTER TABLE design_runs ADD COLUMN project_id uuid;
ALTER TABLE design_runs ADD FOREIGN KEY (site_id, project_id) REFERENCES design_projects (site_id, id);
CREATE INDEX design_runs_project ON design_runs (site_id, project_id, model_key, number DESC);
"""

DOWNGRADE = """
DROP INDEX design_runs_project;
ALTER TABLE design_runs DROP COLUMN project_id;
DROP TABLE design_projects;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
