"""The ROI report over HTTP (T6.01): the pilot period against the baseline, from the events and
warnings the site holds (roi.py), with its Markdown and a digest of what it counted."""

from datetime import datetime, timedelta
from typing import Any

from fastapi import APIRouter, status
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field

from tiles_api import performance, roi
from tiles_api.api_ontology import Ctx
from tiles_api.errors import Problem

router = APIRouter(tags=["warnings"])


class RoiIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    baseline_start: AwareDatetime
    baseline_end: AwareDatetime
    pilot_start: AwareDatetime
    pilot_end: AwareDatetime
    horizon_hours: float = Field(8, gt=0, le=24 * 30)
    codes: list[str] = Field([], max_length=50)  # downtime codes counted (none: all)
    hours_per_stop: float | None = Field(None, ge=0, le=24 * 30)  # the mean stop from the plant's export
    hours_source: str | None = Field(None, max_length=200)  # where that mean comes from
    cost_per_hour: float | None = Field(None, ge=0)
    cost_per_scrap: float | None = Field(None, ge=0)
    currency: str | None = Field(None, pattern=r"^[A-Z]{3}$")
    baseline_parts: float | None = Field(None, gt=0)  # production volume: rates per 1,000 parts
    pilot_parts: float | None = Field(None, gt=0)


class Counts(BaseModel):
    downtime: int
    scrap: int


class Rates(BaseModel):
    downtime: float | None
    scrap: float | None


class AssetCounts(BaseModel):
    asset: str
    downtime: int
    scrap: int


class Warnings(BaseModel):
    warnings: int
    events: int
    caught: int
    recall: float | None
    precision: float | None
    false_per_day: float | None
    median_warning_seconds: float | None


class Period(BaseModel):
    start: datetime
    end: datetime
    days: float
    parts: float | None
    counts: Counts
    rates: Rates  # per day, or per 1,000 parts when both periods' volumes are given
    by_asset: list[AssetCounts]
    warnings: Warnings


class Periods(BaseModel):
    baseline: Period
    pilot: Period


class Avoided(BaseModel):
    stops: float | None
    downtime_hours: float | None
    scrap: float | None
    cost: float | None


class RoiOut(BaseModel):
    periods: Periods
    avoided: Avoided
    inputs: dict[str, Any]
    digest: str  # SHA-256 of the inputs and every counted event
    markdown: str


@router.post("/sites/{site_id}/roi", response_model=RoiOut)
def roi_report(ctx: Ctx, body: RoiIn) -> dict[str, Any]:
    """The pilot period against the baseline: unplanned stops and scrap per day (or per 1,000 parts),
    what was avoided in hours and cost (from the plant's mean stop length and costs), and the
    warnings' recall, precision, false warnings per day and warning time in each period. Reads only;
    the same data gives the same `digest`."""
    if body.baseline_end <= body.baseline_start or body.pilot_end <= body.pilot_start:
        raise Problem(status.HTTP_422_UNPROCESSABLE_CONTENT, "roi.empty", "A period must end after it starts")
    if body.baseline_end > body.pilot_start:
        raise Problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "roi.order", "The baseline must end before the pilot period starts"
        )
    inputs = body.model_dump(
        exclude={"baseline_start", "baseline_end", "pilot_start", "pilot_end", "horizon_hours", "codes"}
    )
    try:
        return roi.report(
            ctx.conn,
            ctx.site_id,
            (body.baseline_start, body.baseline_end),
            (body.pilot_start, body.pilot_end),
            timedelta(hours=body.horizon_hours),
            body.codes,
            inputs,
        )
    except roi.TooMany as e:
        raise Problem(
            status.HTTP_422_UNPROCESSABLE_CONTENT, "roi.too_many", str(e), limit=performance.MAX_EVENTS
        ) from e
