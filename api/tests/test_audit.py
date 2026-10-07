"""Audit log (T1.18): every write recorded with who, what, when and before/after."""

from collections.abc import Iterator
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
