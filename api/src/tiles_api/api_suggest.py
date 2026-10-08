"""Agentic ingestion (T2.11): suggestions for the site's unmapped tags (see suggest.py).

Read-only: accepting a suggestion goes through the existing endpoints, a link
through `PATCH /signals/{id}` and a new node through the ontology's staged
changes, which the engineer commits as any other change.
"""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel

from tiles_api.api_ontology import Ctx
from tiles_api.ontology_store import load_head
from tiles_api.suggest import Suggester

router = APIRouter(tags=["signals"])


class SuggestionOut(BaseModel):
    signal_id: str
    tag: str
    kind: Literal["link", "create"]
    score: float
    node_id: str
    node_label: str
    reasons: list[str]
    ops: list[dict[str, Any]]


class Suggestions(BaseModel):
    unmapped: int  # tags no node is linked to
    suggestions: list[SuggestionOut]  # for the first `limit` of them, in tag order


# Declared before /signals/{signal_id}, which would otherwise take "suggestions" for an id.
@router.get("/sites/{site_id}/signals/suggestions", response_model=Suggestions)
def suggestions(ctx: Ctx, limit: Annotated[int, Query(ge=1, le=500)] = 100) -> Suggestions:
    """For each tag no ontology node is linked to: the node to link, or the Signal node to create (with the
    ops to stage), with a score and the reasons."""
    rows = ctx.conn.execute(
        "SELECT id::text AS id, tag, unit, node_id FROM signals WHERE site_id = %s ORDER BY tag", [ctx.site_id]
    ).fetchall()
    unmapped = [r for r in rows if r["node_id"] is None]
    suggester = Suggester(load_head(ctx.conn, ctx.site_id), rows)
    return Suggestions(
        unmapped=len(unmapped),
        suggestions=[SuggestionOut(**s.as_dict()) for s in suggester.all(unmapped[:limit])],
    )
