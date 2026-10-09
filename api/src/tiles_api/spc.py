"""Statistical process control (T6.10), pure: a Shewhart individuals chart and the Western
Electric run rules, for the App Studio's SPC template.

The points are a signal's bucket means in time order. The limits come from a baseline stretch:
the centre line is its mean, and sigma is estimated from the average moving range between
neighbouring points (MR-bar / d2, d2 = 1.128 for ranges of two), which a drift in the baseline
inflates less than the standard deviation would. Control limits are the centre ± k sigma (k = 3
by default). The rules then look at the points after the baseline:

- `beyond_limits` (rule 1): a point beyond a control limit;
- `two_of_three` (rule 2): two of three points in a row beyond 2 sigma, on the same side;
- `four_of_five` (rule 3): four of five points in a row beyond 1 sigma, on the same side;
- `run_of_eight` (rule 4): eight points in a row on the same side of the centre line;
- `trend_of_six`: six points in a row rising, or falling (Nelson's rule 3).

Each violation is reported once, at the point that completes it.
"""

import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from itertools import pairwise
from typing import Literal

Rule = Literal["beyond_limits", "two_of_three", "four_of_five", "run_of_eight", "trend_of_six"]
RULES: tuple[Rule, ...] = ("beyond_limits", "two_of_three", "four_of_five", "run_of_eight", "trend_of_six")
RULE_TEXT: dict[Rule, str] = {
    "beyond_limits": "a point beyond a control limit",
    "two_of_three": "two of three points beyond 2 sigma on one side",
    "four_of_five": "four of five points beyond 1 sigma on one side",
    "run_of_eight": "eight points in a row on one side of the centre line",
    "trend_of_six": "six points in a row rising or falling",
}
D2 = 1.128  # the mean range of two normal values, in sigmas
MIN_BASELINE = 8  # points to estimate the limits from


@dataclass(frozen=True)
class Limits:
    centre: float
    sigma: float
    upper: float
    lower: float


@dataclass(frozen=True)
class Violation:
    index: int  # of the point (in the points after the baseline) that completes it
    rule: Rule


def limits(baseline: Sequence[float], k: float = 3.0) -> Limits | None:
    """The control limits from the baseline points; None with fewer than MIN_BASELINE of them, or
    when they never move (no spread to measure)."""
    if len(baseline) < MIN_BASELINE:
        return None
    centre = statistics.fmean(baseline)
    ranges = [abs(b - a) for a, b in pairwise(baseline)]
    sigma = statistics.fmean(ranges) / D2
    if sigma <= 0:
        return None
    return Limits(centre, sigma, centre + k * sigma, centre - k * sigma)


def _zone(x: float, lim: Limits) -> float:
    """How many sigmas from the centre, signed."""
    return (x - lim.centre) / lim.sigma


def violations(points: Sequence[float], lim: Limits, rules: Sequence[Rule] = RULES) -> list[Violation]:
    """The rules' violations among `points` (those after the baseline), in order."""
    found: list[Violation] = []
    z = [_zone(x, lim) for x in points]
    # The control limits may be k sigma with k other than 3: rule 1 uses them as set.
    upper_k = (lim.upper - lim.centre) / lim.sigma
    lower_k = (lim.centre - lim.lower) / lim.sigma
    last: dict[Rule, int] = {}  # where each rule last fired, so one long run is reported once

    def fire(i: int, rule: Rule, span: int) -> None:
        if rule in last and last[rule] > i - span:
            last[rule] = i
            return
        last[rule] = i
        found.append(Violation(i, rule))

    for i in range(len(z)):
        if "beyond_limits" in rules and (z[i] > upper_k or z[i] < -lower_k):
            found.append(Violation(i, "beyond_limits"))
        for rule, window, need, beyond in (("two_of_three", 3, 2, 2.0), ("four_of_five", 5, 4, 1.0)):
            if rule in rules and i + 1 >= window:
                recent = z[i + 1 - window : i + 1]
                for side in (1, -1):
                    if sum(1 for v in recent if v * side > beyond) >= need and z[i] * side > beyond:
                        fire(i, rule, window)  # type: ignore[arg-type]
                        break
        if "run_of_eight" in rules and i + 1 >= 8:
            recent = z[i - 7 : i + 1]
            if all(v > 0 for v in recent) or all(v < 0 for v in recent):
                fire(i, "run_of_eight", 8)
        if "trend_of_six" in rules and i + 1 >= 6:
            steps = [b - a for a, b in pairwise(points[i - 5 : i + 1])]
            if all(s > 0 for s in steps) or all(s < 0 for s in steps):
                fire(i, "trend_of_six", 6)
    found.sort(key=lambda v: (v.index, RULES.index(v.rule)))
    return found
