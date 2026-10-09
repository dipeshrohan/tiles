"""An organisation's own identity provider (T5.05): a customer's Entra ID tenant signs its people in
to that organisation only, its groups map to roles, it can be enforced, and it takes over users who
signed in through the deployment's issuer before."""

from typing import Any

import psycopg
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from test_auth import ISSUER, bearer, make_client, prod, site, token  # noqa: F401 - prod and site are fixtures

TENANT = "https://login.microsoftonline.com/6f1d0a59-0000-4000-8000-000000000001/v2.0"
API_APP = "8a2b3c4d-0000-4000-8000-000000000002"
PROVIDER = {
    "issuer": TENANT,
    "client_id": "9c3d4e5f-0000-4000-8000-000000000003",
    "audience": API_APP,
    "scope": f"openid profile email offline_access api://{API_APP}/access",
    "group_roles": {"5e6f7a8b-0000-4000-8000-000000000004": "engineer"},
}


def acme_admin(**overrides: Any) -> dict[str, str]:
    """An admin of the acme organisation, signed in through the deployment's issuer."""
    claims = {"sub": "acme-admin", "email": "lee@acme.example", "tiles_org": "acme"}
    return bearer(token(**{**claims, "realm_access": {"roles": ["tiles-admin"]}, **overrides}))


def entra(**overrides: Any) -> dict[str, str]:
    """An Entra ID access token from acme's tenant: no email claim, the sign-in name instead."""
    claims: dict[str, Any] = {
        "iss": TENANT,
        "aud": API_APP,
        "sub": "entra-pairwise-1",
        "email": None,
        "preferred_username": "Mia@Acme.example",
        "name": "Mia Chen",
        "realm_access": None,
        "roles": [],
        **overrides,
    }
    return bearer(token(**claims))


def lee_in_entra(**overrides: Any) -> dict[str, str]:
    """Lee, acme's admin, through acme's tenant."""
    return entra(sub="lee-entra", preferred_username="lee@acme.example", name="Lee Park", **overrides)


@pytest.fixture
def acme(prod: TestClient, site: str) -> TestClient:  # noqa: F811 - fixtures
    """Acme with its tenant saved and confirmed: Lee saved it, then signed in through it."""
    res = prod.put("/org/identity-provider", headers=acme_admin(), json=PROVIDER)
    assert res.status_code == 200, res.text
    assert res.json()["verified"] is False
    assert prod.get("/sites", headers=lee_in_entra()).status_code == 200
    return prod


def test_a_provider_is_pending_until_the_admin_who_saved_it_signs_in_through_it(
    prod: TestClient,  # noqa: F811 - a fixture
    site: str,  # noqa: F811 - a fixture
    database_url: str,
) -> None:
    assert prod.put("/org/identity-provider", headers=acme_admin(), json=PROVIDER).status_code == 200
    # Until confirmed, the tenant takes no one else, and can't be enforced.
    assert prod.get("/me", headers=entra()).status_code == 401
    assert (
        prod.put("/org/identity-provider", headers=acme_admin(), json={**PROVIDER, "enforced": True}).status_code == 409
    )
    # Lee, who saved it, signs in through it as lee@acme.example: confirmed.
    assert prod.get("/sites", headers=lee_in_entra()).status_code == 200
    assert prod.get("/org/identity-provider", headers=acme_admin()).json()["verified"] is True
    assert prod.get("/me", headers=entra()).status_code == 200
    with psycopg.connect(database_url) as conn:
        actions = [r[0] for r in conn.execute("SELECT action FROM audit_log ORDER BY id")]
    assert actions[-1] == "org.identity_provider.confirm"


def test_no_organisation_can_hold_another_organisations_tenant(acme: TestClient) -> None:
    beta = acme_admin(sub="beta-admin", email="kim@beta.example", tiles_org="beta")
    # Acme's confirmed tenant is acme's.
    assert acme.put("/org/identity-provider", headers=beta, json=PROVIDER).status_code == 409
    # A tenant beta merely claims takes none of its people, and doesn't stop its owner.
    other = "https://login.microsoftonline.com/00000000-0000-4000-8000-0000000000b2/v2.0"
    assert acme.put("/org/identity-provider", headers=beta, json={**PROVIDER, "issuer": other}).status_code == 200
    assert acme.get("/me", headers=entra(iss=other)).status_code == 401
    assert acme.get("/org/identity-provider", headers=beta).json()["verified"] is False


