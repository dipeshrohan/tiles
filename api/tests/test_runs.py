"""Design runs (T4.11): stored with their parent, version, parameters, the output the API computed
and their author; restored as a new run; compared; never changed."""

import uuid
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures

from tiles_api import api_runs
from tiles_api.models import design
from tiles_api.models.registry import registry


def run(api: TestClient, site: str, body: dict[str, Any], who: dict[str, str] = ENG) -> Any:  # noqa: F811
    return api.post(f"/sites/{site}/runs", json=body, headers=who)


def expected(key: str, version: str, params: dict[str, float]) -> float | None:
    model = registry.get(key, version)
    full = {p.name: params.get(p.name, p.default) for p in model.spec.params}
    [value] = next(iter(model.run({}, full).values()))
    return value


def test_runs_keep_their_lineage(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    first = run(api, site, {"model": "swelling", "version": "1.0", "params": {"soc": 90}, "note": "Baseline"})
    assert first.status_code == 201, first.text
    r1 = first.json()
    assert (r1["number"], r1["model"], r1["version"], r1["parent"], r1["lineage"]) == (
        1,
        "cell-swelling",
        "1.0.0",
        None,
        [],
    )
    assert r1["model_name"] == "Cell swelling force"
    assert r1["params"] == {"soc": 90, "temperature": 25, "preload": 2, "cycles": 300, "thickness": 95}
    assert r1["output"] == {"force": expected("cell-swelling", "1.0.0", {"soc": 90})}
    assert r1["units"]["force"] == "kN" and r1["units"]["preload"] == "kN"
    assert r1["author"]["email"] == "eng@example.com"
    assert r1["changes"] == []

    # Changed from it: a new version and a parameter.
    r2 = run(
        api, site, {"model": "cell-swelling", "version": "2.0.0", "params": {"soc": 90, "cycles": 800}, "parent": 1}
    ).json()
    assert (r2["number"], r2["parent"], r2["lineage"]) == (2, 1, [1])
    assert r2["changes"] == [
        {"key": "version", "before": "1.0.0", "after": "2.0.0"},
        {"key": "cycles", "before": 300, "after": 800},
    ]
    r3 = run(api, site, {"model": "swelling", "params": {"soc": 70, "cycles": 800}, "parent": 2}).json()
    assert (r3["version"], r3["lineage"]) == ("2.0.0", [2, 1])  # the latest version unless named
    assert r3["output"] == {"force": expected("cell-swelling", "2.0.0", {"soc": 70, "cycles": 800})}

    # Read by anyone on the site, the latest first, by model.
    runs = api.get(f"/sites/{site}/runs", headers=VIEWER).json()
    assert ([r["number"] for r in runs["runs"]], runs["total"]) == ([3, 2, 1], 3)
    page = api.get(f"/sites/{site}/runs?model=swelling&limit=1&offset=1", headers=VIEWER).json()
    assert ([r["number"] for r in page["runs"]], page["total"]) == ([2], 3)
    assert api.get(f"/sites/{site}/runs?model=joint-actuator", headers=VIEWER).json() == {"runs": [], "total": 0}
    assert api.get(f"/sites/{site}/runs/3", headers=VIEWER).json()["lineage"] == [2, 1]
    assert api.get(f"/sites/{site}/runs/9", headers=VIEWER).status_code == 404

    # Runs never change.
    with psycopg.connect(database_url) as conn, pytest.raises(psycopg.errors.RaiseException):
        conn.execute("UPDATE design_runs SET note = 'Edited' WHERE number = 1")
    with psycopg.connect(database_url) as conn:
        actions = conn.execute(
            "SELECT action, entity_id FROM audit_log WHERE entity_type = 'design_run' ORDER BY id"
        ).fetchall()
    assert actions == [("run.create", "1"), ("run.create", "2"), ("run.create", "3")]


def test_what_a_run_may_be(api: TestClient, site: str) -> None:  # noqa: F811
    assert run(api, site, {"model": "swelling"}, who=VIEWER).status_code == 403
    assert run(api, site, {"model": "nothing"}).status_code == 404
    assert run(api, site, {"model": "swelling", "version": "9.0"}).status_code == 404
    # Out of bounds, unknown and time-series models are refused, with why.
    res = run(api, site, {"model": "swelling", "params": {"soc": 140}})
    assert res.status_code == 422 and "soc" in res.json()["detail"]
    res = run(api, site, {"model": "swelling", "params": {"colour": 1}})
    assert res.status_code == 422 and "colour" in res.json()["detail"]
    res = run(api, site, {"model": "plunger-friction"})
    assert res.status_code == 422 and "only design models run" in res.json()["detail"]
    # A parent of another model, or that doesn't exist.
    actuator = run(api, site, {"model": "actuator"}).json()
    res = run(api, site, {"model": "swelling", "parent": actuator["number"]})
    assert (res.status_code, res.json()["detail"]) == (422, "Run 1 is of joint-actuator, not cell-swelling")
    assert run(api, site, {"model": "swelling", "parent": 42}).status_code == 404
    # Numbers only, and not too many.
    for params in ({"soc": "high"}, {"soc": "90"}, {"soc": True}, {f"p{i}": 1 for i in range(51)}):
        assert run(api, site, {"model": "swelling", "params": params}).status_code == 422, params


def test_restore_runs_an_earlier_run_again_after_the_latest(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    run(api, site, {"model": "actuator", "version": "1.0", "params": {"torque": 60}})
    run(api, site, {"model": "actuator", "version": "1.1", "params": {"torque": 90}, "parent": 1})
    assert api.post(f"/sites/{site}/runs/1/restore", headers=VIEWER).status_code == 403
    res = api.post(f"/sites/{site}/runs/1/restore", headers=ENG)
    assert res.status_code == 201, res.text
    r = res.json()
    assert (r["number"], r["parent"], r["restored_from"], r["lineage"]) == (3, 2, 1, [2, 1])
    assert (r["version"], r["params"]["torque"], r["note"]) == ("1.0.0", 60, "Restored run 1")
    first = api.get(f"/sites/{site}/runs/1", headers=ENG).json()
    assert r["output"] == first["output"]
    assert r["changes"] == [
        {"key": "version", "before": "1.1.0", "after": "1.0.0"},
        {"key": "torque", "before": 90, "after": 60},
    ]
    noted = api.post(f"/sites/{site}/runs/2/restore", json={"note": "Back to the hot one"}, headers=ENG).json()
    assert (noted["parent"], noted["restored_from"], noted["note"]) == (3, 2, "Back to the hot one")
    assert api.post(f"/sites/{site}/runs/99/restore", headers=ENG).status_code == 404
    with psycopg.connect(database_url) as conn:
        audit = conn.execute("SELECT action, after FROM audit_log WHERE action = 'run.restore' ORDER BY id").fetchall()
    assert audit == [
        ("run.restore", {"restored_from": 1, "parent": 2}),
        ("run.restore", {"restored_from": 2, "parent": 3}),
    ]


def test_restore_refuses_a_model_that_gives_another_output(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run(api, site, {"model": "swelling", "version": "1.0"})
    monkeypatch.setattr(design.Swelling100, "run", lambda self, inputs, p: {"force": [1.0]})
    res = api.post(f"/sites/{site}/runs/1/restore", headers=ENG)
    assert res.status_code == 409
    assert res.json()["detail"] == "Run 1 gives another output now: model cell-swelling 1.0.0 changed"
    assert api.get(f"/sites/{site}/runs", headers=ENG).json()["total"] == 1  # nothing stored
    monkeypatch.undo()
    assert run(api, site, {"model": "swelling"}).json()["number"] == 2  # and no number used


def test_a_version_stored_with_another_spec_is_refused(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    assert run(api, site, {"model": "swelling", "version": "2.0"}).status_code == 201  # stores its models row
    where = "WHERE key = 'cell-swelling' AND version = '2.0.0'"
    with psycopg.connect(database_url) as conn:  # as if another deployment had stored another spec
        [(spec,)] = conn.execute(f"SELECT spec FROM models {where}").fetchall()  # noqa: S608 - a constant
        conn.execute(f"UPDATE models SET spec = '{{}}' {where}")  # noqa: S608
    res = run(api, site, {"model": "swelling", "version": "2.0"})
    assert res.status_code == 409
    assert "Give the change a new version" in res.json()["detail"]
    with psycopg.connect(database_url) as conn:  # for the module's other tests
        conn.execute(f"UPDATE models SET spec = %s {where}", [Jsonb(spec)])  # noqa: S608


def test_runs_of_a_version_no_longer_registered_still_show(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    run(api, site, {"model": "swelling", "version": "1.0"})
    with psycopg.connect(database_url) as conn:  # as if 0.9.0, with another output, had been dropped
        conn.execute(
            """
            INSERT INTO design_runs (site_id, number, model_id, model_key, version, params, output,
                                     author_name, author_email)
            SELECT site_id, 2, model_id, model_key, '0.9.0', params, '{"pressure": 3.5}', 'Old', 'old@example.com'
            FROM design_runs WHERE number = 1
            """
        )
    old = api.get(f"/sites/{site}/runs/2", headers=ENG).json()
    assert (old["model_name"], old["units"], old["output"]) == ("cell-swelling", {}, {"pressure": 3.5})
    assert len(api.get(f"/sites/{site}/runs", headers=ENG).json()["runs"]) == 2
    res = api.post(f"/sites/{site}/runs/2/restore", headers=ENG)
    assert (res.status_code, res.json()["detail"]) == (
        409,
        "Run 2's model cell-swelling 0.9.0 is no longer registered",
    )
    # An output only one of the runs has is compared too.
    c = api.get(f"/sites/{site}/runs/compare?a=2&b=1", headers=ENG).json()
    assert [(o["name"], o["a"] is None, o["b"] is None) for o in c["outputs"]] == [
        ("force", True, False),
        ("pressure", False, True),
    ]


def test_a_long_lineage_says_where_it_was_cut(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    run(api, site, {"model": "swelling"})
    for parent in (1, 2):
        run(api, site, {"model": "swelling", "parent": parent})
    full = api.get(f"/sites/{site}/runs/3", headers=ENG).json()
    assert (full["lineage"], full["lineage_complete"]) == ([2, 1], True)
    assert api.get(f"/sites/{site}/runs/1", headers=ENG).json()["lineage_complete"] is True
    monkeypatch.setattr(api_runs, "MAX_LINEAGE", 1)
    cut = api.get(f"/sites/{site}/runs/3", headers=ENG).json()
    assert (cut["lineage"], cut["lineage_complete"]) == ([2], False)


def test_compare_two_runs(api: TestClient, site: str) -> None:  # noqa: F811
    run(api, site, {"model": "swelling", "version": "1.0", "params": {"soc": 50}})
    run(api, site, {"model": "swelling", "version": "1.1", "params": {"soc": 50, "temperature": 45}})
    run(api, site, {"model": "actuator"})
    c = api.get(f"/sites/{site}/runs/compare?a=1&b=2", headers=VIEWER).json()
    assert (c["a"]["number"], c["b"]["number"]) == (1, 2)
    assert c["changes"] == [
        {"key": "version", "before": "1.0.0", "after": "1.1.0"},
        {"key": "temperature", "before": 25, "after": 45},
    ]
    [force] = c["outputs"]
    a = expected("cell-swelling", "1.0.0", {"soc": 50})
    b = expected("cell-swelling", "1.1.0", {"soc": 50, "temperature": 45})
    assert a is not None and b is not None
    assert force == {
        "name": "force",
        "unit": "kN",
        "a": a,
        "b": b,
        "delta": pytest.approx(b - a),
        "percent": pytest.approx(100 * (b - a) / a),
    }
    res = api.get(f"/sites/{site}/runs/compare?a=1&b=3", headers=VIEWER)
    assert (res.status_code, res.json()["detail"]) == (422, "Run 1 is of cell-swelling and run 3 of joint-actuator")
    assert api.get(f"/sites/{site}/runs/compare?a=1&b=8", headers=VIEWER).status_code == 404


def test_runs_outlive_their_author(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    run(api, site, {"model": "swelling"})
    with psycopg.connect(database_url) as conn:
        conn.execute("DELETE FROM users WHERE email = 'eng@example.com'")
        assert conn.execute("SELECT author_id FROM design_runs").fetchall() == [(None,)]
    assert api.get(f"/sites/{site}/runs/1", headers=ADMIN).json()["author"]["email"] == "eng@example.com"


def test_shared_design_projects(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    path = f"/sites/{site}/design-projects"
    assert api.post(path, json={"name": "Pack B"}, headers=VIEWER).status_code == 403
    res = api.post(path, json={"name": " Pack B ", "description": "Swelling of the B cells"}, headers=ENG)
    assert res.status_code == 201, res.text
    b = res.json()
    assert (b["name"], b["description"], b["runs"], b["last_run_at"]) == ("Pack B", "Swelling of the B cells", 0, None)
    assert api.post(path, json={"name": "pack b"}, headers=ADMIN).status_code == 409  # one name per site
    assert api.post(path, json={"name": "  "}, headers=ENG).status_code == 422
    c = api.post(path, json={"name": "Hip joint"}, headers=ENG).json()

    # Runs belong to a project; their parents are in it.
    r1 = run(api, site, {"model": "swelling", "project": b["id"]}).json()
    assert r1["project"] == b["id"]
    r2 = run(api, site, {"model": "swelling", "project": b["id"], "parent": 1, "params": {"soc": 50}}).json()
    assert (r2["parent"], r2["project"]) == (1, b["id"])
    res = run(api, site, {"model": "swelling", "project": c["id"], "parent": 1})
    assert (res.status_code, res.json()["detail"]) == (422, "Run 1 is in another project")
    res = run(api, site, {"model": "swelling", "parent": 1})  # no project: another one too
    assert res.status_code == 422
    assert run(api, site, {"model": "swelling", "project": str(uuid.uuid4())}).status_code == 404
    run(api, site, {"model": "swelling", "project": c["id"]})  # run 3, in the other project
    run(api, site, {"model": "swelling"})  # run 4, in none

    # Listed by project, the one with the latest run first, with their runs.
    listed = api.get(path, headers=VIEWER).json()
    assert [(p["name"], p["runs"]) for p in listed] == [("Hip joint", 1), ("Pack B", 2)]
    runs = api.get(f"/sites/{site}/runs?project={b['id']}&model=swelling", headers=VIEWER).json()
    assert ([r["number"] for r in runs["runs"]], runs["total"]) == ([2, 1], 2)

    # A restore stays in its project, after that project's latest run.
    restored = api.post(f"/sites/{site}/runs/1/restore", headers=ENG).json()
    assert (restored["project"], restored["parent"], restored["restored_from"]) == (b["id"], 2, 1)
    with psycopg.connect(database_url) as conn:
        audit = conn.execute(
            "SELECT after FROM audit_log WHERE action = 'design_project.create' AND site_id = %s ORDER BY id", [site]
        ).fetchall()
    assert audit == [({"name": "Pack B"},), ({"name": "Hip joint"},)]
