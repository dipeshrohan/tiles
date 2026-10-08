"""The backtest over HTTP and as a report (T3.05), on the friction history the browser's model made."""

from pathlib import Path
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_detectors import FIXTURE, at, import_friction

from tiles_api import api_backtest, backtest

EVENTS = [{"at": at(d["shot"]).isoformat(), "code": d["code"]} for d in FIXTURE["downtime"]]
HORIZON = FIXTURE["horizonShots"] * FIXTURE["cycleSeconds"]


def run(api: TestClient, site: str, signal: str, **changes: Any) -> Any:  # noqa: F811
    body = {"signal_id": signal, "events": EVENTS, "horizon_seconds": HORIZON} | changes
    return api.post(f"/sites/{site}/backtest", json=body, headers=ENG)


def test_a_backtest_scores_each_setting_against_the_events(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    signal = import_friction(api, site, FIXTURE["values"])
    body = {"signal_id": signal, "events": EVENTS, "horizon_seconds": HORIZON}
    assert api.post(f"/sites/{site}/backtest", json=body, headers=VIEWER).status_code == 403
    res = run(api, site, signal, window=[100], k=[8, 2.5, 4], persist=[1])
    assert res.status_code == 200, res.text
    out = res.json()
    assert (out["signal_tag"], out["readings"]) == ("dc1.friction", 1600)
    assert (out["first_at"], out["last_at"]) == (z(at(0)), z(at(1599)))
    # Best first: all three events, none false; then all three with two false; then none.
    assert [(s["config"]["k"], s["caught"], s["false_warnings"]) for s in out["settings"]] == [
        (4, 3, 0),
        (2.5, 3, 2),
        (8, 0, 0),
    ]
    best = out["settings"][0]
    assert best["config"] == {
        "window": 100,
        "k": 4,
        "persist": 1,
        "direction": "above",
        "cooldown": 0,
        "flat_spread": 1,
    }
    assert (best["recall"], best["precision"], best["false_per_day"]) == (1, 1, 0)
    assert [e["code"] for e in best["events"]] == ["DT-SEIZURE", "DT-LUBRICATION", "DT-SEIZURE"]
    assert best["warning_seconds"]["count"] == 3
    assert out["report"].startswith("# Backtest: dc1.friction\n")

    # The browser's own setting gives the browser's warning times.
    browser = run(api, site, signal).json()["settings"]
    assert [e["warning_seconds"] / FIXTURE["cycleSeconds"] for e in browser[0]["events"]] == [
        s["leadShots"] for s in FIXTURE["scored"]
    ]
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        audited = conn.execute(
            "SELECT action, after FROM audit_log WHERE entity_id = %s ORDER BY id", [signal]
        ).fetchall()
    assert [(a["action"], a["after"]) for a in audited if a["action"] == "backtest.run"] == [
        ("backtest.run", {"readings": 1600, "settings": 3, "events": 3}),
        ("backtest.run", {"readings": 1600, "settings": 1, "events": 3}),
    ]


def z(t: Any) -> str:
    return str(t.isoformat().replace("+00:00", "Z"))


def test_the_period_limits_the_history_and_its_events(api: TestClient, site: str) -> None:  # noqa: F811
    signal = import_friction(api, site, FIXTURE["values"])
    out = run(api, site, signal, start=at(600).isoformat(), end=at(1200).isoformat()).json()
    assert (out["readings"], out["first_at"], out["last_at"]) == (600, z(at(600)), z(at(1199)))
    # Judged from shot 800, once the baseline filled: only the event at 1090 is inside.
    assert [(e["code"], e["warning_seconds"]) for e in out["settings"][0]["events"]] == [
        ("DT-LUBRICATION", 64 * FIXTURE["cycleSeconds"])
    ]
    empty = run(api, site, signal, start=at(5000).isoformat()).json()
    assert (empty["readings"], empty["first_at"], empty["settings"][0]["caught"]) == (0, None, 0)
    assert "- **History:** none" in empty["report"]


def test_a_backtest_is_checked(api: TestClient, site: str, monkeypatch: pytest.MonkeyPatch) -> None:  # noqa: F811
    signal = import_friction(api, site, FIXTURE["values"][:300])
    nowhere = "00000000-0000-0000-0000-000000000000"
    checked: list[tuple[dict[str, Any], str]] = [
        ({"signal_id": nowhere}, "Not a signal of this site"),
        ({"start": at(10).isoformat(), "end": at(10).isoformat()}, "The start must be before the end"),
        ({"window": [100, 200], "k": [1, 2, 3, 4, 5], "persist": [1, 2, 3, 4, 5]}, "50 settings: at most 48 at once"),
    ]
    for changes, detail in checked:
        res = run(api, site, signal, **changes)
        assert (res.status_code, res.json()["detail"]) == (422, detail), changes
    invalid: list[dict[str, Any]] = [
        {"horizon_seconds": 0},
        {"window": []},
        {"window": [5]},
        {"k": list(range(1, 10))},
        {"direction": ["up"]},
        {"events": [{"at": "2026-08-01T00:00:00"}]},  # no offset: which zone?
        {"events": [{"at": at(1).isoformat()}] * (api_backtest.MAX_EVENTS + 1)},
        {"start": "2026-08-01T00:00:00"},
        {"surprise": 1},
    ]
    for changes in invalid:
        assert run(api, site, signal, **changes).status_code == 422, changes
    monkeypatch.setattr(backtest, "MAX_READINGS", 299)
    res = run(api, site, signal)
    message = "More than 299 readings with 1 setting(s): choose a shorter period or fewer settings"
    assert (res.status_code, res.json()["detail"]) == (422, message)
    monkeypatch.setattr(backtest, "MAX_READINGS", 300)
    assert run(api, site, signal).status_code == 200
    # More settings, fewer readings each.
    monkeypatch.setattr(backtest, "MAX_REPLAYS", 600)
    res = run(api, site, signal, k=[3, 4, 5])
    message = "More than 200 readings with 3 setting(s): choose a shorter period or fewer settings"
    assert (res.status_code, res.json()["detail"]) == (422, message)
    assert run(api, site, signal, k=[3, 4]).status_code == 200


def test_backtests_run_two_at_a_time(api: TestClient, site: str) -> None:  # noqa: F811
    signal = import_friction(api, site, FIXTURE["values"][:300])
    assert api_backtest.RUNNING.acquire(blocking=False) and api_backtest.RUNNING.acquire(blocking=False)
    try:
        res = run(api, site, signal)
        assert (res.status_code, res.json()["detail"]) == (429, "Other backtests are running: try again shortly")
    finally:
        api_backtest.RUNNING.release()
        api_backtest.RUNNING.release()
    assert run(api, site, signal).status_code == 200
    assert run(api, site, signal, signal_id="00000000-0000-0000-0000-000000000000").status_code == 422
    assert run(api, site, signal).status_code == 200  # a refused backtest gave its turn back


def test_the_command_writes_the_report(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    import_friction(api, site, FIXTURE["values"])
    events = tmp_path / "downtime.csv"
    events.write_text("at,code\n" + "".join(f"{e['at']},{e['code']}\n" for e in EVENTS) + ",\n", encoding="utf-8")
    monkeypatch.setenv("TILES_DATABASE_URL", database_url)
    from tiles_api.settings import get_settings

    get_settings.cache_clear()
    out = tmp_path / "report.md"
    args = ["--site", site, "--signal", "dc1.friction", "--events", str(events), "--horizon-hours", str(HORIZON / 3600)]
    try:
        api_backtest.main(
            [*args, "--k", "2.5,4,8", "--window", "100", "--persist", "1", "--flat-spread", "1", "--out", str(out)]
        )
        assert f"\n{out}: 3 setting(s); best warned of 3 event(s)\n" in "\n" + capsys.readouterr().out
        report = out.read_text(encoding="utf-8")
        assert "| window 100, k 4, persist 1 | 17 | 0.00 | 100.0% (3/3) | 100.0% |" in report
        assert "- **Events:** 3" in report

        api_backtest.main(args)  # no --out: printed
        assert "\n# Backtest: dc1.friction\n\n- **Signal:** dc1.friction\n" in "\n" + capsys.readouterr().out

        for bad, message in [
            (["--signal", "nope"], "no signal nope at site"),
            (["--k", "0"], "k.0: Input should be greater than 0"),
            (["--events", str(tmp_path / "missing.csv")], "No such file"),
        ]:
            with pytest.raises(SystemExit):
                api_backtest.main([*args, *bad])
            assert message in capsys.readouterr().err, bad
        events.write_text("time,code\n2026-08-01T00:00:00Z,x\n", encoding="utf-8")
        with pytest.raises(SystemExit):
            api_backtest.main(args)
        assert "needs an 'at' column" in capsys.readouterr().err
    finally:
        get_settings.cache_clear()
