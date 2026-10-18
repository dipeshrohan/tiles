"""Remaining life (T9.01): for every component at or under a place of the ontology, the time until
its wear signal reaches its wear limit, with an interval.

A component is a Signal node of a machine (as coverage.py finds them) whose linked catalogue tag
has a wear limit and the way wear moves it (`signals.wear_limit`, `wear_direction`, set together
on the Signals page). Each runs the wear check (api_wear.run_check: hourly buckets, the last day
against the three before it, ending at its latest reading); the time to the limit is at the
Theil-Sen slope of the last day, and its interval at the ends of Sen's 95% interval of that slope
(wear.sen_interval). Soonest first; then those that don't get there at their pace; then those
without enough readings to say. Everyone reads it.

Next maintenance window (T9.03): for a component heading for its limit, the next planned stop
(T7.03, `planned_stops`) for its machine's asset (coverage.asset_of) or the whole site that is on
now or starts before the predicted limit; none means there is none in time. `window_safe` says
whether it starts before the earliest the limit may come (Sen's interval), when that is known.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query, status
from pydantic import BaseModel

from tiles_api import coverage, ontology_store
from tiles_api.api_ontology import Ctx, SiteContext
from tiles_api.api_wear import WearIn, run_check
from tiles_api.errors import Problem
from tiles_api.ontology import Graph

router = APIRouter(tags=["signals"])

MAX_COMPONENTS = 50  # a wear check each, in one request


class Window(BaseModel):
    id: uuid.UUID
    asset: str | None  # None: the whole site
    starts_at: datetime
    ends_at: datetime
    reason: str


class Component(BaseModel):
    machine: str  # the Machine node
    machine_label: str
    node_id: str  # the Signal node: the component's wear signal
    component: str  # its label
    signal_id: uuid.UUID
    tag: str
    unit: str | None
    limit: float
    direction: Literal["up", "down"]
    verdict: Literal["wearing", "stable", "not_enough_data"]
    level: float | None  # the recent level
    slope_per_day: float | None
    hours_to_limit: float | None  # 0: there already; None: not getting there at this pace
    hours_earliest: float | None
    hours_latest: float | None  # None with an earliest: it may never get there
    end: datetime  # the readings up to here
    window: Window | None = None  # the next planned stop before the predicted limit (T9.03)
    window_needed: bool = False  # heading for the limit: a window is looked for (None found: none in time)
    window_safe: bool | None = None  # it starts before the earliest the limit may come


class RemainingLife(BaseModel):
    place: str | None
    components: list[Component]
    more: bool  # more components than these: choose a smaller place


@router.get("/sites/{site_id}/remaining-life", response_model=RemainingLife)
def remaining_life(ctx: Ctx, place: Annotated[str | None, Query(max_length=200)] = None) -> dict[str, Any]:
    """The time until each component at or under `place` (the whole site without one) reaches its
    wear limit, with its interval, soonest first."""
    components, more = assess(ctx, place, MAX_COMPONENTS)
    return {"place": place, "components": components, "more": more}


def assess(ctx: SiteContext, place: str | None, most: int | None) -> tuple[list[dict[str, Any]], bool]:
    """Each component at or under `place` (the first `most` by tag; all without), soonest first, and
    whether there were more (tiles-draft-work-orders asks for all of them)."""
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
    shown = rows if most is None else rows[:most]
    # Each one's latest reading, in one statement (run_check would ask once per signal).
    latest = {
        r["signal_id"]: r["at"]
        for r in ctx.conn.execute(
            "SELECT signal_id, max(at) AS at FROM site_samples WHERE signal_id = ANY(%s) GROUP BY signal_id",
            [[r["id"] for r in shown]],
        ).fetchall()
    }
    now = datetime.now(UTC)
    out = []
    for r in shown:
        machine = owner[r["node_id"]]
        last = latest.get(r["id"])
        end = last + timedelta(microseconds=1) if last else now
        body = WearIn(end=end, direction=r["wear_direction"], limit=r["wear_limit"])
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

    def order(c: dict[str, Any]) -> tuple[int, float, str, str]:
        group = 2 if c["verdict"] == "not_enough_data" else 1 if c["hours_to_limit"] is None else 0
        return group, c["hours_to_limit"] or 0.0, c["machine_label"], c["tag"]

    _windows(ctx, graph, out, now)
    out.sort(key=order)
    return out, len(shown) < len(rows)


def _windows(ctx: SiteContext, graph: Graph, components: list[dict[str, Any]], now: datetime) -> None:
    """Sets each heading component's next planned stop before its predicted limit (T9.03)."""
    heading = [c for c in components if c["hours_to_limit"]]  # not None, not there already
    if not heading:
        return
    for c in heading:
        c["limit_at"] = c["end"] + timedelta(hours=c["hours_to_limit"])
        c["asset"] = coverage.asset_of(graph, c["machine"])
    stops = ctx.conn.execute(
        "SELECT id, asset, starts_at, ends_at, reason FROM planned_stops"
        " WHERE site_id = %s AND ends_at > %s AND starts_at < %s AND (asset IS NULL OR asset = ANY(%s))"
        " ORDER BY starts_at, ends_at LIMIT 2000",
        [ctx.site_id, now, max(c["limit_at"] for c in heading), sorted({c["asset"] for c in heading})],
    ).fetchall()
    for c in heading:
        c["window_needed"] = True
        found = next((s for s in stops if (s["asset"] in (None, c["asset"])) and s["starts_at"] < c["limit_at"]), None)
        c["window"] = dict(found) if found else None
        if found and c["hours_earliest"] is not None:
            c["window_safe"] = found["starts_at"] < c["end"] + timedelta(hours=c["hours_earliest"])
        del c["limit_at"], c["asset"]
