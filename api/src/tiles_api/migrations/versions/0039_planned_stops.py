"""Planned stops (T7.03): planned downtime (changeovers, planned maintenance) so Warning performance
and the ROI report leave it out. A stop is planned when its code is one of the site's planned codes
(as the MES marks planned downtime), or when it starts within a planned stop entered for its asset
(or for the whole site). `tiles_planned` says so for one event, under the caller's row security.

Revision ID: 0039
Revises: 0038
Create Date: 2026-10-16 22:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0039"
down_revision: str | None = "0038"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Tables of a site's data (row security, T5.04): tests/test_row_security.py reads this.
SITE_TABLES = ("planned_stops", "planned_codes")

UPGRADE = """
CREATE TABLE planned_stops (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    site_id     uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    asset       text CHECK (asset IS NULL OR length(asset) BETWEEN 1 AND 100),  -- null: the whole site
    starts_at   timestamptz NOT NULL,
    ends_at     timestamptz NOT NULL,
    reason      text NOT NULL DEFAULT '' CHECK (length(reason) <= 200),
    created_by  uuid REFERENCES users (id) ON DELETE SET NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CHECK (ends_at > starts_at)
);
CREATE INDEX planned_stops_time ON planned_stops (site_id, starts_at, ends_at);

CREATE TABLE planned_codes (
    site_id  uuid NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
    code     text NOT NULL CHECK (length(code) BETWEEN 1 AND 100),
    PRIMARY KEY (site_id, code)
);

CREATE FUNCTION tiles_planned(site uuid, asset text, at timestamptz, code text) RETURNS boolean
LANGUAGE sql STABLE AS $$
    SELECT EXISTS (SELECT 1 FROM planned_codes c WHERE c.site_id = site AND c.code = tiles_planned.code)
        OR EXISTS (
            SELECT 1 FROM planned_stops p
            WHERE p.site_id = site AND (p.asset IS NULL OR p.asset = tiles_planned.asset)
              AND at >= p.starts_at AND at < p.ends_at
        )
$$;
"""

DOWNGRADE = """
DROP FUNCTION tiles_planned(uuid, text, timestamptz, text);
DROP TABLE planned_codes;
DROP TABLE planned_stops;
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
