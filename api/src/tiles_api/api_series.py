"""Time series for the Data Explorer (T2.10): a signal's readings over a time range, downsampled.

When the range holds no more readings than the points asked for, they come back
as they are. Otherwise they are grouped into equal time buckets (at most
`points`, starting at `from`), each with the average, minimum and maximum of its
readings, so a chart of a year of 1 Hz data stays a few thousand points and
still shows every spike. True/false readings count as 1 and 0; a text signal's
bucket carries its last text. A bucket without readings is left out, so the gap
shows.
"""

import math
import uuid
from datetime import datetime, timedelta
from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import AwareDatetime, BaseModel

from tiles_api.api_ontology import Ctx, SiteContext

router = APIRouter(tags=["signals"])

MAX_SPAN = timedelta(days=5 * 366)  # as long as samples are kept


class Point(BaseModel):
    at: datetime  # the reading's time, or the bucket's start
    value: float | None  # the reading, or the bucket's average; None for text
    min: float | None
    max: float | None
    n: int  # readings behind this point
    text: str | None  # a text reading, or a bucket's last


class Series(BaseModel):
    signal_id: uuid.UUID
    tag: str
    unit: str | None
    start: datetime
    end: datetime
    bucket_s: float | None  # None: the readings as they are
    points: list[Point]


RAW = """
SELECT at, coalesce(value, value_bool::int) AS value, coalesce(value, value_bool::int) AS min,
       coalesce(value, value_bool::int) AS max, 1 AS n, value_text AS text
FROM samples WHERE signal_id = %(id)s AND at >= %(start)s AND at < %(end)s ORDER BY at LIMIT %(limit)s
"""

BUCKETS = """
SELECT time_bucket(%(bucket_s)s * interval '1 second', at, %(start)s::timestamptz) AS at,
       avg(coalesce(value, value_bool::int)) AS value, min(coalesce(value, value_bool::int)) AS min,
       max(coalesce(value, value_bool::int)) AS max, count(*) AS n, last(value_text, at) AS text
FROM samples WHERE signal_id = %(id)s AND at >= %(start)s AND at < %(end)s
GROUP BY 1 ORDER BY 1
"""


@router.get("/sites/{site_id}/signals/{signal_id}/series", response_model=Series)
def get_series(
    ctx: Ctx,
    signal_id: uuid.UUID,
    start: Annotated[AwareDatetime, Query(alias="from")],
    end: Annotated[AwareDatetime, Query(alias="to")],
    points: Annotated[int, Query(ge=10, le=5000)] = 1000,
) -> Series:
    """A signal's readings from `from` (included) to `to` (excluded): as they are when there are at
    most `points`, otherwise in at most `points` buckets with their average, minimum and maximum."""
    return read_series(ctx, signal_id, start, end, points)


def read_series(ctx: SiteContext, signal_id: uuid.UUID, start: datetime, end: datetime, points: int) -> Series:
    """A signal of this site over a range, as `GET …/series` answers it."""
    if end <= start:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "`to` must be after `from`")
    if end - start > MAX_SPAN:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "The range can be at most five years")
    signal = ctx.conn.execute(
        "SELECT tag, unit FROM signals WHERE id = %s AND site_id = %s", [signal_id, ctx.site_id]
    ).fetchone()
    if signal is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such signal on this site")
    args: dict[str, Any] = {"id": signal_id, "start": start, "end": end}
    # The readings as they are, one more than fit: if that one comes back, they are bucketed instead.
    rows = ctx.conn.execute(RAW, {**args, "limit": points + 1}).fetchall()
    bucket_s: float | None = None
    if len(rows) > points:
        # Whole milliseconds, rounded up so that the buckets never outnumber the points.
        bucket_s = math.ceil((end - start).total_seconds() * 1000 / points) / 1000
        rows = ctx.conn.execute(BUCKETS, {**args, "bucket_s": bucket_s}).fetchall()
    return Series(
        signal_id=signal_id,
        tag=signal["tag"],
        unit=signal["unit"],
        start=start,
        end=end,
        bucket_s=bucket_s,
        points=[Point(**r) for r in rows],
    )
