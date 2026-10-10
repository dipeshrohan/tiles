"""The copilot per site (threat model G-A4): a site's admins turn it on, as it sends the questions
and the tool results it reads to the AI provider. Off for new sites; on for sites that already used
it, so an upgrade changes nothing for them.

Revision ID: 0032
Revises: 0031
Create Date: 2026-10-10 06:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0032"
down_revision: str | None = "0031"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# A site "used it" when a question was asked there: a usage row (one per question since 0019), or a
# question still in a conversation. Those tables are under row security: read across sites, then
# the scope set back as it was.
UPGRADE = """
ALTER TABLE sites ADD COLUMN copilot_enabled boolean NOT NULL DEFAULT false;
DO $$
DECLARE
    scope text := coalesce(current_setting('tiles.site_id', true), '');
BEGIN
    PERFORM set_config('tiles.site_id', '*', true);
    UPDATE sites SET copilot_enabled = true
    WHERE EXISTS (SELECT 1 FROM copilot_usage u WHERE u.site_id = sites.id)
       OR EXISTS (SELECT 1 FROM conversations c JOIN conversation_messages m ON m.conversation_id = c.id
                  WHERE c.site_id = sites.id AND m.role = 'user');
    PERFORM set_config('tiles.site_id', scope, true);
END
$$;
"""

DOWNGRADE = """
ALTER TABLE sites DROP COLUMN copilot_enabled;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
