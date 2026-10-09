"""Setting up a site (T6.06): organisation admins create sites; a site's onboarding progress is
worked out from its own data, step by step."""

import uuid
from datetime import UTC, datetime
from typing import Any

import psycopg
from fastapi.testclient import TestClient
from test_agents import ADMIN, ENG, VIEWER, agent_auth, api, beat, site  # noqa: F401 - api and site are fixtures

from tiles_api.api_sites import machine_of


def make_org_admin(database_url: str, email: str, admin: bool = True) -> None:
    with psycopg.connect(database_url) as conn:
        conn.execute("UPDATE users SET org_admin = %s WHERE email = %s", [admin, email])


def new_slug() -> str:
    return f"plant-{uuid.uuid4().hex[:8]}"


def test_an_organisation_admin_creates_a_site_and_is_its_admin(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    slug = new_slug()
    body = {"name": " Plant 2 ", "slug": slug, "timezone": "Europe/Berlin"}
    # An engineer, or a site admin, may not: it takes an organisation admin.
    res = api.post("/sites", json=body, headers=ADMIN)
    assert (res.status_code, res.json()["detail"]) == (403, "Creating a site needs an organisation admin")
    make_org_admin(database_url, "admin@example.com")
    try:
        res = api.post("/sites", json=body, headers=ADMIN)
        assert res.status_code == 201, res.text
        made = res.json()
        assert (made["slug"], made["name"], made["org"]) == (slug, "Plant 2", "demo")
        assert made["id"] in [s["id"] for s in api.get("/sites", headers=ENG).json()]
        with psycopg.connect(database_url) as conn:
            row = conn.execute(
                "SELECT s.timezone, m.role FROM sites s JOIN site_members m ON m.site_id = s.id"
                " JOIN users u ON u.id = m.user_id WHERE s.id = %s AND u.email = 'admin@example.com'",
                [made["id"]],
            ).fetchone()
        assert row == ("Europe/Berlin", "admin")
        # The creation is in the new site's audit log.
        make_org_admin(database_url, "admin@example.com", False)  # its membership makes them admin anyway
        audit = api.get(f"/sites/{made['id']}/audit", headers=ADMIN).json()
        entries = audit["entries"] if isinstance(audit, dict) else audit
        assert [(e["action"], e["actor_name"]) for e in entries] == [("site.create", "admin")]
        make_org_admin(database_url, "admin@example.com")

        # A slug is the organisation's once; bad names, slugs and time zones are refused.
        again = api.post("/sites", json=body, headers=ADMIN)
        assert (again.status_code, again.json()["detail"]) == (
            409,
            f"Your organisation already has a site called {slug}",
        )
        for bad in ({"slug": "Plant 3"}, {"name": "  "}, {"timezone": "Mars/Olympus"}):
            res = api.post("/sites", json={**body, "slug": new_slug(), **bad}, headers=ADMIN)
            assert res.status_code == 422, bad
    finally:
        make_org_admin(database_url, "admin@example.com", False)


def test_the_development_identity_names_the_organisation_when_there_are_several(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    make_org_admin(database_url, "admin@example.com")
    other = f"other-{uuid.uuid4().hex[:6]}"
    with psycopg.connect(database_url) as conn:
        conn.execute("INSERT INTO orgs (slug, name) VALUES (%s, 'Other')", [other])
    try:
        body = {"name": "Plant 3", "slug": new_slug()}
        res = api.post("/sites", json=body, headers=ADMIN)
        assert (res.status_code, res.json()["detail"]) == (400, "Name the organisation with ?org=<slug>")
        assert api.post("/sites?org=nowhere", json=body, headers=ADMIN).status_code == 400
        # In the other organisation they are a new user, and no admin there.
        assert api.post(f"/sites?org={other}", json=body, headers=ADMIN).status_code == 403
        res = api.post("/sites?org=demo", json=body, headers=ADMIN)
        assert (res.status_code, res.json()["org"]) == (201, "demo")
    finally:
        make_org_admin(database_url, "admin@example.com", False)
        with psycopg.connect(database_url) as conn:
            conn.execute("DELETE FROM orgs WHERE slug = %s", [other])


def steps(api: TestClient, site_id: str) -> dict[str, Any]:  # noqa: F811
    res = api.get(f"/sites/{site_id}/onboarding", headers=VIEWER)
    assert res.status_code == 200, res.text
    out: dict[str, Any] = res.json()
    out["done"] = [s["key"] for s in out["steps"] if s["done"]]
    out["details"] = {s["key"]: s["detail"] for s in out["steps"]}
    return out


def test_onboarding_follows_the_site_from_created_to_its_first_dashboard(
    api: TestClient,  # noqa: F811
    database_url: str,
) -> None:
    make_org_admin(database_url, "admin@example.com")
    try:
        made = api.post("/sites", json={"name": "Plant 4", "slug": new_slug()}, headers=ADMIN).json()
    finally:
        make_org_admin(database_url, "admin@example.com", False)
    site_id = made["id"]
    for who in (ENG, VIEWER):
        api.get(f"/sites/{site_id}/me", headers=who)
    with psycopg.connect(database_url) as conn:
        conn.execute(
            "UPDATE site_members SET role = 'engineer' WHERE site_id = %s"
            " AND user_id = (SELECT id FROM users WHERE email = 'eng@example.com')",
            [site_id],
        )

    s = steps(api, site_id)
    assert (s["done"], s["next"]) == (["site"], "outline")
    assert s["details"]["outline"] == "No machines in the ontology yet"
    assert s["details"]["agent"] == "No edge agent yet"

    # The plant outlined: a line, a machine and its PLC with a signal.
    def node(id: str, type: str, label: str, **props: Any) -> dict[str, Any]:
        return {"kind": "addNode", "node": {"id": id, "type": type, "label": label, "props": props}}

    def edge(a: str, rel: str, b: str) -> dict[str, Any]:
        return {"kind": "addEdge", "edge": {"id": f"{a}-{rel}-{b}", "from": a, "rel": rel, "to": b}}

    ops = [
        node("line", "Line", "Line 1"),
        node("press", "Machine", "Press 1"),
        node("plc", "PLC", "PLC 1", protocol="OPC UA"),
        node("force", "Signal", "Press force", unit="kN"),
        edge("line", "contains", "press"),
        edge("press", "controlledBy", "plc"),
        edge("plc", "emits", "force"),
    ]
    assert api.post(f"/sites/{site_id}/ontology/staged/batch", json=ops, headers=ENG).status_code == 201
    assert api.post(f"/sites/{site_id}/ontology/commits", json={"message": "outline"}, headers=ENG).status_code == 201
    s = steps(api, site_id)
    assert (s["done"], s["machines"]) == (["site", "outline"], 1)

    # An agent registered, then calling in.
    token = api.post(f"/sites/{site_id}/agents", json={"name": "edge-01"}, headers=ADMIN).json()["token"]
    assert steps(api, site_id)["details"]["agent"] == "1 agent registered, none has called in yet"
    assert api.post("/agent/heartbeat", json=beat(), headers=agent_auth(token)).status_code == 200
    s = steps(api, site_id)
    assert s["details"]["agent"] == "1 agent has called in, 1 online now"
    assert (s["done"], s["agents_seen"], s["details"]["mapping"]) == (
        ["site", "outline", "agent"],
        1,
        "No tags have arrived yet",
    )

    # Its tags arrive; one is mapped, and its machine is the first dashboard.
    samples = {
        "samples": [
            {"signal": tag, "at": datetime.now(UTC).isoformat(), "value": 1.0} for tag in ("p1.force", "p1.temp")
        ]
    }
    assert api.post("/agent/samples", json=samples, headers=agent_auth(token)).status_code == 200
    s = steps(api, site_id)
    assert (s["tags"], s["mapped"], s["details"]["mapping"]) == (2, 0, "0 of 2 tags mapped")
    signal = api.get(f"/sites/{site_id}/signals?q=p1.force", headers=ENG).json()["signals"][0]
    res = api.patch(f"/sites/{site_id}/signals/{signal['id']}", json={"node_id": "force"}, headers=ENG)
    assert res.status_code == 200, res.text
    s = steps(api, site_id)
    assert (s["done"], s["next"]) == (["site", "outline", "agent", "mapping", "dashboard"], None)
    assert s["dashboard"] == {"id": "press", "label": "Press 1"}
    assert s["details"]["dashboard"] == "Press 1: 1 mapped signal"

    # An agent gone quiet has still called in: the step stays done, and says it isn't online.
    with psycopg.connect(database_url) as conn:
        conn.execute("UPDATE edge_agents SET last_seen_at = now() - interval '1 day' WHERE site_id = %s", [site_id])
    assert steps(api, site_id)["details"]["agent"] == "1 agent has called in, 0 online now"

    # Another site's members can't read it.
    other = api.get(f"/sites/{site_id}/onboarding", headers={"Authorization": "Bearer not-a-token"})
    assert other.status_code == 401


def test_a_signal_belongs_to_its_plcs_machine_or_the_machine_containing_it() -> None:
    def g(*edges: tuple[str, str, str], types: dict[str, str]) -> Any:
        return {
            "nodes": {k: {"id": k, "type": t, "label": k.upper(), "props": {}} for k, t in types.items()},
            "edges": {f"{a}{r}{b}": {"id": f"{a}{r}{b}", "from": a, "rel": r, "to": b} for a, r, b in edges},
        }

    types = {"m": "Machine", "p": "PLC", "s": "Signal", "c": "Cell", "x": "Signal"}
    graph = g(
        ("m", "controlledBy", "p"), ("p", "emits", "s"), ("m", "contains", "c"), ("c", "contains", "x"), types=types
    )
    assert machine_of(graph, "s") == "m"
    assert machine_of(graph, "x") == "m"  # through the cell it is in
    assert machine_of(graph, "c") == "m"
    loop = g(("a", "contains", "b"), ("b", "contains", "a"), types={"a": "Cell", "b": "Cell"})
    assert machine_of(loop, "a") is None  # a cycle ends the search
