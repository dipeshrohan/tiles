"""Data-quality checks (T2.09): gaps, stuck values, out-of-range values, unit mismatches; a badge per signal."""

import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, agent_auth, api, register, site  # noqa: F401 - api and site are fixtures
from test_signals import by_tag, commit_nodes, signals

from tiles_api import api_signals, quality
from tiles_api.quality import assess, duration
from tiles_api.settings import get_settings

T0 = datetime(2026, 9, 1, 6, 0, tzinfo=UTC)
MINUTE = timedelta(minutes=1)


def wave(n: int) -> list[float]:
    """n readings that keep changing."""
    return [20.0 + (i % 7) * 0.5 for i in range(n)]


def load(api: TestClient, site: str, tag: str, points: list[tuple[datetime, Any]], flag: str = "good") -> None:  # noqa: F811
    imp = api.post(f"/sites/{site}/imports", json={"name": "plant.csv"}, headers=ENG).json()
    samples = [{"signal": tag, "at": at.isoformat(), "value": v, "quality": flag} for at, v in points]
    res = api.post(f"/sites/{site}/imports/{imp['id']}/samples", json={"samples": samples}, headers=ENG)
    assert res.status_code == 200, res.text


def every_minute(values: list[Any], start: datetime = T0) -> list[tuple[datetime, Any]]:
    return [(start + i * MINUTE, v) for i, v in enumerate(values)]


def check(api: TestClient, site: str, **body: Any) -> dict[str, Any]:  # noqa: F811
    res = api.post(f"/sites/{site}/signals/quality", json=body, headers=ENG)
    assert res.status_code == 200, res.text
    out: dict[str, Any] = res.json()
    return out


def report(api: TestClient, site: str, tag: str) -> dict[str, Any]:  # noqa: F811
    q: dict[str, Any] = by_tag(api, site, tag)["quality"]
    return q


def checks(r: dict[str, Any]) -> list[tuple[str, str]]:
    return [(i["check"], i["severity"]) for i in r["issues"]]


def patch(api: TestClient, site: str, tag: str, change: dict[str, Any]) -> Any:  # noqa: F811
    return api.patch(f"/sites/{site}/signals/{by_tag(api, site, tag)['id']}", json=change, headers=ENG)


def test_a_steady_signal_is_good(api: TestClient, site: str) -> None:  # noqa: F811
    load(api, site, "press1.temperature", every_minute(wave(120)))
    assert by_tag(api, site, "press1.temperature")["quality"] is None  # not checked yet
    assert signals(api, site, quality="unchecked")["total"] == 1
    assert check(api, site) == {"checked": 1, "badges": {"good": 1, "warn": 0, "bad": 0, "unknown": 0}}
    r = report(api, site, "press1.temperature")
    assert (r["badge"], r["readings"], r["period_s"], r["coverage"], r["gaps"], r["issues"]) == (
        "good",
        120,
        60.0,
        1.0,
        0,
        [],
    )
    assert r["window_hours"] == 24
    assert signals(api, site, quality="good")["total"] == 1
    assert signals(api, site, quality="unchecked")["total"] == 0


def test_gaps_are_found_and_a_large_share_missing_is_a_problem(api: TestClient, site: str) -> None:  # noqa: F811
    # One 20-minute hole in four hours of minute readings: a warning.
    load(api, site, "a.flow", [p for p in every_minute(wave(240)) if not 100 <= (p[0] - T0) / MINUTE < 119])
    # Half of the time missing: a problem.
    load(api, site, "b.flow", [p for p in every_minute(wave(240)) if not 60 <= (p[0] - T0) / MINUTE < 180])
    check(api, site)
    a = report(api, site, "a.flow")
    assert (a["badge"], a["gaps"], a["longest_gap_s"], checks(a)) == ("warn", 1, 20 * 60.0, [("gaps", "warn")])
    assert a["coverage"] == pytest.approx(1 - 19 / 239)
    assert a["issues"][0]["message"] == "1 gap(s) longer than 3 min; the longest 20 min; 92.0% of the time covered"
    b = report(api, site, "b.flow")
    assert (b["badge"], checks(b)) == ("bad", [("gaps", "bad")])
    # A sample rate in the catalogue sets the period: at 1 Hz, minute readings are all gaps.
    assert patch(api, site, "a.flow", {"sample_rate_hz": 1}).status_code == 200
    a = report(api, site, "a.flow")  # checked again by the change
    assert (a["badge"], a["period_s"], a["gaps"]) == ("bad", 1.0, 220)


