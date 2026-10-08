"""How the warnings did, over HTTP (T3.10): the live counterpart of the backtest, from real warnings
and the events the MES reported (performance.py)."""

import uuid
from datetime import datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from tiles_api import performance
from tiles_api.api_ontology import Ctx

router = APIRouter(tags=["warnings"])


class Spread(BaseModel):
    count: int
    min: float
    p10: float
    median: float
    p90: float
    max: float


class Confirmed(BaseModel):
    true_alarm: int
    false_alarm: int
    unknown: int
    unresolved: int


class Totals(BaseModel):
    warnings: int
    true_warnings: int  # an event followed within the horizon
    false_warnings: int
    pending_warnings: int  # the horizon runs past now
    events: int
    caught: int
    recall: float | None
    precision: float | None
    false_per_day: float | None
    warning_seconds: Spread | None
    confirmed: Confirmed  # what people resolved them as


class DetectorRow(BaseModel):
    id: uuid.UUID
    name: str
    signal_tag: str
    asset: str | None
    matched: bool  # False: no asset, so its warnings can't be matched to events
    judged_from: datetime  # the part of the period it has judged: from its signal's first reading...
    judged_until: datetime  # ...to where its runs got to
    warnings: int
    true_warnings: int = 0
    false_warnings: int = 0
    pending_warnings: int = 0
    events: int
    caught: int = 0
    recall: float | None = None
    precision: float | None = None
    false_per_day: float | None = None
    warning_seconds: Spread | None = None
    confirmed: Confirmed


class Unwatched(BaseModel):
    asset: str
    events: int


class EventRow(BaseModel):
    at: datetime
    asset: str
    kind: Literal["downtime", "scrap", "other"]
    signal_tag: str
    code: str
    warned_at: datetime | None
    warning_seconds: float | None
    detector: str | None


class Report(BaseModel):
    start: datetime
    end: datetime
    horizon_seconds: float
    totals: Totals
    detectors: list[DetectorRow]
    unwatched: list[Unwatched]  # events of assets no detector watches
    events: list[EventRow]  # newest first, at most 200


@router.get("/sites/{site_id}/performance", response_model=Report)
def warning_performance(
    ctx: Ctx,
    days: Annotated[float, Query(gt=0, le=366)] = 30,
    horizon_hours: Annotated[float, Query(gt=0, le=24 * 30)] = 8,
    codes: Annotated[list[Annotated[str, Query(min_length=1, max_length=100)]], Query(max_length=50)] = [],  # noqa: B006
) -> dict[str, Any]:
    """The last `days`: each detector's warnings scored against its asset's events (an event caught
    when a warning started within `horizon_hours` before it), with what people resolved them as.
    `codes` (repeatable) counts only those events, e.g. the downtime codes the detectors target."""
    end: datetime = ctx.conn.execute("SELECT now() AS now").fetchone()["now"]  # type: ignore[index]
    try:
        return performance.report(
            ctx.conn, ctx.site_id, end - timedelta(days=days), end, timedelta(hours=horizon_hours), codes
        )
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
