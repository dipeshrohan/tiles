"""Design runs (T4.11): a run of a design model version with its parameters, the output the API
computed, its parent run, the run it restored (if any), a note and its author. Runs are numbered
per site and never change: the lineage of a design is the chain of parents.

Revision ID: 0020
Revises: 0019
Create Date: 2026-10-09 10:30:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE run_numbers (
    site_id  uuid PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
    last     integer NOT NULL
);

CREATE TABLE design_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id        uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    number         integer NOT NULL,
    model_id       uuid NOT NULL REFERENCES models (id),
    model_key      text NOT NULL,
    version        text NOT NULL,
    params         jsonb NOT NULL,
    output         jsonb NOT NULL,
    parent_id      uuid,
    restored_from  uuid,
    note           text NOT NULL DEFAULT '' CHECK (length(note) <= 500),
    author_id      uuid REFERENCES users (id) ON DELETE SET NULL,
    author_name    text NOT NULL,
    author_email   text NOT NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (site_id, number),
    UNIQUE (site_id, id),
    FOREIGN KEY (site_id, parent_id) REFERENCES design_runs (site_id, id),
    FOREIGN KEY (site_id, restored_from) REFERENCES design_runs (site_id, id)
);

CREATE INDEX design_runs_model ON design_runs (site_id, model_key, number DESC);

-- A run is a record of what was computed: it never changes, except that its author's account
-- may be deleted (the name and email stay).
CREATE FUNCTION design_runs_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.author_id IS NULL AND to_jsonb(NEW) - 'author_id' = to_jsonb(OLD) - 'author_id' THEN
        RETURN NEW;
    END IF;
    RAISE EXCEPTION 'design runs never change';
END;
$$;

CREATE TRIGGER design_runs_immutable BEFORE UPDATE ON design_runs
    FOR EACH ROW EXECUTE FUNCTION design_runs_immutable();
"""

DOWNGRADE = """
DROP TABLE design_runs;
DROP FUNCTION design_runs_immutable();
DROP TABLE run_numbers;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
