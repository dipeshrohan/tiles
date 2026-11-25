"""Datasets and the correlation finder over HTTP (T3.11), on the browser's cutter batches."""

import importlib
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_correlate import FIXTURE, KEYS

from tiles_api import api_datasets

migration = importlib.import_module("tiles_api.migrations.versions.0046_dataset_segments")

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
    # Splits are the columns with few values: never id, one per batch (review H-11).
    assert detail["splits"] == ["material", "ng"]
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
    assert out["hints"] == []  # split already

    # Pooled, with every number column by default: the tension effect cancels out, and the split
    # that shows it is given as a hint, with what it shows (review H-11).
    pooled = run(api, site, dataset, outcome="ng").json()
    assert {f["variable"] for f in pooled["findings"]} == {*variables, "tabDev"}
    assert next(f for f in pooled["findings"] if f["variable"] == "tension")["clear"] is False
    assert pooled["hints"] == []  # tabDev stands out pooled: nothing tried
    pooled = run(api, site, dataset, outcome="ng", variables=variables).json()
    assert pooled["explanations"] == []
    assert [h["split"] for h in pooled["hints"]] == ["material"]
    assert pooled["hints"][0]["explanations"] == out["explanations"]


def test_split_hints_stay_within_the_work_budget(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dataset = upload(api, site)
    variables = FIXTURE["variables"]
    work = 720 * len(variables)  # one run's
    monkeypatch.setattr(api_datasets, "MAX_WORK", work)  # the pooled run only: no split tried
    pooled = run(api, site, dataset, outcome="ng", variables=variables).json()
    assert (pooled["explanations"], pooled["hints"]) == ([], [])
    monkeypatch.setattr(api_datasets, "MAX_WORK", work * 2 - 1)  # still not room for a second
    assert run(api, site, dataset, outcome="ng", variables=variables).json()["hints"] == []
    monkeypatch.setattr(api_datasets, "MAX_WORK", work * 2)  # room for one split
    assert [h["split"] for h in run(api, site, dataset, outcome="ng", variables=variables).json()["hints"]] == [
        "material"
    ]


def test_segments_are_kept_as_rows_arrive_as_the_migration_works_them_out(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    dataset = upload(api, site)
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        kept = conn.execute("SELECT segments FROM datasets WHERE id = %s", [dataset]).fetchone()
        assert kept is not None
        assert kept["segments"]["material"] == ["anode", "cathode"]
        assert kept["segments"]["ng"] == ["false", "true"]
        assert len(kept["segments"]["id"]) == api_datasets.MAX_SEGMENTS + 1  # enough to know: too many
        # The migration's backfill, on the same rows, gives the same segments (id: any 51 of them).
        conn.execute("UPDATE datasets SET segments = '{}' WHERE id = %s", [dataset])
        conn.execute(migration.UPGRADE.split(";", 1)[1])
        filled = conn.execute("SELECT segments FROM datasets WHERE id = %s", [dataset]).fetchone()
        assert filled is not None
        assert {k: v for k, v in filled["segments"].items() if k != "id"} == {
            k: v for k, v in kept["segments"].items() if k != "id"
        }
        assert len(filled["segments"]["id"]) == api_datasets.MAX_SEGMENTS + 1


def test_segments_merge_blanks_and_stop_past_a_splits_limit() -> None:
    columns = [{"name": "line", "kind": "text"}, {"name": "x", "kind": "number"}, {"name": "ok", "kind": "bool"}]
    rows: list[dict[str, Any]] = [{"line": "L2", "ok": True}, {"line": None, "ok": False}, {"line": "L1"}]
    assert api_datasets.merge_segments(columns, {"line": ["L1"]}, rows) == {
        "line": ["(blank)", "L1", "L2"],
        "ok": ["(blank)", "false", "true"],
    }
    many = [{"line": f"B{i:03}"} for i in range(200)]
    merged = api_datasets.merge_segments(columns, {}, many)
    assert len(merged["line"]) == api_datasets.MAX_SEGMENTS + 1


def test_splits_are_columns_with_few_values() -> None:
    columns = [
        {"name": "id", "kind": "text"},
        {"name": "shift", "kind": "text"},
        {"name": "line", "kind": "text"},
        {"name": "night", "kind": "bool"},
        {"name": "one", "kind": "text"},
        {"name": "speed", "kind": "number"},
    ]
    values = {"id": 10, "shift": 3, "line": 2, "night": 2, "one": 1, "speed": 4}
    assert api_datasets.split_columns(columns, values, rows=10) == ["line", "night", "shift"]
    assert api_datasets.split_columns(columns, values, rows=5) == ["line", "night"]  # 3 > 5 // 2
    assert api_datasets.split_columns(columns, values | {"id": 51}, rows=1000) == ["line", "night", "shift"]
    assert api_datasets.split_columns(columns, values | {"id": 50}, rows=1000)[-1] == "id"


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
    assert (again.status_code, again.json()["detail"]) == (
        409,
        "A batch table is already called cutter batches. Choose another name.",
    )
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
    for body in ({"outcome": "x" * 201}, {"outcome": ""}, {"outcome": "ng", "split": "x" * 201}):
        assert run(api, site, dataset, **body).status_code == 422  # names are bounded (T5.07)
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


def test_each_segment_is_explained_by_its_strongest_clear_effect(api: TestClient, site: str) -> None:  # noqa: F811
    columns = [
        {"name": "ng", "kind": "bool"},
        {"name": "night", "kind": "bool"},
        {"name": "a", "kind": "number"},
        {"name": "b", "kind": "number"},
    ]
    res = api.post(f"/sites/{site}/datasets", json={"name": "shifts", "columns": columns}, headers=ENG)
    dataset = res.json()["id"]
    rows: list[dict[str, Any]] = []
    for night in (True, False):
        for i in range(40):
            ng = i % 4 == 0
            # a: measured on four batches only, far apart but too few to be sure; b: on all, clearly apart.
            a = {0: 2.5, 4: 4.5, 1: -1.0, 2: 1.0}.get(i)
            rows.append({"ng": ng, "night": night, "a": a, "b": (1.5 if ng else 0.0) + (i % 3 - 1) * 0.8})
    assert api.post(f"/sites/{site}/datasets/{dataset}/rows", json={"rows": rows}, headers=ENG).status_code == 200
    out = run(api, site, dataset, outcome="ng", split="night").json()
    assert [(f["segment"], f["variable"], f["clear"]) for f in out["findings"]][:2] == [
        ("true", "a", False),
        ("false", "a", False),
    ]
    assert [(e["segment"], e["variable"]) for e in out["explanations"]] == [("true", "b"), ("false", "b")]
    assert out["explanations"][0]["text"].startswith("true: failed batches ran b higher (")
    pooled = run(api, site, dataset, outcome="ng").json()
    assert [e["segment"] for e in pooled["explanations"]] == ["all"]
    assert pooled["hints"] == []  # found pooled: nothing tried
    assert pooled["explanations"][0]["text"].startswith("failed batches ran ")  # no segment named

    res = run(api, site, dataset, outcome="ng", split="ng")
    assert res.status_code == 422
    assert "Split by another column than the outcome" in res.text
