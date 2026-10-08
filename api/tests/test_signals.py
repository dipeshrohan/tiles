"""Signal catalogue (T2.08): browse and search the site's signals, describe them and link them to the ontology."""

import threading
import time
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures

T0 = datetime(2026, 9, 1, 6, 0, tzinfo=UTC)


def backfill(api: TestClient, site: str, readings: dict[str, list[Any]]) -> None:  # noqa: F811
    imp = api.post(f"/sites/{site}/imports", json={"name": "plant.csv"}, headers=ENG).json()
    samples = [
        {"signal": tag, "at": (T0 + timedelta(minutes=i)).isoformat(), "value": v}
        for tag, values in readings.items()
        for i, v in enumerate(values)
    ]
    res = api.post(f"/sites/{site}/imports/{imp['id']}/samples", json={"samples": samples}, headers=ENG)
    assert res.status_code == 200, res.text


def commit_nodes(api: TestClient, site: str, *nodes: dict[str, Any]) -> None:  # noqa: F811
    base = f"/sites/{site}/ontology"
    for node in nodes:
        assert api.post(f"{base}/staged", json={"kind": "addNode", "node": node}, headers=ENG).status_code == 201
    assert api.post(f"{base}/commits", json={"message": "add nodes"}, headers=ENG).status_code == 201


def signals(api: TestClient, site: str, **query: str) -> dict[str, Any]:  # noqa: F811
    res = api.get(f"/sites/{site}/signals", params=query, headers=VIEWER)
    assert res.status_code == 200, res.text
    page: dict[str, Any] = res.json()
    return page


def by_tag(api: TestClient, site: str, tag: str) -> dict[str, Any]:  # noqa: F811
    found: list[dict[str, Any]] = [s for s in signals(api, site, q=tag)["signals"] if s["tag"] == tag]
    assert len(found) == 1
    return found[0]


def test_signals_are_listed_with_their_latest_reading(api: TestClient, site: str) -> None:  # noqa: F811
    backfill(api, site, {"press1.temperature": [20.5, 21.0], "press1.state": ["running"], "oven.temp": [180.0]})
    page = signals(api, site)
    assert page["total"] == 3
    assert [s["tag"] for s in page["signals"]] == ["oven.temp", "press1.state", "press1.temperature"]
    temp = page["signals"][2]
    assert (temp["source"], temp["unit"], temp["node_id"], temp["node_label"]) == ("import:plant.csv", None, None, None)
    assert (temp["last_value"], temp["last_at"]) == (
        21.0,
        (T0 + timedelta(minutes=1)).isoformat().replace("+00:00", "Z"),
    )
    assert page["signals"][1]["last_value"] == "running"


def test_search_and_filters(api: TestClient, site: str) -> None:  # noqa: F811
    backfill(api, site, {"press1.temperature": [1.0], "press1.force": [2.0], "oven.temp": [3.0]})
    assert [s["tag"] for s in signals(api, site, q="PRESS1")["signals"]] == ["press1.force", "press1.temperature"]
    assert signals(api, site, q="%")["total"] == 0  # searched for literally, not as a wildcard
    assert signals(api, site, source="import")["total"] == 3
    assert signals(api, site, source="edge")["total"] == 0
    assert signals(api, site, linked="no")["total"] == 3
    paged = signals(api, site, limit="2", offset="2")
    assert (paged["total"], [s["tag"] for s in paged["signals"]]) == (3, ["press1.temperature"])
    assert signals(api, site, offset="5") == {"total": 3, "signals": []}  # past the end, still counted
    assert signals(api, site, q="nothing") == {"total": 0, "signals": []}
    assert api.get(f"/sites/{site}/signals", params={"source": "other"}, headers=VIEWER).status_code == 422
    assert api.get(f"/sites/{site}/signals", params={"q": "press\x00"}, headers=VIEWER).status_code == 422


