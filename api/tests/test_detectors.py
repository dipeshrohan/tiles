"""Detectors and warnings over the API (T3.04), on a friction history the browser's model made."""

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures

from tiles_api import detector_job

FIXTURE = json.loads((Path(__file__).parents[2] / "test" / "fixtures" / "friction-detection.json").read_text())
T0 = datetime(2026, 8, 1, tzinfo=UTC)
EVERY = timedelta(seconds=FIXTURE["cycleSeconds"])


def at(i: int) -> datetime:
    return T0 + i * EVERY


def import_friction(api: TestClient, site: str, values: list[float], first: int = 0) -> str:  # noqa: F811
    imp = api.post(f"/sites/{site}/imports", json={"name": "friction.csv"}, headers=ENG).json()
    samples = [{"signal": "dc1.friction", "at": at(first + i).isoformat(), "value": v} for i, v in enumerate(values)]
    res = api.post(f"/sites/{site}/imports/{imp['id']}/samples", json={"samples": samples}, headers=ENG)
    assert res.status_code == 200, res.text
    signals = api.get(f"/sites/{site}/signals", params={"q": "dc1.friction"}, headers=VIEWER).json()["signals"]
    return str(signals[0]["id"])


def create(api: TestClient, site: str, signal: str, **changes: Any) -> Any:  # noqa: F811
    return api.post(
        f"/sites/{site}/detectors", json={"name": "dc1-friction", "signal_id": signal} | changes, headers=ENG
    )


EXPECTED = [(a["firstShot"], a["lastShot"], a["peak"]) for a in FIXTURE["alerts"]]


def found(api: TestClient, site: str, **query: str) -> list[dict[str, Any]]:  # noqa: F811
    res = api.get(f"/sites/{site}/warnings", params=query, headers=VIEWER)
    assert res.status_code == 200, res.text
    return list(reversed(res.json()))  # oldest first


def test_a_detector_raises_the_browsers_warnings_on_the_stored_history(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    signal = import_friction(api, site, FIXTURE["values"])
    res = create(api, site, signal)
    assert res.status_code == 201, res.text
    detector = res.json()
    assert detector["config"] == {
        "window": 200,
        "k": 4,
        "persist": 3,
        "direction": "above",
        "cooldown": 0,
        "min_spread": 1,
    }
    path = f"/sites/{site}/detectors/{detector['id']}/run"
    assert api.post(path, headers=VIEWER).status_code == 403
    run = api.post(path, headers=ENG).json()
    assert (run["readings"], run["opened"], run["closed"], run["caught_up"]) == (1600, 3, 3, True)
    warnings = found(api, site)
    assert [(w["started_at"], w["last_at"], w["peak"]) for w in warnings] == [
        (at(first).isoformat().replace("+00:00", "Z"), at(last).isoformat().replace("+00:00", "Z"), peak)
        for first, last, peak in EXPECTED
    ]
    assert all(w["ended_at"] and w["side"] == "above" and w["signal_tag"] == "dc1.friction" for w in warnings)
    assert all(w["detector"] == "dc1-friction" for w in warnings)
    assert api.post(path, headers=ENG).json()["readings"] == 0  # nothing new

    # Stopped: its warnings stay; it no longer runs.
    assert api.delete(f"/sites/{site}/detectors/{detector['id']}", headers=ENG).status_code == 204
    stopped = api.post(path, headers=ENG)
    assert (stopped.status_code, stopped.json()["detail"]) == (409, "This detector is stopped")
    assert len(found(api, site)) == 3
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        assert detector["id"] not in [str(d) for d in detector_job.due(conn)]
        actions = [
            r["action"]
            for r in conn.execute("SELECT action FROM audit_log WHERE entity_id = %s ORDER BY id", [detector["id"]])
        ]
    assert actions == ["detector.create", "detector.run", "detector.run", "detector.stop"]


def test_runs_of_small_batches_give_the_same_warnings_and_keep_one_open_across_runs(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    signal = import_friction(api, site, FIXTURE["values"])
    detector = create(api, site, signal).json()
    monkeypatch.setattr(detector_job, "BATCH", 37)  # warnings open in one run and close in a later one
    path = f"/sites/{site}/detectors/{detector['id']}/run"
    open_seen = False
    while not (run := api.post(path, headers=ENG).json())["caught_up"] or run["readings"]:
        open_seen = open_seen or bool(found(api, site, state="open"))
    assert open_seen  # a warning was open between runs
    assert [(w["started_at"], w["peak"]) for w in found(api, site)] == [
        (at(first).isoformat().replace("+00:00", "Z"), peak) for first, _, peak in EXPECTED
    ]
    assert found(api, site, state="open") == []
    assert len(found(api, site, state="ended", signal_id=signal)) == 3
    assert found(api, site, signal_id="00000000-0000-0000-0000-000000000000") == []


def test_readings_still_arriving_wait_for_a_later_run(api: TestClient, site: str) -> None:  # noqa: F811
    now = datetime.now(UTC)
    imp = api.post(f"/sites/{site}/imports", json={"name": "now.csv"}, headers=ENG).json()
    samples = [
        {"signal": "dc2.friction", "at": (now - timedelta(seconds=s)).isoformat(), "value": 1.0} for s in (900, 600, 60)
    ]
    assert (
        api.post(f"/sites/{site}/imports/{imp['id']}/samples", json={"samples": samples}, headers=ENG).status_code
        == 200
    )
    signal = api.get(f"/sites/{site}/signals", params={"q": "dc2.friction"}, headers=VIEWER).json()["signals"][0]["id"]
    detector = create(api, site, signal, name="dc2").json()
    assert detector["lateness_seconds"] == 300
    run = api.post(f"/sites/{site}/detectors/{detector['id']}/run", headers=ENG).json()
    assert run["readings"] == 2  # the one from a minute ago waits: more may still come before it


def test_a_detector_is_checked(api: TestClient, site: str) -> None:  # noqa: F811
    signal = import_friction(api, site, FIXTURE["values"][:10])
    nowhere = "00000000-0000-0000-0000-000000000000"
    bad = create(api, site, nowhere)
    assert (bad.status_code, bad.json()["detail"]) == (422, "Not a signal of this site")
    for changes in ({"window": 5}, {"k": 0}, {"persist": 0}, {"direction": "up"}, {"min_spread": 0}, {"name": "Bad"}):
        assert create(api, site, signal, **changes).status_code == 422, changes
    assert create(api, site, signal).status_code == 201
    again = create(api, site, signal)
    assert (again.status_code, again.json()["detail"]) == (409, "A detector is already called dc1-friction")
    listed = api.get(f"/sites/{site}/detectors", headers=VIEWER).json()
    assert [(d["name"], d["signal_tag"], d["open_warning"]) for d in listed] == [
        ("dc1-friction", "dc1.friction", False)
    ]


def test_the_command_runs_every_enabled_detector(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    signal = import_friction(api, site, FIXTURE["values"])
    detector = create(api, site, signal).json()
    monkeypatch.setenv("TILES_DATABASE_URL", database_url)
    from tiles_api.settings import get_settings

    get_settings.cache_clear()
    try:
        detector_job.main(["--site", site])
    finally:
        get_settings.cache_clear()
    assert f"{detector['id']}: 1600 reading(s), 3 warning(s) raised, 3 ended" in capsys.readouterr().out
