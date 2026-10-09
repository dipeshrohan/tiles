"""The wear check over HTTP (T3.13): any signal of the site, read as bucket medians from the
samples (wear.py says what is checked). Read-only: anyone on the site may run it.
"""

import math
import uuid
from datetime import datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, status
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

from tiles_api import wear
from tiles_api.api_ontology import Ctx
from tiles_api.store import one

router = APIRouter(tags=["signals"])

MAX_SPAN_HOURS = 24 * 120
MAX_BUCKETS = 5_000
MAX_RECENT_BUCKETS = 500  # the slope compares every two of them


class WearIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    end: AwareDatetime | None = None  # excluded; default: just after the signal's latest reading
    recent_hours: Annotated[float, Field(gt=0)] = 24
    baseline_hours: Annotated[float, Field(gt=0)] = 72  # before the recent window
    bucket_minutes: Annotated[float, Field(ge=1, le=24 * 60)] = 60
    direction: wear.Direction = "either"  # which way wear moves the signal
    threshold: Annotated[float, Field(gt=0, le=10)] = 0.05  # a fraction of the baseline
    limit: float | None = None  # the level at which the tool is worn out
    last: Annotated[int, Field(ge=1, le=50)] = 4  # recent buckets whose median is the recent level

    @model_validator(mode="after")
    def _fits(self) -> "WearIn":
        width = self.bucket_minutes / 60
        if self.recent_hours + self.baseline_hours > MAX_SPAN_HOURS:
            raise ValueError(f"The baseline and recent window together can be at most {MAX_SPAN_HOURS // 24} days")
        for name, hours in (("recent_hours", self.recent_hours), ("baseline_hours", self.baseline_hours)):
            if not math.isclose(hours / width, round(hours / width)):
                raise ValueError(f"{name} must be a whole number of buckets")
        if (self.recent_hours + self.baseline_hours) / width > MAX_BUCKETS:
            raise ValueError(f"At most {MAX_BUCKETS} buckets: choose longer buckets")
        if self.recent_hours / width > MAX_RECENT_BUCKETS:
            raise ValueError(f"At most {MAX_RECENT_BUCKETS} buckets in the recent window: choose longer buckets")
        if self.recent_hours / width < self.last:
            raise ValueError("The recent window needs at least `last` buckets")
        return self


class BucketOut(BaseModel):
    at: datetime  # its start
    value: float  # the median of its readings
    n: int


class WearOut(BaseModel):
    signal_id: uuid.UUID
    tag: str
    unit: str | None
    start: datetime  # the baseline's start
    recent_from: datetime
    end: datetime
    verdict: wear.Verdict
    baseline: float | None
    last: float | None
    change: float | None
    slope_per_day: float | None
    hours_to_limit: float | None
    baseline_buckets: int
    recent_buckets: int
    text: str
    buckets: list[BucketOut]


BUCKETS = """
SELECT time_bucket(%(width)s * interval '1 second', at, %(start)s::timestamptz) AS at,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY coalesce(value, value_bool::int)) AS value, count(*) AS n
FROM samples
WHERE signal_id = %(id)s AND at >= %(start)s AND at < %(end)s AND coalesce(value, value_bool::int) IS NOT NULL
GROUP BY 1 ORDER BY 1
"""


def _num(x: float, unit: str | None) -> str:
    text = f"{x:,.0f}" if abs(x) >= 1000 else f"{x:.4g}"
    return f"{text} {unit}" if unit else text


def _duration(hours: float) -> str:
    if hours < 1:
        return f"{max(1, round(hours * 60))} min"
    if hours < 48:
        return f"{hours:.0f} h"
    return f"{hours / 24:.0f} days"


def explain(a: wear.Assessment, unit: str | None, limit: float | None, body: WearIn) -> str:
    if a.verdict == "not_enough_data" or a.baseline is None or a.last is None or a.change is None:
        return (
            f"Not enough readings: {a.baseline_buckets} baseline bucket(s) (at least {wear.MIN_BASELINE}) "
            f"and {a.recent_buckets} recent one(s) (at least {body.last}), with a baseline other than 0."
        )
    way = "above" if a.change >= 0 else "below"
    head = "Wearing" if a.verdict == "wearing" else "Stable"
    parts = [
        f"{head}: the recent level is {_num(a.last, unit)}, {abs(a.change):.1%} {way} the baseline of "
        f"{_num(a.baseline, unit)} (the threshold is {body.threshold:.0%})"
    ]
    if a.slope_per_hour is not None:
        per_day = a.slope_per_hour * 24
        moving = "rises" if per_day > 0 else "falls" if per_day < 0 else "holds steady"
        parts.append(f"it {moving}" + (f" {_num(abs(per_day), unit)} a day" if per_day else ""))
    if limit is not None:
        if a.hours_to_limit == 0:
            parts.append(f"it has reached the limit of {_num(limit, unit)}")
        elif a.hours_to_limit is not None:
            parts.append(f"at that pace it reaches {_num(limit, unit)} in about {_duration(a.hours_to_limit)}")
        else:
            parts.append(f"it is not heading for the limit of {_num(limit, unit)}")
    return "; ".join(parts) + "."


@router.post("/sites/{site_id}/signals/{signal_id}/wear-check", response_model=WearOut)
def wear_check(ctx: Ctx, signal_id: uuid.UUID, body: WearIn) -> dict[str, Any]:
    """Has the signal's level moved from its baseline (a wearing tool's), how fast, and when does
    it reach `limit`? The baseline is `baseline_hours` before the last `recent_hours` up to `end`."""
    signal = ctx.conn.execute(
        "SELECT tag, unit FROM signals WHERE id = %s AND site_id = %s", [signal_id, ctx.site_id]
    ).fetchone()
    if signal is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such signal on this site")
    end = body.end
    if end is None:
        latest = one(
            ctx.conn.execute("SELECT max(at) AS at FROM samples WHERE signal_id = %s", [signal_id]).fetchone()
        )["at"]
        end = (latest + timedelta(microseconds=1)) if latest else datetime.now().astimezone()
    recent_from = end - timedelta(hours=body.recent_hours)
    start = recent_from - timedelta(hours=body.baseline_hours)
    rows = ctx.conn.execute(
        BUCKETS, {"width": body.bucket_minutes * 60, "start": start, "end": end, "id": signal_id}
    ).fetchall()

    def hours(at: datetime) -> float:
        return (at - start).total_seconds() / 3600

    buckets = [wear.Bucket(hours(r["at"]), float(r["value"])) for r in rows]
    split = hours(recent_from)
    a = wear.assess(
        [b for b in buckets if b.at < split],
        [b for b in buckets if b.at >= split],
        direction=body.direction,
        threshold=body.threshold,
        limit=body.limit,
        last=body.last,
    )
    return {
        "signal_id": signal_id,
        "tag": signal["tag"],
        "unit": signal["unit"],
        "start": start,
        "recent_from": recent_from,
        "end": end,
        "verdict": a.verdict,
        "baseline": a.baseline,
        "last": a.last,
        "change": a.change,
        "slope_per_day": None if a.slope_per_hour is None else a.slope_per_hour * 24,
        "hours_to_limit": a.hours_to_limit,
        "baseline_buckets": a.baseline_buckets,
        "recent_buckets": a.recent_buckets,
        "text": explain(a, signal["unit"], body.limit, body),
        "buckets": [{"at": r["at"], "value": r["value"], "n": r["n"]} for r in rows],
    }
