"""Home by role (U5.01): the cards a person keeps on their home on a site, in their order. The
browser has the cards (each answers "what needs me now?" for a role: my open warnings, reviews
waiting for me, agent health…) and a default set per role; a person who changes theirs keeps it
here, so it follows them to any browser. Like copilot conversations, it is the person's own and
changes nothing on the site: any member keeps theirs (`Ctx`), still audited."""

import re
from datetime import datetime
from typing import Any

from fastapi import APIRouter, Response, status
from pydantic import BaseModel, ConfigDict, Field, field_validator

from tiles_api.api_ontology import Ctx

router = APIRouter(tags=["Home"])

MAX_CARDS = 16


class Layout(BaseModel):
    cards: list[str] | None = Field(description="The cards in order; null: the role's own")
    updated_at: datetime | None = None


class LayoutIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cards: list[str] = Field(
        max_length=MAX_CARDS, description="Card ids from the app's catalogue (lower-case words), in order"
    )

    @field_validator("cards")
    @classmethod
    def _cards(cls, cards: list[str]) -> list[str]:
        for card in cards:
            if not re.fullmatch(r"[a-z][a-z0-9-]{0,31}", card):
                raise ValueError(f"Not a card: {card[:40]!r}")
        if len(set(cards)) != len(cards):
            raise ValueError("A card is listed twice")
        return cards


def _layout(ctx: Any) -> dict[str, Any]:
    row: dict[str, Any] | None = ctx.conn.execute(
        "SELECT cards, updated_at FROM home_layouts WHERE site_id = %s AND user_id = %s",
        [ctx.site_id, ctx.user.id],
    ).fetchone()
    return row or {"cards": None, "updated_at": None}


@router.get("/sites/{site_id}/me/home", response_model=Layout)
def get_home(ctx: Ctx) -> dict[str, Any]:
    """Your home's cards on this site, in order; `cards` is null until you change them (the app
    shows your role's)."""
    return _layout(ctx)


@router.put("/sites/{site_id}/me/home", response_model=Layout)
def set_home(ctx: Ctx, body: LayoutIn) -> dict[str, Any]:
    """Keep your home's cards on this site, in order (any member: it is yours alone)."""
    before = _layout(ctx)["cards"]
    row = ctx.conn.execute(
        """
        INSERT INTO home_layouts (site_id, user_id, cards) VALUES (%s, %s, %s)
        ON CONFLICT (site_id, user_id) DO UPDATE SET cards = EXCLUDED.cards, updated_at = now()
        RETURNING cards, updated_at
        """,
        [ctx.site_id, ctx.user.id, body.cards],
    ).fetchone()
    if before != body.cards:
        ctx.audit("home.layout", "user", str(ctx.user.id), before={"cards": before}, after={"cards": body.cards})
    return dict(row) if row else {"cards": body.cards, "updated_at": None}


@router.delete("/sites/{site_id}/me/home", status_code=status.HTTP_204_NO_CONTENT)
def reset_home(ctx: Ctx) -> Response:
    """Go back to your role's cards on this site."""
    gone = ctx.conn.execute(
        "DELETE FROM home_layouts WHERE site_id = %s AND user_id = %s RETURNING cards",
        [ctx.site_id, ctx.user.id],
    ).fetchone()
    if gone:
        ctx.audit("home.layout", "user", str(ctx.user.id), before={"cards": gone["cards"]}, after={"cards": None})
    return Response(status_code=status.HTTP_204_NO_CONTENT)
