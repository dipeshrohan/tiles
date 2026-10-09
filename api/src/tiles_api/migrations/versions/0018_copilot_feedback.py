"""Feedback on copilot answers (T4.04): a user rates an answer up or down, with a comment; the
site's admins read them to improve the copilot and to grow its evaluation set (T4.05).

Revision ID: 0018
Revises: 0017
Create Date: 2026-10-09 08:40:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE copilot_feedback (
    conversation_id  uuid NOT NULL,
    seq              integer NOT NULL,
    site_id          uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    rating           text NOT NULL CHECK (rating IN ('up', 'down')),
    comment          text NOT NULL DEFAULT '' CHECK (length(comment) <= 2000),
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, seq),
    FOREIGN KEY (conversation_id, seq) REFERENCES conversation_messages (conversation_id, seq) ON DELETE CASCADE
);

CREATE INDEX copilot_feedback_site ON copilot_feedback (site_id, rating, updated_at DESC);
"""

DOWNGRADE = """
DROP TABLE copilot_feedback;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
