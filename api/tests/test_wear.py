"""The wear check (T3.13): the browser's welder check on the same numbers, generalised to any
signal over HTTP, with its trend and the time to a limit."""

import json
import random
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_series import T0, load

from tiles_api import wear

FIXTURE: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[2] / "test" / "fixtures" / "wear-check.json").read_text()
)
HOUR = timedelta(hours=1)


def close(a: float | None, b: float) -> bool:
    return a is not None and abs(a - b) <= 1e-12 * max(1.0, abs(b))


@pytest.mark.parametrize("tip", ["cathode", "anode"])
def test_the_browsers_welder_check_on_the_same_numbers(tip: str) -> None:
    baseline, last, change = wear.check(FIXTURE[tip], window=FIXTURE["window_hours"])
    expected = FIXTURE["results"][tip]
    assert close(baseline, expected["baseline"])
    assert close(last, expected["last"])
    assert close(change, expected["change"])


def buckets(values: list[float], first: float = 0) -> list[wear.Bucket]:
    return [wear.Bucket(first + i, v) for i, v in enumerate(values)]


def test_verdicts_follow_the_direction_and_threshold() -> None:
    base = buckets([100.0] * 10)
    up = buckets([100, 102, 104, 106, 108, 110], first=10)
    assert wear.assess(base, up).verdict == "wearing"  # +7% (the median of 104, 106, 108, 110)
    assert wear.assess(base, up, direction="down").verdict == "stable"
    assert wear.assess(base, up, threshold=0.1).verdict == "stable"
    a = wear.assess(base, up, limit=120)
    assert (a.baseline, a.last, a.change, a.slope_per_hour) == (100, 107, 0.07, 2)
    assert a.hours_to_limit == pytest.approx(6.5)  # (120 - 107) / 2
    assert wear.assess(base, up, limit=90).hours_to_limit is None  # moving away from it
    assert wear.assess(base, up, limit=110, direction="down").hours_to_limit == 0  # below it already
    assert wear.assess(base, up, limit=105, direction="up").hours_to_limit == 0
    down = buckets([100, 97, 94, 91, 88], first=10)
    assert wear.assess(base, down, direction="down").verdict == "wearing"
    assert wear.assess(base, down, direction="either").verdict == "wearing"


def test_one_spike_moves_neither_the_level_nor_the_slope() -> None:
    recent = buckets([100, 101, 102, 900, 104, 105, 106, 107], first=10)
    a = wear.assess(buckets([100.0] * 10), recent)
    assert a.slope_per_hour == 1
    assert a.last == 105.5  # the median of 104, 105, 106, 107


def test_too_few_buckets_or_a_zero_baseline_say_so() -> None:
    assert wear.assess(buckets([1.0] * 5), buckets([2.0] * 4, 5)).verdict == "not_enough_data"
    assert wear.assess(buckets([1.0] * 6), buckets([2.0] * 3, 6)).verdict == "not_enough_data"
    zero = wear.assess(buckets([0.0] * 6), buckets([2.0] * 4, 6))
    assert (zero.verdict, zero.change) == ("not_enough_data", None)


def check(api: TestClient, site: str, signal: str, **body: Any) -> Any:  # noqa: F811
    return api.post(f"/sites/{site}/signals/{signal}/wear-check", json=body, headers=VIEWER)


def test_the_welder_check_on_real_readings(api: TestClient, site: str) -> None:  # noqa: F811
    cathode = load(api, site, "w03.cathode_power", FIXTURE["cathode"], step=HOUR)
    anode = load(api, site, "w03.anode_power", FIXTURE["anode"], step=HOUR)
    end = (T0 + 72 * HOUR).isoformat()
    res = check(api, site, cathode, end=end, baseline_hours=48, limit=1900)
    assert res.status_code == 200, res.text
    out = res.json()
    expected = FIXTURE["results"]["cathode"]
    for key in ("baseline", "last", "change"):
        assert close(out[key], expected[key]), key
    assert (out["verdict"], out["baseline_buckets"], out["recent_buckets"], len(out["buckets"])) == (
        "wearing",
        48,
        24,
        72,
    )
    assert out["slope_per_day"] > 0
    assert 0 < out["hours_to_limit"] < 24
    assert out["text"].startswith("Wearing: the recent level is 1,785, 10.2% above the baseline of 1,620")
    assert "reaches 1,900 in about" in out["text"]
    # By default it ends just after the latest reading: the same answer.
    assert close(check(api, site, cathode, baseline_hours=48).json()["change"], expected["change"])

    calm = check(api, site, anode, end=end, baseline_hours=48, limit=1900).json()
    assert calm["verdict"] == "stable"
    assert close(calm["change"], FIXTURE["results"]["anode"]["change"])
    assert calm["text"] == (
        "Stable: the recent level is 1,459, 0.6% above the baseline of 1,451 (the threshold is 5%); "
        "it rises 7.957 a day; at that pace it reaches 1,900 in about 55 days."
    )

    few = check(api, site, cathode, end=(T0 + 3 * HOUR).isoformat(), baseline_hours=48).json()
    assert few["verdict"] == "not_enough_data"
    assert few["text"].startswith("Not enough readings: 0 baseline bucket(s)")


