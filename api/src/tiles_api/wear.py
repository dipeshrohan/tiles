"""The wear check (T3.13), pure: has a signal's level moved away from its baseline, as a wearing
tool's does (a welder tip's power climbing before its swap, a spindle's current, a cutter's force)?

The readings are first cut into equal time buckets, each its median. The baseline is the median of
the buckets before the recent window; the recent level is the median of the last few buckets in
it (four by default), so one odd bucket doesn't decide. The change is (recent - baseline) /
|baseline| (so a fall is negative whatever the baseline's sign). On hourly buckets, for a positive
baseline, this is the browser's wearCheck (js/lib/analysis.ts), which the demo
copilot runs on the welder: test/fixtures/wear-check.json keeps the two matched.

It also says how fast the level moves in the recent window (the Theil-Sen slope: the median of
the slopes between every two buckets, which one spike can't tilt), and, given a limit, about how
long until the level reaches it at that pace. Remaining life (T9.01) gives that time an interval:
Sen's 95% confidence interval of the slope (from the ranks of the sorted pairwise slopes and the
variance of Kendall's S) makes the earliest and latest times the level could reach the limit.
"""

import math
import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

Direction = Literal["up", "down", "either"]
Verdict = Literal["wearing", "stable", "not_enough_data"]

MIN_BASELINE = 6  # buckets before the recent window


@dataclass(frozen=True)
class Bucket:
    at: float  # hours from the start of the baseline
    value: float  # the median of its readings


@dataclass(frozen=True)
class Assessment:
    verdict: Verdict
    baseline: float | None
    last: float | None
    change: float | None  # (last - baseline) / baseline
    slope_per_hour: float | None  # in the recent window
    hours_to_limit: float | None  # at that pace; 0 if already past it
    baseline_buckets: int
    recent_buckets: int
    slope_interval: tuple[float, float] | None = None  # Sen's 95% interval, per hour
    hours_interval: tuple[float, float | None] | None = None  # earliest, latest (None: maybe never)


def check(values: Sequence[float], window: int = 24, last: int = 4) -> tuple[float, float, float]:
    """The browser's wearCheck on evenly spaced values (until their end): the baseline, the recent
    level and the change."""
    end = len(values)
    recent = values[max(0, end - window) : end]
    base = statistics.median(values[: max(1, end - window)])
    level = statistics.median(recent[-last:])
    return base, level, (level - base) / base


def theil_sen(points: Sequence[Bucket]) -> float | None:
    """The median slope between every two points (per hour); None for fewer than two."""
    slopes = [
        (b.value - a.value) / (b.at - a.at) for i, a in enumerate(points) for b in points[i + 1 :] if b.at != a.at
    ]
    return statistics.median(slopes) if slopes else None


def sen_interval(points: Sequence[Bucket], z: float = 1.96) -> tuple[float, float] | None:
    """Sen's confidence interval of the Theil-Sen slope (per hour), as SciPy's theilslopes takes it:
    among the N sorted pairwise slopes, those at round((N - C) / 2) - 1 and round((N + C) / 2),
    C = z * sqrt(Var S) for Kendall's S over n points (no ties). None for fewer than three points."""
    slopes = sorted(
        (b.value - a.value) / (b.at - a.at) for i, a in enumerate(points) for b in points[i + 1 :] if b.at != a.at
    )
    n, total = len(points), len(slopes)
    if n < 3 or not total:
        return None
    c = z * math.sqrt(n * (n - 1) * (2 * n + 5) / 18)
    low = max(0, round((total - c) / 2) - 1)
    high = min(total - 1, round((total + c) / 2))
    return slopes[low], slopes[high]


def assess(
    baseline: Sequence[Bucket],
    recent: Sequence[Bucket],
    *,
    direction: Direction = "either",
    threshold: float = 0.05,
    limit: float | None = None,
    last: int = 4,
) -> Assessment:
    """Whether the recent level has moved from the baseline by `threshold` (a fraction) or more in
    `direction`, how fast it moves, and when it reaches `limit` at that pace."""
    if len(baseline) < MIN_BASELINE or len(recent) < last:
        return Assessment("not_enough_data", None, None, None, None, None, len(baseline), len(recent))
    base = statistics.median(b.value for b in baseline)
    level = statistics.median(b.value for b in recent[-last:])
    slope = theil_sen(recent)
    change = (level - base) / abs(base) if base else None  # a fall is negative, whatever the sign of the baseline
    if change is None:
        verdict: Verdict = "not_enough_data"  # a zero baseline has no relative change
    else:
        moved = {"up": change >= threshold, "down": change <= -threshold, "either": abs(change) >= threshold}
        verdict = "wearing" if moved[direction] else "stable"
    toward = direction if direction != "either" or limit is None else ("up" if limit >= base else "down")
    interval = sen_interval(recent)
    hours = _hours_to(limit, level, slope, toward)
    return Assessment(
        verdict,
        base,
        level,
        change,
        slope,
        hours,
        len(baseline),
        len(recent),
        slope_interval=interval,
        hours_interval=_hours_between(limit, level, interval, toward) if hours is not None else None,
    )


def _hours_between(
    limit: float | None, level: float, interval: tuple[float, float] | None, direction: Direction
) -> tuple[float, float | None] | None:
    """The earliest and latest hours to `limit` over the slope's interval: the fastest slope
    towards it gives the earliest; the slowest, the latest, or None when the interval reaches a
    slope that never gets there."""
    if limit is None or interval is None:
        return None
    times = [_hours_to(limit, level, s, direction) for s in interval]
    reached = [t for t in times if t is not None]
    if not reached:
        return None
    return min(reached), (max(reached) if len(reached) == len(times) else None)


def _hours_to(limit: float | None, level: float, slope: float | None, direction: Direction) -> float | None:
    """Hours until the level reaches `limit` at `slope`: 0 if it is there or past it (in
    `direction`; for `either`, the side of the baseline the limit is on), None if it moves away
    from it or not at all."""
    if limit is None:
        return None
    gap = limit - level
    if gap == 0 or (direction == "up" and gap < 0) or (direction == "down" and gap > 0):
        return 0.0
    if slope is None or slope == 0 or (gap > 0) != (slope > 0):
        return None
    return gap / slope
