"""The wear check (T3.13), pure: has a signal's level moved away from its baseline, as a wearing
tool's does (a welder tip's power climbing before its swap, a spindle's current, a cutter's force)?

The readings are first cut into equal time buckets, each its median. The baseline is the median of
the buckets before the recent window; the recent level is the median of the last few buckets in
it (four by default), so one odd bucket doesn't decide. The change is (recent - baseline) /
baseline. On hourly buckets this is the browser's wearCheck (js/lib/analysis.ts), which the demo
copilot runs on the welder: test/fixtures/wear-check.json keeps the two matched.

It also says how fast the level moves in the recent window (the Theil-Sen slope: the median of
the slopes between every two buckets, which one spike can't tilt), and, given a limit, about how
long until the level reaches it at that pace.
"""

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
    counts = {"baseline_buckets": len(baseline), "recent_buckets": len(recent)}
    if len(baseline) < MIN_BASELINE or len(recent) < last:
        return Assessment("not_enough_data", None, None, None, None, None, **counts)
    base = statistics.median(b.value for b in baseline)
    level = statistics.median(b.value for b in recent[-last:])
    slope = theil_sen(recent)
    change = (level - base) / abs(base) if base else None
    if change is None:
        verdict: Verdict = "not_enough_data"  # a zero baseline has no relative change
    else:
        moved = {"up": change >= threshold, "down": change <= -threshold, "either": abs(change) >= threshold}
        verdict = "wearing" if moved[direction] else "stable"
    return Assessment(verdict, base, level, change, slope, _hours_to(limit, level, slope, direction), **counts)


def _hours_to(limit: float | None, level: float, slope: float | None, direction: Direction) -> float | None:
    """Hours until the level reaches `limit` at `slope`: 0 if it is there or past it (in
    `direction`), None if it moves away from it or not at all."""
    if limit is None:
        return None
    gap = limit - level
    if gap == 0 or (direction == "up" and gap < 0) or (direction == "down" and gap > 0):
        return 0.0
    if slope is None or slope == 0 or (gap > 0) != (slope > 0):
        return None
    return gap / slope
