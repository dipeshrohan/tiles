"""Model runner (T3.03): bound models run on new data windows and write derived signals."""

import json
import math
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures

from tiles_api.models import runner
from tiles_api.models.plunger import PlungerFriction

SHOTS = json.loads((Path(__file__).parents[2] / "test" / "fixtures" / "plunger-shots.json").read_text())["shots"]
T0 = datetime(2026, 9, 1, 6, 0, tzinfo=UTC)
CYCLE = timedelta(seconds=95)  # one shot every 95 s


def at(seconds: float) -> datetime:
    return T0 + timedelta(seconds=seconds)


def test_readings_are_cut_into_windows_by_pauses_or_by_length() -> None:
    times = [at(s) for s in (0, 0.5, 1.0, 10, 10.5, 30)]
    assert runner.cut(times, "gap", 2) == [(0, 3), (3, 5), (5, 6)]
    assert runner.cut(times, "fixed", 10) == [(0, 3), (3, 5), (5, 6)]  # [0,10) [10,20) [30,40)
    assert runner.cut(times, "fixed", 60) == [(0, 6)]
    assert runner.cut([], "gap", 2) == []


def test_the_last_window_waits_until_no_reading_can_still_join_it() -> None:
    last = at(100)
    assert runner.complete(last, False, "gap", 2, last)  # later data follows: complete
    assert not runner.complete(last, True, "gap", 2, at(101))  # the shot may still be going
    assert runner.complete(last, True, "gap", 2, at(102.5))
    assert not runner.complete(at(95), True, "fixed", 60, at(119))  # [60, 120) not over yet
    assert runner.complete(at(95), True, "fixed", 60, at(120))


def shot_readings(shot: dict[str, Any], start: datetime) -> list[dict[str, Any]]:
    p = shot["payload"]
    out = []
    for i, t in enumerate(p["t"]):
        when = (start + timedelta(seconds=t)).isoformat()
        out += [
            {"signal": tag, "at": when, "value": p[key][i]}
            for tag, key in (("dc1.v", "v"), ("dc1.ph", "ph"), ("dc1.pm", "pm"))
        ]
    return out


def import_shots(api: TestClient, site: str, shots: list[dict[str, Any]], first: int = 0) -> None:  # noqa: F811
    imp = api.post(f"/sites/{site}/imports", json={"name": "shots.csv"}, headers=ENG).json()
    samples = [r for n, shot in enumerate(shots, first) for r in shot_readings(shot, T0 + n * CYCLE)]
    res = api.post(f"/sites/{site}/imports/{imp['id']}/samples", json={"samples": samples}, headers=ENG)
    assert res.status_code == 200, res.text


def signal_id(api: TestClient, site: str, tag: str) -> str:  # noqa: F811
    found = [
        s
        for s in api.get(f"/sites/{site}/signals", params={"q": tag}, headers=VIEWER).json()["signals"]
        if s["tag"] == tag
    ]
    return str(found[0]["id"])


def bind(api: TestClient, site: str, **changes: Any) -> Any:  # noqa: F811
    body = {
        "name": "dc1-plunger",
        "model": "plunger-friction",
        "inputs": {
            "t": "@time",
            "v": signal_id(api, site, "dc1.v"),
            "ph": signal_id(api, site, "dc1.ph"),
            "pm": signal_id(api, site, "dc1.pm"),
        },
        "window": {"kind": "gap", "seconds": 2},
    } | changes
    return api.post(f"/sites/{site}/model-bindings", json=body, headers=ENG)


def readings(database_url: str, site: str, tag: str) -> list[tuple[datetime, float]]:  # noqa: F811
    with psycopg.connect(database_url) as conn:
        return [
            (r[0], r[1])
            for r in conn.execute(
                "SELECT s.at, s.value FROM samples s JOIN signals g ON g.id = s.signal_id"
                " WHERE g.site_id = %s AND g.tag = %s ORDER BY s.at",
                [site, tag],
            )
        ]


