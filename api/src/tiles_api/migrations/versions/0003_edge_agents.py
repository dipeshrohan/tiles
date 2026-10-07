"""Edge agents (T2.01): agents registered per site, their token hashes and last heartbeat.

Only a SHA-256 hash of each agent's token is stored; the token itself is shown
once, when an admin registers the agent. Revoking keeps the row (for the audit
trail) and frees the name for a new agent.

Revision ID: 0003
Revises: 0002
Create Date: 2026-10-07 17:40:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE edge_agents (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id        uuid NOT NULL REFERENCES orgs (id),
    site_id       uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    name          text NOT NULL CHECK (name ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'),
    token_hash    bytea NOT NULL UNIQUE CHECK (length(token_hash) = 32),
    created_by    uuid REFERENCES users (id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    revoked_at    timestamptz,
    last_seen_at  timestamptz,
    last_status   jsonb
);
CREATE UNIQUE INDEX edge_agents_active_name ON edge_agents (site_id, name) WHERE revoked_at IS NULL;
"""

DOWNGRADE = """
DROP TABLE edge_agents;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
