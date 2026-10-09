"""Change requests the copilot proposes (T4.09): `source` says who wrote the ops (a person, or the
copilot for the person who asked it), and `conversation_id` the conversation it was asked in. A
copilot's proposal is reviewed like any other: its author (the person who asked) can't approve it.

Revision ID: 0021
Revises: 0020
Create Date: 2026-10-09 11:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
ALTER TABLE change_requests
    ADD COLUMN source text NOT NULL DEFAULT 'person' CHECK (source IN ('person', 'copilot')),
    ADD COLUMN conversation_id uuid REFERENCES conversations (id) ON DELETE SET NULL;

CREATE INDEX change_requests_conversation ON change_requests (conversation_id) WHERE conversation_id IS NOT NULL;
"""

DOWNGRADE = """
DROP INDEX change_requests_conversation;
ALTER TABLE change_requests DROP COLUMN conversation_id, DROP COLUMN source;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
