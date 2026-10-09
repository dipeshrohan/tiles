"""The correlation finder (T3.11): the browser's findings on its own cutter batches, and the
confidence intervals it adds."""

import json
import math
from pathlib import Path
from typing import Any

import pytest

from tiles_api.correlate import cohens_d, d_interval, find, pearson

FIXTURE = json.loads((Path(__file__).parents[2] / "test" / "fixtures" / "correlation.json").read_text())
KEYS = {
    "ngMean": "ng_mean",
    "okMean": "ok_mean",
    "effect": "effect",
    "r": "r",
    "ngCount": "ng_count",
    "okCount": "ok_count",
}


def same(found: list[Any], expected: list[dict[str, Any]]) -> None:
    assert [(f.segment, f.variable) for f in found] == [(e["segment"], e["variable"]) for e in expected]
    for f, e in zip(found, expected, strict=True):
        for js, py in KEYS.items():
            assert getattr(f, py) == pytest.approx(e[js], rel=1e-12, abs=1e-12), (f.segment, f.variable, js)


@pytest.mark.parametrize(("split", "expected"), [(None, "pooled"), ("material", "split")])
def test_the_findings_are_the_browsers(split: str | None, expected: str) -> None:
    found = find(FIXTURE["rows"], FIXTURE["variables"], bool, "ng", split)
    same(found, FIXTURE[expected])


def test_the_split_shows_what_pooling_hides_with_intervals() -> None:
    found = find(FIXTURE["rows"], FIXTURE["variables"], bool, "ng", "material")
    anode, cathode = (
        next(f for f in found if f.segment == s and f.variable == "tension") for s in ("anode", "cathode")
    )
    assert anode.clear and anode.ci_low is not None and anode.ci_low > 0  # anode fails when tension runs high
    assert cathode.clear and cathode.ci_high is not None and cathode.ci_high < 0  # cathode when it runs low
    pooled = next(f for f in find(FIXTURE["rows"], FIXTURE["variables"], bool, "ng") if f.variable == "tension")
    assert abs(pooled.effect) < 0.5
    assert all(f.ci_low is not None and f.ci_high is not None and f.ci_low < f.effect < f.ci_high for f in found)


def test_the_interval_is_the_hedges_olkin_one() -> None:
    low, high = d_interval(0.5, 20, 30) or (0, 0)
    se = math.sqrt(50 / 600 + 0.25 / 100)
    assert (low, high) == pytest.approx((0.5 - 1.959963984540054 * se, 0.5 + 1.959963984540054 * se))
    assert d_interval(1.0, 1, 30) is None


def test_small_or_flat_groups_and_missing_values() -> None:
    assert cohens_d([1.0], [1.0, 2.0]) == 0
    assert cohens_d([1.0, 1.0], [1.0, 1.0]) == 0
    assert pearson([1.0, 2.0], [0.0, 1.0]) == 0
    rows: list[dict[str, Any]] = [
        {"ok": "NG", "x": 5.0, "y": None},
        {"ok": "NG", "x": 6.0, "y": "n/a"},
        {"ok": "OK", "x": 1.0, "y": 2.0},
        {"ok": "OK", "x": 2.0, "y": True},  # true isn't a number
        {"ok": None, "x": 100.0, "y": 3.0},  # no outcome: left out
        {"ok": "OK", "x": math.inf, "y": 4.0},  # not finite: left out of x
    ]
    x, y = sorted(find(rows, ["x", "y"], lambda v: v == "NG", "ok"), key=lambda f: f.variable)
    assert (x.ng_count, x.ok_count, x.ng_mean, x.ok_mean) == (2, 2, 5.5, 1.5)
    assert (y.ng_count, y.ok_count, y.effect, y.ci_low) == (0, 2, 0, None)
    assert math.isnan(y.ng_mean)
