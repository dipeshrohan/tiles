"""Copilot message notes (T4.03): an answer's grounding report (which results it cites, and any
number or name no cited result holds) is kept with it.

Revision ID: 0017
Revises: 0016
Create Date: 2026-10-09 07:40:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE conversation_messages"
        " ADD COLUMN meta jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(meta) = 'object')"
    )


def downgrade() -> None:
    op.execute("ALTER TABLE conversation_messages DROP COLUMN meta")
