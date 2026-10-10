"""Models served over HTTP (T4.15): an organisation registers a model version with its spec and the
endpoint that computes it (`source` 'http'), beside the built-in ones written on first use. The
endpoint's token is sealed (sealed.py); who registered it is in the organisation's audit log. A
version's spec never changes; its endpoint may move, and it may be archived (no new uses; past
runs keep showing it).

Revision ID: 0030
Revises: 0029
Create Date: 2026-10-10 00:30:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0030"
down_revision: str | None = "0029"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
ALTER TABLE models
    ADD COLUMN source         text NOT NULL DEFAULT 'builtin' CHECK (source IN ('builtin', 'http')),
    ADD COLUMN endpoint_url   text,
    ADD COLUMN endpoint_token text,
    ADD COLUMN archived_at    timestamptz,
    ADD CONSTRAINT models_endpoint CHECK ((source = 'http') = (endpoint_url IS NOT NULL)),
    ADD CONSTRAINT models_token CHECK (endpoint_token IS NULL OR source = 'http');
"""

# HTTP models' rows stay (runs refer to them), without their endpoints: to the older version they
# are versions no longer registered, whose runs still show.
DOWNGRADE = """
ALTER TABLE models
    DROP CONSTRAINT models_token,
    DROP CONSTRAINT models_endpoint,
    DROP COLUMN archived_at,
    DROP COLUMN endpoint_token,
    DROP COLUMN endpoint_url,
    DROP COLUMN source;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
