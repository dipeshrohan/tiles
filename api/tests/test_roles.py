"""Roles v0 (T1.17): viewers read, engineers write, admins also manage members."""

from collections.abc import Iterator
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient

from tiles_api.main import create_app
from tiles_api.seed import seed
from tiles_api.settings import Settings

ENG = {"X-Tiles-User": "eng@example.com"}
VIEWER = {"X-Tiles-User": "viewer@example.com"}
ADMIN = {"X-Tiles-User": "admin@example.com"}
NODE = {"kind": "addNode", "node": {"id": "a", "type": "Line", "label": "A", "props": {}}}


@pytest.fixture(scope="module")
def api(database_url: str) -> Iterator[TestClient]:
    with TestClient(create_app(Settings(_env_file=None, env="test", database_url=database_url))) as client:
        yield client


@pytest.fixture
def site(api: TestClient, database_url: str) -> str:
    with psycopg.connect(database_url) as conn:
        conn.execute("TRUNCATE ontology_nodes, ontology_edges, commits, staged_ops, site_members, users CASCADE")
    site_id = seed(Settings(_env_file=None, database_url=database_url))
    # Everyone joins as an engineer (dev identity); then set the roles we want.
    for who in (ENG, VIEWER, ADMIN):
        api.get(f"/sites/{site_id}/me", headers=who)
    set_role(database_url, site_id, "viewer@example.com", "viewer")
    set_role(database_url, site_id, "admin@example.com", "admin")
    return site_id


def set_role(database_url: str, site: str, email: str, role: str) -> None:
    with psycopg.connect(database_url) as conn:
        conn.execute(
            "UPDATE site_members SET role = %s"
            " WHERE site_id = %s AND user_id = (SELECT id FROM users WHERE email = %s)",
            [role, site, email],
        )


def writes(site: str) -> list[tuple[str, str, Any]]:
    o = f"/sites/{site}/ontology"
    return [
        ("POST", f"{o}/staged", NODE),
        ("POST", f"{o}/staged/batch", [NODE]),
        ("DELETE", f"{o}/staged", None),
        ("POST", f"{o}/commits", {"message": "m"}),
        ("POST", f"{o}/commits/c-1/revert", None),
    ]


def test_viewers_can_read_but_every_write_is_refused(api: TestClient, site: str) -> None:
    for method, path, body in writes(site):
        res = api.request(method, path, json=body, headers=VIEWER)
        assert res.status_code == 403, path
        assert res.json()["detail"] == "Your role on this site is viewer; this needs engineer or above"
    o = f"/sites/{site}/ontology"
    for path in (f"{o}/graph", f"{o}/graph?view=head", f"{o}/staged", f"{o}/commits", f"{o}/health"):
        assert api.get(path, headers=VIEWER).status_code == 200, path


def test_engineers_can_write(api: TestClient, site: str) -> None:
    o = f"/sites/{site}/ontology"
    assert api.post(f"{o}/staged", json=NODE, headers=ENG).status_code == 201
    assert api.post(f"{o}/commits", json={"message": "add a"}, headers=ENG).status_code == 201


def test_my_role_and_the_member_list(api: TestClient, site: str, database_url: str) -> None:
    me = api.get(f"/sites/{site}/me", headers=VIEWER).json()
    assert (me["email"], me["role"], me["site_role"], me["org_admin"]) == (
        "viewer@example.com",
        "viewer",
        "viewer",
        False,
    )
    members = api.get(f"/sites/{site}/members", headers=VIEWER).json()
    assert [(m["email"], m["role"]) for m in members] == [
        ("admin@example.com", "admin"),
        ("eng@example.com", "engineer"),
        ("viewer@example.com", "viewer"),
    ]
    # Organisation admins are admins on every site, whatever their site role.
    with psycopg.connect(database_url) as conn:
        conn.execute("UPDATE users SET org_admin = true WHERE email = 'viewer@example.com'")
    me = api.get(f"/sites/{site}/me", headers=VIEWER).json()
    assert (me["role"], me["site_role"]) == ("admin", "viewer")
    assert api.post(f"/sites/{site}/ontology/staged", json=NODE, headers=VIEWER).status_code == 201


def test_admins_change_roles_and_the_change_applies_at_once(api: TestClient, site: str) -> None:
    members = {m["email"]: m["user_id"] for m in api.get(f"/sites/{site}/members", headers=ADMIN).json()}
    url = f"/sites/{site}/members/{members['eng@example.com']}"
    res = api.put(url, json={"role": "viewer"}, headers=ADMIN)
    assert (res.status_code, res.json()["role"]) == (200, "viewer")
    assert api.post(f"/sites/{site}/ontology/staged", json=NODE, headers=ENG).status_code == 403
    api.put(url, json={"role": "engineer"}, headers=ADMIN)
    assert api.post(f"/sites/{site}/ontology/staged", json=NODE, headers=ENG).status_code == 201


def test_role_changes_are_guarded(api: TestClient, site: str) -> None:
    members = {m["email"]: m["user_id"] for m in api.get(f"/sites/{site}/members", headers=ADMIN).json()}
    viewer_url = f"/sites/{site}/members/{members['viewer@example.com']}"
    assert api.put(viewer_url, json={"role": "admin"}, headers=ENG).status_code == 403  # not an admin
    own = f"/sites/{site}/members/{members['admin@example.com']}"
    assert api.put(own, json={"role": "viewer"}, headers=ADMIN).status_code == 409
    stranger = f"/sites/{site}/members/00000000-0000-0000-0000-000000000000"
    assert api.put(stranger, json={"role": "viewer"}, headers=ADMIN).status_code == 404
    assert api.put(viewer_url, json={"role": "owner"}, headers=ADMIN).status_code == 422
