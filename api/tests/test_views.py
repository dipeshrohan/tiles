"""Saved views (U5.06): kept by their owner, shared with the site by engineers, audited."""

import psycopg
from fastapi.testclient import TestClient
from test_agents import ADMIN, ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures

WARNINGS = {"page": "warnings", "name": "Mine, new", "query": {"show": "raised", "who": "me"}}


def test_a_view_is_its_owners_until_shared(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    views = f"/sites/{site}/views"
    res = api.post(views, json={**WARNINGS, "table": {"sort": {"key": "raised", "dir": "desc"}}}, headers=ENG)
    assert res.status_code == 201, res.text
    mine = res.json()
    assert mine["mine"] and not mine["shared"]
    assert mine["query"] == {"show": "raised", "who": "me"}
    assert mine["table"] == {"sort": {"key": "raised", "dir": "desc"}, "hidden": [], "density": "comfortable"}
    # Nobody else sees it, and nobody else changes it.
    assert api.get(views, headers=VIEWER).json() == []
    assert api.patch(f"{views}/{mine['id']}", json={"name": "x"}, headers=ADMIN).status_code == 404
    # Shared, everyone sees it; still only its owner changes it.
    res = api.patch(f"{views}/{mine['id']}", json={"shared": True, "name": "  New, mine  "}, headers=ENG)
    assert res.status_code == 200, res.text
    assert res.json()["name"] == "New, mine"
    seen = api.get(views, params={"page": "warnings"}, headers=VIEWER).json()
    assert [(v["name"], v["mine"], v["shared"]) for v in seen] == [("New, mine", False, True)]
    assert api.get(views, params={"page": "signals"}, headers=VIEWER).json() == []
    assert api.patch(f"{views}/{mine['id']}", json={"name": "x"}, headers=VIEWER).status_code == 403
    assert api.delete(f"{views}/{mine['id']}", headers=VIEWER).status_code == 403
    # A viewer keeps views of their own but can't share them.
    own = api.post(views, json={"page": "signals", "name": "Temps", "query": {"q": "temp"}}, headers=VIEWER)
    assert own.status_code == 201
    assert api.post(views, json={**WARNINGS, "shared": True}, headers=VIEWER).status_code == 403
    assert api.patch(f"{views}/{own.json()['id']}", json={"shared": True}, headers=VIEWER).status_code == 403
    # Yours first, then the shared ones.
    assert [v["name"] for v in api.get(views, headers=VIEWER).json()] == ["Temps", "New, mine"]
    # A name used twice on a page is refused; on another page it's fine.
    assert api.post(views, json={**WARNINGS, "name": "New, mine"}, headers=ENG).status_code == 409
    assert api.post(views, json={**WARNINGS, "page": "documents", "name": "New, mine"}, headers=ENG).status_code == 201
    # A site admin may delete a shared view.
    assert api.delete(f"{views}/{mine['id']}", headers=ADMIN).status_code == 204
    assert api.get(f"{views}", params={"page": "warnings"}, headers=ENG).json() == []
    with psycopg.connect(database_url) as conn:
        actions = conn.execute(
            "SELECT action FROM audit_log WHERE site_id = %s AND entity_type = 'saved_view' ORDER BY id", [site]
        ).fetchall()
    assert [a[0] for a in actions] == ["view.create", "view.update", "view.create", "view.create", "view.delete"]


def test_a_view_keeps_filters_and_table_settings_only(api: TestClient, site: str) -> None:  # noqa: F811
    views = f"/sites/{site}/views"
    for bad in (
        {**WARNINGS, "page": "ontology"},
        {**WARNINGS, "name": ""},
        {**WARNINGS, "name": "   "},
        {**WARNINGS, "name": "x" * 81},
        {**WARNINGS, "query": {"Show": "all"}},
        {**WARNINGS, "query": {"q": "x" * 201}},
        {**WARNINGS, "query": {f"k{n}": "1" for n in range(13)}},
        {**WARNINGS, "query": {"show": 1}},
        {**WARNINGS, "table": {"sort": {"key": "raised", "dir": "up"}}},
        {**WARNINGS, "table": {"hidden": ["<b>"]}},
        {**WARNINGS, "table": {"widths": {}}},
        {**WARNINGS, "owner": "someone"},
    ):
        assert api.post(views, json=bad, headers=ENG).status_code == 422, bad


def test_a_person_keeps_at_most_fifty_views(api: TestClient, site: str) -> None:  # noqa: F811
    views = f"/sites/{site}/views"
    for n in range(50):
        assert api.post(views, json={**WARNINGS, "name": f"v{n}"}, headers=ENG).status_code == 201
    assert api.post(views, json={**WARNINGS, "name": "one more"}, headers=ENG).status_code == 409
    assert api.post(views, json={**WARNINGS, "name": "theirs"}, headers=VIEWER).status_code == 201


def test_a_shared_view_is_changed_by_engineers_only(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    views = f"/sites/{site}/views"
    shared = api.post(views, json={**WARNINGS, "shared": True}, headers=ENG).json()
    # Its owner becomes a viewer: they can no longer change what everyone sees, but can delete it.
    with psycopg.connect(database_url) as conn:
        conn.execute(
            "UPDATE site_members SET role = 'viewer'"
            " WHERE site_id = %s AND user_id = (SELECT owner_id FROM saved_views WHERE id = %s)",
            [site, shared["id"]],
        )
    for change in ({"name": "Renamed"}, {"query": {"show": "all"}}, {"shared": False}):
        assert api.patch(f"{views}/{shared['id']}", json=change, headers=ENG).status_code == 403, change
    assert api.delete(f"{views}/{shared['id']}", headers=ENG).status_code == 204
