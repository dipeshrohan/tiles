"""How the warnings did (T3.10): real warnings scored against the MES's events, as the browser does."""

from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_detectors import FIXTURE, create

from tiles_api import performance

EVERY = timedelta(seconds=FIXTURE["cycleSeconds"])
HORIZON_H = FIXTURE["horizonShots"] * FIXTURE["cycleSeconds"] / 3600


def send(api: TestClient, site: str, samples: list[dict[str, Any]]) -> None:  # noqa: F811
    imp = api.post(f"/sites/{site}/imports", json={"name": "plant.csv"}, headers=ENG).json()
    res = api.post(f"/sites/{site}/imports/{imp['id']}/samples", json={"samples": samples}, headers=ENG)
    assert res.status_code == 200, res.text


def signal_id(api: TestClient, site: str, tag: str) -> str:  # noqa: F811
    return str(api.get(f"/sites/{site}/signals", params={"q": tag}, headers=VIEWER).json()["signals"][0]["id"])


def plant(api: TestClient, site: str) -> dict[str, Any]:  # noqa: F811
    """The browser's friction history ending now, its downtime on an MES event signal, a detector run."""
    end = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=10)
    n = len(FIXTURE["values"])
    at = [end - (n - 1 - i) * EVERY for i in range(n)]
    send(
        api,
        site,
        [
            {"signal": "dc1.friction", "at": t.isoformat(), "value": v}
            for t, v in zip(at, FIXTURE["values"], strict=True)
        ],
    )
    downtime = [
        {"signal": "mes.dc1.downtime", "at": at[d["shot"]].isoformat(), "value": d["code"]} for d in FIXTURE["downtime"]
    ]
    other = [{"signal": "mes.dc2.downtime", "at": at[1000].isoformat(), "value": "DT-TOOL"}]
    scrap = [
        {"signal": "mes.dc1.scrap", "at": at[i].isoformat(), "value": v} for i, v in ((1350, 0), (1360, 3))
    ]  # no warning before it
    send(api, site, downtime + other + scrap)
    for tag, kind, asset in (
        ("mes.dc1.downtime", "downtime", "DC-01"),
        ("mes.dc2.downtime", "downtime", "DC-02"),
        ("mes.dc1.scrap", "scrap", "DC-01"),
    ):
        res = api.patch(
            f"/sites/{site}/signals/{signal_id(api, site, tag)}", json={"event_kind": kind, "asset": asset}, headers=ENG
        )
        assert (res.status_code, res.json()["event_kind"], res.json()["asset"]) == (200, kind, asset)
    detector = create(api, site, signal_id(api, site, "dc1.friction"), asset="DC-01").json()
    assert detector["asset"] == "DC-01"
    assert api.post(f"/sites/{site}/detectors/{detector['id']}/run", headers=ENG).json()["opened"] == 3
    return {"at": at, "detector": detector}


def report(api: TestClient, site: str, **query: Any) -> Any:  # noqa: F811
    res = api.get(f"/sites/{site}/performance", params={"horizon_hours": HORIZON_H, **query}, headers=VIEWER)
    assert res.status_code == 200, res.text
    return res.json()


def test_real_warnings_are_scored_against_the_mes_events_as_the_browser_scores_them(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
) -> None:
    p = plant(api, site)
    out = report(api, site)
    t = out["totals"]
    # The three downtimes, plus the one scrap reading that wasn't 0; DC-02 has no detector.
    assert (t["events"], t["caught"], t["warnings"], t["true_warnings"], t["false_warnings"]) == (4, 3, 3, 3, 0)
    assert (t["recall"], t["precision"]) == (0.75, 1)
    assert t["confirmed"] == {"true_alarm": 0, "false_alarm": 0, "unknown": 0, "unresolved": 3}
    assert out["unwatched"] == [{"asset": "DC-02", "events": 1}]
    downtimes = sorted((e for e in out["events"] if e["kind"] == "downtime"), key=lambda e: e["at"])
    # The browser's warning times (test/fixtures/friction-detection.json).
    leads = [s["leadShots"] * FIXTURE["cycleSeconds"] for s in FIXTURE["scored"]]
    assert [(e["code"], e["warning_seconds"]) for e in downtimes] == [
        (d["code"], lead) for d, lead in zip(FIXTURE["downtime"], leads, strict=True)
    ]
    assert all(e["detector"] == "dc1-friction" for e in downtimes)
    (scrap,) = [e for e in out["events"] if e["kind"] == "scrap"]
    assert (scrap["code"], scrap["warned_at"], scrap["signal_tag"]) == ("3", None, "mes.dc1.scrap")
    (row,) = out["detectors"]
    assert (row["name"], row["asset"], row["matched"], row["recall"]) == ("dc1-friction", "DC-01", True, 0.75)

    # Only the targeted codes: the lubrication stop no longer counts, so its warning is false.
    seizures = report(api, site, codes=["DT-SEIZURE"])["totals"]
    assert (seizures["events"], seizures["caught"], seizures["true_warnings"], seizures["false_warnings"]) == (
        2,
        2,
        2,
        1,
    )
    # The last day only: the first downtime (27 h ago) and its warning are out of the period.
    day = report(api, site, days=1)["totals"]
    assert (day["events"], day["warnings"]) == (3, 2)

    # What people said counts too.
    first = api.get(f"/sites/{site}/warnings", headers=VIEWER).json()[-1]
    api.post(f"/sites/{site}/warnings/{first['id']}/resolve", json={"outcome": "true_alarm"}, headers=ENG)
    assert report(api, site)["totals"]["confirmed"] == {
        "true_alarm": 1,
        "false_alarm": 0,
        "unknown": 0,
        "unresolved": 2,
    }

    # A detector without an asset can't be matched: it is listed, but not scored.
    path = f"/sites/{site}/detectors/{p['detector']['id']}"
    assert api.patch(path, json={"asset": None}, headers=VIEWER).status_code == 403
    assert api.patch(path, json={"asset": None}, headers=ENG).json()["asset"] is None
    unmatched = report(api, site)
    assert unmatched["detectors"][0]["matched"] is False
    assert unmatched["totals"]["events"] == 0
    assert {u["asset"] for u in unmatched["unwatched"]} == {"DC-01", "DC-02"}


