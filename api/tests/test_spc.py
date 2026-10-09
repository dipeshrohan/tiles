"""The SPC chart (T6.10): limits from a baseline, and the Western Electric rules."""

import pytest

from tiles_api import spc

# A baseline that moves by exactly 1 between neighbours: MR-bar is 1, sigma 1 / 1.128.
BASELINE = [10.0, 11.0, 10.0, 11.0, 10.0, 11.0, 10.0, 11.0, 10.0, 11.0]


def lim() -> spc.Limits:
    found = spc.limits(BASELINE)
    assert found is not None
    return found


def test_limits_come_from_the_mean_and_the_average_moving_range() -> None:
    limits = lim()
    assert limits.centre == pytest.approx(10.5)
    assert limits.sigma == pytest.approx(1 / 1.128)
    assert limits.upper == pytest.approx(10.5 + 3 / 1.128)
    assert limits.lower == pytest.approx(10.5 - 3 / 1.128)
    assert spc.limits(BASELINE, k=2).upper == pytest.approx(10.5 + 2 / 1.128)  # type: ignore[union-attr]
    assert spc.limits(BASELINE[:7]) is None  # too few points
    assert spc.limits([5.0] * 10) is None  # no spread to measure


def at(sigmas: float) -> float:
    return 10.5 + sigmas / 1.128


def rules(points: list[float], only: list[spc.Rule] | None = None) -> list[tuple[int, str]]:
    return [(v.index, v.rule) for v in spc.violations(points, lim(), only or spc.RULES)]


def test_a_point_beyond_a_limit() -> None:
    assert rules([at(0.5), at(3.5), at(-0.5), at(-3.2)], ["beyond_limits"]) == [
        (1, "beyond_limits"),
        (3, "beyond_limits"),
    ]


def test_two_of_three_and_four_of_five_on_one_side() -> None:
    assert rules([at(2.5), at(0.1), at(2.2)], ["two_of_three"]) == [(2, "two_of_three")]
    assert rules([at(2.5), at(0.1), at(-2.2)], ["two_of_three"]) == []  # opposite sides
    assert rules([at(1.5), at(1.2), at(-0.3), at(1.1), at(1.4)], ["four_of_five"]) == [(4, "four_of_five")]


def test_a_run_of_eight_is_reported_once() -> None:
    run = [at(0.4)] * 12
    assert rules(run, ["run_of_eight"]) == [(7, "run_of_eight")]
    broken = [at(0.4)] * 7 + [at(-0.4)] + [at(0.4)] * 8
    assert rules(broken, ["run_of_eight"]) == [(15, "run_of_eight")]


def test_a_trend_of_six() -> None:
    rising = [at(-1 + 0.3 * i) for i in range(6)]
    assert rules(rising, ["trend_of_six"]) == [(5, "trend_of_six")]
    assert rules([*rising[:3], rising[2], *rising[3:]], ["trend_of_six"]) == []  # a flat step breaks it


def test_a_quiet_process_breaks_no_rule() -> None:
    assert rules([at(z) for z in (0.3, -0.5, 0.8, -0.2, 0.1, -0.9, 0.4, -0.1, 0.6, -0.3)]) == []
