"""The warning workflow (T3.07): raised, acknowledged, assigned and resolved with an outcome, on the
warnings a detector raises on the browser's friction history."""

from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_detectors import FIXTURE, create, import_friction

from tiles_api import detector_job

ENG2 = {"X-Tiles-User": "eng2@example.com"}


def raise_warnings(api: TestClient, site: str) -> list[str]:  # noqa: F811
    """The three warnings of the friction history, oldest first."""
    signal = import_friction(api, site, FIXTURE["values"])
    detector = create(api, site, signal).json()
    assert api.post(f"/sites/{site}/detectors/{detector['id']}/run", headers=ENG).json()["opened"] == 3
    return [w["id"] for w in reversed(listed(api, site))]


def listed(api: TestClient, site: str, headers: dict[str, str] = VIEWER, **query: str) -> list[dict[str, Any]]:  # noqa: F811
    res = api.get(f"/sites/{site}/warnings", params=query, headers=headers)
    assert res.status_code == 200, res.text
    return list(res.json())


def user_id(api: TestClient, site: str, headers: dict[str, str]) -> str:  # noqa: F811
    return str(api.get(f"/sites/{site}/me", headers=headers).json()["user_id"])


def steps(detail: dict[str, Any]) -> list[tuple[Any, ...]]:
    return [(a["action"], a["actor"], a["assignee"], a["outcome"], a["note"]) for a in detail["activity"]]