def test_engineers_describe_signals_and_each_change_is_audited(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    backfill(api, site, {"press1.temperature": [1.0]})
    sig = by_tag(api, site, "press1.temperature")
    path = f"/sites/{site}/signals/{sig['id']}"
    change = {"unit": "°C", "sample_rate_hz": 10, "description": "Platen temperature, upper"}
    assert api.patch(path, json=change, headers=VIEWER).status_code == 403
    res = api.patch(path, json=change, headers=ENG)
    assert res.status_code == 200, res.text
    assert {k: res.json()[k] for k in change} == {
        "unit": "°C",
        "sample_rate_hz": 10.0,
        "description": change["description"],
    }
    # Only what is given changes; null clears.
    cleared = api.patch(path, json={"unit": None}, headers=ENG).json()
    assert (cleared["unit"], cleared["sample_rate_hz"]) == (None, 10.0)
    assert signals(api, site, q="platen")["total"] == 1  # descriptions are searched too
    nul = ({"unit": "a\x00"}, {"description": "a\x00b"}, {"node_id": "sig\x00"})  # PostgreSQL text can't hold NUL
    booleans = ({"sample_rate_hz": True}, {"unit": True}, {"description": False})  # not 1.0, nor "True"
    for bad in ({"sample_rate_hz": 0}, {"unit": "x" * 41}, {"tag": "renamed"}, *nul, *booleans):
        assert api.patch(path, json=bad, headers=ENG).status_code == 422, bad
    assert (
        api.patch(f"/sites/{site}/signals/00000000-0000-0000-0000-000000000000", json={}, headers=ENG).status_code
        == 404
    )
    # Setting a field to the value it has changes nothing, and leaves no audit entry.
    assert (
        api.patch(path, json={"sample_rate_hz": 10, "description": change["description"]}, headers=ENG).status_code
        == 200
    )
    with psycopg.connect(database_url) as conn:
        audit = conn.execute(
            "SELECT before, after FROM audit_log WHERE action = 'signal.update' AND entity_id = %s ORDER BY id",
            [sig["id"]],
        ).fetchall()
    assert audit[0][1] == {"tag": "press1.temperature", **change}
    assert audit[1] == ({"tag": "press1.temperature", "unit": "°C"}, {"tag": "press1.temperature", "unit": None})
    assert len(audit) == 2  # the no-op change left none


def test_a_signal_links_to_one_signal_node_of_the_ontology(api: TestClient, site: str) -> None:  # noqa: F811
    backfill(api, site, {"press1.temperature": [1.0], "press1.temp2": [2.0]})
    commit_nodes(
        api,
        site,
        {"id": "sig-p1-temp", "type": "Signal", "label": "Press 1 temperature", "props": {"unit": "°C"}},
        {"id": "press-1", "type": "Machine", "label": "Press 1", "props": {}},
    )
    first, second = by_tag(api, site, "press1.temperature"), by_tag(api, site, "press1.temp2")
    linked = api.patch(f"/sites/{site}/signals/{first['id']}", json={"node_id": "sig-p1-temp"}, headers=ENG)
    assert (linked.json()["node_id"], linked.json()["node_label"]) == ("sig-p1-temp", "Press 1 temperature")
    assert [s["tag"] for s in signals(api, site, linked="yes")["signals"]] == ["press1.temperature"]
    assert signals(api, site, q="press 1 temp")["total"] == 1  # the node's label is searched too

    clash = api.patch(f"/sites/{site}/signals/{second['id']}", json={"node_id": "sig-p1-temp"}, headers=ENG)
    assert (clash.status_code, clash.json()["detail"]) == (409, "sig-p1-temp is already linked to press1.temperature")
    for node in ("press-1", "nowhere"):  # a Machine, and no node at all
        res = api.patch(f"/sites/{site}/signals/{second['id']}", json={"node_id": node}, headers=ENG)
        assert res.status_code == 422 and "not a Signal node of the committed ontology" in res.json()["detail"], node

    # The node is removed from the ontology later: the link stays, without a label.
    assert (
        api.post(
            f"/sites/{site}/ontology/staged", json={"kind": "removeNode", "id": "sig-p1-temp"}, headers=ENG
        ).status_code
        == 201
    )
    assert api.post(f"/sites/{site}/ontology/commits", json={"message": "remove"}, headers=ENG).status_code == 201
    gone = by_tag(api, site, "press1.temperature")
    assert (gone["node_id"], gone["node_label"]) == ("sig-p1-temp", None)
    # A node of another type that takes the same id later is not a valid link either.
    commit_nodes(api, site, {"id": "sig-p1-temp", "type": "Machine", "label": "Press 1 again", "props": {}})
    assert by_tag(api, site, "press1.temperature")["node_label"] is None
    assert signals(api, site, q="press 1 again")["total"] == 0
    unlinked = api.patch(f"/sites/{site}/signals/{first['id']}", json={"node_id": None}, headers=ENG).json()
    assert unlinked["node_id"] is None


def test_concurrent_edits_audit_what_each_replaced(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    backfill(api, site, {"press1.temperature": [1.0]})
    sig = by_tag(api, site, "press1.temperature")
    answers: list[int] = []
    with psycopg.connect(database_url) as other:
        # Another edit holds the row and has not committed yet.
        other.execute("UPDATE signals SET unit = 'K' WHERE id = %s", [sig["id"]])
        patch = threading.Thread(
            target=lambda: answers.append(
                api.patch(f"/sites/{site}/signals/{sig['id']}", json={"unit": "°C"}, headers=ENG).status_code
            )
        )
        patch.start()
        time.sleep(0.3)  # the PATCH waits for the row
        other.commit()
        patch.join(10)
    assert answers == [200]
    with psycopg.connect(database_url) as conn:
        before = conn.execute(
            "SELECT before FROM audit_log WHERE action = 'signal.update' AND entity_id = %s", [sig["id"]]
        ).fetchone()
    assert before == ({"tag": "press1.temperature", "unit": "K"},)  # not the value before the other edit


def test_a_link_waits_for_an_ontology_commit_in_progress(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    backfill(api, site, {"press1.temperature": [1.0]})
    commit_nodes(api, site, {"id": "sig-p1", "type": "Signal", "label": "Press 1", "props": {"unit": "°C"}})
    sig = by_tag(api, site, "press1.temperature")
    answers: list[int] = []
    with psycopg.connect(database_url) as other:
        # A commit removing the node holds the site, as ontology commits do, and has not committed yet.
        other.execute("SELECT 1 FROM sites WHERE id = %s FOR UPDATE", [site])
        other.execute("DELETE FROM ontology_nodes WHERE site_id = %s AND id = 'sig-p1'", [site])
        patch = threading.Thread(
            target=lambda: answers.append(
                api.patch(f"/sites/{site}/signals/{sig['id']}", json={"node_id": "sig-p1"}, headers=ENG).status_code
            )
        )
        patch.start()
        time.sleep(0.3)  # the PATCH waits for the commit
        other.commit()
        patch.join(10)
    assert answers == [422]  # the node is gone: no link to it
    assert by_tag(api, site, "press1.temperature")["node_id"] is None
