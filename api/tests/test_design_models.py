"""Design Studio models in the shared registry (T4.10): the browser's swelling and actuator models,
version by version, give the same numbers here (test/fixtures/design-models.json)."""

import json
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures

from tiles_api.models import registry as r
from tiles_api.models.design import from_browser
from tiles_api.models.registry import ModelError, evaluate

FIXTURE: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[2] / "test" / "fixtures" / "design-models.json").read_text()
)
CASES = [
    (browser_id, version, case)
    for browser_id, model in FIXTURE.items()
    for version, cases in model["versions"].items()
    for case in cases
]


@pytest.mark.parametrize(("browser_id", "version", "case"), CASES)
def test_each_version_gives_the_browsers_number(browser_id: str, version: str, case: dict[str, Any]) -> None:
    model = r.registry.get(*from_browser(browser_id, version))
    out = evaluate(model, {}, case["params"])
    [value] = next(iter(out.values()))
    assert value is not None
    assert abs(value - case["value"]) <= 1e-12 * max(1.0, abs(case["value"])), (value, case)


@pytest.mark.parametrize("browser_id", sorted(FIXTURE))
def test_every_versions_spec_is_the_browsers_word_for_word(browser_id: str) -> None:
    browser = FIXTURE[browser_id]
    key, latest_version = from_browser(browser_id, browser["latest"])
    versions = [m for m in r.registry.all() if m.spec.key == key]
    assert sorted(m.spec.version for m in versions) == sorted(
        from_browser(browser_id, v)[1] for v in browser["versions"]
    )
    assert r.registry.get(key).spec.version == latest_version
    for m in versions:
        s = m.spec
        assert (s.kind, s.name, s.domain, s.inputs) == ("design", browser["name"], browser["domain"], ()), s.version
        assert [(p.name, p.description, p.unit, p.min, p.max, p.default) for p in s.params] == [
            (p["key"], p["label"], p["unit"], p["min"], p["max"], p["default"]) for p in browser["params"]
        ], s.version
        [out] = s.outputs
        assert (out.name, out.description, out.unit) == (
            browser["output"]["key"],
            browser["output"]["label"],
            browser["output"]["unit"],
        ), s.version


def test_browser_ids_and_versions_map_to_the_registry() -> None:
    assert from_browser("swelling", "2.0") == ("cell-swelling", "2.0.0")
    assert from_browser("actuator", "1.1.0") == ("joint-actuator", "1.1.0")
    with pytest.raises(KeyError):
        from_browser("gearbox", "1.0")


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
    # A design model takes no signals: binding one says so.
    res = api.post(
        f"/sites/{site}/model-bindings",
        json={"name": "swell", "model": "cell-swelling", "inputs": {}, "window": {"kind": "gap", "seconds": 2}},
        headers=ENG,
    )
    assert (res.status_code, res.json()["detail"]) == (
        422,
        "cell-swelling is a design model: it takes no signals, so it is run with evaluate, not bound",
    )