def test_a_bound_model_writes_derived_signals_from_the_history_then_only_new_data(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    good = SHOTS[:4]  # the fifth has a repeated timestamp, which a store keyed by time can't hold
    import_shots(api, site, good[:3])
    res = bind(api, site)
    assert res.status_code == 201, res.text
    binding = res.json()
    assert (binding["model"], binding["version"], binding["window"]) == (
        "plunger-friction",
        "1.0.0",
        {"kind": "gap", "seconds": 2.0},
    )
    assert [(o["name"], o["tag"]) for o in binding["outputs"]] == [
        ("force", "dc1-plunger.force"),
        ("friction", "dc1-plunger.friction"),
    ]
    friction = [
        s
        for s in api.get(f"/sites/{site}/signals", params={"q": "dc1-plunger.friction"}, headers=VIEWER).json()[
            "signals"
        ]
    ]
    assert (friction[0]["source"], friction[0]["unit"]) == ("model:plunger-friction@1.0.0", "N")

    path = f"/sites/{site}/model-bindings/{binding['id']}/run"
    assert api.post(path, headers=VIEWER).status_code == 403
    first = api.post(path, headers=ENG).json()
    assert (first["windows"], first["error"]) == (3, None)  # each shot is a window: they pause 95 s apart
    estimates = readings(database_url, site, "dc1-plunger.friction")
    assert [round(v, 6) for _, v in estimates] == [round(s["estimate"], 6) for s in good[:3]]  # as the browser's model
    # At each shot's last reading.
    assert [t for t, _ in estimates] == [
        T0 + n * CYCLE + timedelta(seconds=good[n]["payload"]["t"][-1]) for n in range(3)
    ]
    assert len(readings(database_url, site, "dc1-plunger.force")) == 3 * (len(good[0]["payload"]["t"]) - 1)
    assert first["written"] == 3 + 3 * (len(good[0]["payload"]["t"]) - 1)

    # Nothing new: nothing to run. A new shot: only it runs.
    assert api.post(path, headers=ENG).json()["windows"] == 0
    import_shots(api, site, good[3:], first=3)
    second = api.post(path, headers=ENG).json()
    assert second["windows"] == 1
    assert [round(v, 6) for _, v in readings(database_url, site, "dc1-plunger.friction")][-1] == round(
        good[3]["estimate"], 6
    )
    listed = api.get(f"/sites/{site}/model-bindings", headers=VIEWER).json()
    assert (listed[0]["last_windows"], listed[0]["done_until"] is not None) == (1, True)

    # Stopped: kept, with its readings, but no longer run on schedule.
    assert api.delete(f"/sites/{site}/model-bindings/{binding['id']}", headers=ENG).status_code == 204
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        assert binding["id"] not in [str(b) for b in runner.due(conn)]
        actions = [
            r["action"]
            for r in conn.execute("SELECT action FROM audit_log WHERE entity_id = %s ORDER BY id", [binding["id"]])
        ]
    assert actions == ["model.bind", "model.run", "model.run", "model.run", "model.stop"]
    assert len(readings(database_url, site, "dc1-plunger.friction")) == 4


def test_a_shot_still_being_recorded_waits_for_the_next_run(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    import_shots(api, site, SHOTS[:2])
    binding = bind(api, site).json()
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        row = conn.execute("SELECT * FROM model_bindings WHERE id = %s", [binding["id"]]).fetchone()
        assert row is not None
        last = T0 + CYCLE + timedelta(seconds=SHOTS[1]["payload"]["t"][-1])
        # One second after the second shot's last reading: it may still be going on.
        result = runner.run_binding(conn, row, PlungerFriction(), now=last + timedelta(seconds=1))
        assert (result.windows, result.done_until) == (1, T0 + timedelta(seconds=SHOTS[0]["payload"]["t"][-1]))
        later = runner.run_binding(
            conn, row | {"done_until": result.done_until}, PlungerFriction(), now=last + timedelta(seconds=3)
        )
        assert (later.windows, later.done_until) == (1, last)


def test_a_binding_is_checked(api: TestClient, site: str) -> None:  # noqa: F811
    import_shots(api, site, SHOTS[:1])
    cases: list[tuple[dict[str, Any], str]] = [
        ({"inputs": {"t": "@time"}}, "inputs must be exactly ph, pm, t, v"),
        ({"params": {"mass": -1}}, "param mass = -1 is outside [1, 10000]"),
        ({"inputs": {"t": "@time", "v": "@time", "ph": "@time", "pm": "@time"}}, "at least one input must be a signal"),
        (
            {"inputs": {"t": "@time", "v": "00000000-0000-0000-0000-000000000000", "ph": "@time", "pm": "@time"}},
            "not signals of this site",
        ),
    ]
    for changes, problem in cases:
        res = bind(api, site, **changes)
        assert res.status_code == 422 and problem in res.json()["detail"], (changes, res.text)
    assert bind(api, site, model="nothing").status_code == 404
    assert bind(api, site, version="9.9.9").status_code == 404
    assert bind(api, site, name="Bad Name").status_code == 422
    assert bind(api, site).status_code == 201
    again = bind(api, site)
    assert (again.status_code, again.json()["detail"]) == (409, "A model binding is already called dc1-plunger")
    # An output's signal name taken by another signal (here, an imported tag): refused, nothing made.
    imp = api.post(f"/sites/{site}/imports", json={"name": "other.csv"}, headers=ENG).json()
    tagged = {"signal": "dc2.friction", "at": T0.isoformat(), "value": 1.0}
    assert (
        api.post(f"/sites/{site}/imports/{imp['id']}/samples", json={"samples": [tagged]}, headers=ENG).status_code
        == 200
    )
    clash = bind(api, site, name="dc2")
    assert (clash.status_code, clash.json()["detail"]) == (409, "The site already has a signal dc2.friction")
    names = [b["name"] for b in api.get(f"/sites/{site}/model-bindings", headers=VIEWER).json()]
    assert names == ["dc1-plunger"]
    assert not [
        s for s in api.get(f"/sites/{site}/signals", params={"q": "dc2.force"}, headers=VIEWER).json()["signals"]
    ]


def test_the_command_runs_every_enabled_binding(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    import_shots(api, site, SHOTS[:2])
    binding = bind(api, site).json()
    monkeypatch.setenv("TILES_DATABASE_URL", database_url)
    from tiles_api.settings import get_settings

    get_settings.cache_clear()
    try:
        runner.main(["--site", site])
    finally:
        get_settings.cache_clear()
    assert f"{binding['id']}: 2 window(s)" in capsys.readouterr().out
    assert len(readings(database_url, site, "dc1-plunger.friction")) == 2
    assert all(math.isfinite(v) for _, v in readings(database_url, site, "dc1-plunger.force"))
