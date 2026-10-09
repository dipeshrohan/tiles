"""Copilot conversations (T4.01): each user's own, with every message of the exchange (questions,
answers, tool calls and their results) as the Messages API takes them back.

`busy_since` is set while an answer streams, so a second question waits for the first.

Revision ID: 0016
Revises: 0015
Create Date: 2026-10-09 07:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE conversations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id     uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    title       text NOT NULL DEFAULT '',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    busy_since  timestamptz,
    input_tokens   bigint NOT NULL DEFAULT 0,
    output_tokens  bigint NOT NULL DEFAULT 0
);

CREATE INDEX conversations_user ON conversations (site_id, user_id, updated_at DESC);

CREATE TABLE conversation_messages (
    conversation_id  uuid NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
    seq              integer NOT NULL,
    role             text NOT NULL CHECK (role IN ('user', 'assistant')),
    content          jsonb NOT NULL CHECK (jsonb_typeof(content) = 'array'),
    created_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, seq)
);
"""

DOWNGRADE = """
DROP TABLE conversation_messages;
DROP TABLE conversations;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
