"""Edge agents (T2.01): registration, heartbeats with an agent token, revocation."""

from collections.abc import Iterator
from datetime import UTC, datetime
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


def beat(**extra: Any) -> dict[str, Any]:
    return {
        "version": "0.1.0",
        "hostname": "edge-01",
        "started_at": datetime(2026, 10, 7, 12, 0, tzinfo=UTC).isoformat(),
        "heartbeat_seconds": 30,
        "connectors": [],
        **extra,
    }


def agent_auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="module")
def api(database_url: str) -> Iterator[TestClient]:
    with TestClient(create_app(Settings(_env_file=None, env="test", database_url=database_url))) as client:
        yield client


@pytest.fixture
def site(api: TestClient, database_url: str) -> str:
    with psycopg.connect(database_url) as conn:
        conn.execute("TRUNCATE edge_agents, site_members, users CASCADE")
        # audit_log refuses TRUNCATE; give each test a fresh site instead.
        conn.execute("UPDATE sites SET slug = 'old-' || left(md5(random()::text), 8) WHERE slug = 'plant-1'")
    site_id = seed(Settings(_env_file=None, database_url=database_url))
    for who in (ENG, VIEWER, ADMIN):
        api.get(f"/sites/{site_id}/me", headers=who)
    with psycopg.connect(database_url) as conn:
        for email, role in (("viewer@example.com", "viewer"), ("admin@example.com", "admin")):
            conn.execute(
                "UPDATE site_members SET role = %s"
                " WHERE site_id = %s AND user_id = (SELECT id FROM users WHERE email = %s)",
                [role, site_id, email],
            )
    return site_id


def register(api: TestClient, site: str, name: str = "edge-01") -> dict[str, Any]:
    res = api.post(f"/sites/{site}/agents", json={"name": name}, headers=ADMIN)
    assert res.status_code == 201, res.text
    body: dict[str, Any] = res.json()
    return body


def test_an_admin_registers_an_agent_and_its_heartbeat_marks_it_online(api: TestClient, site: str) -> None:
    new = register(api, site)
    assert new["token"].startswith("tla_") and len(new["token"]) > 40
    assert (new["agent"]["name"], new["agent"]["status"]) == ("edge-01", "never seen")

    connectors = [{"name": "press-opcua", "kind": "opcua", "status": "ok", "detail": ""}]
    res = api.post("/agent/heartbeat", json=beat(connectors=connectors), headers=agent_auth(new["token"]))
    assert res.status_code == 200, res.text
    answer = res.json()
    assert (answer["agent_id"], answer["site_id"], answer["commands"]) == (new["agent"]["id"], site, [])

    [agent] = api.get(f"/sites/{site}/agents", headers=VIEWER).json()  # every member can see them
    assert (agent["status"], agent["version"], agent["hostname"]) == ("online", "0.1.0", "edge-01")
    assert agent["connectors"] == connectors
    assert agent["buffer"] is None  # an agent without a buffer, e.g. `check`


def test_a_heartbeat_carries_the_buffer_status(api: TestClient, site: str) -> None:
    token = register(api, site)["token"]
    buffer = {
        "queued": 1200,
        "oldest_at": "2026-10-07T08:00:00+00:00",
        "sent": 50,
        "dropped": 0,
        "rejected": 2,
        "problem": "can't reach Tiles: Connection refused",
    }
    assert api.post("/agent/heartbeat", json=beat(buffer=buffer), headers=agent_auth(token)).status_code == 200
    [agent] = api.get(f"/sites/{site}/agents", headers=VIEWER).json()
    assert agent["buffer"] == {**buffer, "oldest_at": "2026-10-07T08:00:00Z"}


def test_only_the_token_hash_is_stored(api: TestClient, site: str, database_url: str) -> None:
    token = register(api, site)["token"]
    with psycopg.connect(database_url) as conn:
        dump = conn.execute("SELECT row_to_json(a)::text FROM edge_agents a").fetchone()
        log = conn.execute("SELECT coalesce(string_agg(row_to_json(l)::text, ''), '') FROM audit_log l").fetchone()
    assert dump is not None and log is not None
    assert token not in dump[0] and token not in log[0]


