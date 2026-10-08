"""Model registry (T3.01) and the plunger-friction virtual sensor (T3.02)."""

import json
import math
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any, ClassVar

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import VIEWER, api, site  # noqa: F401 - api and site are fixtures

from tiles_api.models import store
from tiles_api.models.plunger import PlungerFriction
from tiles_api.models.registry import ModelError, ModelSpec, Param, Port, Registry, evaluate, registry

SHOTS = json.loads((Path(__file__).parents[2] / "test" / "fixtures" / "plunger-shots.json").read_text())["shots"]


def spec(**changes: Any) -> ModelSpec:
    fields: dict[str, Any] = {
        "key": "doubler",
        "version": "1.0.0",
        "name": "Doubler",
        "kind": "virtual-sensor",
        "inputs": (Port("x", "m"),),
        "outputs": (Port("y", "m"), Port("total", "m", per="window")),
        "params": (Param("gain", "", 2, 0, 10),),
    }
    return ModelSpec(**(fields | changes))


class Doubler:
    spec: ClassVar[ModelSpec] = spec()

    def run(self, inputs: Mapping[str, Sequence[float]], params: Mapping[str, float]) -> dict[str, list[float | None]]:
        y: list[float | None] = [params["gain"] * x for x in inputs["x"]]
        return {"y": y, "total": [math.nan if not y else sum(v for v in y if v is not None)]}


@pytest.mark.parametrize(
    ("changes", "problem"),
    [
        ({"key": "Bad Key"}, "key 'Bad Key'"),
        ({"version": "1.0"}, "MAJOR.MINOR.PATCH"),
        ({"outputs": ()}, "at least one output"),
        ({"inputs": (Port("x", "m"), Port("x", "s"))}, "input names must be unique"),
        ({"params": (Param("gain", "", 20, 0, 10),)}, "default 20 is outside [0, 10]"),
        ({"params": (Param("Gain", "", 1),)}, "param name 'Gain'"),
    ],
)
def test_a_spec_is_checked_when_written(changes: dict[str, Any], problem: str) -> None:
    with pytest.raises(ModelError) as e:
        spec(**changes)
    assert problem in str(e.value)


def test_the_registry_finds_the_latest_version_and_keeps_a_version_fixed() -> None:
    reg = Registry()
    reg.add(Doubler())

    class Newer(Doubler):
        spec = spec(version="1.10.0")

    class Older(Doubler):
        spec = spec(version="1.9.0")

    reg.add(Newer())
    reg.add(Older())
    assert reg.get("doubler").spec.version == "1.10.0"  # numerically, not as text
    assert reg.get("doubler", "1.9.0").spec.version == "1.9.0"
    assert [m.spec.version for m in reg.all()] == ["1.0.0", "1.9.0", "1.10.0"]
    with pytest.raises(KeyError):
        reg.get("doubler", "2.0.0")

    class Changed(Doubler):
        spec = spec(name="Doubler, renamed")

    with pytest.raises(ModelError, match="registered twice with different specs"):
        reg.add(Changed())


def test_evaluate_checks_inputs_and_params_and_fills_defaults() -> None:
    model = Doubler()
    assert evaluate(model, {"x": [1, 2.5]}) == {"y": [2.0, 5.0], "total": [7.0]}
    assert evaluate(model, {"x": [1]}, {"gain": 3}) == {"y": [3.0], "total": [3.0]}
    assert evaluate(model, {"x": []}) == {"y": [], "total": [None]}  # NaN means no value
    cases: list[tuple[dict[str, list[Any]], dict[str, Any], str]] = [
        ({}, {}, "missing input x"),
        ({"x": [1], "z": [1]}, {}, "unknown input(s): z"),
        ({"x": [1, None]}, {}, "input x must be finite numbers"),
        ({"x": [True]}, {}, "input x must be finite numbers"),
        ({"x": [math.inf]}, {}, "input x must be finite numbers"),
        ({"x": [1]}, {"gain": 11}, "param gain = 11 is outside [0, 10]"),
        ({"x": [1]}, {"gain": "2"}, "param gain must be a finite number"),
        ({"x": [1]}, {"speed": 1}, "unknown param(s): speed"),
    ]
    for inputs, params, problem in cases:
        with pytest.raises(ModelError) as e:
            evaluate(model, inputs, params)
        assert problem in str(e.value), (inputs, params)


def test_evaluate_checks_what_a_model_returns() -> None:
    class Broken(Doubler):
        def run(
            self, inputs: Mapping[str, Sequence[float]], params: Mapping[str, float]
        ) -> dict[str, list[float | None]]:
            return {"y": [1.0]}

    with pytest.raises(ModelError, match=r"returned \['y'\], not \['total', 'y'\]"):
        evaluate(Broken(), {"x": [1, 2]})

    class Short(Doubler):
        def run(
            self, inputs: Mapping[str, Sequence[float]], params: Mapping[str, float]
        ) -> dict[str, list[float | None]]:
            return {"y": [1.0], "total": [1.0]}

    with pytest.raises(ModelError, match="returned 1 values for y, not 2"):
        evaluate(Short(), {"x": [1, 2]})

    class Unequal(Doubler):
        spec = spec(inputs=(Port("x", "m"), Port("w", "m")))

    with pytest.raises(ModelError, match="the same length"):
        evaluate(Unequal(), {"x": [1, 2], "w": [1]})


