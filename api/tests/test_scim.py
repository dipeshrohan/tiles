"""SCIM 2.0 provisioning (T5.05): an organisation's identity provider creates, updates, deactivates
and deletes its users with a SCIM token, as Entra ID's provisioning service sends the requests."""

from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from test_auth import bearer, prod, site, token  # noqa: F401 - prod and site are fixtures
from test_org_sign_in import acme_admin

MEDIA = "application/scim+json"
USER = "urn:ietf:params:scim:schemas:core:2.0:User"
PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp"


@pytest.fixture
def scim(prod: TestClient, site: str) -> tuple[TestClient, dict[str, str]]:  # noqa: F811 - fixtures
    res = prod.post("/org/scim-tokens", headers=acme_admin(), json={"name": "Entra ID provisioning"})
    assert res.status_code == 201, res.text
    assert res.json()["token"].startswith("tiles_scim_")
    return prod, {"Authorization": f"Bearer {res.json()['token']}", "Content-Type": MEDIA}


def entra_user(email: str = "mia@acme.example", **extra: Any) -> dict[str, Any]:
    """A create request as Entra ID sends it: its UPN as userName, attributes Tiles doesn't keep."""
    return {
        "schemas": [USER, "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"],
        "externalId": "mia-object-id",
        "userName": email,
        "active": True,
        "displayName": "Mia Chen",
        "name": {"givenName": "Mia", "familyName": "Chen"},
        "emails": [{"primary": True, "type": "work", "value": email}],
        "title": "Process engineer",
        "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User": {"department": "Moulding"},
        **extra,
    }


def patch(*ops: dict[str, Any]) -> dict[str, Any]:
    return {"schemas": [PATCH], "Operations": list(ops)}


def test_a_provider_creates_finds_and_reads_users(scim: tuple[TestClient, dict[str, str]]) -> None:
    c, auth = scim
    created = c.post("/scim/v2/Users", headers=auth, json=entra_user(email="Mia@Acme.example"))
    assert created.status_code == 201, created.text
    assert created.headers["content-type"].startswith(MEDIA)
    user = created.json()
    assert user["userName"] == "mia@acme.example"
    assert user["displayName"] == "Mia Chen"
    assert user["externalId"] == "mia-object-id"
    assert user["active"] is True
    assert created.headers["location"] == user["meta"]["location"]
    assert c.get(f"/scim/v2/Users/{user['id']}", headers=auth).json() == user
    # Entra ID looks a user up before creating them.
    found = c.get("/scim/v2/Users", headers=auth, params={"filter": 'userName eq "MIA@acme.example"'}).json()
    assert found["totalResults"] == 1 and found["Resources"][0]["id"] == user["id"]
    by_id = c.get("/scim/v2/Users", headers=auth, params={"filter": 'externalId eq "mia-object-id"'}).json()
    assert [u["id"] for u in by_id["Resources"]] == [user["id"]]
    none = c.get("/scim/v2/Users", headers=auth, params={"filter": 'userName eq "nobody@acme.example"'}).json()
    assert none["totalResults"] == 0 and none["Resources"] == []
    # The same person again is a conflict, in SCIM's terms.
    again = c.post("/scim/v2/Users", headers=auth, json=entra_user())
    assert again.status_code == 409 and again.json()["scimType"] == "uniqueness"


def test_pages_and_unsupported_filters(scim: tuple[TestClient, dict[str, str]]) -> None:
    c, auth = scim
    for i in range(3):
        c.post("/scim/v2/Users", headers=auth, json=entra_user(email=f"u{i}@acme.example", externalId=f"x{i}"))
    page = c.get("/scim/v2/Users", headers=auth, params={"startIndex": 2, "count": 1}).json()
    # The admin who made the token is the organisation's first user.
    assert (page["totalResults"], page["startIndex"], page["itemsPerPage"]) == (4, 2, 1)
    assert page["Resources"][0]["userName"] == "u0@acme.example"
    bad = c.get("/scim/v2/Users", headers=auth, params={"filter": 'title co "engineer"'})
    assert bad.status_code == 400 and bad.json()["scimType"] == "invalidFilter"


def test_deactivating_refuses_sign_in_and_reactivating_restores_it(
    scim: tuple[TestClient, dict[str, str]], database_url: str
) -> None:
    c, auth = scim
    uid = c.post("/scim/v2/Users", headers=auth, json=entra_user()).json()["id"]
    mia = bearer(token(sub="mia", email="mia@acme.example", tiles_org="acme"))
    assert c.get("/sites", headers=mia).status_code == 200  # linked to the provisioned user
    # Entra ID's PATCH: the value as text, the op capitalised.
    res = c.patch(
        f"/scim/v2/Users/{uid}", headers=auth, json=patch({"op": "Replace", "path": "active", "value": "False"})
    )
    assert res.status_code == 200, res.text
    assert res.json()["active"] is False
    assert c.get("/sites", headers=mia).status_code == 403
    # A value object without a path.
    res = c.patch(f"/scim/v2/Users/{uid}", headers=auth, json=patch({"op": "replace", "value": {"active": True}}))
    assert res.json()["active"] is True
    assert c.get("/sites", headers=mia).status_code == 200
    with psycopg.connect(database_url) as conn:
        users = conn.execute("SELECT count(*) FROM users WHERE email = 'mia@acme.example'").fetchone()
        actions = [r[0] for r in conn.execute("SELECT action FROM audit_log WHERE entity_id = %s ORDER BY id", [uid])]
    assert users == (1,)
    assert actions == ["scim.user.create", "scim.user.update", "scim.user.update"]


