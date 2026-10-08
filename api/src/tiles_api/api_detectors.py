"""Detectors over HTTP (T3.04). The detection itself is detection.py; the job that feeds detectors
new readings is detector_job.py (`tiles-detect`); their warnings are served by api_warnings.py."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, status
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field

from tiles_api import detector_job
from tiles_api.api_ontology import Ctx, Editor, SiteContext
from tiles_api.detection import Config

router = APIRouter(tags=["detection"])


DEFAULT = Config()
SETTINGS = ("window", "k", "persist", "direction", "cooldown", "flat_spread")


Asset = Annotated[str, Field(min_length=1, max_length=100, pattern=r"^\S(.*\S)?$")]


class DetectorIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,62}$")]
    signal_id: uuid.UUID
    # The detection settings (detection.Config, whose defaults these are).
    window: Annotated[int, Field(ge=10, le=2_000)] = DEFAULT.window  # readings in the baseline
    k: Annotated[float, Field(gt=0, le=50)] = DEFAULT.k  # robust spreads from the baseline
    persist: Annotated[int, Field(ge=1, le=10_000)] = DEFAULT.persist  # readings out in a row
    direction: Literal["above", "below", "both"] = DEFAULT.direction
    cooldown: Annotated[int, Field(ge=0, le=1_000_000)] = DEFAULT.cooldown  # readings after a warning
    flat_spread: Annotated[float, Field(gt=0, le=1e12)] = DEFAULT.flat_spread  # a flat baseline's spread
    lateness_seconds: Annotated[float, Field(ge=0, le=7 * 86400)] = 300  # newer readings wait a run
    asset: Asset | None = None  # the machine it watches, as the MES names it: its events are matched to its warnings


class DetectorPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    asset: Asset | None


class Detector(BaseModel):
    id: uuid.UUID
    name: str
    signal_id: uuid.UUID
    signal_tag: str
    config: dict[str, Any]
    lateness_seconds: float
    asset: str | None
    enabled: bool
    done_until: datetime | None
    last_run_at: datetime | None
    last_readings: int
    open_warning: bool
    created_at: datetime


class RunOut(BaseModel):
    readings: int
    opened: int
    closed: int
    done_until: datetime | None
    caught_up: bool


DETECTORS = """
SELECT d.id, d.name, d.signal_id, g.tag AS signal_tag, d.config, d.lateness_s AS lateness_seconds, d.asset, d.enabled,
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
    config = Config(**body.model_dump(include=set(SETTINGS))).as_json()
    row = ctx.conn.execute(
        """
        INSERT INTO detectors (site_id, signal_id, name, config, lateness_s, asset, created_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT (site_id, name) DO NOTHING RETURNING id
        """,
        [ctx.site_id, body.signal_id, body.name, Jsonb(config), body.lateness_seconds, body.asset, ctx.user.id],
    ).fetchone()
    if row is None:  # also when another request took the name a moment ago
        raise HTTPException(status.HTTP_409_CONFLICT, f"A detector is already called {body.name}")
    after = {"name": body.name, "signal_id": str(body.signal_id), "config": config}
    ctx.audit(
        "detector.create",
        "detector",
        str(row["id"]),
        after=after | {"lateness_s": body.lateness_seconds, "asset": body.asset},
    )
    return _get(ctx, row["id"])


@router.patch("/sites/{site_id}/detectors/{detector_id}", response_model=Detector)
def update_detector(ctx: Editor, detector_id: uuid.UUID, body: DetectorPatch) -> dict[str, Any]:
    """Set (or clear, with null) the asset the detector watches, to match its warnings to that
    asset's events (T3.10)."""
    # Lock the row first, so that `before` (for the audit log) is what this change replaces.
    ctx.conn.execute("SELECT 1 FROM detectors WHERE id = %s AND site_id = %s FOR UPDATE", [detector_id, ctx.site_id])
    before = _get(ctx, detector_id)
    if body.asset != before["asset"]:
        ctx.conn.execute("UPDATE detectors SET asset = %s WHERE id = %s", [body.asset, detector_id])
        ctx.audit(
            "detector.update",
            "detector",
            str(detector_id),
            before={"asset": before["asset"]},
            after={"asset": body.asset},
        )
    return _get(ctx, detector_id)


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
    """Stop the detector. Its warnings stay; one still open ends now, since nothing will update it."""
    detector = _get(ctx, detector_id)
    if detector["enabled"]:
        ctx.conn.execute("UPDATE detectors SET enabled = false WHERE id = %s", [detector_id])
        ctx.conn.execute(
            "UPDATE warnings SET ended_at = greatest(now(), last_at + interval '1 microsecond')"
            " WHERE detector_id = %s AND ended_at IS NULL",
            [detector_id],
        )
        ctx.audit("detector.stop", "detector", str(detector_id), before={"name": detector["name"]})
