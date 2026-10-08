"""Notifications (T3.09): people choose which warnings reach them by email, admins point a site at
a Microsoft Teams channel, and an outbox holds each message until `tiles-notify` delivers it.

Messages are queued in the same transaction as what they announce (a warning raised, a warning
assigned), so none is lost or sent for something rolled back, and sent afterwards, so a slow mail
server never holds up a detector or a person. A message is queued once per warning, kind, channel,
recipient and (for an assignment) step, so a re-run never sends it twice.

Revision ID: 0012
Revises: 0011
Create Date: 2026-10-08 15:20:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

UPGRADE = """
CREATE TABLE notification_prefs (
    site_id      uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    on_raised    boolean NOT NULL DEFAULT false,  -- every new warning on the site
    on_assigned  boolean NOT NULL DEFAULT true,   -- a warning assigned to them by someone else
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (site_id, user_id)
);

CREATE TABLE site_notifications (
    site_id            uuid PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
    teams_webhook_url  text CHECK (teams_webhook_url ~ '^https://'),
    teams_on_raised    boolean NOT NULL DEFAULT true,
    updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
    id            bigserial PRIMARY KEY,
    site_id       uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    warning_id    uuid NOT NULL REFERENCES warnings (id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN ('warning_raised', 'warning_assigned')),
    channel       text NOT NULL CHECK (channel IN ('email', 'teams')),
    recipient_id  uuid REFERENCES users (id) ON DELETE CASCADE,  -- for email; null for the site's channel
    activity_id   bigint REFERENCES warning_activity (id) ON DELETE CASCADE,  -- the assignment
    created_at    timestamptz NOT NULL DEFAULT now(),
    next_at       timestamptz NOT NULL DEFAULT now(),  -- when to (re)try
    attempts      integer NOT NULL DEFAULT 0,
    sent_at       timestamptz,
    failed_at     timestamptz,  -- gave up
    last_error    text,
    CHECK ((channel = 'email') = (recipient_id IS NOT NULL)),
    UNIQUE NULLS NOT DISTINCT (warning_id, kind, channel, recipient_id, activity_id)
);
CREATE INDEX notifications_due ON notifications (next_at) WHERE sent_at IS NULL AND failed_at IS NULL;
CREATE INDEX notifications_site_time ON notifications (site_id, created_at DESC);
"""

DOWNGRADE = """
DROP TABLE notifications;
DROP TABLE site_notifications;
DROP TABLE notification_prefs;
"""


def upgrade() -> None:
    op.execute(UPGRADE)


def downgrade() -> None:
    op.execute(DOWNGRADE)