def test_events_settings_are_checked_and_audited(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    send(api, site, [{"signal": "mes.downtime", "at": "2026-08-01T00:00:00Z", "value": "DT-1"}])
    sid = signal_id(api, site, "mes.downtime")
    path = f"/sites/{site}/signals/{sid}"
    for bad in ({"event_kind": "outage"}, {"asset": " DC-01"}, {"asset": ""}, {"asset": "x" * 101}):
        assert api.patch(path, json=bad, headers=ENG).status_code == 422, bad
    assert api.patch(path, json={"event_kind": "downtime"}, headers=VIEWER).status_code == 403
    assert api.patch(path, json={"event_kind": "downtime", "asset": "DC 01"}, headers=ENG).status_code == 200
    cleared = api.patch(path, json={"event_kind": None}, headers=ENG).json()
    assert (cleared["event_kind"], cleared["asset"]) == (None, "DC 01")
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        audited = conn.execute(
            "SELECT before, after FROM audit_log WHERE action = 'signal.update' AND entity_id = %s ORDER BY id", [sid]
        ).fetchall()
    assert audited[0]["after"] == {"tag": "mes.downtime", "event_kind": "downtime", "asset": "DC 01"}
    assert audited[1]["before"] == {"tag": "mes.downtime", "event_kind": "downtime"}


def test_too_many_events_ask_for_a_shorter_period(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plant(api, site)
    monkeypatch.setattr(performance, "MAX_EVENTS", 3)
    res = api.get(f"/sites/{site}/performance", headers=VIEWER)
    assert (res.status_code, res.json()["detail"]) == (
        422,
        "More than 3 events in this period: choose a shorter one, or some codes",
    )
    assert api.get(f"/sites/{site}/performance", params={"days": 0}, headers=VIEWER).status_code == 422
    assert api.get(f"/sites/{site}/performance", headers=ADMIN).status_code == 422  # still too many


def test_only_what_a_detector_judged_counts_and_a_warning_before_the_period_still_warns(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
) -> None:
    p = plant(api, site)
    at = p["at"]
    now = datetime.now(UTC)
    send(
        api,
        site,
        [
            # Before the friction history began, and after the detector's last run: neither counts.
            {"signal": "mes.dc1.downtime", "at": (at[0] - timedelta(days=3)).isoformat(), "value": "DT-OLD"},
            {"signal": "mes.dc1.downtime", "at": (now - timedelta(minutes=2)).isoformat(), "value": "DT-NEW"},
            # Another stream on the asset reporting the same code at the same time as the scrap.
            {"signal": "mes.dc1.rework", "at": at[1360].isoformat(), "value": "3"},
        ],
    )
    api.patch(
        f"/sites/{site}/signals/{signal_id(api, site, 'mes.dc1.rework')}",
        json={"event_kind": "other", "asset": "DC-01"},
        headers=ENG,
    )
    out = report(api, site)
    assert out["totals"]["events"] == 5  # the four, and the rework; not DT-OLD or DT-NEW
    assert {e["code"] for e in out["events"]} >= {"3"} and not {"DT-OLD", "DT-NEW"} & {e["code"] for e in out["events"]}
    (row,) = out["detectors"]
    assert row["judged_from"] == at[0].isoformat().replace("+00:00", "Z")
    assert row["judged_until"] < (now - timedelta(minutes=5)).isoformat()
    threes = sorted((e["kind"], e["signal_tag"]) for e in out["events"] if e["code"] == "3")
    assert threes == [("other", "mes.dc1.rework"), ("scrap", "mes.dc1.scrap")]

    # The last four hours: the warning before it (4.6 h ago) still warned of the downtime in it.
    recent = report(api, site, days=4 / 24)
    t = recent["totals"]
    assert (t["events"], t["caught"], t["warnings"], t["false_warnings"]) == (1, 1, 0, 0)
    (event,) = recent["events"]
    assert event["warning_seconds"] == FIXTURE["scored"][2]["leadShots"] * FIXTURE["cycleSeconds"]
