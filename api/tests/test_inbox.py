"""The notification centre (U5.07): what waits for each person, read marks, and nothing stale."""

from typing import Any

import psycopg
from fastapi.testclient import TestClient
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_datasets import upload
from test_insights import CORRELATION, save
from test_reviews import ENG2, NODE, ask, member, stage
from test_warnings import raise_warnings, user_id


def inbox(api: TestClient, site: str, who: dict[str, str]) -> dict[str, Any]:  # noqa: F811
    res = api.get(f"/sites/{site}/inbox", headers=who)
    assert res.status_code == 200, res.text
    return dict(res.json())


def kinds(box: dict[str, Any]) -> list[tuple[str, str]]:
    return [(i["kind"], i["title"]) for i in box["items"]]


def test_what_waits_for_each_person_comes_and_goes(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    member(api, site, ENG2)
    first, second, _third = raise_warnings(api, site)
    eng2 = user_id(api, site, ENG2)
    eng = user_id(api, site, ENG)
    warnings = f"/sites/{site}/warnings"
    assert inbox(api, site, ENG2) == {"items": [], "unread": 0}

    # Assigned by someone else: in their inbox, unread. Assigned to oneself: not news.
    api.put(f"{warnings}/{first}/assignee", json={"user_id": eng2}, headers=ENG)
    api.put(f"{warnings}/{second}/assignee", json={"user_id": eng}, headers=ENG)
    box = inbox(api, site, ENG2)
    assert box["unread"] == 1
    [item] = box["items"]
    assert (item["kind"], item["read"], item["href"]) == ("warning", False, f"#/warnings?show=all&warning={first}")
    assert item["title"].endswith("assigned to you") and item["detail"].startswith("By eng")
    assert inbox(api, site, ENG)["items"] == []

    # A change request asked of them, and an insight waiting for another engineer.
    stage(api, site, {"kind": "addNode", "node": NODE})
    review = ask(api, site, message="Add press 9", reviewer_id=eng2)
    save(api, site, CORRELATION | {"dataset_id": upload(api, site)})
    box = inbox(api, site, ENG2)
    assert sorted(i["kind"] for i in box["items"]) == ["insight", "review", "warning"]
    assert box["unread"] == 3
    [r] = [i for i in box["items"] if i["kind"] == "review"]
    assert (r["href"], r["detail"]) == (f"#/reviews/{review['number']}", "Add press 9 (from eng)")
    # Not for its author, nor for a viewer; an admin may review the insight (the request is eng2's).
    assert inbox(api, site, ENG)["items"] == []
    assert inbox(api, site, VIEWER)["items"] == []
    assert [i["kind"] for i in inbox(api, site, ADMIN)["items"]] == ["insight"]

    # Read one, then all; a key not in the inbox is ignored.
    res = api.post(f"/sites/{site}/inbox/read", json={"keys": [r["key"], "warning:nope"]}, headers=ENG2)
    assert res.status_code == 200, res.text
    assert res.json()["unread"] == 2
    assert inbox(api, site, ENG2)["unread"] == 2
    assert api.post(f"/sites/{site}/inbox/read", json={"keys": []}, headers=ENG2).json()["unread"] == 0
    assert inbox(api, site, ADMIN)["unread"] == 1  # each person's own

    # Resolved, decided: gone. Assigned again: news again.
    api.post(f"{warnings}/{first}/resolve", json={"outcome": "true_alarm"}, headers=ENG2)
    api.post(f"/sites/{site}/ontology/reviews/{review['number']}/approve", json={}, headers=ENG2)
    assert [i["kind"] for i in inbox(api, site, ENG2)["items"]] == ["insight"]
    api.post(f"{warnings}/{first}/reopen", json={}, headers=ENG)
    api.put(f"{warnings}/{first}/assignee", json={"user_id": eng}, headers=ENG)
    api.put(f"{warnings}/{first}/assignee", json={"user_id": eng2}, headers=ENG)
    box = inbox(api, site, ENG2)
    assert [(i["kind"], i["read"]) for i in box["items"] if i["kind"] == "warning"] == [("warning", False)]

    with psycopg.connect(database_url) as conn:
        actions = conn.execute(
            "SELECT count(*) FROM audit_log WHERE site_id = %s AND action = 'inbox.read'", [site]
        ).fetchone()
    assert actions == (2,)


def test_an_import_that_never_finished_is_news_to_whoever_started_it(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    imp = api.post(f"/sites/{site}/imports", json={"name": "line2.csv"}, headers=ENG).json()
    assert inbox(api, site, ENG)["items"] == []  # still going
    with psycopg.connect(database_url) as conn:
        conn.execute("UPDATE imports SET created_at = now() - interval '2 hours' WHERE id = %s", [imp["id"]])
    assert kinds(inbox(api, site, ENG)) == [("import", "Import of line2.csv did not finish")]
    assert inbox(api, site, ADMIN)["items"] == []
    with psycopg.connect(database_url) as conn:
        conn.execute("UPDATE imports SET created_at = now() - interval '8 days' WHERE id = %s", [imp["id"]])
    assert inbox(api, site, ENG)["items"] == []  # too old to be news


def test_marks_are_keys_the_inbox_names(api: TestClient, site: str) -> None:  # noqa: F811
    path = f"/sites/{site}/inbox/read"
    for bad in ({"keys": [""]}, {"keys": ["x" * 121]}, {"keys": [f"k{n}" for n in range(51)]}, {}):
        assert api.post(path, json=bad, headers=ENG).status_code == 422, bad


def test_the_bell_and_the_menu_count_the_same_reviews(api: TestClient, site: str) -> None:  # noqa: F811
    member(api, site, ENG2)
    stage(api, site, {"kind": "addNode", "node": NODE})
    ask(api, site, message="Add press 9")
    for who in (ENG, ENG2, ADMIN, VIEWER):
        menu = api.get(f"/sites/{site}/menu-counts", headers=who).json()["reviews_waiting"]
        bell = [i for i in inbox(api, site, who)["items"] if i["kind"] == "review"]
        assert len(bell) == menu, who


def test_a_reopened_insight_is_news_again_and_old_marks_of_waiting_items_stay(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    member(api, site, ENG2)
    number = save(api, site, CORRELATION | {"dataset_id": upload(api, site)}).json()["number"]
    api.post(f"/sites/{site}/inbox/read", json={"keys": []}, headers=ENG2)
    # A mark kept long (the insight still waiting) stays when marks are tidied.
    with psycopg.connect(database_url) as conn:
        conn.execute("UPDATE inbox_reads SET read_at = now() - interval '100 days' WHERE site_id = %s", [site])
    api.post(f"/sites/{site}/inbox/read", json={"keys": []}, headers=ENG2)
    assert inbox(api, site, ENG2)["unread"] == 0
    # Rejected, reworked and reopened: waiting again, so unread again.
    res = api.post(
        f"/sites/{site}/insights/{number}/review", json={"decision": "rejected", "note": "Which batches?"}, headers=ENG2
    )
    assert res.status_code == 200, res.text
    assert inbox(api, site, ENG2)["items"] == []  # decided: not waiting
    assert api.post(f"/sites/{site}/insights/{number}/reopen", json={}, headers=ENG).status_code == 200
    box = inbox(api, site, ENG2)
    assert [(i["kind"], i["read"]) for i in box["items"]] == [("insight", False)]