def test_patch_and_put_change_what_tiles_keeps(scim: tuple[TestClient, dict[str, str]]) -> None:
    c, auth = scim
    uid = c.post("/scim/v2/Users", headers=auth, json=entra_user()).json()["id"]
    res = c.patch(
        f"/scim/v2/Users/{uid}",
        headers=auth,
        json=patch(
            {"op": "Replace", "path": "displayName", "value": "Mia Chen-Ortiz"},
            {"op": "Replace", "path": 'emails[type eq "work"].value', "value": "mia.chen@acme.example"},
            {"op": "Add", "path": "title", "value": "Lead"},  # not kept: accepted, ignored
            {"op": "Remove", "path": "externalId"},
        ),
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["displayName"], body["userName"], "externalId" in body) == (
        "Mia Chen-Ortiz",
        "mia.chen@acme.example",
        False,
    )
    put = c.put(f"/scim/v2/Users/{uid}", headers=auth, json=entra_user(email="mia@acme.example", displayName=None))
    assert put.status_code == 200, put.text
    assert (put.json()["userName"], put.json()["displayName"], put.json()["externalId"]) == (
        "mia@acme.example",
        "Mia Chen",
        "mia-object-id",
    )
    bad = c.patch(
        f"/scim/v2/Users/{uid}",
        headers=auth,
        json=patch({"op": "Replace", "path": "userName", "value": "not-an-email"}),
    )
    assert bad.status_code == 400 and bad.json()["schemas"] == ["urn:ietf:params:scim:api:messages:2.0:Error"]
    assert c.patch(f"/scim/v2/Users/{uid}", headers=auth, json={"Operations": []}).status_code == 400
    assert (
        c.patch(f"/scim/v2/Users/{uid}", headers=auth, json=patch({"op": "move", "path": "active"})).status_code == 400
    )


def test_deleting_ends_memberships_and_a_new_create_brings_the_user_back(
    scim: tuple[TestClient, dict[str, str]], database_url: str
) -> None:
    c, auth = scim
    site_id = c.post("/sites", headers=acme_admin(), json={"name": "Plant", "slug": "plant"}).json()["id"]
    uid = c.post("/scim/v2/Users", headers=auth, json=entra_user()).json()["id"]
    mia = bearer(token(sub="mia", email="mia@acme.example", tiles_org="acme"))
    assert c.get(f"/sites/{site_id}/me", headers=mia).status_code == 200  # a member now
    assert c.delete(f"/scim/v2/Users/{uid}", headers=auth).status_code == 204
    assert c.get(f"/scim/v2/Users/{uid}", headers=auth).status_code == 404
    assert c.delete(f"/scim/v2/Users/{uid}", headers=auth).status_code == 404
    assert c.get(f"/sites/{site_id}/me", headers=mia).status_code == 403
    with psycopg.connect(database_url) as conn:
        assert conn.execute("SELECT count(*) FROM site_members WHERE user_id = %s", [uid]).fetchone() == (0,)
    back = c.post("/scim/v2/Users", headers=auth, json=entra_user())
    assert back.status_code == 201, back.text
    assert back.json()["id"] == uid  # the same user, with their history
    assert c.get("/sites", headers=mia).status_code == 200


def test_tokens_reach_their_own_organisation_only(scim: tuple[TestClient, dict[str, str]]) -> None:
    c, auth = scim
    uid = c.post("/scim/v2/Users", headers=auth, json=entra_user()).json()["id"]
    beta_admin = acme_admin(sub="beta-admin", email="kim@beta.example", tiles_org="beta")
    beta = {
        "Authorization": f"Bearer {c.post('/org/scim-tokens', headers=beta_admin, json={'name': 'b'}).json()['token']}"
    }
    assert c.get(f"/scim/v2/Users/{uid}", headers=beta).status_code == 404
    assert [u["userName"] for u in c.get("/scim/v2/Users", headers=beta).json()["Resources"]] == ["kim@beta.example"]
    for headers in ({}, {"Authorization": "Bearer tiles_scim_nope"}, {"Authorization": "Bearer tla_agent"}):
        res = c.get("/scim/v2/Users", headers=headers)
        assert res.status_code == 401
        assert res.json()["status"] == "401"


def test_a_revoked_token_stops_at_once(scim: tuple[TestClient, dict[str, str]]) -> None:
    c, auth = scim
    tokens = c.get("/org/scim-tokens", headers=acme_admin()).json()
    assert [t["name"] for t in tokens] == ["Entra ID provisioning"]
    assert "token" not in tokens[0]
    assert c.get("/scim/v2/Users", headers=auth).status_code == 200
    assert c.get("/org/scim-tokens", headers=acme_admin()).json()[0]["last_used_at"] is not None
    assert c.delete(f"/org/scim-tokens/{tokens[0]['id']}", headers=acme_admin()).status_code == 204
    assert c.get("/scim/v2/Users", headers=auth).status_code == 401
    assert c.delete(f"/org/scim-tokens/{tokens[0]['id']}", headers=acme_admin()).status_code == 404
    # Only organisation admins make them.
    viewer = bearer(token(sub="v", email="v@acme.example", tiles_org="acme", realm_access={"roles": []}))
    assert c.post("/org/scim-tokens", headers=viewer, json={"name": "x"}).status_code == 403


def test_the_service_describes_itself(prod: TestClient) -> None:  # noqa: F811 - a fixture
    config = prod.get("/scim/v2/ServiceProviderConfig")
    assert config.status_code == 200 and config.headers["content-type"].startswith(MEDIA)
    assert config.json()["patch"] == {"supported": True}
    assert [r["id"] for r in prod.get("/scim/v2/ResourceTypes").json()["Resources"]] == ["User"]
