"""Streaming detection (T3.04): rolling robust baseline, persistence and cooldown."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

from tiles_api.detection import Config, State, step

FIXTURE = json.loads((Path(__file__).parents[2] / "test" / "fixtures" / "friction-detection.json").read_text())
T0 = datetime(2026, 9, 1, tzinfo=UTC)


def readings(values: list[float], every: float = 95.0) -> list[tuple[datetime, float]]:
    return [(T0 + timedelta(seconds=i * every), v) for i, v in enumerate(values)]


def index(at: datetime, every: float = 95.0) -> int:
    return round((at - T0).total_seconds() / every)


def test_it_raises_the_browsers_alerts_in_one_pass_or_fed_in_pieces() -> None:
    config = Config(**FIXTURE["config"])
    expected = [(a["firstShot"], a["lastShot"], a["peak"]) for a in FIXTURE["alerts"]]
    data = readings(FIXTURE["values"])
    for pieces in ([data], [data[:150], data[150:500], data[500:501], data[501:1200], data[1200:]]):
        state = State()
        closed = []
        for piece in pieces:
            # The state goes through JSON between pieces, as between runs of the job.
            state = State.from_json(json.loads(json.dumps(state.as_json())))
            done, _ = step(config, state, piece)
            closed += done
        found = [(index(w.started_at), index(w.last_at), w.peak) for w in closed]
        assert found == expected
        assert all(w.side == "above" and w.peak > w.threshold > w.baseline for w in closed)


def flat_then(values: list[float], base: float = 100.0, n: int = 20) -> list[tuple[datetime, float]]:
    return readings([base] * n + values, every=1.0)


def test_nothing_is_judged_until_the_baseline_is_full() -> None:
    state = State()
    assert step(Config(window=20, persist=1), state, readings([1e9] * 20, every=1.0)) == ([], [])
    assert state.open is None and len(state.baseline) == 20


def test_a_cooldown_keeps_one_rough_patch_from_raising_many_warnings() -> None:
    out, back = 200.0, 100.0
    # Out 3, back 1, out 3, back 1 … with cooldown 4: the second run of 3 starts inside it.
    values = [out] * 3 + [back] + [out] * 3 + [back] + [back] * 3 + [out] * 3 + [back]
    config = Config(window=20, k=3, persist=2, cooldown=4)
    closed, opened = step(config, State(), flat_then(values))
    assert len(opened) == 2 and len(closed) == 2
    assert [index(w.started_at, every=1.0) for w in opened] == [21, 32]  # the second patch is skipped
    # Without a cooldown, each patch is its own warning.
    _, opened = step(Config(window=20, k=3, persist=2), State(), flat_then(values))
    assert [index(w.started_at, every=1.0) for w in opened] == [21, 25, 32]


def test_a_run_still_out_when_the_cooldown_ends_raises_then() -> None:
    values = [200.0] * 2 + [100.0] + [200.0] * 6 + [100.0]
    _, opened = step(Config(window=20, k=3, persist=2, cooldown=3), State(), flat_then(values))
    # Closed at 22; readings 23, 24, 25 are the cooldown; 26 is out and the run is long enough.
    assert [index(w.started_at, every=1.0) for w in opened] == [21, 26]


def test_direction_and_the_spread_floor() -> None:
    low = flat_then([50.0] * 3)
    assert step(Config(window=20, k=3, persist=3), State(), low)[1] == []  # above only
    _, opened = step(Config(window=20, k=3, persist=3, direction="below"), State(), low)
    assert [(w.side, w.peak, w.threshold) for w in opened] == [("below", 50.0, 97.0)]  # 100 - 3 x min_spread 1
    _, opened = step(Config(window=20, k=3, persist=3, direction="both"), State(), flat_then([150.0] * 3))
    assert opened[0].side == "above"
    # A flat baseline counts as spread min_spread, so a small wobble isn't a warning.
    assert step(Config(window=20, k=3, persist=1, min_spread=5), State(), flat_then([110.0]))[1] == []


def test_an_open_warning_survives_a_save_between_runs() -> None:
    config = Config(window=20, k=3, persist=2)
    state = State()
    step(config, state, flat_then([200.0] * 3))
    assert state.open is not None
    restored = State.from_json(json.loads(json.dumps(state.as_json())))
    later = [(T0 + timedelta(seconds=23), 250.0), (T0 + timedelta(seconds=24), 100.0)]
    closed, _ = step(config, restored, later)
    assert len(closed) == 1
    w = closed[0]
    assert (w.peak, w.readings, index(w.started_at, every=1.0), index(w.ended_at, every=1.0)) == (250.0, 3, 21, 24)  # type: ignore[arg-type]
