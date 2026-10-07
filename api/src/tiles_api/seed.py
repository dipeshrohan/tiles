"""`tiles-seed`: create the demo organisation and site if they don't exist."""

import psycopg

from tiles_api.settings import Settings, get_settings
from tiles_api.store import one

DEMO_ORG = ("demo", "Demo Manufacturing")
DEMO_SITE = ("plant-1", "Plant 1")


def seed(settings: Settings | None = None) -> str:
    """Returns the demo site's id."""
    settings = settings or get_settings()
    with psycopg.connect(settings.database_url) as conn:
        org = one(
            conn.execute(
                "INSERT INTO orgs (slug, name) VALUES (%s, %s) ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug"
                " RETURNING id",
                DEMO_ORG,
            ).fetchone()
        )
        site = one(
            conn.execute(
                "INSERT INTO sites (org_id, slug, name) VALUES (%s, %s, %s)"
                " ON CONFLICT (org_id, slug) DO UPDATE SET slug = EXCLUDED.slug RETURNING id",
                [org[0], *DEMO_SITE],
            ).fetchone()
        )
        return str(site[0])


def main() -> None:
    print(f"Demo site: {seed()}")
