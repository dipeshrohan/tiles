"""Remaining life (T9.01): for every component at or under a place of the ontology, the time until
its wear signal reaches its wear limit, with an interval.

A component is a Signal node of a machine (as coverage.py finds them) whose linked catalogue tag
has a wear limit (`signals.wear_limit`, set on the Signals page). Each runs the wear check
(api_wear.run_check: hourly buckets, the last day against the three before it, towards the limit
or in the signal's `wear_direction`); the time to the limit is at the Theil-Sen slope of the last
day, and its interval at the ends of Sen's 95% interval of that slope (wear.sen_interval). Soonest
first; those that never get there at their pace last. Everyone reads it.
"""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, status
from pydantic import BaseModel

from tiles_api import coverage, ontology_store
from tiles_api.api_ontology import Ctx
from tiles_api.api_wear import WearIn, run_check
from tiles_api.errors import Problem

router = APIRouter(tags=["signals"])

MAX_COMPONENTS = 100  # a wear check each


class Component(BaseModel):
    machine: str  # the Machine node
    machine_label: str
    node_id: str  # the Signal node: the component's wear signal
    component: str  # its label
    signal_id: uuid.UUID
    tag: str
    unit: str | None
    limit: float
    direction: Literal["up", "down"] | None
    verdict: Literal["wearing", "stable", "not_enough_data"]
    level: float | None  # the recent level
    slope_per_day: float | None
    hours_to_limit: float | None  # 0: there already; None: not getting there at this pace
    hours_earliest: float | None
    hours_latest: float | None  # None with an earliest: it may never get there
    end: datetime  # the readings up to here


class RemainingLife(BaseModel):
    place: str | None
    components: list[Component]
    more: bool  # more components than these: choose a smaller place


@router.get("/sites/{site_id}/remaining-life", response_model=RemainingLife)
def remaining_life(ctx: Ctx, place: Annotated[str | None, Query(max_length=200)] = None) -> dict[str, Any]:
    """The time until each component at or under `place` (the whole site without one) reaches its
    wear limit, with its interval, soonest first."""
    graph = ontology_store.load_head(ctx.conn, ctx.site_id)
    index = coverage.Index(graph)
    try:
        machines = coverage.machines_under(index, place)
    except coverage.NoPlace as e:
        raise Problem(
            status.HTTP_404_NOT_FOUND, "coverage.no_place", f"No place {place} in the plant model", place=str(e)
        ) from e
    owner = {n: m for m in machines for n in coverage.signal_nodes(index, m)}
    rows = ctx.conn.execute(
        "SELECT id, tag, unit, node_id, wear_limit, wear_direction FROM signals"
        " WHERE site_id = %s AND wear_limit IS NOT NULL AND node_id = ANY(%s) ORDER BY tag",
        [ctx.site_id, list(owner)],
    ).fetchall()
    out = []
    for r in rows[:MAX_COMPONENTS]:
        machine = owner[r["node_id"]]
        body = WearIn(direction=r["wear_direction"] or "either", limit=r["wear_limit"])
        w = run_check(ctx, r["id"], body, signal=r)
        out.append(
            {
                "machine": machine,
                "machine_label": graph["nodes"][machine]["label"],
                "node_id": r["node_id"],
                "component": graph["nodes"][r["node_id"]]["label"],
                "signal_id": r["id"],
                "tag": r["tag"],
                "unit": r["unit"],
                "limit": r["wear_limit"],
                "direction": r["wear_direction"],
                "verdict": w["verdict"],
                "level": w["last"],
                "slope_per_day": w["slope_per_day"],
                "hours_to_limit": w["hours_to_limit"],
                "hours_earliest": w["hours_to_limit_earliest"],
                "hours_latest": w["hours_to_limit_latest"],
                "end": w["end"],
            }
        )
    out.sort(key=lambda c: (c["hours_to_limit"] is None, c["hours_to_limit"] or 0, c["machine_label"], c["tag"]))
    return {"place": place, "components": out, "more": len(rows) > MAX_COMPONENTS}