def test_an_organisation_sets_its_provider_and_its_tokens_sign_in_there_only(
    acme: TestClient, database_url: str
) -> None:
    assert acme.get("/org/identity-provider", headers=acme_admin()).json()["issuer"] == TENANT
    # Whatever the token claims, it is acme's: a tenant can't sign in to another organisation.
    me = acme.get("/me", headers=entra(tiles_org="demo"))
    assert me.status_code == 200, me.text
    assert me.json() == {"email": "mia@acme.example", "name": "Mia Chen", "org": "acme", "via": "oidc"}
    # The audience is acme's API app, and an unknown issuer is refused.
    assert acme.get("/me", headers=entra(aud="tiles-api")).status_code == 401
    other = "https://login.microsoftonline.com/00000000-0000-4000-8000-00000000dead/v2.0"
    assert acme.get("/me", headers=entra(iss=other)).status_code == 401
    with psycopg.connect(database_url) as conn:
        actions = [r[0] for r in conn.execute("SELECT action FROM audit_log ORDER BY id")]
    assert "org.identity_provider.set" in actions


def test_the_browser_finds_an_organisations_sign_in(acme: TestClient) -> None:
    config = acme.get("/auth/config", params={"org": "ACME"}).json()
    assert config == {
        "enabled": True,
        "issuer": TENANT,
        "client_id": PROVIDER["client_id"],
        "scope": PROVIDER["scope"],
        "org": "acme",
        "dev_identity": False,
    }
    assert acme.get("/auth/config", params={"org": "demo"}).status_code == 404
    assert acme.get("/auth/config", params={"org": "no such/org"}).status_code == 404


def test_groups_and_app_roles_grant_roles(acme: TestClient) -> None:
    res = acme.post("/sites", headers=acme_admin(), json={"name": "Plant", "slug": "plant"})
    assert res.status_code == 201, res.text
    sid = res.json()["id"]

    def role(**claims: Any) -> str:
        res = acme.get(f"/sites/{sid}/me", headers=entra(**claims))
        assert res.status_code == 200, res.text
        return str(res.json()["role"])

    assert role(sub="g", preferred_username="g@acme.example", groups=[PROVIDER_GROUP]) == "engineer"
    assert role(sub="r", preferred_username="r@acme.example", roles=["tiles-admin"]) == "admin"
    assert role(sub="v", preferred_username="v@acme.example", groups=["another-group"]) == "viewer"


PROVIDER_GROUP = next(iter(PROVIDER["group_roles"]))


def test_enforcing_needs_a_working_sign_in_then_refuses_the_others(acme: TestClient) -> None:
    enforced = {**PROVIDER, "enforced": True}
    # Not signed in through the provider: it might not work, so not yet.
    assert acme.put("/org/identity-provider", headers=acme_admin(), json=enforced).status_code == 409
    # An admin signed in through it may.
    admin = entra(sub="mia", roles=["tiles-admin"])
    res = acme.put("/org/identity-provider", headers=admin, json=enforced)
    assert res.status_code == 200, res.text
    assert acme.get("/sites", headers=acme_admin()).status_code == 403
    assert acme.get("/sites", headers=admin).status_code == 200
    # Another organisation is unaffected.
    assert acme.get("/sites", headers=bearer(token())).status_code == 200


def test_people_move_between_the_deployments_issuer_and_the_provider(acme: TestClient, database_url: str) -> None:
    def lee() -> list[tuple[str, str]]:
        with psycopg.connect(database_url) as conn:
            return conn.execute(
                "SELECT oidc_issuer, oidc_subject FROM users WHERE email = 'lee@acme.example'"
            ).fetchall()

    assert lee() == [(TENANT, "lee-entra")]  # Lee first signed in through the deployment's issuer
    # Back through the deployment's issuer (the provider not enforced), and through it again.
    assert acme.get("/sites", headers=acme_admin()).status_code == 200
    assert lee() == [(ISSUER, "acme-admin")]
    assert acme.get("/sites", headers=lee_in_entra()).status_code == 200
    assert lee() == [(TENANT, "lee-entra")]
    # But never to another identity of the same issuer.
    assert (
        acme.get("/sites", headers=entra(sub="someone-else", preferred_username="lee@acme.example")).status_code == 409
    )


