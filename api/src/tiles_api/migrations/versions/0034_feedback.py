"""In-app feedback (U4.09): what people say about Tiles from any page, with a mood, the page, the
version and the browser, and a screenshot of the page when they chose to attach one. Anonymous
unless they chose to give their name (`user_id` is null then). Site admins list it.

Revision ID: 0034
Revises: 0033
Create Date: 2026-10-14 21:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0034"
down_revision: str | None = "0033"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Tables of a site's data (row security, T5.04): tests/test_row_security.py reads this.
SITE_TABLES = ("feedback",)

UPGRADE = """
CREATE TABLE feedback (
    id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    site_id    uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    mood       text NOT NULL CHECK (mood IN ('unhappy', 'neutral', 'happy')),
    body       text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
    page       text NOT NULL CHECK (page ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
    version    text NOT NULL CHECK (version ~ '^[0-9A-Za-z.+-]{1,32}$'),
    browser    text NOT NULL CHECK (char_length(browser) <= 300),
    user_id    uuid REFERENCES users (id) ON DELETE SET NULL,
    screenshot bytea CHECK (screenshot IS NULL OR octet_length(screenshot) <= 2097152)
);
CREATE INDEX feedback_site_created ON feedback (site_id, created_at DESC);
"""

DOWNGRADE = """
DROP TABLE feedback;
"""


def upgrade() -> None:
    op.execute(UPGRADE)
    for table in SITE_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY site_rows ON {table} USING (tiles_site_visible(site_id))"
            " WITH CHECK (tiles_site_visible(site_id))"
        )


def downgrade() -> None:
    op.execute(DOWNGRADE)
