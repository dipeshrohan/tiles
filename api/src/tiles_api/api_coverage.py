"""Line coverage over HTTP (T7.01): what Tiles watches on each machine of a place, and what is
missing (coverage.py)."""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, status
from pydantic import BaseModel

from tiles_api import coverage
from tiles_api.api_ontology import Ctx
from tiles_api.errors import Problem

router = APIRouter(tags=["ontology"])

Missing = Literal["signal_nodes", "linked_tags", "detector", "event_stream"]


class EventStream(BaseModel):
    tag: str
    kind: Literal["downtime", "scrap", "other"]


class MachineCoverage(BaseModel):
    id: str
    label: str
    asset: str  # the name its events are matched by: its `asset` property, else its label
    signal_nodes: int  # Signal nodes under its PLCs or in it
    signals: int  # of those, linked to a catalogue tag
    detectors: int  # enabled, on those tags
    models: int  # enabled model bindings fed by those tags
    event_streams: list[EventStream]  # event signals whose asset is the machine's
    missing: list[Missing]  # what it still needs, in the order to do it


class Totals(BaseModel):
    machines: int
    covered: int  # nothing missing
    with_signals: int
    with_detectors: int
    with_events: int


class Coverage(BaseModel):
    place: str | None
    machines: list[MachineCoverage]
    totals: Totals


@router.get("/sites/{site_id}/coverage", response_model=Coverage)
def line_coverage(ctx: Ctx, place: Annotated[str | None, Query(min_length=1, max_length=200)] = None) -> dict[str, Any]:
    """Each machine at or under `place` (a node of the committed ontology: a site, workcenter, line,
    cell or machine; without it, every machine of the site): its signals, detectors, models and
    event streams, and what is missing. Event streams are matched by the machine's `asset`
    property, or its label without one."""
    try:
        return coverage.report(ctx.conn, ctx.site_id, place)
    except coverage.NoPlace as e:
        raise Problem(
            status.HTTP_404_NOT_FOUND, "coverage.no_place", f"No place {place} in the plant model", place=str(e)
        ) from e