def test_stuck_values(api: TestClient, site: str) -> None:  # noqa: F811
    # Changing for an hour, then 90 minutes on one value.
    load(api, site, "press1.force", every_minute([*wave(60), *[12.5] * 90]))
    check(api, site)
    r = report(api, site, "press1.force")
    assert (r["badge"], r["stuck_runs"], r["longest_stuck_s"], checks(r)) == ("warn", 1, 89 * 60.0, [("stuck", "warn")])
    assert r["issues"][0]["message"] == "Stuck at 12.5 for 89 min (90 readings) from 2026-09-01T07:00:00+00:00"
    # Holding a value for two hours is normal for this one.
    assert patch(api, site, "press1.force", {"stuck_after_s": 7200}).status_code == 200
    assert report(api, site, "press1.force")["badge"] == "good"
    # Text states are reported on change: neither stuck nor gaps are checked.
    load(api, site, "press1.state", [(T0, "running"), (T0 + 5 * MINUTE, "running"), (T0 + 9 * 60 * MINUTE, "idle")])
    check(api, site)
    assert report(api, site, "press1.state")["badge"] == "good"


def test_out_of_range_values(api: TestClient, site: str) -> None:  # noqa: F811
    values = wave(100)
    values[10] = 250.0
    load(api, site, "oven.temp", every_minute(values))
    assert patch(api, site, "oven.temp", {"unit": "°C", "range_min": 0, "range_max": 200}).status_code == 200
    r = report(api, site, "oven.temp")  # a change of range checks the signal again
    assert (r["badge"], r["out_of_range"], checks(r)) == ("warn", 1, [("range", "warn")])
    assert r["issues"][0]["message"] == "1 of 100 readings outside the expected range (0 to 200 °C)"
    assert patch(api, site, "oven.temp", {"range_max": 20.5}).status_code == 200
    r = report(api, site, "oven.temp")
    assert (r["badge"], r["out_of_range"]) == ("bad", 70)  # 21.0 and above
    assert patch(api, site, "oven.temp", {"range_max": None, "range_min": 21}).status_code == 200
    assert report(api, site, "oven.temp")["issues"][0]["message"] == (
        "30 of 100 readings outside the expected range (at least 21 °C)"
    )
    res = patch(api, site, "oven.temp", {"range_max": 21})
    assert res.status_code == 422
    assert res.json()["detail"] == "The expected range's minimum must be below its maximum"
    nan = api.patch(
        f"/sites/{site}/signals/{by_tag(api, site, 'oven.temp')['id']}",
        content='{"range_min": NaN}',
        headers={**ENG, "Content-Type": "application/json"},
    )
    assert nan.status_code == 422  # not a 500 from echoing the NaN back
    assert nan.json()["detail"][0]["input"] == "nan"


def test_readings_the_source_marked_bad(api: TestClient, site: str) -> None:  # noqa: F811
    load(api, site, "line.speed", every_minute(wave(100)))
    load(api, site, "line.speed", every_minute(wave(3), T0 + 100 * MINUTE), flag="uncertain")
    check(api, site)
    r = report(api, site, "line.speed")
    assert (r["source_flagged"], checks(r)) == (3, [("source", "warn")])


