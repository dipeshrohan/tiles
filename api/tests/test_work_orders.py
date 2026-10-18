"""Work orders out (T9.02): drafted from a warning or a component's remaining life, approved by
someone else, exported as CSV for the CMMS, closed with their outcome; audited."""

import csv
import io
from typing import Any

import psycopg
from fastapi.testclient import TestClient
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_performance import plant, signal_id
from test_remaining_life import plant as worn_plant
from test_reviews import ENG2

BASE = "/sites/{}/work-orders"


def post(api: TestClient, site: str, path: str = "", who: dict[str, str] = ENG, status: int = 200, **body: Any) -> Any:  # noqa: F811
    res = api.post(BASE.format(site) + path, json=body, headers=who)
    assert res.status_code == status, res.text
    return res.json()


def listed(api: TestClient, site: str, **query: str) -> list[dict[str, Any]]:  # noqa: F811
    res = api.get(BASE.format(site), params=query, headers=VIEWER)
    assert res.status_code == 200, res.text
    out: list[dict[str, Any]] = res.json()
    return out


def test_a_warning_drafts_a_work_order_someone_else_approves_exports_and_closes(api: TestClient, site: str) -> None:  # noqa: F811
    plant(api, site)
    api.get(f"/sites/{site}/me", headers=ENG2)  # another engineer
    warning = api.get(f"/sites/{site}/warnings", params={"state": "all"}, headers=VIEWER).json()[0]
    order = post(
        api,
        site,
        status=201,
        source="warning",
        warning_id=warning["id"],
        title="Check the plunger tip",
        description="Friction rising before seizures",
        priority="high",
    )
    assert (order["number"], order["status"], order["asset"], order["mine"]) == (1, "draft", "DC-01", True)
    assert (order["warning_tag"], order["drafted_by"]) == ("dc1.friction", "eng")
    # Its drafter can't approve it; another engineer does.
    refused = post(api, site, "/1/approve", status=403)
    assert refused["code"] == "work_order.own_draft"
    approved = post(api, site, "/1/approve", who=ENG2, note="Planned for Monday")
    assert (approved["status"], approved["approved_by"], approved["mine"]) == ("approved", "eng2", False)
    assert post(api, site, "/1/approve", who=ENG2, status=409)["params"] == {"number": 1, "status": "approved"}
    # One open work order per warning.
    again = post(api, site, status=409, source="warning", warning_id=warning["id"], title="Again")
    assert (again["code"], again["params"]) == ("work_order.exists", {"number": 1})
    # Exported as CSV for the CMMS: then marked exported with the file's name.
    out = post(api, site, "/export")
    assert out["numbers"] == [1] and out["name"].startswith("tiles-work-orders-") and out["name"].endswith("-1.csv")
    rows = list(csv.DictReader(io.StringIO(out["csv"])))
    assert [(r["number"], r["asset"], r["title"], r["priority"], r["source"], r["warning_signal"]) for r in rows] == [
        ("1", "DC-01", "Check the plunger tip", "high", "warning", "dc1.friction")
    ]
    assert (rows[0]["drafted_by"], rows[0]["approved_by"]) == ("eng", "eng2")
    [exported] = listed(api, site)
    assert (exported["status"], exported["export_ref"]) == ("exported", out["name"])
    assert post(api, site, "/export", status=409)["code"] == "work_order.none_approved"
    # The same file again, if the first download was lost.
    assert post(api, site, "/export", again=out["name"]) == out
    assert post(api, site, "/export", status=404, again="nope.csv")["code"] == "work_order.no_export"
    # Its outcome closes it.
    done = post(api, site, "/1/outcome", outcome="done", note="Tip replaced")
    assert (done["status"], done["outcome"], done["outcome_note"]) == ("done", "done", "Tip replaced")
    assert post(api, site, "/1/cancel", status=409)["code"] == "work_order.wrong_status"
    assert listed(api, site) == [] and [o["number"] for o in listed(api, site, show="all")] == [1]
    assert [o["number"] for o in listed(api, site, show="done")] == [1]
    # A closed one leaves the warning free for another.
    post(api, site, status=201, source="warning", warning_id=warning["id"], title="Next time")
    # Every step is audited.
    actions = [e["action"] for e in api.get(f"/sites/{site}/audit", headers=ADMIN).json()]
    for action in ("draft", "approve", "export", "export_again", "outcome"):
        assert f"work_order.{action}" in actions


