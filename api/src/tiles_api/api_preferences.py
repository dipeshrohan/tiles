"""Preferences (U6.06): a person's own settings for the app, kept with them (not with a site), so
they follow them to every site and browser and come back after signing out and in. The browser
applies them; the API only checks their shape. Like a person's home cards, they change nothing on
the site: any member keeps theirs (`Ctx`), audited on the site they were changed from."""

from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, StrictBool

from tiles_api.api_ontology import Ctx

router = APIRouter(tags=["Preferences"])


class Preferences(BaseModel):
    model_config = ConfigDict(extra="forbid")
    theme: Literal["system", "light", "dark"] = Field(description="The colours: the system's, or always one")
    density: Literal["comfortable", "compact"] = Field(description="How tall table rows are")
    language: str = Field(pattern=r"^(auto|[a-z]{2})$", description="A language code (`de`), or `auto`: the browser's")
    numbers: str = Field(
        pattern=r"^(auto|[a-z]{2}-[A-Z]{2})$",
        description="How numbers and dates are written (`en-US`), or `auto`: as the language does",
    )
    time_zone: Literal["site", "device"] = Field(description="Times in the site's clock or this device's")
    motion: Literal["system", "reduce"] = Field(description="Less motion always, or as the system asks")
    shortcuts: StrictBool = Field(description="Single-key shortcuts on")
    start: str | None = Field(
        default=None, pattern=r"^[a-z][a-z0-9-]{0,31}$", description="The page the app opens at; null: Home"
    )


class Kept(BaseModel):
    preferences: Preferences | None = Field(description="Null until you keep some (the app's defaults)")
    updated_at: datetime | None = None


def _kept(ctx: Any) -> dict[str, Any]:
    row: dict[str, Any] | None = ctx.conn.execute(
        "SELECT prefs AS preferences, updated_at FROM user_preferences WHERE user_id = %s", [ctx.user.id]
    ).fetchone()
    return row or {"preferences": None, "updated_at": None}


@router.get("/sites/{site_id}/me/preferences", response_model=Kept)
def get_preferences(ctx: Ctx) -> dict[str, Any]:
    """Your preferences, the same on every site; null until you keep some."""
    return _kept(ctx)


@router.put("/sites/{site_id}/me/preferences", response_model=Kept)
def set_preferences(ctx: Ctx, body: Preferences) -> dict[str, Any]:
    """Keep your preferences (any member: they are yours alone, on every site)."""
    before = _kept(ctx)["preferences"]
    after = body.model_dump()
    row = ctx.conn.execute(
        """
        INSERT INTO user_preferences (user_id, prefs) VALUES (%s, %s)
        ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()
        RETURNING prefs AS preferences, updated_at
        """,
        [ctx.user.id, Jsonb(after)],
    ).fetchone()
    if before != after:
        changed = sorted(k for k in after if (before or {}).get(k) != after[k])
        ctx.audit(
            "preferences.update",
            "user",
            str(ctx.user.id),
            before={k: (before or {}).get(k) for k in changed},
            after={k: after[k] for k in changed},
        )
    return dict(row) if row else {"preferences": after, "updated_at": None}
