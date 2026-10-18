"""The process model for recommendations (T11.01): the registry's die-porosity carries the fit's
coefficients, computes what they say, and the fit itself recovers a known model."""

import json
import math
import random
from dataclasses import replace
from pathlib import Path

import pytest

from tiles_api.models import process
from tiles_api.models.process import DiePorosity
from tiles_api.models.registry import ModelError, evaluate, registry
from tiles_api.sample_plant.die_casting import process_fit as pf
from tiles_api.sample_plant.die_casting.plant import PILOT, PRODUCTS

FIT = json.loads(
    (Path(__file__).parents[2] / "data" / "sample-plants" / "die-casting" / "process-model" / "fit.json").read_text()
)


def test_the_model_carries_the_committed_fit() -> None:
    # The plant's test checks fit.json is what the fit finds; this, that the model is fit.json.
    assert FIT["coefficients"] == process.COEFFICIENTS
    assert (FIT["vacuum_level"], FIT["buildup_level"]) == (process.VACUUM_LEVEL, process.BUILDUP_LEVEL)
    assert FIT["residual_sd"] == process.RESIDUAL_SD
    assert FIT["passed"] and FIT["held_out"]["mae"] <= FIT["target"]["mae"]
    spec = registry.get("die-porosity").spec
    assert (spec.version, spec.kind, spec.domain) == ("1.0.0", "design", "die casting")
    for value in process.COEFFICIENTS.values():  # the description says the numbers it computes with
        assert f"{value:g}" in spec.description


def test_a_shot_on_its_set_points_is_the_base_and_the_hydrogen() -> None:
    out = evaluate(DiePorosity(), {})
    c = process.COEFFICIENTS
    assert out["porosity"] == [pytest.approx(c["base"] + 0.1 * c["hydrogen"])]  # defaults: on set, 48 mbar
    assert out["grade"] == [0.0] and out["scrap_chance"][0] is not None and out["scrap_chance"][0] < 1e-9


def test_each_term_adds_what_its_coefficient_says() -> None:
    c = process.COEFFICIENTS
    base = evaluate(DiePorosity(), {})["porosity"][0]
    assert base is not None
    changes: dict[str, tuple[dict[str, float], float]] = {
        "vacuum": ({"vacuum": 150}, 100 * c["vacuum"]),
        "intensification": ({"intensification": 800}, 100 * c["intensification"]),
        "intensification above its set point adds nothing": ({"intensification": 950}, 0.0),
        "die temperature, either side": ({"die_temp": 222}, 10 * c["die_temp"]),
        "speed": ({"speed": 4.3}, 0.5 * c["speed"]),
        "build-up": ({"buildup": 45}, 20 * c["buildup"]),
    }
    for name, (params, added) in changes.items():
        got = evaluate(DiePorosity(), {}, params)["porosity"][0]
        assert got == pytest.approx(base + added), name


def test_grade_and_scrap_chance_follow_sop_qa_05() -> None:
    assert [process.grade(p) for p in (0.59, 0.6, 0.85, 1.1, 1.39, 1.4)] == [0, 1, 2, 3, 3, 4]
    # At the scrap limit, half the parts are scrap; a spread above it, about 84 %.
    at = evaluate(DiePorosity(), {}, {"vacuum": 50 + (1.1 - 0.19302 - 0.249836) / 0.002})
    assert at["porosity"][0] == pytest.approx(1.1) and at["scrap_chance"][0] == pytest.approx(0.5)
    hydrogen = 0.1 + process.RESIDUAL_SD / process.COEFFICIENTS["hydrogen"]
    above = evaluate(DiePorosity(), {}, {"vacuum": 50 + (1.1 - 0.19302 - 0.249836) / 0.002, "hydrogen": hydrogen})
    assert above["scrap_chance"][0] == pytest.approx(0.5 * math.erfc(-1 / math.sqrt(2)))


def test_a_state_outside_the_models_bounds_is_refused() -> None:
    with pytest.raises(ModelError, match="vacuum"):
        evaluate(DiePorosity(), {}, {"vacuum": 900})


def test_the_fit_recovers_a_known_model_and_its_levels() -> None:
    rng = random.Random(4)  # noqa: S311 - test data, not secrets
    truth = [0.2, 0.003, 0.004, 2.0, 0.005, 0.1, 0.008]
    made = []
    for i in range(6000):
        product = PRODUCTS[i % len(PRODUCTS)]
        s = pf.Shot(
            at=pf.SPLIT.timestamp() + (i - 3000) * 60,
            asset=PILOT[i % 4].asset,
            product=product.code,
            vacuum=rng.uniform(20, 200),
            intensification=product.intensification_bar - rng.uniform(-40, 120),
            hydrogen=rng.uniform(0.05, 0.2),
            die_temp=product.die_temp_c + rng.uniform(-20, 20),
            speed=product.speed_2nd - rng.uniform(-0.2, 1),
            buildup=rng.uniform(18, 60),
            porosity=0.0,
        )
        made.append(replace(s, porosity=pf.predict(truth, pf.terms(s, 60, 27.5)) + rng.gauss(0, 0.01)))
    f = pf.fit(made)
    assert (f.vacuum_level, f.buildup_level) == (60, 27.5)
    for got, want in zip(f.coefficients.values(), truth, strict=True):
        assert got == pytest.approx(want, rel=0.02, abs=0.0005)
    assert f.held_out.rmse == pytest.approx(0.01, abs=0.002) and f.passed
    assert "meets its target" in pf.report(f)


def test_collinear_terms_have_no_single_fit() -> None:
    with pytest.raises(ValueError, match="collinear"):
        pf.solve([[1.0, 2.0], [2.0, 4.0]], [1.0, 2.0])
