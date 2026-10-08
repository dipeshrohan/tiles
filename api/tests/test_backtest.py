"""The backtest (T3.05): its baselines and replay match the detector exactly, and it scores warnings
against events as the browser does (test/fixtures/friction-detection.json)."""

import json
import random
import statistics
from collections import deque
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest

from tiles_api import backtest
from tiles_api.backtest import Event, Spread, baselines, check_size, ranked, replay, report, score, settings
from tiles_api.detection import Alert, Config, State, mad, step

FIXTURE = json.loads((Path(__file__).parents[2] / "test" / "fixtures" / "friction-detection.json").read_text())
T0 = datetime(2026, 8, 1, tzinfo=UTC)
EVERY = timedelta(seconds=FIXTURE["cycleSeconds"])
TIMES = [T0 + i * EVERY for i in range(len(FIXTURE["values"]))]


def slow_baselines(values: list[float], window: int) -> list[tuple[float, float] | None]:
    """What detection.step computes for each reading."""
    out: list[tuple[float, float] | None] = []
    base: deque[float] = deque()
    for v in values:
        if len(base) >= window:
            center = statistics.median(base)
            out.append((center, mad(base, center)))
        else:
            out.append(None)
        base.append(v)
        if len(base) > window:
            base.popleft()
    return out


@pytest.mark.parametrize("window", [10, 11, 25, 200])
def test_baselines_are_exactly_the_detectors(window: int) -> None:
    rng = random.Random(window)  # noqa: S311 - test data, not secrets
    # Ties, flat stretches, steps and noise: every case the sorted search has to get right.
    values = [round(rng.gauss(0, 1), 1) for _ in range(400)] + [5.0] * 60 + [rng.uniform(-1e3, 1e3) for _ in range(300)]
    assert baselines(values, window) == slow_baselines(values, window)
    assert baselines(FIXTURE["values"], window) == slow_baselines(FIXTURE["values"], window)
    assert baselines(values[: window - 3], window) == [None] * (window - 3)


def as_tuples(alerts: list[Alert]) -> list[tuple[object, ...]]:
    return [(a.started_at, a.last_at, a.ended_at, a.peak, a.side, a.readings, a.threshold) for a in alerts]


def test_a_replay_raises_the_warnings_a_detector_with_that_setting_raises() -> None:
    rng = random.Random(5)  # noqa: S311 - test data, not secrets
    values = [rng.gauss(0, 1) + (6 if 300 <= i < 330 else 0) - (6 if 500 <= i < 520 else 0) for i in range(800)]
    values += [rng.gauss(0, 1) * (1 + i % 7) for i in range(400)]
    times = [T0 + i * EVERY for i in range(len(values))]
    configs = settings(window=[20, 50], k=[2.5, 4], persist=[1, 3], direction=["above", "both"], cooldown=[0, 15])
    assert len(configs) == 32
    for outcome in replay(times, values, [], configs, timedelta(hours=1)):
        _, opened = step(outcome.config, State(), zip(times, values, strict=True))
        assert as_tuples(outcome.alerts) == as_tuples(opened), outcome.config
    shots = replay(TIMES, FIXTURE["values"], [], [Config()], timedelta(hours=1))[0].alerts
    assert [(TIMES.index(a.started_at), TIMES.index(a.last_at), a.peak) for a in shots] == [
        (a["firstShot"], a["lastShot"], a["peak"]) for a in FIXTURE["alerts"]
    ]


def test_events_are_scored_as_the_browser_scores_them() -> None:
    events = [Event(TIMES[d["shot"]], d["code"]) for d in FIXTURE["downtime"]]
    horizon = FIXTURE["horizonShots"] * EVERY
    (o,) = replay(TIMES, FIXTURE["values"], events, [Config()], horizon)
    assert [(TIMES.index(e.event.at), e.warned_at is not None, e.warning_time) for e in o.events] == [
        (s["shot"], s["predicted"], s["leadShots"] * EVERY) for s in FIXTURE["scored"]
    ]
    assert (o.caught, o.recall, o.true_warnings, o.false_warnings, o.pending_warnings) == (3, 1.0, 3, 0, 0)
    assert o.precision == 1.0 and o.false_per_day == 0.0
    leads = sorted(s["leadShots"] * EVERY.total_seconds() for s in FIXTURE["scored"])
    p10, p90 = leads[0] + 0.2 * (leads[1] - leads[0]), leads[1] + 0.8 * (leads[2] - leads[1])  # linear in rank
    assert o.warning_times == Spread(3, leads[0], p10, leads[1], p90, leads[2])
    # A horizon too short for the first warning (82 shots ahead): that event is missed.
    (short,) = replay(TIMES, FIXTURE["values"], events, [Config()], 70 * EVERY)
    assert [e.warned_at is not None for e in short.events] == [False, True, True]
    assert (short.true_warnings, short.false_warnings) == (2, 1)


