"""App Studio apps (T6.10): a template's version (app_templates.py) configured on a site, numbered
per site (`app_numbers`), kept when archived. The template and version are stored with the
configuration, so a template's later version never changes what an app does.

Revision ID: 0028
Revises: 0027
Create Date: 2026-10-09 22:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0028"
down_revision: str | None = "0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Tables of a site's data (row security, T5.04): tests/test_row_security.py reads this.
SITE_TABLES = ("app_numbers", "apps")

UPGRADE = """
CREATE TABLE app_numbers (
    site_id uuid PRIMARY KEY REFERENCES sites (id) ON DELETE CASCADE,
    last    integer NOT NULL
);

CREATE TABLE apps (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id          uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    number           integer NOT NULL,
    name             text NOT NULL CHECK (name <> '' AND length(name) <= 120),
    template         text NOT NULL,
    template_version integer NOT NULL,
    config           jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
    created_by_id    uuid REFERENCES users (id) ON DELETE SET NULL,
    created_by       text NOT NULL,
    created_at       timestamptz NOT NULL DEFAULT now(),
    updated_at       timestamptz NOT NULL DEFAULT now(),
    archived_at      timestamptz,
    UNIQUE (site_id, number)
);
CREATE INDEX apps_site ON apps (site_id, number) WHERE archived_at IS NULL;
"""

DOWNGRADE = """
DROP TABLE apps;
DROP TABLE app_numbers;
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
