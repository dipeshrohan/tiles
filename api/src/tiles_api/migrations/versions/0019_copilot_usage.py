"""Copilot usage (T4.07): one row per question, with the tokens each model call used (cache
writes and reads apart), the time to the first text and to the end, how it ended and whether the
answer was grounded. Rate limits and the daily token budget are counted from it, and admins read
it as the usage dashboard. A deleted user's questions stay (their user is NULL): they were spent.

Revision ID: 0019
Revises: 0018
Create Date: 2026-10-09 10:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE copilot_usage (
    id                  bigserial PRIMARY KEY,
    org_id              uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
    site_id             uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    user_id             uuid REFERENCES users (id) ON DELETE SET NULL,
    conversation_id     uuid REFERENCES conversations (id) ON DELETE SET NULL,
    asked_at            timestamptz NOT NULL DEFAULT now(),
    finished_at         timestamptz,
    outcome             text NOT NULL DEFAULT 'running'
                        CHECK (outcome IN ('running', 'answered', 'failed', 'over_budget')),
    grounded            boolean,
    model_calls         integer NOT NULL DEFAULT 0,
    input_tokens        bigint NOT NULL DEFAULT 0,
    output_tokens       bigint NOT NULL DEFAULT 0,
    cache_write_tokens  bigint NOT NULL DEFAULT 0,
    cache_read_tokens   bigint NOT NULL DEFAULT 0,
    billed_tokens       bigint NOT NULL DEFAULT 0,
    first_text_ms       integer,
    total_ms            integer
);

CREATE INDEX copilot_usage_org ON copilot_usage (org_id, asked_at DESC);
CREATE INDEX copilot_usage_site ON copilot_usage (site_id, asked_at DESC);
CREATE INDEX copilot_usage_user ON copilot_usage (user_id, asked_at DESC);
"""

DOWNGRADE = """
DROP TABLE copilot_usage;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