def test_requests_are_checked(api: TestClient, site: str) -> None:  # noqa: F811
    signal = load(api, site, "w03.cathode_power", [1.0, 2.0])
    assert check(api, site, "00000000-0000-0000-0000-000000000000").status_code == 404
    for body, why in (
        ({"recent_hours": 1.5}, "recent_hours must be a whole number of buckets"),
        ({"baseline_hours": 24 * 120}, "at most 120 days"),
        ({"bucket_minutes": 1, "baseline_hours": 100}, "At most 5000 buckets"),
        ({"bucket_minutes": 1, "recent_hours": 24, "baseline_hours": 24}, "At most 500 buckets in the recent"),
        ({"recent_hours": 2, "last": 4}, "at least `last` buckets"),
        ({"direction": "sideways"}, ""),
        ({"threshold": 0}, ""),
    ):
        res = check(api, site, signal, **body)
        assert res.status_code == 422, body
        assert why in res.text, body
    assert api.post(f"/sites/{site}/signals/{signal}/wear-check", json={}, headers=ENG).status_code == 200


def test_a_limit_already_passed_counts_on_either_side_of_the_baseline() -> None:
    base = buckets([100.0] * 10)
    over = buckets([116, 118, 120, 122, 124], first=10)  # rising past a limit above the baseline
    assert wear.assess(base, over, limit=110).hours_to_limit == 0
    back = buckets([128, 126, 124, 122, 120], first=10)  # falling back toward it: still past it
    assert wear.assess(base, back, limit=110).hours_to_limit == 0
    under = buckets([90, 88, 86, 84, 82], first=10)  # below a limit under the baseline
    assert wear.assess(base, under, limit=95).hours_to_limit == 0
    assert wear.assess(base, under, limit=70).hours_to_limit == pytest.approx(7.5)  # (70 - 85) / -2


def test_a_fall_is_negative_whatever_the_baselines_sign() -> None:
    vacuum = wear.assess(buckets([-10.0] * 6), buckets([-12.0] * 4, 6), direction="down")
    assert vacuum.change == pytest.approx(-0.2)
    assert vacuum.verdict == "wearing"


def test_the_threshold_is_written_as_given(api: TestClient, site: str) -> None:  # noqa: F811
    signal = load(api, site, "w03.cathode_power", FIXTURE["cathode"], step=HOUR)
    out = check(api, site, signal, baseline_hours=48, threshold=0.025).json()
    assert "(the threshold is 2.5%)" in out["text"]


def test_sens_interval_of_the_slope_and_the_time_to_a_limit() -> None:
    # Six pairwise slopes, sorted -1, 0.5, 0.667, 1, 1.5, 2; for 4 points C = 1.96 * sqrt(4 * 3 * 13 / 18).
    pts = [wear.Bucket(0, 0), wear.Bucket(1, 1), wear.Bucket(2, 3), wear.Bucket(3, 2)]
    assert wear.sen_interval(pts) == (-1, 2)
    assert wear.sen_interval(pts[:2]) is None  # too few to say
    # SciPy's theilslopes on the same points gives these (scipy.stats.theilslopes(y, x, 0.95)).
    xs = range(10)
    ys = [0.0, 1.3, 1.9, 3.4, 3.8, 5.6, 5.9, 7.3, 8.2, 8.8]
    assert wear.sen_interval([wear.Bucket(x, y) for x, y in zip(xs, ys, strict=True)]) == (0.9, 1.08)
    tied = [1, 1, 2, 2, 2, 3, 3, 4, 4, 5]  # tied values narrow the interval, as SciPy's does
    assert wear.sen_interval([wear.Bucket(x, y) for x, y in zip(xs, tied, strict=True)]) == (1 / 3, 0.5)
    rng = random.Random(7)  # noqa: S311 - test data
    rising = [wear.Bucket(i, 10 + 0.5 * i + rng.gauss(0, 1)) for i in range(24)]
    low, high = wear.sen_interval(rising) or (0, 0)
    assert low < (wear.theil_sen(rising) or 0) < high and low > 0.3 and high < 0.7
    flat = [wear.Bucket(i - 10, 10) for i in range(8)]
    a = wear.assess(flat, rising, direction="up", limit=40)
    assert a.hours_to_limit is not None and a.hours_interval is not None
    earliest, latest = a.hours_interval
    assert latest is not None and earliest < a.hours_to_limit < latest
    # A slope that may be falling: there is an earliest time, but it may never get there.
    assert wear._hours_between(40, 10, (-0.1, 0.5), "up") == (60, None)
    assert wear._hours_between(40, 10, (0.25, 0.5), "up") == (60, 120)
    assert wear._hours_between(40, 10, (-0.5, -0.1), "up") is None
    # The median slope may miss the limit while the interval's fastest reaches it: maybe.
    steady = [wear.Bucket(i, 10 + (0.3 if i % 2 else -0.3) + 0.01 * i) for i in range(24)]
    c = wear.assess(flat, steady, direction="up", limit=11)
    assert c.hours_interval is not None and c.hours_interval[0] > 0
    assert wear._hours_between(None, 10, (0.25, 0.5), "up") is None
