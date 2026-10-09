"""Datasets and the correlation finder over HTTP (T3.11), on the browser's cutter batches."""

from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_correlate import FIXTURE, KEYS

from tiles_api import api_datasets

COLUMNS = [
    {"name": "id", "kind": "text"},
    {"name": "material", "kind": "text"},
    *({"name": v, "kind": "number"} for v in ("tension", "speed", "humidity", "bladeAge", "rollDiameter", "tabDev")),
    {"name": "ng", "kind": "bool"},
]


def upload(api: TestClient, site: str, name: str = "cutter batches") -> str:  # noqa: F811
    res = api.post(f"/sites/{site}/datasets", json={"name": name, "columns": COLUMNS}, headers=ENG)
    assert res.status_code == 201, res.text
    dataset = res.json()["id"]
    rows = FIXTURE["rows"]
    for first in range(0, len(rows), 500):
        res = api.post(f"/sites/{site}/datasets/{dataset}/rows", json={"rows": rows[first : first + 500]}, headers=ENG)
        assert res.status_code == 200, res.text
    assert res.json() == {"received": 220, "row_count": 720}
    return str(dataset)


def run(api: TestClient, site: str, dataset: str, **body: Any) -> Any:  # noqa: F811
    return api.post(f"/sites/{site}/datasets/{dataset}/correlate", json=body, headers=VIEWER)


def test_a_batch_table_gives_the_browsers_findings_with_intervals(api: TestClient, site: str) -> None:  # noqa: F811
    dataset = upload(api, site)
    detail = api.get(f"/sites/{site}/datasets/{dataset}", headers=VIEWER).json()
    assert (detail["row_count"], len(detail["preview"]), detail["preview"][0]["id"]) == (720, 20, "B0001")
    assert detail["created_by"] == "eng"
    variables = FIXTURE["variables"]
    res = run(api, site, dataset, outcome="ng", variables=variables, split="material")
    assert res.status_code == 200, res.text
    out = res.json()
    assert (out["rows"], out["ng"] + out["ok"]) == (720, 720)
    assert [(f["segment"], f["variable"]) for f in out["findings"]] == [
        (e["segment"], e["variable"]) for e in FIXTURE["split"]
    ]
    for f, e in zip(out["findings"], FIXTURE["split"], strict=True):
        for js, py in KEYS.items():
            assert f[py] == pytest.approx(e[js], rel=1e-12, abs=1e-12)
        assert f["ci_low"] < f["effect"] < f["ci_high"]
    assert [(e["segment"], e["variable"]) for e in out["explanations"]] == [
        ("anode", "tension"),
        ("cathode", "tension"),
    ]
    assert out["explanations"][0]["text"].startswith("anode: failed batches ran tension higher (")
    assert "lower" in out["explanations"][1]["text"]

    # Pooled, with every number column by default: the tension effect cancels out.
    pooled = run(api, site, dataset, outcome="ng").json()
    assert {f["variable"] for f in pooled["findings"]} == {*variables, "tabDev"}
    assert next(f for f in pooled["findings"] if f["variable"] == "tension")["clear"] is False


def test_outcomes_named_by_their_values(api: TestClient, site: str) -> None:  # noqa: F811
    columns = [{"name": "result", "kind": "text"}, {"name": "code", "kind": "number"}, {"name": "x", "kind": "number"}]
    res = api.post(f"/sites/{site}/datasets", json={"name": "lot results", "columns": columns}, headers=ENG)
    dataset = res.json()["id"]
    rows: list[dict[str, Any]] = [
        {"result": "NG" if i % 4 == 0 else "OK", "code": 1 if i % 4 == 0 else 0, "x": i % 4 * 10 + i % 3}
        for i in range(40)
    ]
    rows.append({"result": None, "x": 999})  # no outcome: left out
    api.post(f"/sites/{site}/datasets/{dataset}/rows", json={"rows": rows}, headers=ENG)
    by_text = run(api, site, dataset, outcome="result", ng_values=["NG"]).json()
    by_number = run(api, site, dataset, outcome="code", ng_values=[1.0]).json()
    assert (by_text["rows"], by_text["ng"], by_text["ok"]) == (40, 10, 30)
    assert by_number["findings"][0]["effect"] == by_text["findings"][0]["effect"] < 0  # NG batches ran x lower
    res = run(api, site, dataset, outcome="result")
    assert (res.status_code, res.json()["detail"]) == (
        422,
        "Say which values of result mean a failed batch (ng_values)",
    )


def test_uploads_and_requests_are_checked(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = f"/sites/{site}/datasets"
    assert api.post(path, json={"name": "x", "columns": COLUMNS}, headers=VIEWER).status_code == 403
    for bad in (
        {"name": "x", "columns": []},
        {"name": "x", "columns": [{"name": "a", "kind": "number"}, {"name": "a", "kind": "text"}]},
        {"name": " x", "columns": COLUMNS},
        {"name": "x", "columns": [{"name": "a", "kind": "date"}]},
    ):
        assert api.post(path, json=bad, headers=ENG).status_code == 422, bad
    dataset = upload(api, site)
    again = api.post(path, json={"name": "cutter batches", "columns": COLUMNS}, headers=ENG)
    assert (again.status_code, again.json()["detail"]) == (409, "A dataset is already called cutter batches")
    rows = f"{path}/{dataset}/rows"
    for row, detail in (
        ({"color": "red"}, "Row 1: no column 'color' in this dataset"),
        ({"tension": "high"}, "Row 1: tension must be a number"),
        ({"tension": True}, "Row 1: tension must be a number"),
        ({"ng": 1}, "Row 1: ng must be true or false"),
        ({"material": 3}, "Row 1: material must be text"),
    ):
        res = api.post(rows, json={"rows": [{}, row][1:]}, headers=ENG)
        assert (res.status_code, res.json()["detail"]) == (422, detail), row
    monkeypatch.setattr(api_datasets, "MAX_ROWS", 720)
    res = api.post(rows, json={"rows": [{}]}, headers=ENG)
    assert (res.status_code, res.json()["detail"]) == (422, "A dataset holds at most 720 rows")

    for body, detail in (
        ({"outcome": "colour"}, "No column 'colour' in this dataset"),
        ({"outcome": "ng", "variables": ["material"]}, "material is not a number column"),
        ({"outcome": "ng", "split": "id"}, "id has more than 50 values to split by"),
    ):
        res = run(api, site, dataset, **body)
        assert (res.status_code, res.json()["detail"]) == (422, detail), body
    monkeypatch.setattr(api_datasets, "MAX_WORK", 720 * 5)
    res = run(api, site, dataset, outcome="ng")
    assert (res.status_code, res.json()["detail"]) == (
        422,
        "720 rows x 6 variables is too much at once: choose fewer variables",
    )

    assert api.delete(f"{path}/{dataset}", headers=VIEWER).status_code == 403
    assert api.delete(f"{path}/{dataset}", headers=ENG).status_code == 204
    assert api.get(f"{path}/{dataset}", headers=VIEWER).status_code == 404
    assert api.get(path, headers=VIEWER).json() == []
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        actions = [
            r["action"]
            for r in conn.execute("SELECT action FROM audit_log WHERE entity_id = %s ORDER BY id", [dataset])
        ]
    assert actions == ["dataset.create", *["dataset.rows"] * 2, "dataset.delete"]
