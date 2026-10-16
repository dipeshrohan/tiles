"""Planned stops (T7.03): planned downtime that Warning performance and the ROI report leave out."""

from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_performance import HORIZON_H, plant, report


def stops(api: TestClient, site: str, **query: str) -> Any:  # noqa: F811
    res = api.get(f"/sites/{site}/planned-stops", params=query, headers=VIEWER)
    assert res.status_code == 200, res.text
    return res.json()


def add(api: TestClient, site: str, status: int = 201, who: dict[str, str] = ENG, **body: Any) -> Any:  # noqa: F811
    res = api.post(f"/sites/{site}/planned-stops", json=body, headers=who)
    assert res.status_code == status, res.text
    return res.json()


def test_engineers_enter_and_remove_planned_stops(api: TestClient, site: str) -> None:  # noqa: F811
    s = add(
        api, site, asset="DC-01", starts_at="2026-05-01T06:00:00Z", ends_at="2026-05-01T08:00:00Z", reason="Die change"
    )
    whole = add(api, site, starts_at="2026-05-02T00:00:00Z", ends_at="2026-05-03T00:00:00Z", reason="Shutdown")
    assert (s["asset"], s["reason"], s["created_by"]) == ("DC-01", "Die change", "eng")
    assert whole["asset"] is None  # the whole site
    assert [x["id"] for x in stops(api, site)["stops"]] == [whole["id"], s["id"]]  # latest first
    # Only those overlapping a range.
    assert [x["id"] for x in stops(api, site, since="2026-05-01T07:00:00Z", until="2026-05-01T09:00:00Z")["stops"]] == [
        s["id"]
    ]
    assert api.delete(f"/sites/{site}/planned-stops/{s['id']}", headers=ENG).status_code == 204
    assert [x["id"] for x in stops(api, site)["stops"]] == [whole["id"]]
    gone = api.delete(f"/sites/{site}/planned-stops/{s['id']}", headers=ENG)
    assert (gone.status_code, gone.json()["code"]) == (404, "planned.not_found")
    audit = api.get(f"/sites/{site}/audit", headers={"X-Tiles-User": "admin@example.com"}).json()
    actions = [e["action"] for e in (audit["entries"] if isinstance(audit, dict) else audit)]
    assert "planned_stop.create" in actions and "planned_stop.delete" in actions


def test_viewers_read_only_and_a_stop_must_end_after_it_starts(api: TestClient, site: str) -> None:  # noqa: F811
    backwards = add(api, site, 422, starts_at="2026-05-01T08:00:00Z", ends_at="2026-05-01T06:00:00Z")
    assert backwards["code"] == "planned.order"
    add(api, site, 403, who=VIEWER, starts_at="2026-05-01T06:00:00Z", ends_at="2026-05-01T08:00:00Z")
    assert api.put(f"/sites/{site}/planned-codes", json={"codes": ["PM"]}, headers=VIEWER).status_code == 403
    assert add(api, site, 422, starts_at="2026-05-01T06:00:00", ends_at="2026-05-01T08:00:00")["detail"]  # no zone
    spaced = add(api, site, 422, asset=" DC-01", starts_at="2026-05-01T08:00:00Z", ends_at="2026-05-01T09:00:00Z")
    assert spaced["detail"]


def test_planned_downtime_is_left_out_of_warning_performance(api: TestClient, site: str) -> None:  # noqa: F811
    p = plant(api, site)
    before = report(api, site)
    assert before["totals"]["events"] == 4 and before["unwatched"] == [{"asset": "DC-02", "events": 1}]
    # A planned code: DT-LUBRICATION is planned maintenance at this plant.
    res = api.put(f"/sites/{site}/planned-codes", json={"codes": ["DT-LUBRICATION", "PM"]}, headers=ENG)
    assert (res.status_code, res.json()["codes"]) == (200, ["DT-LUBRICATION", "PM"])
    assert report(api, site)["totals"]["events"] == 3
    # A planned stop for DC-02 around its one stop; one for DC-01 leaves DC-02's alone.
    at = p["at"][1000]
    add(
        api,
        site,
        asset="DC-01",
        starts_at=(at - timedelta(minutes=5)).isoformat(),
        ends_at=(at + timedelta(minutes=5)).isoformat(),
    )
    assert report(api, site)["unwatched"] == [{"asset": "DC-02", "events": 1}]
    add(
        api,
        site,
        asset="DC-02",
        starts_at=(at - timedelta(minutes=5)).isoformat(),
        ends_at=(at + timedelta(minutes=5)).isoformat(),
    )
    assert report(api, site)["unwatched"] == []
    # Scrap is never planned downtime.
    assert any(e["kind"] == "scrap" for e in report(api, site)["events"])
    # The ROI report leaves it out too.
    roi = api.post(
        f"/sites/{site}/roi",
        json={
            "baseline_start": (p["at"][0] - timedelta(days=10)).isoformat(),
            "baseline_end": (p["at"][0] - timedelta(days=1)).isoformat(),
            "pilot_start": p["at"][0].isoformat(),
            "pilot_end": (p["at"][-1] + timedelta(minutes=5)).isoformat(),
            "horizon_hours": HORIZON_H,
        },
        headers=VIEWER,
    ).json()
    assert roi["periods"]["pilot"]["counts"]["downtime"] == 2  # DC-01's two seizures; lubrication and DC-02's planned
    # Setting the codes again with none clears them.
    assert api.put(f"/sites/{site}/planned-codes", json={"codes": []}, headers=ENG).json()["codes"] == []
