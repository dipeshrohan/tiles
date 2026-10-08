"""Detectors and their warnings over HTTP (T3.04). The detection itself is detection.py; the job
that feeds detectors new readings is detector_job.py (`tiles-detect`)."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field

from tiles_api import detector_job
from tiles_api.api_ontology import Ctx, Editor, SiteContext
from tiles_api.detection import Config
from tiles_api.store import one

router = APIRouter(tags=["detection"])


class DetectorIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,62}$")]
    signal_id: uuid.UUID
    window: Annotated[int, Field(ge=10, le=10_000)] = 200  # readings in the baseline
    k: Annotated[float, Field(gt=0, le=50)] = 4  # robust spreads from the baseline
    persist: Annotated[int, Field(ge=1, le=10_000)] = 3  # readings out in a row to raise a warning
    direction: Literal["above", "below", "both"] = "above"
    cooldown: Annotated[int, Field(ge=0, le=1_000_000)] = 0  # readings after a warning before another
    min_spread: Annotated[float, Field(gt=0, le=1e12)] = 1  # the least spread counted
    lateness_seconds: Annotated[float, Field(ge=0, le=7 * 86400)] = 300  # newer readings wait a run


class Detector(BaseModel):
    id: uuid.UUID
    name: str
    signal_id: uuid.UUID
    signal_tag: str
    config: dict[str, Any]
    lateness_seconds: float
    enabled: bool
    done_until: datetime | None
    last_run_at: datetime | None
    last_readings: int
    open_warning: bool
    created_at: datetime


class WarningOut(BaseModel):
    id: uuid.UUID
    detector: str
    signal_id: uuid.UUID
    signal_tag: str
    started_at: datetime
    last_at: datetime
    ended_at: datetime | None
    side: Literal["above", "below"]
    peak: float
    baseline: float
    threshold: float
    readings: int


class RunOut(BaseModel):
    readings: int
    opened: int
    closed: int
    done_until: datetime | None
    caught_up: bool


DETECTORS = """
SELECT d.id, d.name, d.signal_id, g.tag AS signal_tag, d.config, d.lateness_s AS lateness_seconds, d.enabled,
       d.done_until, d.last_run_at, d.last_readings, d.created_at,
       EXISTS (SELECT 1 FROM warnings w WHERE w.detector_id = d.id AND w.ended_at IS NULL) AS open_warning
FROM detectors d JOIN signals g ON g.id = d.signal_id
WHERE d.site_id = %s
"""


def _get(ctx: SiteContext, detector_id: uuid.UUID) -> dict[str, Any]:
    row = ctx.conn.execute(DETECTORS + " AND d.id = %s", [ctx.site_id, detector_id]).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such detector")
    return row


@router.get("/sites/{site_id}/detectors", response_model=list[Detector])
def list_detectors(ctx: Ctx) -> list[dict[str, Any]]:
    return ctx.conn.execute(DETECTORS + " ORDER BY d.name", [ctx.site_id]).fetchall()


@router.post("/sites/{site_id}/detectors", response_model=Detector, status_code=status.HTTP_201_CREATED)
def create_detector(ctx: Editor, body: DetectorIn) -> dict[str, Any]:
    """Watch a signal: warn when it leaves its rolling baseline by `k` robust spreads for `persist`
    readings in a row. It starts with the signal's stored history."""
    if not ctx.conn.execute(
        "SELECT 1 FROM signals WHERE site_id = %s AND id = %s", [ctx.site_id, body.signal_id]
    ).fetchone():
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Not a signal of this site")
    if ctx.conn.execute(
        "SELECT 1 FROM detectors WHERE site_id = %s AND name = %s", [ctx.site_id, body.name]
    ).fetchone():
        raise HTTPException(status.HTTP_409_CONFLICT, f"A detector is already called {body.name}")
    config = Config(
        window=body.window,
        k=body.k,
        persist=body.persist,
        direction=body.direction,
        cooldown=body.cooldown,
        min_spread=body.min_spread,
    ).as_json()
    row = one(
        ctx.conn.execute(
            """
            INSERT INTO detectors (site_id, signal_id, name, config, lateness_s, created_by)
            VALUES (%s, %s, %s, %s, %s, %s) RETURNING id
            """,
            [ctx.site_id, body.signal_id, body.name, Jsonb(config), body.lateness_seconds, ctx.user.id],
        ).fetchone()
    )
    after = {"name": body.name, "signal_id": str(body.signal_id), "config": config}
    ctx.audit("detector.create", "detector", str(row["id"]), after=after | {"lateness_s": body.lateness_seconds})
    return _get(ctx, row["id"])


@router.post("/sites/{site_id}/detectors/{detector_id}/run", response_model=RunOut)
def run_now(ctx: Editor, detector_id: uuid.UUID) -> dict[str, Any]:
    """Run the detector on one batch of its new readings now (`caught_up`: nothing more waiting)."""
    if not _get(ctx, detector_id)["enabled"]:
        raise HTTPException(status.HTTP_409_CONFLICT, "This detector is stopped")
    r = detector_job.run(ctx.conn, detector_id, batches=1)
    out = {
        "readings": r.readings,
        "opened": r.opened,
        "closed": r.closed,
        "done_until": r.done_until,
        "caught_up": r.caught_up,
    }
    done = r.done_until.isoformat() if r.done_until else None
    ctx.audit("detector.run", "detector", str(detector_id), after=out | {"done_until": done})
    return out


@router.delete("/sites/{site_id}/detectors/{detector_id}", status_code=status.HTTP_204_NO_CONTENT)
def stop(ctx: Editor, detector_id: uuid.UUID) -> None:
    """Stop the detector. Its warnings stay."""
    detector = _get(ctx, detector_id)
    if detector["enabled"]:
        ctx.conn.execute("UPDATE detectors SET enabled = false WHERE id = %s", [detector_id])
        ctx.audit("detector.stop", "detector", str(detector_id), before={"name": detector["name"]})


@router.get("/sites/{site_id}/warnings", response_model=list[WarningOut])
def list_warnings(
    ctx: Ctx,
    state: Literal["open", "ended", "all"] = "all",
    signal_id: uuid.UUID | None = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> list[dict[str, Any]]:
    """The site's warnings, newest first: still open (the signal is still out), ended, or all."""
    return ctx.conn.execute(
        """
        SELECT w.id, d.name AS detector, w.signal_id, g.tag AS signal_tag, w.started_at, w.last_at, w.ended_at,
               w.side, w.peak, w.baseline, w.threshold, w.readings
        FROM warnings w JOIN detectors d ON d.id = w.detector_id JOIN signals g ON g.id = w.signal_id
        WHERE w.site_id = %s AND (%s::uuid IS NULL OR w.signal_id = %s)
          AND (%s = 'all' OR (%s = 'open') = (w.ended_at IS NULL))
        ORDER BY w.started_at DESC LIMIT %s OFFSET %s
        """,
        [ctx.site_id, signal_id, signal_id, state, state, limit, offset],
    ).fetchall()