def test_units_are_checked_against_the_ontology(api: TestClient, site: str) -> None:  # noqa: F811
    load(api, site, "press1.temperature", every_minute(wave(30)))
    commit_nodes(
        api, site, {"id": "sig-temp", "type": "Signal", "label": "Platen temperature", "props": {"unit": "°C"}}
    )
    assert patch(api, site, "press1.temperature", {"node_id": "sig-temp"}).status_code == 200
    r = report(api, site, "press1.temperature")
    assert (r["badge"], r["issues"][0]["message"]) == (
        "warn",
        "No unit set; the ontology node Platen temperature says °C",
    )
    assert patch(api, site, "press1.temperature", {"unit": "°F"}).status_code == 200
    r = report(api, site, "press1.temperature")
    assert (r["badge"], r["issues"][0]["message"]) == (
        "bad",
        "The unit is °F but the ontology node Platen temperature says °C",
    )
    assert signals(api, site, quality="bad")["total"] == 1
    assert patch(api, site, "press1.temperature", {"unit": "°c"}).status_code == 200  # case doesn't matter
    assert report(api, site, "press1.temperature")["badge"] == "good"


def test_the_window_ends_at_the_latest_reading(api: TestClient, site: str) -> None:  # noqa: F811
    # A day-long hole two days back, then a steady day: only the last day is checked.
    load(api, site, "kiln.temp", every_minute(wave(60)))
    load(api, site, "kiln.temp", every_minute(wave(24 * 60), T0 + timedelta(days=2)))
    check(api, site)
    r = report(api, site, "kiln.temp")
    assert (r["badge"], r["readings"], r["first_at"]) == ("good", 24 * 60, "2026-09-03T06:00:00Z")
    check(api, site, hours=72)
    r = report(api, site, "kiln.temp")
    assert (r["badge"], r["window_hours"], r["readings"], checks(r)) == ("bad", 72, 25 * 60, [("gaps", "bad")])