# ---- plunger friction (T3.02), against the browser's model ---------------------------


@pytest.mark.parametrize("shot", SHOTS, ids=[str(s["friction"]) for s in SHOTS])
def test_plunger_friction_gives_the_browser_models_estimate(shot: dict[str, Any]) -> None:
    payload = shot["payload"]
    out = evaluate(PlungerFriction(), {k: payload[k] for k in ("t", "v", "ph", "pm")})
    estimate = out["friction"][0]
    assert estimate is not None
    assert math.isclose(estimate, shot["estimate"], rel_tol=1e-9)  # the same number as js/lib/physics.ts
    assert abs(estimate - shot["friction"]) / shot["friction"] < 0.05  # and close to the true friction
    assert len(out["force"]) == len(payload["t"]) and out["force"][0] is None


def test_plunger_friction_skips_samples_without_time_passing() -> None:
    out = evaluate(PlungerFriction(), {"t": [0, 0.005, 0.005, 0.01], "v": [0, 1, 1, 1], "ph": [50] * 4, "pm": [10] * 4})
    assert out["force"][0] is None and out["force"][2] is None  # a repeated timestamp
    assert out["friction"][0] is not None
    # Heavier plunger, same shot: more of the force went into acceleration.
    heavier = evaluate(PlungerFriction(), {"t": [0, 0.005], "v": [0, 1], "ph": [50] * 2, "pm": [10] * 2}, {"mass": 100})
    lighter = evaluate(PlungerFriction(), {"t": [0, 0.005], "v": [0, 1], "ph": [50] * 2, "pm": [10] * 2})
    assert heavier["friction"][0] is not None and lighter["friction"][0] is not None
    assert heavier["friction"][0] < lighter["friction"][0]


def test_the_built_in_models_are_registered() -> None:
    assert registry.get("plunger-friction").spec.version == "1.0.0"


# ---- stored per organisation, and served -----------------------------------------------


def test_each_organisation_stores_the_registered_versions_once(database_url: str, site: str) -> None:  # noqa: F811
    reg = Registry()
    reg.add(Doubler())
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        org = conn.execute("SELECT org_id FROM sites WHERE id = %s", [site]).fetchone()
        assert org is not None
        conn.execute("DELETE FROM models WHERE key = 'doubler'")
        store.sync(conn, org["org_id"], reg)
        store.sync(conn, org["org_id"], reg)  # the second time, nothing to add
        rows = conn.execute("SELECT key, version, kind, spec FROM models WHERE key = 'doubler'").fetchall()
        assert [(r["key"], r["version"], r["kind"]) for r in rows] == [("doubler", "1.0.0", "virtual-sensor")]
        assert rows[0]["spec"]["params"][0]["default"] == 2

        # The same version with another spec: refused, rather than changing what runs used.
        class Changed(Doubler):
            spec = spec(params=(Param("gain", "", 3, 0, 10),))

        changed = Registry()
        changed.add(Changed())
        with pytest.raises(store.ModelChanged, match=r"doubler 1\.0\.0"):
            store.sync(conn, org["org_id"], changed)
        conn.rollback()


def test_the_api_lists_and_evaluates_models(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    listed = api.get(f"/sites/{site}/models", headers=VIEWER)
    assert listed.status_code == 200, listed.text
    plunger = next(m for m in listed.json() if m["key"] == "plunger-friction")
    assert (plunger["version"], plunger["kind"], [p["name"] for p in plunger["inputs"]]) == (
        "1.0.0",
        "virtual-sensor",
        ["t", "v", "ph", "pm"],
    )
    assert plunger["outputs"][1] == {
        "name": "friction",
        "unit": "N",
        "description": plunger["outputs"][1]["description"],
        "per": "window",
    }
    with psycopg.connect(database_url) as conn:
        assert conn.execute(
            "SELECT count(*) FROM models m JOIN sites s ON s.org_id = m.org_id WHERE s.id = %s AND m.key = %s",
            [site, "plunger-friction"],
        ).fetchone() == (1,)
    assert [v["version"] for v in api.get(f"/sites/{site}/models/plunger-friction", headers=VIEWER).json()] == ["1.0.0"]
    assert api.get(f"/sites/{site}/models/nothing", headers=VIEWER).status_code == 404

    shot = SHOTS[2]
    body = {"inputs": {k: shot["payload"][k] for k in ("t", "v", "ph", "pm")}}
    res = api.post(f"/sites/{site}/models/plunger-friction/evaluate", json=body, headers=VIEWER)
    assert res.status_code == 200, res.text
    assert (res.json()["version"], round(res.json()["outputs"]["friction"][0], 6)) == (
        "1.0.0",
        round(shot["estimate"], 6),
    )
    bad = api.post(
        f"/sites/{site}/models/plunger-friction/evaluate", json={**body, "params": {"mass": -1}}, headers=VIEWER
    )
    assert (bad.status_code, bad.json()["detail"]) == (422, "param mass = -1 is outside [1, 10000]")
    missing = api.post(f"/sites/{site}/models/plunger-friction/evaluate", json={"version": "9.9.9"}, headers=VIEWER)
    assert missing.status_code == 404
