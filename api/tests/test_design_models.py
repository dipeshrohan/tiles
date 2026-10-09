"""Design Studio models in the shared registry (T4.10): the browser's swelling and actuator models,
version by version, give the same numbers here (test/fixtures/design-models.json)."""

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from test_agents import VIEWER, api, site  # noqa: F401 - api and site are fixtures

from tiles_api.models import registry as r
from tiles_api.models.registry import ModelError, evaluate

FIXTURE: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[2] / "test" / "fixtures" / "design-models.json").read_text()
)
KEYS = {"swelling": "cell-swelling", "actuator": "joint-actuator"}  # the browser's ids, the registry's keys


def semver(v: str) -> str:
    return f"{v}.0"


CASES = [
    (browser_id, version, case)
    for browser_id, model in FIXTURE.items()
    for version, cases in model["versions"].items()
    for case in cases
]


@pytest.mark.parametrize(("browser_id", "version", "case"), CASES)
def test_each_version_gives_the_browsers_number(browser_id: str, version: str, case: dict[str, Any]) -> None:
    model = r.registry.get(KEYS[browser_id], semver(version))
    out = evaluate(model, {}, case["params"])
    [value] = next(iter(out.values()))
    assert value is not None
    assert abs(value - case["value"]) <= 1e-12 * max(1.0, abs(case["value"])), (value, case)


@pytest.mark.parametrize("browser_id", sorted(FIXTURE))
def test_the_specs_are_the_browsers(browser_id: str) -> None:
    browser = FIXTURE[browser_id]
    versions = sorted(r.version_key(m.spec.version) for m in r.registry.all() if m.spec.key == KEYS[browser_id])
    assert versions == sorted(r.version_key(semver(v)) for v in browser["versions"])
    latest = r.registry.get(KEYS[browser_id])
    assert latest.spec.version == semver(browser["latest"])
    assert latest.spec.kind == "design"
    assert [(p.name, p.unit, p.min, p.max, p.default) for p in latest.spec.params] == [
        (p["key"], p["unit"], p["min"], p["max"], p["default"]) for p in browser["params"]
    ]
    [out] = latest.spec.outputs
    assert (out.name, out.unit) == (browser["output"]["key"], browser["output"]["unit"])


def test_parameters_outside_their_bounds_are_refused() -> None:
    with pytest.raises(ModelError, match=r"param soc = 120 is outside \[0, 100\]"):
        evaluate(r.registry.get("cell-swelling"), {}, {"soc": 120})
    with pytest.raises(ModelError, match="unknown param"):
        evaluate(r.registry.get("joint-actuator"), {}, {"speed": 1})


def test_a_design_model_runs_through_the_api(api: TestClient, site: str) -> None:  # noqa: F811
    listed = api.get(f"/sites/{site}/models/cell-swelling", headers=VIEWER).json()
    assert [m["version"] for m in listed] == ["2.0.0", "1.1.0", "1.0.0"]
    res = api.post(
        f"/sites/{site}/models/cell-swelling/evaluate",
        json={"version": "2.0.0", "inputs": {}, "params": {"soc": 80}},
        headers=VIEWER,
    )
    assert res.status_code == 200, res.text
    expected = FIXTURE["swelling"]["versions"]["2.0"][0]["value"]  # the defaults (soc 80 is the default)
    assert res.json()["outputs"]["force"][0] == pytest.approx(expected, rel=1e-12)