def test_only_listed_signals_are_checked_and_checks_are_audited(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    load(api, site, "a.flow", every_minute(wave(10)))
    load(api, site, "b.flow", every_minute(wave(10)))
    a = by_tag(api, site, "a.flow")
    assert api.post(f"/sites/{site}/signals/quality", json={}, headers=VIEWER).status_code == 403
    assert check(api, site, signal_ids=[a["id"]])["checked"] == 1
    assert by_tag(api, site, "b.flow")["quality"] is None
    assert api.post(f"/sites/{site}/signals/quality", json={"hours": 0}, headers=ENG).status_code == 422
    assert api.post(f"/sites/{site}/signals/quality", json={"hours": True}, headers=ENG).status_code == 422
    with psycopg.connect(database_url) as conn:
        rows = conn.execute(
            "SELECT entity_type, after FROM audit_log WHERE action = 'signal.quality_check' AND site_id = %s",
            [site],
        ).fetchall()
    assert rows == [("site", {"hours": 24.0, "checked": 1, "good": 1, "warn": 0, "bad": 0, "unknown": 0})]


def test_an_edge_signal_gone_quiet_is_a_problem(api: TestClient, site: str) -> None:  # noqa: F811
    token = register(api, site)["token"]
    samples = [
        {"signal": "press1.temperature", "at": (T0 + i * MINUTE).isoformat(), "value": v}
        for i, v in enumerate(wave(30))
    ]
    assert api.post("/agent/samples", json={"samples": samples}, headers=agent_auth(token)).status_code == 200
    check(api, site)
    r = report(api, site, "press1.temperature")
    assert r["badge"] == "bad"
    assert checks(r) == [("silent", "bad")]
    assert r["issues"][0]["message"].startswith("No reading for ")
    # A state sent only when it changes is quiet when nothing changes: not a problem.
    states = [{"signal": "press1.state", "at": T0.isoformat(), "value": "running"}]
    assert api.post("/agent/samples", json={"samples": states}, headers=agent_auth(token)).status_code == 200
    check(api, site)
    assert report(api, site, "press1.state")["badge"] == "good"


def test_the_command_checks_every_site(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    load(api, site, "a.flow", every_minute(wave(10)))
    monkeypatch.setenv("TILES_DATABASE_URL", database_url)
    get_settings.cache_clear()
    try:
        quality.main(["--site", site])
    finally:
        get_settings.cache_clear()
    assert capsys.readouterr().out.splitlines()[-1] == f"{site}: 1 good, 0 warn, 0 bad, 0 unknown"
    assert report(api, site, "a.flow")["badge"] == "good"
    with pytest.raises(SystemExit):
        quality.main(["--hours", "0"])


NO_READINGS = {
    "readings": 0,
    "first_at": None,
    "last_at": None,
    "period": None,
    "gaps": 0,
    "longest_gap": None,
    "missing": 0,
    "numeric": 0,
    "out_of_range": 0,
    "flagged": 0,
    "stuck_runs": 0,
    "longest_stuck": None,
}


def test_a_signal_without_readings_is_unknown_unless_its_unit_is_wrong() -> None:
    signal = {"unit": "bar", "source": "manual", "node_id": None, "node_label": None, "node_unit": None}
    assert assess(signal, NO_READINGS, T0, 24).badge == "unknown"
    linked = {**signal, "node_id": "sig-p", "node_label": None, "node_unit": "kPa"}
    r = assess(linked, NO_READINGS, T0, 24)
    assert (r.badge, r.issues[0].message) == ("bad", "The unit is bar but the ontology node sig-p says kPa")


def test_coverage_is_rounded_down() -> None:
    assert [quality.percent(x) for x in (0.89999, 0.9, 1.0, 0.0)] == ["89.9%", "90.0%", "100.0%", "0.0%"]


def test_durations_read_naturally() -> None:
    assert [duration(s) for s in (0.5, 45, 600, 3 * 3600 + 1800, 3 * 86400)] == [
        "0.5 s",
        "45 s",
        "10 min",
        "3.5 h",
        "3.0 d",
    ]


def test_a_check_waits_for_an_edit_in_progress(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    values = wave(100)
    values[10] = 250.0
    load(api, site, "oven.temp", every_minute(values))
    sig = by_tag(api, site, "oven.temp")
    answers: list[int] = []
    with psycopg.connect(database_url) as other:
        # An edit setting the expected range holds the signal and has not committed yet.
        other.execute("UPDATE signals SET range_max = 200 WHERE id = %s", [sig["id"]])
        run = threading.Thread(
            target=lambda: answers.append(api.post(f"/sites/{site}/signals/quality", json={}, headers=ENG).status_code)
        )
        run.start()
        time.sleep(0.3)  # the check waits for the signal
        other.commit()
        run.join(10)
    assert answers == [200]
    r = report(api, site, "oven.temp")
    assert (r["badge"], r["out_of_range"]) == ("warn", 1)  # checked with the new range


def test_a_whole_site_too_big_for_a_request_is_left_to_the_command(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    load(api, site, "a.flow", every_minute(wave(10)))
    load(api, site, "b.flow", every_minute(wave(10)))
    monkeypatch.setattr(api_signals, "MAX_CHECK", 1)
    res = api.post(f"/sites/{site}/signals/quality", json={}, headers=ENG)
    assert res.status_code == 422
    assert res.json()["detail"].endswith("check the whole site with tiles-check-quality")
    one = [by_tag(api, site, "a.flow")["id"]]
    assert api.post(f"/sites/{site}/signals/quality", json={"signal_ids": one}, headers=ENG).status_code == 200


def test_the_command_keeps_other_sites_checks_when_one_fails(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    load(api, site, "a.flow", every_minute(wave(10)))
    with psycopg.connect(database_url) as conn:
        other = conn.execute("SELECT id FROM sites WHERE id <> %s ORDER BY slug LIMIT 1", [site]).fetchone()
    assert other is not None
    real = quality.check_site

    def flaky(conn: object, site_id: object, *args: object, **kwargs: object) -> dict[str, int]:
        if str(site_id) == str(other[0]):
            raise psycopg.errors.LockNotAvailable("site busy")
        return real(conn, site_id, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(quality, "check_site", flaky)
    monkeypatch.setenv("TILES_DATABASE_URL", database_url)
    get_settings.cache_clear()
    try:
        with pytest.raises(SystemExit) as exit_:
            quality.main([])
    finally:
        get_settings.cache_clear()
    assert exit_.value.code == 1
    err = capsys.readouterr().err
    assert f"{other[0]}: not checked (site busy)" in err
    assert report(api, site, "a.flow")["badge"] == "good"  # the other sites' checks were kept
