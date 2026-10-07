"""Audit log (T1.18): every write recorded with who, what, when and before/after."""

import threading
import time
from collections.abc import Callable, Iterator
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from tiles_api.main import create_app
from tiles_api.seed import seed
from tiles_api.settings import Settings

ENG = {"X-Tiles-User": "eng@example.com"}
ADMIN = {"X-Tiles-User": "admin@example.com"}


def node(i: str) -> dict[str, Any]:
    return {"kind": "addNode", "node": {"id": i, "type": "Line", "label": i, "props": {}}}


@pytest.fixture(scope="module")
def api(database_url: str) -> Iterator[TestClient]:
    with TestClient(create_app(Settings(_env_file=None, env="test", database_url=database_url))) as client:
        yield client


@pytest.fixture
def site(api: TestClient, database_url: str) -> str:
    with psycopg.connect(database_url) as conn:
        conn.execute("TRUNCATE ontology_nodes, ontology_edges, commits, staged_ops, site_members, users CASCADE")
        # audit_log refuses TRUNCATE; give each test a fresh site instead.
        conn.execute("UPDATE sites SET slug = 'old-' || left(md5(random()::text), 8) WHERE slug = 'plant-1'")
    site_id = seed(Settings(_env_file=None, database_url=database_url))
    for who in (ENG, ADMIN):
        api.get(f"/sites/{site_id}/me", headers=who)
    with psycopg.connect(database_url) as conn:
        conn.execute(
            "UPDATE site_members SET role = 'admin' WHERE site_id = %s"
            " AND user_id = (SELECT id FROM users WHERE email = 'admin@example.com')",
            [site_id],
        )
    return site_id


def log(api: TestClient, site: str) -> list[dict[str, Any]]:
    res = api.get(f"/sites/{site}/audit", headers=ADMIN)
    assert res.status_code == 200
    entries: list[dict[str, Any]] = res.json()
    return entries


def test_every_ontology_write_is_recorded(api: TestClient, site: str) -> None:
    o = f"/sites/{site}/ontology"
    api.post(f"{o}/staged", json=node("a"), headers={**ENG, "X-Request-ID": "req-stage"})
    api.post(f"{o}/staged/batch", json=[node("b"), node("c")], headers=ENG)
    commit = api.post(f"{o}/commits", json={"message": "three lines"}, headers=ENG).json()
    revert = api.post(f"{o}/commits/{commit['id']}/revert", headers=ENG).json()
    api.post(f"{o}/staged", json=node("d"), headers=ENG)
    api.delete(f"{o}/staged", headers=ENG)

    entries = log(api, site)
    assert [e["action"] for e in entries] == [
        "ontology.discard",
        "ontology.stage",
        "ontology.revert",
        "ontology.commit",
        "ontology.stage",
        "ontology.stage",
    ]
    assert {e["actor_name"] for e in entries} == {"eng"}
    discard, _, rev, com, batch, first = entries
    assert first["after"] == {"ops": [node("a")]}
    assert first["request_id"] == "req-stage"
    assert [op["node"]["id"] for op in batch["after"]["ops"]] == ["b", "c"]
    assert (com["entity_type"], com["entity_id"], com["after"]["message"]) == ("commit", commit["id"], "three lines")
    assert com["after"]["stats"] == {"nodes": 3, "edges": 0, "props": 0}
    assert rev["before"] == {"reverted": commit["id"]}
    assert rev["entity_id"] == revert["id"]
    assert discard["before"] == {"ops": [node("d")]}
    assert discard["after"] is None


def test_failed_and_empty_writes_leave_no_entry(api: TestClient, site: str) -> None:
    o = f"/sites/{site}/ontology"
    api.post(f"{o}/staged", json=node("a"), headers=ENG)
    assert api.post(f"{o}/staged", json=node("a"), headers=ENG).status_code == 409  # duplicate
    assert api.post(f"{o}/staged/batch", json=[node("x"), node("x")], headers=ENG).status_code == 409
    assert api.post(f"{o}/commits/nope/revert", headers=ENG).status_code == 404
    api.delete(f"{o}/staged", headers=ADMIN)  # admin has nothing staged: nothing to record
    assert [e["action"] for e in log(api, site)] == ["ontology.stage"]


def test_role_changes_are_recorded(api: TestClient, site: str) -> None:
    eng_id = next(m["user_id"] for m in api.get(f"/sites/{site}/members", headers=ADMIN).json() if m["name"] == "eng")
    api.put(f"/sites/{site}/members/{eng_id}", json={"role": "viewer"}, headers=ADMIN)
    api.put(f"/sites/{site}/members/{eng_id}", json={"role": "viewer"}, headers=ADMIN)  # no change: not recorded
    [entry] = log(api, site)
    assert (entry["action"], entry["entity_id"], entry["actor_name"]) == ("member.role", eng_id, "admin")
    assert (entry["before"], entry["after"]) == ({"role": "engineer"}, {"role": "viewer"})


