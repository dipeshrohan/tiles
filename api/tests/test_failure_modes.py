"""Die casting's failure-mode models (T8.02 to T8.04): the same numbers as the browser's twins,
what each reads from its failure, and the backtest's join and windows (the runner's)."""

import json
import math
from array import array
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest

from tiles_api.backtest import Event
from tiles_api.models.failure_modes import AccumulatorCharge, DieCooling, FurnaceHeater
from tiles_api.models.registry import Model, evaluate, registry
from tiles_api.sample_plant.die_casting import failure_backtest as fb

FIXTURE = Path(__file__).parents[2] / "test" / "fixtures" / "failure-models.json"
WINDOWS: list[dict[str, Any]] = json.loads(FIXTURE.read_text())["windows"]
MODELS: dict[str, Model] = {"accumulator": AccumulatorCharge(), "furnace": FurnaceHeater(), "cooling": DieCooling()}
CASES = [(i, name) for i, w in enumerate(WINDOWS) for name in MODELS if name in w]


def same(a: list[float | None], b: list[float | None]) -> bool:
    return len(a) == len(b) and all(
        (x is None and y is None)
        or (x is not None and y is not None and math.isclose(x, y, rel_tol=1e-12, abs_tol=1e-12))
        for x, y in zip(a, b, strict=True)
    )


@pytest.mark.parametrize(("i", "name"), CASES, ids=[f"{n}-{i}" for i, n in CASES])
def test_each_model_gives_the_browser_twins_numbers(i: int, name: str) -> None:
    case = WINDOWS[i][name]
    out = evaluate(MODELS[name], case["inputs"])
    assert set(out) == set(case["outputs"])
    for port, values in case["outputs"].items():
        assert same(out[port], values), port  # js/lib/failure-models.ts made them


def test_the_models_are_registered_as_virtual_sensors_for_die_casting() -> None:
    for key in ("accumulator-charge", "furnace-heater", "die-cooling"):
        spec = registry.get(key).spec
        assert (spec.version, spec.kind, spec.domain) == ("1.0.0", "virtual-sensor", "die casting")


def test_the_accumulator_charge_follows_the_gas_and_orifice_laws() -> None:
    out = evaluate(AccumulatorCharge(), {"buildup": [24.0, 40.0], "pressure": [160.0, 110.0]})
    ratio = 0.7**1.4
    assert out["precharge"] == [160 * ratio, 110 * ratio]
    assert out["expected_buildup"][0] == 24  # the rated accumulator: as rated
    e = 24 * math.sqrt(100 / 50)
    assert out["expected_buildup"][1] == pytest.approx(e)  # half the pressure over the load: √2 slower
    assert out["excess_buildup"] == [0, pytest.approx(40 - e)]
    # A larger fill compresses the gas more: the same charged pressure is a lower precharge.
    more = evaluate(AccumulatorCharge(), {"buildup": [24.0], "pressure": [160.0]}, {"fill": 0.5})
    assert more["precharge"][0] is not None and more["precharge"][0] < out["precharge"][0]  # type: ignore[operator]


def test_the_furnace_heater_leaves_out_a_waiting_cell_and_explains_the_bath() -> None:
    out = evaluate(
        FurnaceHeater(), {"power": [48.0, 48.0, 60.0], "bath": [690.0, 680.0, 690.0], "cycle": [90.0, 90.0, 900.0]}
    )
    assert out["demand"] == [48, pytest.approx(48 - 3.4), None]  # a cooler bath needs less
    assert out["excess"] == [0, pytest.approx(3.4), None]
    assert out["bath_deficit"] == [5.0]  # the median of 0 and 10


def test_die_cooling_gives_its_blockage_beyond_the_limit() -> None:
    clean = evaluate(DieCooling(), {"die_temp": [240.0], "fixed_temp": [236.0], "flow": [42.0]})
    assert clean["flow_loss"] == [0] and clean["half_gap"] == [0] and clean["over_limit"] == [0]
    blocked = evaluate(DieCooling(), {"die_temp": [270.0], "fixed_temp": [236.0], "flow": [21.0]})
    assert blocked["blockage"] == [0.5] and blocked["over_limit"] == [pytest.approx(0.3)]
    assert blocked["heat_transfer"] == [pytest.approx(0.5**0.8)]
    assert blocked["hot_half"] == [30]


def series(points: list[tuple[float, float]]) -> tuple[array[float], array[float]]:
    return array("d", [t for t, _ in points]), array("d", [v for _, v in points])


def test_the_join_takes_each_inputs_latest_reading_within_the_alignment_as_the_runner_does() -> None:
    shots = series([(100, 1), (400, 2), (1000, 3)])
    grid = series([(0, 10), (300, 20), (600, 30)])
    times, columns = fb.join([shots, grid], 300)
    # 100: the grid's 0; 400: its 300; 1000: its last was 600, more than 300 s before: left out.
    assert times == [100, 400] and columns == [[1, 2], [10, 20]]
    assert fb.join([series([(5, 1)]), grid], 300) == ([5.0], [[1.0], [10.0]])
    assert fb.join([series([(-1, 1)]), grid], 300) == ([], [[], []])  # nothing yet


def test_windows_are_hourly_and_written_at_their_last_reading() -> None:
    plan = fb.PLANS[2]
    hour = 3600
    times = [0.0, 1800.0, hour + 60.0]
    columns = [[240.0, 240.0, 260.0], [236.0, 236.0, 236.0], [42.0, 42.0, 21.0]]
    at, values = fb.windows(plan, times, columns)
    assert at == [datetime.fromtimestamp(1800, UTC), datetime.fromtimestamp(hour + 60, UTC)]
    assert values == [0, pytest.approx(0.3)]


def test_pooled_scores_add_up_over_the_cells() -> None:
    t0 = datetime(2026, 1, 1, tzinfo=UTC)
    at = [t0 + timedelta(hours=h) for h in range(300)]
    flat = [0.0] * 300
    rising = [0.0] * 200 + [1.0] * 100
    config = fb.LIMIT[0]
    stop = Event(t0 + timedelta(hours=250), "DT-DIE")
    got = fb.pooled([config], {"a": (at, rising), "b": (at, flat)}, {"a": [stop], "b": []}, None, None)[0]
    assert (got.events, got.caught, got.false) == (1, 1, 0)
    assert got.median_hours == pytest.approx(250 - 200 - (config.persist - 1))