def test_a_warning_is_acknowledged_assigned_resolved_and_reopened(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    first, second, third = raise_warnings(api, site)
    eng2 = user_id(api, site, ENG2)
    viewer = user_id(api, site, VIEWER)
    path = f"/sites/{site}/warnings"
    assert [w["status"] for w in listed(api, site, status="raised")] == ["raised"] * 3
    assert api.post(f"{path}/{first}/acknowledge", json={}, headers=VIEWER).status_code == 403

    # Acknowledged: someone is looking.
    acked = api.post(f"{path}/{first}/acknowledge", json={"note": "On it"}, headers=ENG).json()
    assert (acked["status"], acked["acknowledged_by"], acked["assignee"]) == ("acknowledged", "eng", None)
    assert steps(acked) == [("raised", None, None, None, ""), ("acknowledged", "eng", None, None, "On it")]
    again = api.post(f"{path}/{first}/acknowledge", json={}, headers=ENG)
    assert (again.status_code, again.json()["detail"]) == (409, "This warning is already acknowledged")

    # Assigned: to an engineer of the site, acknowledging it on the way.
    res = api.put(f"{path}/{second}/assignee", json={"user_id": eng2, "note": "Your line"}, headers=ENG)
    assert res.status_code == 200, res.text
    assigned = res.json()
    assert (assigned["status"], assigned["assignee"], assigned["assignee_id"]) == ("acknowledged", "eng2", eng2)
    assert steps(assigned)[1:] == [
        ("acknowledged", "eng", None, None, ""),
        ("assigned", "eng", "eng2", None, "Your line"),
    ]
    same = api.put(f"{path}/{second}/assignee", json={"user_id": eng2}, headers=ENG).json()
    assert len(same["activity"]) == 3  # already theirs: nothing changes
    for nobody in (viewer, "00000000-0000-0000-0000-000000000000"):
        res = api.put(f"{path}/{second}/assignee", json={"user_id": nobody}, headers=ENG)
        assert (res.status_code, res.json()["detail"]) == (422, "Not an engineer or admin of this site")

    # The inbox's filters.
    assert [w["id"] for w in listed(api, site, ENG2, assignee="me")] == [second]
    assert [w["id"] for w in listed(api, site, assignee=eng2)] == [second]
    assert [w["id"] for w in listed(api, site, assignee="none")] == [third, first]
    assert [w["id"] for w in listed(api, site, status="acknowledged")] == [second, first]
    assert [w["id"] for w in listed(api, site, status="raised")] == [third]
    assert api.get(f"{path}?assignee=bob", headers=VIEWER).status_code == 422

    # Resolved, with its outcome; then nothing changes it until it is reopened.
    res = api.post(f"{path}/{second}/resolve", json={"outcome": "true_alarm", "note": "Seized"}, headers=ENG2)
    resolved = res.json()
    assert (resolved["status"], resolved["outcome"], resolved["resolved_by"], resolved["resolution_note"]) == (
        "resolved",
        "true_alarm",
        "eng2",
        "Seized",
    )
    assert resolved["assignee"] == "eng2"
    for method, action, body in [
        ("post", "resolve", {"outcome": "false_alarm"}),
        ("post", "acknowledge", {}),
        ("put", "assignee", {"user_id": None}),
    ]:
        res = api.request(method.upper(), f"{path}/{second}/{action}", json=body, headers=ENG)
        assert res.status_code == 409, action
    assert [w["id"] for w in listed(api, site, status="resolved", outcome="true_alarm")] == [second]
    assert [w["id"] for w in listed(api, site, status="unresolved")] == [third, first]
    assert listed(api, site, outcome="false_alarm") == []

    reopened = api.post(f"{path}/{second}/reopen", json={"note": "Came back"}, headers=ENG).json()
    assert (reopened["status"], reopened["outcome"], reopened["resolved_at"], reopened["resolution_note"]) == (
        "acknowledged",
        None,
        None,
        "",
    )
    assert reopened["assignee"] == "eng2"  # still theirs
    assert steps(reopened)[-2:] == [
        ("resolved", "eng2", None, "true_alarm", "Seized"),
        ("reopened", "eng", None, None, "Came back"),
    ]
    res = api.post(f"{path}/{first}/reopen", json={}, headers=ENG)
    assert (res.status_code, res.json()["detail"]) == (409, "This warning is not resolved")
    unassigned = api.put(f"{path}/{second}/assignee", json={"user_id": None}, headers=ENG).json()
    assert (unassigned["assignee"], steps(unassigned)[-1]) == (None, ("unassigned", "eng", None, None, ""))

    # Straight from raised to resolved: acknowledged on the way. Comments go anywhere.
    res = api.post(f"{path}/{third}/comments", json={"note": "Looks like noise"}, headers=ADMIN)
    assert res.status_code == 201
    assert api.post(f"{path}/{third}/comments", json={"note": "  "}, headers=ENG).status_code == 422
    done = api.post(f"{path}/{third}/resolve", json={"outcome": "false_alarm"}, headers=ENG).json()
    assert [a[0] for a in steps(done)] == ["raised", "commented", "acknowledged", "resolved"]
    assert steps(done)[1] == ("commented", "admin", None, None, "Looks like noise")

    detail = api.get(f"{path}/{third}", headers=VIEWER).json()
    assert detail["detector_config"]["window"] == 200 and detail["signal_tag"] == "dc1.friction"
    assert api.get(f"{path}/00000000-0000-0000-0000-000000000000", headers=VIEWER).status_code == 404
    with psycopg.connect(database_url, row_factory=dict_row) as conn:
        actions = [
            r["action"]
            for r in conn.execute(
                "SELECT action FROM audit_log WHERE entity_type = 'warning' AND entity_id = %s ORDER BY id", [second]
            )
        ]
    assert actions == ["warning.assign", "warning.resolve", "warning.reopen", "warning.assign"]


def test_what_is_asked_is_checked(api: TestClient, site: str) -> None:  # noqa: F811
    first, _, _ = raise_warnings(api, site)
    path = f"/sites/{site}/warnings/{first}"
    for action, body in [
        ("resolve", {"outcome": "maybe"}),
        ("resolve", {}),
        ("resolve", {"outcome": "unknown", "note": "x" * 2001}),
        ("acknowledge", {"surprise": 1}),
        ("comments", {}),
    ]:
        assert api.post(f"{path}/{action}", json=body, headers=ENG).status_code == 422, (action, body)
    assert api.get(f"/sites/{site}/warnings?outcome=maybe", headers=VIEWER).status_code == 422
    assert api.get(f"/sites/{site}/warnings?status=new", headers=VIEWER).status_code == 422
    nowhere = "00000000-0000-0000-0000-000000000000"
    assert api.post(f"/sites/{site}/warnings/{nowhere}/acknowledge", json={}, headers=ENG).status_code == 404
    assert api.post(f"{path}/resolve", json={"outcome": "unknown"}, headers=ENG).json()["outcome"] == "unknown"


def test_the_detector_keeps_updating_a_warning_people_are_working_on(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first_shot = FIXTURE["alerts"][0]["firstShot"]
    signal = import_friction(api, site, FIXTURE["values"])
    detector = create(api, site, signal).json()
    run = f"/sites/{site}/detectors/{detector['id']}/run"
    monkeypatch.setattr(detector_job, "batch_size", lambda window: first_shot + 10)  # stops inside the first
    api.post(run, headers=ENG)
    (warning,) = listed(api, site, state="open")
    path = f"/sites/{site}/warnings/{warning['id']}"
    api.put(f"{path}/assignee", json={"user_id": user_id(api, site, ENG)}, headers=ENG)
    api.post(f"{path}/resolve", json={"outcome": "true_alarm"}, headers=ENG)
    monkeypatch.setattr(detector_job, "batch_size", lambda window: 10_000)
    api.post(run, headers=ENG)
    after = api.get(path, headers=VIEWER).json()
    # The signal came back and the peak grew; the people's side is as they left it.
    assert after["ended_at"] is not None and after["peak"] == FIXTURE["alerts"][0]["peak"]
    assert (after["status"], after["outcome"], after["assignee"]) == ("resolved", "true_alarm", "eng")
    assert listed(api, site, state="ended", status="resolved") == [listed(api, site, status="resolved")[0]]
