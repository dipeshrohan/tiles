"""Models from GitHub (T4.15): an organisation registers a model version from a repository at a
pinned commit (`source` 'github'). Its code, as fetched then (the model's directory, zipped), is
kept with its SHA-256, so it is the same code every time and the sandbox never reaches GitHub.

Revision ID: 0031
Revises: 0030
Create Date: 2026-10-10 02:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0031"
down_revision: str | None = "0030"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
ALTER TABLE models DROP CONSTRAINT models_source_check;
ALTER TABLE models
    ADD CONSTRAINT models_source_check CHECK (source IN ('builtin', 'http', 'github')),
    ADD COLUMN repo        text,
    ADD COLUMN commit_sha  text CHECK (commit_sha ~ '^[0-9a-f]{40}$'),
    ADD COLUMN path        text,
    ADD COLUMN entry       text,
    ADD COLUMN code        bytea,
    ADD COLUMN code_sha256 text CHECK (code_sha256 ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT models_github CHECK (
        (source = 'github') = (repo IS NOT NULL AND commit_sha IS NOT NULL AND path IS NOT NULL
                               AND entry IS NOT NULL AND code IS NOT NULL AND code_sha256 IS NOT NULL)
    );
"""

# Models from GitHub stay (runs refer to them), without their code: to the older version they are
# versions no longer registered, whose runs still show.
DOWNGRADE = """
UPDATE models SET source = 'builtin' WHERE source = 'github';
ALTER TABLE models
    DROP CONSTRAINT models_github,
    DROP COLUMN code_sha256,
    DROP COLUMN code,
    DROP COLUMN entry,
    DROP COLUMN path,
    DROP COLUMN commit_sha,
    DROP COLUMN repo,
    DROP CONSTRAINT models_source_check,
    ADD CONSTRAINT models_source_check CHECK (source IN ('builtin', 'http'));
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
