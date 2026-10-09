"""Sealed credentials (T5.06): a site's Teams webhook URL is stored sealed with a data key
(`tiles:v1:…`, sealed.py) once TILES_DATA_KEYS is set, so its check now takes either form.
`tiles-rotate-keys` seals the URLs stored before.

Revision ID: 0025
Revises: 0024
Create Date: 2026-10-09 14:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0025"
down_revision: str | None = "0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
ALTER TABLE site_notifications DROP CONSTRAINT site_notifications_teams_webhook_url_check;
ALTER TABLE site_notifications ADD CONSTRAINT site_notifications_teams_webhook_url_check
    CHECK (teams_webhook_url ~ '^(https://|tiles:v1:)');
"""

DOWNGRADE = """
ALTER TABLE site_notifications DROP CONSTRAINT site_notifications_teams_webhook_url_check;
ALTER TABLE site_notifications ADD CONSTRAINT site_notifications_teams_webhook_url_check
    CHECK (teams_webhook_url ~ '^https://');
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