def test_a_components_remaining_life_drafts_one_for_its_machine(api: TestClient, site: str) -> None:  # noqa: F811
    worn_plant(api, site)
    tip = signal_id(api, site, "w1.tip")
    order = post(api, site, status=201, source="remaining_life", signal_id=tip, title="Replace the welder tip")
    assert (order["asset"], order["signal_tag"], order["source"]) == ("Welder 1", "w1.tip", "remaining_life")
    assert post(api, site, status=422, source="remaining_life", title="Which?")["code"] == "work_order.needs_signal"
    assert post(api, site, status=422, source="warning", title="Which?")["code"] == "work_order.needs_warning"
    unknown = "00000000-0000-0000-0000-000000000000"
    missing = post(api, site, status=404, source="remaining_life", signal_id=unknown, title="x")
    assert missing["code"] == "signal.not_found"
    gone = post(api, site, status=404, source="warning", warning_id=unknown, title="x")
    assert gone["code"] == "warning.not_found"


def test_by_hand_cancelled_and_no_one_approves_their_own(api: TestClient, site: str) -> None:  # noqa: F811
    order = post(api, site, status=201, who=ADMIN, source="manual", asset="Press 9", title="Grease the press")
    assert (order["asset"], order["priority"]) == ("Press 9", "medium")
    assert post(api, site, "/1/approve", who=ADMIN, status=403)["code"] == "work_order.own_draft"  # admins too
    assert post(api, site, "/1/approve")["status"] == "approved"
    post(api, site, status=201, source="manual", title='=HYPERLINK("http://example.com")', description="-1+2")
    cancelled = post(api, site, "/2/cancel", note="Not needed after all")
    assert (cancelled["status"], cancelled["outcome_note"], cancelled["closed_at"] is not None) == (
        "cancelled",
        "Not needed after all",
        True,
    )
    assert post(api, site, "/2/outcome", status=409, outcome="done")["code"] == "work_order.wrong_status"
    # A cell a spreadsheet would run as a formula is written as text.
    post(api, site, status=201, source="manual", title='=HYPERLINK("http://example.com")', description="-1+2")
    post(api, site, "/3/approve", who=ADMIN)
    rows = list(csv.DictReader(io.StringIO(post(api, site, "/export")["csv"])))
    assert [(r["number"], r["title"], r["description"]) for r in rows] == [
        ("1", "Grease the press", ""),
        ("3", '\'=HYPERLINK("http://example.com")', "'-1+2"),
    ]


def test_viewers_read_engineers_write(api: TestClient, site: str) -> None:  # noqa: F811
    assert post(api, site, status=403, who=VIEWER, source="manual", title="x")["code"] == "role.too_low"
    post(api, site, status=201, source="manual", title="Look at the cooling")
    assert post(api, site, "/1/approve", who=VIEWER, status=403)["code"] == "role.too_low"
    assert [o["title"] for o in listed(api, site)] == ["Look at the cooling"]
    res = api.get(BASE.format(site) + "/9", headers=VIEWER)
    assert (res.status_code, res.json()["code"]) == (404, "work_order.not_found")


def test_the_machine_is_found_for_a_warning_without_one_and_kept_short(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    worn_plant(api, site)
    tip = signal_id(api, site, "w1.tip")
    # A detector without an asset: the warning's signal names its machine through the plant model.
    res = api.post(f"/sites/{site}/detectors", json={"name": "tip", "signal_id": tip, "window": 20}, headers=ENG)
    assert res.status_code == 201, res.text
    with psycopg.connect(database_url) as conn:
        row = conn.execute(
            "INSERT INTO warnings (site_id, detector_id, signal_id, started_at, last_at, side, peak, baseline,"
            " threshold, readings) VALUES (%s, %s, %s, now() - interval '1 hour', now(), 'above', 150, 100, 120, 5)"
            " RETURNING id",
            [site, res.json()["id"], tip],
        ).fetchone()
    assert row is not None
    warning = str(row[0])
    order = post(api, site, status=201, source="warning", warning_id=warning, title="Check the tip")
    assert order["asset"] == "Welder 1"
    # A machine named longer than an asset can be is left out, not refused.
    long = "W" * 150
    ops = [{"kind": "setProp", "id": "m1", "key": "asset", "value": long}]
    assert api.post(f"/sites/{site}/ontology/staged/batch", json=ops, headers=ENG).status_code == 201
    assert api.post(f"/sites/{site}/ontology/commits", json={"message": "long"}, headers=ENG).status_code in (200, 201)
    order = post(api, site, status=201, source="remaining_life", signal_id=tip, title="Replace the tip")
    assert order["asset"] is None