def test_a_removed_provider_stops_at_once_on_every_api_process(acme: TestClient, database_url: str) -> None:
    assert acme.get("/sites", headers=entra()).status_code == 200
    # Removed by another API process: this one still remembers the provider, and asks anyway.
    with psycopg.connect(database_url) as conn:
        conn.execute("DELETE FROM org_identity_providers")
    assert acme.get("/sites", headers=entra()).status_code == 401
    # Its people sign in through the deployment's issuer again.
    assert acme.get("/sites", headers=acme_admin()).status_code == 200
    assert acme.delete("/org/identity-provider", headers=acme_admin()).status_code == 404


def test_providers_are_refused_when_they_cant_be_right(acme: TestClient) -> None:
    def put(headers: dict[str, str], **changes: Any) -> int:
        return acme.put("/org/identity-provider", headers=headers, json={**PROVIDER, **changes}).status_code

    beta = acme_admin(sub="beta-admin", email="kim@beta.example", tiles_org="beta")
    assert put(beta) == 409  # acme's issuer
    assert put(beta, issuer=ISSUER) == 409  # the deployment's own
    assert put(beta, issuer="http://login.example.com/x") == 422
    assert put(beta, issuer=TENANT + "/") == 422
    assert put(beta, issuer="https://idp.beta.example", jwks_url="http://keys.example") == 422
    assert put(beta, issuer="https://idp.beta.example", group_roles={"g": "owner"}) == 422
    assert put(beta, issuer="https://idp.beta.example") == 200
    assert put(beta, issuer="https://idp.beta.example", enforced=True) == 409  # not confirmed
    # Only organisation admins.
    viewer = bearer(token(sub="v", email="v@beta.example", tiles_org="beta", realm_access={"roles": []}))
    assert put(viewer, issuer="https://idp.beta.example") == 403


def test_without_a_database_unknown_issuers_are_refused(database_url: str) -> None:
    with make_client("") as c:
        assert c.get("/me", headers=entra()).status_code == 401


def test_people_learn_whether_they_manage_their_organisation(acme: TestClient) -> None:
    assert acme.get("/org", headers=acme_admin()).json() == {"slug": "acme", "name": "Acme", "admin": True}
    assert acme.get("/org", headers=entra(sub="mia")).json() == {"slug": "acme", "name": "Acme", "admin": False}
    assert acme.get("/org", headers=acme_admin(), params={"org": "demo"}).status_code == 403


def test_the_development_identity_names_its_organisation(database_url: str, site: str) -> None:  # noqa: F811
    with make_client(database_url, env="development", issuer=None) as dev:
        assert dev.get("/org").json() == {"slug": "demo", "name": "Demo Manufacturing", "admin": False}
        assert dev.get("/org", params={"org": "nope"}).json() == {"slug": None, "name": None, "admin": False}


def test_an_organisations_provider_is_fetched_from_public_addresses_only(monkeypatch: pytest.MonkeyPatch) -> None:
    import socket

    import jwt as pyjwt

    from tiles_api.auth import TokenVerifier, public_https

    def resolves_to(address: str) -> Any:
        return lambda *_a, **_k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]

    monkeypatch.setattr(socket, "getaddrinfo", resolves_to("20.190.160.1"))
    public_https(TENANT)  # a public address: fine
    for address in ("10.0.0.5", "127.0.0.1", "169.254.169.254", "fd00::1"):
        monkeypatch.setattr(socket, "getaddrinfo", resolves_to(address))
        with pytest.raises(pyjwt.PyJWKClientConnectionError, match="public"):
            public_https("https://idp.cluster.local/x")
    with pytest.raises(pyjwt.PyJWKClientConnectionError, match="https"):
        public_https("http://login.example.com/x")
    # The verifier checks before fetching anything: a 503, as for any unreachable provider.
    verifier = TokenVerifier("https://idp.cluster.local/x", "a", public_only=True)
    with pytest.raises(HTTPException) as e:
        verifier.verify(token(iss="https://idp.cluster.local/x", aud="a"))
    assert e.value.status_code == 503