def test_an_agent_is_offline_after_missing_three_heartbeats(api: TestClient, site: str, database_url: str) -> None:
    new = register(api, site)
    api.post("/agent/heartbeat", json=beat(heartbeat_seconds=10), headers=agent_auth(new["token"]))
    with psycopg.connect(database_url) as conn:
        conn.execute("UPDATE edge_agents SET last_seen_at = clock_timestamp() - interval '29 seconds'")
    assert api.get(f"/sites/{site}/agents", headers=ENG).json()[0]["status"] == "online"
    with psycopg.connect(database_url) as conn:
        conn.execute("UPDATE edge_agents SET last_seen_at = clock_timestamp() - interval '31 seconds'")
    assert api.get(f"/sites/{site}/agents", headers=ENG).json()[0]["status"] == "offline"


def test_heartbeats_need_a_valid_agent_token(api: TestClient, site: str) -> None:
    register(api, site)
    for headers in ({}, agent_auth("tla_not-a-real-token"), agent_auth("eyJhbGciOi.user.jwt"), {"Authorization": "x"}):
        res = api.post("/agent/heartbeat", json=beat(), headers=headers)
        assert res.status_code == 401, headers
        assert res.headers["www-authenticate"] == "Bearer"
    # A user's identity is no agent token.
    assert api.post("/agent/heartbeat", json=beat(), headers=ADMIN).status_code == 401


def test_heartbeats_are_validated(api: TestClient, site: str) -> None:
    token = register(api, site)["token"]
    for bad in (
        beat(heartbeat_seconds=0),
        beat(connectors=[{"name": "x", "kind": "opcua", "status": "on fire"}]),
        beat(surprise=True),
        beat(buffer={"queued": -1}),
        beat(buffer={"queued": 1, "problem": "x" * 301}),
        beat(buffer={"queued": 1, "surprise": True}),
        {"version": "0.1.0"},
    ):
        assert api.post("/agent/heartbeat", json=bad, headers=agent_auth(token)).status_code == 422, bad


def test_only_admins_register_and_revoke(api: TestClient, site: str) -> None:
    for who in (ENG, VIEWER):
        assert api.post(f"/sites/{site}/agents", json={"name": "edge-01"}, headers=who).status_code == 403
    agent_id = register(api, site)["agent"]["id"]
    assert api.delete(f"/sites/{site}/agents/{agent_id}", headers=ENG).status_code == 403


def test_names_are_checked_and_unique_per_site(api: TestClient, site: str) -> None:
    for name in ("", "-starts-with-dash", "has space", "x" * 64, "slash/no"):
        assert api.post(f"/sites/{site}/agents", json={"name": name}, headers=ADMIN).status_code == 422, name
    register(api, site, "edge-01")
    res = api.post(f"/sites/{site}/agents", json={"name": "edge-01"}, headers=ADMIN)
    assert (res.status_code, res.json()["detail"]) == (409, "An agent named edge-01 already exists")
    register(api, site, "edge-02")  # the request after a conflict still works


def test_a_revoked_agent_is_locked_out_and_its_name_is_free_again(api: TestClient, site: str) -> None:
    new = register(api, site)
    agent_id, token = new["agent"]["id"], new["token"]
    assert api.delete(f"/sites/{site}/agents/{agent_id}", headers=ADMIN).status_code == 204
    assert api.post("/agent/heartbeat", json=beat(), headers=agent_auth(token)).status_code == 401
    assert api.get(f"/sites/{site}/agents", headers=ADMIN).json() == []
    assert api.delete(f"/sites/{site}/agents/{agent_id}", headers=ADMIN).status_code == 404
    register(api, site)  # same name, new agent


def test_registering_and_revoking_are_audited(api: TestClient, site: str) -> None:
    agent_id = register(api, site)["agent"]["id"]
    api.delete(f"/sites/{site}/agents/{agent_id}", headers=ADMIN)
    entries = api.get(f"/sites/{site}/audit", headers=ADMIN).json()
    assert [(e["action"], e["entity_id"], e["before"], e["after"]) for e in entries] == [
        ("agent.revoke", agent_id, {"name": "edge-01"}, None),
        ("agent.register", agent_id, None, {"name": "edge-01"}),
    ]


def test_heartbeats_work_in_production_without_a_user_token(database_url: str, site: str, api: TestClient) -> None:
    token = register(api, site)["token"]
    prod = Settings(_env_file=None, env="production", database_url=database_url, oidc_issuer="https://idp.example.com")
    with TestClient(create_app(prod)) as client:
        assert client.post("/agent/heartbeat", json=beat(), headers=agent_auth(token)).status_code == 200
        assert client.get(f"/sites/{site}/agents").status_code == 401  # people still need to sign in
