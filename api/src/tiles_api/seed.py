"""`tiles-seed`: create the demo organisation and site if they don't exist."""

from tiles_api.settings import Settings, get_settings
from tiles_api.store import connect_job, one

DEMO_ORG = ("demo", "Demo Manufacturing")
DEMO_SITE = ("plant-1", "Plant 1")


def seed(settings: Settings | None = None) -> str:
    """Returns the demo site's id."""
    settings = settings or get_settings()
    with connect_job(settings) as conn:
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
                [org["id"], *DEMO_SITE],
            ).fetchone()
        )
        return str(site["id"])


def main() -> None:
    print(f"Demo site: {seed()}")