def alert(at: datetime) -> Alert:
    return Alert(started_at=at, last_at=at, peak=1, baseline=0, threshold=1, side="above", readings=1)


def test_the_horizon_bounds_and_the_history_ends_are_kept() -> None:
    h = timedelta(hours=2)
    start, end = T0, T0 + timedelta(days=2)
    events = [
        Event(T0 - timedelta(hours=1), "before"),  # before the history: not counted
        Event(T0 + timedelta(hours=5), "on time"),  # the warning at 3 h is exactly 2 h ahead: too early
        Event(T0 + timedelta(hours=10), "same reading"),  # a warning at the event itself counts
        Event(end + timedelta(minutes=30), "after"),
    ]
    warnings = [
        alert(T0 + timedelta(hours=3)),
        alert(T0 + timedelta(hours=10)),
        alert(T0 + timedelta(hours=20)),  # false
        alert(end - timedelta(hours=1)),  # its horizon outlasts the history: pending...
    ]
    o = score(Config(), warnings, events, h, start, end)
    assert [(e.event.code, e.warning_time) for e in o.events] == [("on time", None), ("same reading", timedelta(0))]
    # ...though an event after the history still makes it true.
    assert (o.true_warnings, o.false_warnings, o.pending_warnings) == (2, 2, 0)
    o = score(Config(), warnings, events[:3], h, start, end)
    assert (o.true_warnings, o.false_warnings, o.pending_warnings) == (1, 2, 1)
    assert (o.recall, o.precision, o.false_per_day) == (0.5, 1 / 3, 1.0)
    empty = score(Config(), [], [], h, start, start)
    assert (empty.recall, empty.precision, empty.false_per_day, empty.warning_times) == (None, None, None, None)


def test_settings_are_combined_once_and_the_size_is_bounded() -> None:
    configs = settings(window=[100, 100], k=[3, 4], persist=[2])
    assert configs == [Config(100, 3, 2), Config(100, 4, 2)]
    check_size(backtest.MAX_READINGS, [Config()] * 10)
    for readings, configs, message in [
        (10, [], "No settings to try"),
        (10, [Config()] * (backtest.MAX_SETTINGS + 1), "at most 48 at once"),
        (backtest.MAX_READINGS + 1, [Config()], "choose a shorter period"),
        (backtest.MAX_READINGS, [Config()] * 11, "try fewer settings"),
        (backtest.MAX_READINGS, [Config(window=w) for w in (10, 20, 30, 40, 50, 60)], "6 window sizes"),
    ]:
        with pytest.raises(ValueError, match=message):
            check_size(readings, configs)


def test_a_short_history_judges_nothing() -> None:
    (o,) = replay(TIMES[:50], FIXTURE["values"][:50], [Event(TIMES[40])], [Config()], timedelta(hours=1))
    assert (o.alerts, o.events, o.days, o.recall) == ([], [], 0.0, None)


def test_the_report_ranks_the_settings_and_lists_the_best_ones_events() -> None:
    events = [Event(TIMES[d["shot"]], d["code"]) for d in FIXTURE["downtime"]]
    configs = settings(window=[100], k=[2.5, 8, 4], persist=[1])
    outcomes = replay(TIMES, FIXTURE["values"], events, configs, 300 * EVERY)
    # k 2.5 warns of all three too, but also twice for nothing; k 8 never warns.
    assert [(o.config.k, o.caught, o.false_warnings) for o in ranked(outcomes)] == [(4, 3, 0), (2.5, 3, 2), (8, 0, 0)]
    text = report("Backtest: dc1.friction", {"Signal": "dc1.friction"}, outcomes, 300 * EVERY)
    assert text.startswith("# Backtest: dc1.friction\n\n- **Signal:** dc1.friction\n")
    assert "- **Warning horizon:** 7.9 h before an event" in text
    rows = [line for line in text.splitlines() if line.startswith("| window")]
    assert rows[0].startswith("| window 100, k 4, persist 1 | 17 | 0.00 | 100% (3/3) | 100% |")
    assert rows[1].startswith(
        "| window 100, k 2.5, persist 1 | 27 | 1.21 | 100% (3/3) | 93% |"
    )  # 2 in 1,499 shots of 95 s
    assert rows[2] == "| window 100, k 8, persist 1 | 0 | 0.00 | 0% (0/3) | - | - |"
    assert "## Events with the best setting (window 100, k 4, persist 1)" in text
    best = ranked(outcomes)[0].events[0]
    assert best.warning_time is not None
    lead = backtest.duration(best.warning_time.total_seconds())
    assert f"| {TIMES[560].isoformat()} | DT-SEIZURE | yes | {lead} |" in text


def test_durations_read_well() -> None:
    assert [backtest.duration(s) for s in (59, 3600, 7200, 90000, 172800)] == [
        "1 min",
        "60 min",
        "2.0 h",
        "25.0 h",
        "2.0 d",
    ]
