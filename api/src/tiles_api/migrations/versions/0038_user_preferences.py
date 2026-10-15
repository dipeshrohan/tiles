"""Preferences (U6.06): each person's own settings for the app (theme, row density, language and
number format, which clock times are shown in, less motion, keyboard shortcuts, the page it opens
at), kept with the person, not a site, so they follow them to every site and browser. No site's
data: a request reaches only its own person's row.

Revision ID: 0038
Revises: 0037
Create Date: 2026-10-16 09:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0038"
down_revision: str | None = "0037"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE user_preferences (
    user_id    uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
    prefs      jsonb NOT NULL CHECK (jsonb_typeof(prefs) = 'object' AND octet_length(prefs::text) <= 4096),
    updated_at timestamptz NOT NULL DEFAULT now()
);
"""

DOWNGRADE = """
DROP TABLE user_preferences;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