def test_only_admins_read_the_log(api: TestClient, site: str) -> None:
    assert api.get(f"/sites/{site}/audit", headers=ENG).status_code == 403
    api.post(f"/sites/{site}/ontology/staged", json=node("a"), headers=ENG)
    api.post(f"/sites/{site}/ontology/staged", json=node("b"), headers=ENG)
    page = api.get(f"/sites/{site}/audit?limit=1&offset=1", headers=ADMIN).json()
    assert [e["after"]["ops"][0]["node"]["id"] for e in page] == ["a"]


def while_locked(
    database_url: str, lock_sql: str, args: list[Any], request: Callable[[], Any], change: Callable[[Any], Any]
) -> Any:
    """Holds a row lock in another transaction, starts `request` in a thread,
    waits until it blocks on that lock, makes `change` and commits. Returns the
    request's response: what a concurrent writer that got there first leaves behind."""
    result: list[Any] = []
    # pg_stat_activity is a snapshot per transaction, so it is watched from its own autocommit connection.
    with psycopg.connect(database_url) as conn, psycopg.connect(database_url, autocommit=True) as watch:
        conn.execute(lock_sql, args)
        thread = threading.Thread(target=lambda: result.append(request()))
        thread.start()
        deadline = time.monotonic() + 10
        while not watch.execute(
            "SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()"
        ).fetchone():
            assert time.monotonic() < deadline, "the request never waited for the lock"
            time.sleep(0.02)
        change(conn)
    thread.join(10)
    return result[0]


def test_a_discard_records_only_what_it_dropped(api: TestClient, site: str, database_url: str) -> None:
    o = f"/sites/{site}/ontology"
    api.post(f"{o}/staged", json=node("a"), headers=ENG)
    # Another discard of the same ops holds the site lock and commits first.
    res = while_locked(
        database_url,
        "SELECT 1 FROM sites WHERE id = %s FOR UPDATE",
        [site],
        lambda: api.delete(f"{o}/staged", headers=ENG),
        lambda conn: conn.execute("DELETE FROM staged_ops WHERE site_id = %s", [site]),
    )
    assert res.status_code == 204
    assert [e["action"] for e in log(api, site)] == ["ontology.stage"]  # this request dropped nothing


def test_a_role_change_records_the_role_it_replaced(api: TestClient, site: str, database_url: str) -> None:
    eng_id = next(m["user_id"] for m in api.get(f"/sites/{site}/members", headers=ADMIN).json() if m["name"] == "eng")
    member = "SELECT 1 FROM site_members WHERE site_id = %s AND user_id = %s FOR UPDATE"
    # Another admin's identical change holds the member row and commits first.
    res = while_locked(
        database_url,
        member,
        [site, eng_id],
        lambda: api.put(f"/sites/{site}/members/{eng_id}", json={"role": "viewer"}, headers=ADMIN),
        lambda conn: conn.execute(
            "UPDATE site_members SET role = 'viewer' WHERE site_id = %s AND user_id = %s", [site, eng_id]
        ),
    )
    assert res.json()["role"] == "viewer"
    assert log(api, site) == []  # it changed nothing, so it records nothing


def test_entries_are_stamped_when_written_not_when_the_transaction_began(
    api: TestClient, site: str, database_url: str
) -> None:
    with psycopg.connect(database_url) as conn:
        before = conn.execute("SELECT clock_timestamp()").fetchone()
    assert before is not None
    # The request starts its transaction, then waits 0.3 s for the site lock before it writes.
    while_locked(
        database_url,
        "SELECT 1 FROM sites WHERE id = %s FOR UPDATE",
        [site],
        lambda: api.post(f"/sites/{site}/ontology/staged", json=node("a"), headers=ENG),
        lambda conn: conn.execute("SELECT pg_sleep(0.3)"),
    )
    [entry] = log(api, site)
    with psycopg.connect(database_url) as conn:
        row = conn.execute("SELECT at FROM audit_log WHERE id = %s", [entry["id"]]).fetchone()
    assert row is not None
    assert (row[0] - before[0]).total_seconds() >= 0.3


def test_the_audit_query_uses_the_site_time_index(site: str, database_url: str) -> None:
    with psycopg.connect(database_url) as conn:
        conn.execute("SET enable_seqscan = off")
        conn.execute("SET enable_bitmapscan = off")
        plan = "\n".join(
            r[0]
            for r in conn.execute(
                "EXPLAIN SELECT id FROM audit_log WHERE site_id = %s ORDER BY at DESC, id DESC LIMIT 50", [site]
            )
        )
    assert "audit_log_site_time" in plan, plan
