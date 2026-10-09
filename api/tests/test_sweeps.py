"""Parameter sweeps as background jobs (T4.12): started, run in chunks with progress, cancelled,
kept and answered again from the cache; picked up again when left behind."""

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures

from tiles_api import sweeps
from tiles_api.models import design
from tiles_api.models.registry import registry
from tiles_api.store import Conn

X = {"param": "soc", "from": 0, "to": 100, "steps": 11}
Y = {"param": "cycles", "from": 0, "to": 2000, "steps": 5}


def start(api: TestClient, site: str, body: dict[str, Any], who: dict[str, str] = ENG) -> Any:  # noqa: F811
    return api.post(f"/sites/{site}/sweeps", json=body, headers=who)


def test_a_sweep_runs_in_the_background_and_is_kept(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    res = start(api, site, {"model": "swelling", "version": "2.0", "params": {"preload": 3}, "x": X, "y": Y})
    assert res.status_code == 202, res.text
    started = res.json()
    assert (started["total"], started["model"], started["version"]) == (55, "cell-swelling", "2.0.0")
    # The test client runs background tasks before it answers: the sweep is done.
    done = api.get(f"/sites/{site}/sweeps/{started['id']}", headers=VIEWER).json()
    assert (done["status"], done["done"], done["cached"]) == ("done", 55, False)
    result = done["result"]
    assert (result["output"], result["unit"]) == ("force", "kN")
    assert result["x"] == {"param": "soc", "values": [10.0 * i for i in range(11)]}
    assert result["y"]["values"] == [0.0, 500.0, 1000.0, 1500.0, 2000.0]
    model = registry.get("cell-swelling", "2.0.0")
    params = {p.name: p.default for p in model.spec.params} | {"preload": 3}
    [expected] = model.run({}, params | {"soc": 30.0, "cycles": 1500.0})["force"]
    assert result["grid"][3][3] == expected  # [y][x]
    flat = [v for row in result["grid"] for v in row]
    assert (result["min"], result["max"]) == (min(flat), max(flat))

    # The same sweep again is answered from the kept result, at once.
    again = start(api, site, {"model": "cell-swelling", "version": "2.0.0", "params": {"preload": 3}, "x": X, "y": Y})
    assert again.status_code == 200
    assert (again.json()["id"], again.json()["cached"]) == (started["id"], True)
    # The held value of a swept parameter doesn't matter (the grid sets it), nor 0 against 0.0.
    same = {
        "model": "swelling",
        "version": "2.0",
        "params": {"preload": 3.0, "soc": 90},
        "x": {**X, "from": 0.0},
        "y": Y,
    }
    assert start(api, site, same).status_code == 200
    # Another parameter held, another sweep.
    assert start(api, site, {"model": "swelling", "version": "2.0", "x": X, "y": Y}).status_code == 202
    listed = api.get(f"/sites/{site}/sweeps", headers=VIEWER).json()
    assert len(listed) == 2 and all(s["result"] is None for s in listed)
    with psycopg.connect(database_url) as conn:
        actions = conn.execute(
            "SELECT action FROM audit_log WHERE entity_type = 'sweep' AND site_id = %s", [site]
        ).fetchall()
    assert actions == [("sweep.start",), ("sweep.start",)]


def test_what_a_sweep_may_be(api: TestClient, site: str) -> None:  # noqa: F811
    assert start(api, site, {"model": "swelling", "x": X}, who=VIEWER).status_code == 403
    one_axis = start(api, site, {"model": "actuator", "x": {"param": "torque", "from": 5, "to": 120, "steps": 3}})
    assert one_axis.status_code == 202
    assert api.get(f"/sites/{site}/sweeps/{one_axis.json()['id']}", headers=ENG).json()["result"]["y"] is None
    for body, reason in (
        ({"model": "swelling", "x": {**X, "param": "colour"}}, "unknown param(s): colour"),
        ({"model": "swelling", "x": {**X, "to": 140}}, "param soc = 140 is outside"),
        ({"model": "swelling", "x": X, "params": {"cycles": -1}}, "cycles"),
        ({"model": "plunger-friction", "x": X}, "only design models run"),
    ):
        res = start(api, site, body)
        assert res.status_code == 422 and reason in res.json()["detail"], (body, res.text)
    for body in (
        {"model": "swelling", "x": X, "y": {**X}},  # the same parameter twice
        {"model": "swelling", "x": {**X, "steps": 201}},
        {"model": "swelling", "x": {**X, "steps": 200}, "y": {**Y, "steps": 201}},
        {"model": "swelling", "x": {**X, "steps": 1}},
        {"model": "swelling", "x": {**X, "from": True}},
    ):
        assert start(api, site, body).status_code == 422, body
    assert start(api, site, {"model": "swelling", "x": X, "project": str(uuid.uuid4())}).status_code == 404
    for bad in ("NaN", "Infinity"):  # numbers JSON parsers let through
        raw = '{"model": "swelling", "x": {"param": "soc", "from": ' + bad + ', "to": 100, "steps": 3}}'
        res = api.post(f"/sites/{site}/sweeps", content=raw, headers=ENG | {"content-type": "application/json"})
        assert res.status_code == 422, bad
    assert api.get(f"/sites/{site}/sweeps/{uuid.uuid4()}", headers=ENG).status_code == 404


@pytest.fixture
def connect(database_url: str) -> Any:
    @contextmanager
    def open_conn() -> Iterator[Conn]:
        with psycopg.connect(database_url, row_factory=dict_row) as conn:
            yield conn

    return open_conn


def queue(database_url: str, site: str, steps: int = 40) -> uuid.UUID:  # noqa: F811
    """A sweep left queued, as if the API had stopped before running it."""
    model = registry.get("cell-swelling", "2.0.0")
    params = {p.name: p.default for p in model.spec.params}
    x = {**X, "steps": steps}
    y = {**Y, "steps": steps}
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        model_id = conn.execute("SELECT id FROM models WHERE key = 'cell-swelling' AND version = '2.0.0'").fetchone()
        assert model_id
        row = conn.execute(
            """
            INSERT INTO sweeps (site_id, model_id, model_key, version, params, x, y, cache_key, total, created_by)
            VALUES (%s, %s, 'cell-swelling', '2.0.0', %s, %s, %s, %s, %s, 'test') RETURNING id
            """,
            [
                site,
                model_id["id"],
                psycopg.types.json.Jsonb(params),
                psycopg.types.json.Jsonb(x),
                psycopg.types.json.Jsonb(y),
                uuid.uuid4().hex,
                steps * steps,
            ],
        ).fetchone()
    assert row
    sweep_id: uuid.UUID = row["id"]
    return sweep_id


def test_a_running_sweep_stops_when_cancelled(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    connect: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    start(api, site, {"model": "swelling", "version": "2.0", "x": X})  # stores the models row
    sweep_id = queue(database_url, site)  # 1,600 points: four chunks
    calls = 0
    original = design.Swelling200.run

    def counting(self: Any, inputs: Any, p: Any) -> Any:
        nonlocal calls
        calls += 1
        if calls == sweeps.CHUNK + 1:  # someone cancels while the second chunk runs
            assert api.post(f"/sites/{site}/sweeps/{sweep_id}/cancel", headers=ENG).status_code == 200
        return original(self, inputs, p)

    monkeypatch.setattr(design.Swelling200, "run", counting)
    assert sweeps.run(connect, sweep_id) == (sweep_id, "cancelled")
    shown = api.get(f"/sites/{site}/sweeps/{sweep_id}", headers=ENG).json()
    assert (shown["status"], shown["done"], shown["result"]) == ("cancelled", 2 * sweeps.CHUNK, None)
    assert calls == 2 * sweeps.CHUNK  # it stopped after the chunk it was on
    res = api.post(f"/sites/{site}/sweeps/{sweep_id}/cancel", headers=ENG)
    assert (res.status_code, res.json()["detail"]) == (409, "The sweep is already cancelled")


def test_a_queued_sweep_is_cancelled_at_once(api: TestClient, site: str, database_url: str, connect: Any) -> None:  # noqa: F811
    start(api, site, {"model": "swelling", "version": "2.0", "x": X})
    sweep_id = queue(database_url, site)
    assert api.post(f"/sites/{site}/sweeps/{sweep_id}/cancel", headers=VIEWER).status_code == 403
    cancelled = api.post(f"/sites/{site}/sweeps/{sweep_id}/cancel", headers=ENG).json()
    assert (cancelled["status"], cancelled["done"]) == ("cancelled", 0)
    assert sweeps.run(connect, sweep_id) is None  # nothing left to run


def test_the_worker_picks_up_what_was_left(api: TestClient, site: str, database_url: str, connect: Any) -> None:  # noqa: F811
    start(api, site, {"model": "swelling", "version": "2.0", "x": X})
    queued = queue(database_url, site, steps=5)
    stalled = queue(database_url, site, steps=5)
    fresh = queue(database_url, site, steps=5)
    with psycopg.connect(database_url) as conn:  # a worker died on one; another is still working
        conn.execute(
            "UPDATE sweeps SET status = 'running', heartbeat_at = now() - interval '10 minutes' WHERE id = %s",
            [stalled],
        )
        conn.execute("UPDATE sweeps SET status = 'running', heartbeat_at = now() WHERE id = %s", [fresh])
    ran = []
    while (r := sweeps.run(connect)) is not None:
        ran.append(r)
    assert sorted(ran) == sorted([(queued, "done"), (stalled, "done")])
    assert api.get(f"/sites/{site}/sweeps/{fresh}", headers=ENG).json()["status"] == "running"


def test_a_sweep_that_fails_says_why(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    connect: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    start(api, site, {"model": "swelling", "version": "2.0", "x": X})
    sweep_id = queue(database_url, site, steps=3)

    def broken(self: Any, inputs: Any, p: Any) -> Any:
        if p["soc"] > 60:
            raise ZeroDivisionError("division by zero")  # a point it can't run: null
        if p["cycles"] > 1500:
            return {"force": [float("inf")]}  # one the registry refuses: null too
        return {"force": [1.0]}

    monkeypatch.setattr(design.Swelling200, "run", broken)
    assert sweeps.run(connect, sweep_id) == (sweep_id, "done")
    grid = api.get(f"/sites/{site}/sweeps/{sweep_id}", headers=ENG).json()["result"]["grid"]
    assert grid[0] == [1.0, 1.0, None]
    assert grid[2] == [None, None, None]
    failing = queue(database_url, site, steps=3)
    with psycopg.connect(database_url) as conn:  # its model version is no longer registered
        conn.execute("UPDATE sweeps SET version = '9.9.9' WHERE id = %s", [failing])
    assert sweeps.run(connect, failing) == (failing, "failed")
    shown = api.get(f"/sites/{site}/sweeps/{failing}", headers=ENG).json()
    assert shown["status"] == "failed" and shown["error"]


def test_values_along_an_axis() -> None:
    assert sweeps.values({"from": 0, "to": 1, "steps": 5}) == [0.0, 0.25, 0.5, 0.75, 1.0]
    assert sweeps.values({"from": 3, "to": 3, "steps": 1}) == [3.0]
    a = sweeps.cache_key(registry.get("cell-swelling", "2.0.0"), {"soc": 1}, X, None)
    assert a == sweeps.cache_key(registry.get("cell-swelling", "2.0.0"), {"soc": 1}, dict(X), None)
    assert a != sweeps.cache_key(registry.get("cell-swelling", "1.1.0"), {"soc": 1}, X, None)


def test_a_sweep_cancelled_in_its_last_chunk_keeps_no_result(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    connect: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    start(api, site, {"model": "swelling", "version": "2.0", "x": X})
    sweep_id = queue(database_url, site, steps=5)  # 25 points: one chunk
    original = design.Swelling200.run
    calls = 0

    def cancelling(self: Any, inputs: Any, p: Any) -> Any:
        nonlocal calls
        calls += 1
        if calls == 3:
            api.post(f"/sites/{site}/sweeps/{sweep_id}/cancel", headers=ENG)
        return original(self, inputs, p)

    monkeypatch.setattr(design.Swelling200, "run", cancelling)
    assert sweeps.run(connect, sweep_id) == (sweep_id, "cancelled")
    shown = api.get(f"/sites/{site}/sweeps/{sweep_id}", headers=ENG).json()
    assert (shown["status"], shown["result"]) == ("cancelled", None)


def test_a_sweep_taken_over_is_written_by_its_new_run_only(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    connect: Any,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    start(api, site, {"model": "swelling", "version": "2.0", "x": X})
    sweep_id = queue(database_url, site)  # 1,600 points
    original = design.Swelling200.run
    calls = 0

    def slow(self: Any, inputs: Any, p: Any) -> Any:
        nonlocal calls
        calls += 1
        if calls == 10:  # this run goes quiet; a worker takes the sweep over and finishes it
            with psycopg.connect(database_url) as conn:
                conn.execute("UPDATE sweeps SET heartbeat_at = now() - interval '10 minutes' WHERE id = %s", [sweep_id])
            monkeypatch.setattr(design.Swelling200, "run", original)
            assert sweeps.run(connect, sweep_id) == (sweep_id, "done")
        return original(self, inputs, p)

    monkeypatch.setattr(design.Swelling200, "run", slow)
    assert sweeps.run(connect, sweep_id) == (sweep_id, "taken")  # the first run writes nothing more
    shown = api.get(f"/sites/{site}/sweeps/{sweep_id}", headers=ENG).json()
    assert (shown["status"], shown["done"]) == ("done", 1600)


def test_a_cancelled_sweep_left_running_is_ended_not_run_again(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    connect: Any,
) -> None:
    start(api, site, {"model": "swelling", "version": "2.0", "x": X})
    sweep_id = queue(database_url, site, steps=5)
    with psycopg.connect(database_url) as conn:  # cancelled, then its worker died
        conn.execute(
            "UPDATE sweeps SET status = 'running', cancel_requested = true,"
            " heartbeat_at = now() - interval '10 minutes' WHERE id = %s",
            [sweep_id],
        )
    assert sweeps.run(connect) is None
    assert api.get(f"/sites/{site}/sweeps/{sweep_id}", headers=ENG).json()["status"] == "cancelled"


def test_the_api_runs_at_most_two_sweeps_at_once(api: TestClient, site: str, database_url: str, connect: Any) -> None:  # noqa: F811
    start(api, site, {"model": "swelling", "version": "2.0", "x": X})
    sweep_id = queue(database_url, site, steps=5)
    held = [sweeps._api_workers.acquire(blocking=False) for _ in range(sweeps.API_WORKERS)]
    try:
        assert all(held)
        sweeps.drain(connect)  # two are at it already: they will take it
        assert api.get(f"/sites/{site}/sweeps/{sweep_id}", headers=ENG).json()["status"] == "queued"
    finally:
        for _ in held:
            sweeps._api_workers.release()
    sweeps.drain(connect)
    assert api.get(f"/sites/{site}/sweeps/{sweep_id}", headers=ENG).json()["status"] == "done"
