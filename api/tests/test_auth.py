"""Single sign-on: bearer-token checks, first-login users and orgs, roles."""

import time
from collections.abc import Iterator
from typing import Any

import jwt
import psycopg
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm

from tiles_api import sealed
from tiles_api.auth import TokenVerifier, role_from_claims
from tiles_api.main import create_app
from tiles_api.seed import seed
from tiles_api.settings import Settings

PRODUCTION_KEYS = sealed.new_key("test")  # production needs data keys (T5.06)

ISSUER = "https://idp.example.com/realms/tiles"
KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)
OTHER_KEY = rsa.generate_private_key(public_exponent=65537, key_size=2048)


class StaticJwks:
    """Stands in for PyJWKClient: always returns our test key."""

    def __init__(self) -> None:
        jwk = RSAAlgorithm.to_jwk(KEY.public_key(), as_dict=True)
        self.key = jwt.PyJWK.from_dict({**jwk, "kid": "k1", "alg": "RS256", "use": "sig"})

    def get_signing_key_from_jwt(self, _token: str) -> jwt.PyJWK:
        return self.key


def token(key: Any = KEY, **overrides: Any) -> str:
    now = int(time.time())
    claims = {
        "iss": ISSUER,
        "aud": "tiles-api",
        "sub": "user-1",
        "exp": now + 300,
        "iat": now,
        "email": "Ana@Example.com",
        "name": "Ana Lopez",
        "realm_access": {"roles": ["tiles-engineer"]},
        **overrides,
    }
    return jwt.encode({k: v for k, v in claims.items() if v is not None}, key, algorithm="RS256", headers={"kid": "k1"})


def bearer(t: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {t}"}


def make_client(database_url: str, env: str = "production", issuer: str | None = ISSUER) -> TestClient:
    settings = Settings(
        _env_file=None, env=env, database_url=database_url, oidc_issuer=issuer, data_keys=PRODUCTION_KEYS
    )
    app = create_app(settings)
    if issuer:
        app.state.verifier = TokenVerifier(settings, jwk_client=StaticJwks())
    return TestClient(app)


@pytest.fixture
def prod(database_url: str) -> Iterator[TestClient]:
    with make_client(database_url) as client:
        yield client


@pytest.fixture
def site(database_url: str) -> str:
    with psycopg.connect(database_url) as conn:
        conn.execute("TRUNCATE ontology_nodes, ontology_edges, commits, staged_ops, site_members, users CASCADE")
        conn.execute("DELETE FROM sites WHERE org_id IN (SELECT id FROM orgs WHERE slug <> 'demo')")
        conn.execute("DELETE FROM orgs WHERE slug <> 'demo'")
    return seed(Settings(_env_file=None, database_url=database_url))


def graph(site: str) -> str:
    return f"/sites/{site}/ontology/graph"


def test_auth_config_tells_the_browser_how_to_sign_in(database_url: str) -> None:
    with make_client(database_url) as c:
        assert c.get("/auth/config").json() == {
            "enabled": True,
            "issuer": ISSUER,
            "client_id": "tiles-web",
            "dev_identity": False,
        }
    with make_client(database_url, env="development", issuer=None) as c:
        assert c.get("/auth/config").json()["enabled"] is False
        assert c.get("/auth/config").json()["dev_identity"] is True


def test_valid_token_signs_the_user_in(prod: TestClient, site: str) -> None:
    me = prod.get("/me", headers=bearer(token()))
    assert me.status_code == 200
    assert me.json() == {"email": "ana@example.com", "name": "Ana Lopez", "org": "demo", "via": "oidc"}
    assert prod.get(graph(site), headers=bearer(token())).status_code == 200


def test_production_requires_a_token(prod: TestClient, site: str) -> None:
    for headers in ({}, {"X-Tiles-User": "ana@example.com"}):
        res = prod.get(graph(site), headers=headers)
        assert res.status_code == 401
        assert res.headers["www-authenticate"].startswith("Bearer")
    assert prod.get("/sites").status_code == 401


@pytest.mark.parametrize(
    "bad",
    [
        token(exp=int(time.time()) - 120),
        token(aud="someone-else"),
        token(iss="https://evil.example.com"),
        token(key=OTHER_KEY),
        token(email=None),
        token(tiles_org="Not A Slug!"),
        "not-a-jwt",
    ],
    ids=["expired", "audience", "issuer", "signature", "no-email", "bad-org", "garbage"],
)
def test_bad_tokens_are_refused(prod: TestClient, site: str, bad: str) -> None:
    assert prod.get(graph(site), headers=bearer(bad)).status_code == 401


def test_non_bearer_authorization_is_refused(prod: TestClient) -> None:
    assert prod.get("/me", headers={"Authorization": "Basic YWxhZGRpbjpvcGVu"}).status_code == 401


def test_bearer_without_sign_in_configured_is_refused(database_url: str) -> None:
    with make_client(database_url, env="development", issuer=None) as c:
        assert c.get("/me", headers=bearer(token())).status_code == 401
        assert c.get("/me").json()["via"] == "dev"  # no token: dev identity outside production


def test_first_sign_in_creates_the_org_and_user_and_sees_only_its_sites(
    prod: TestClient, database_url: str, site: str
) -> None:
    acme = bearer(token(sub="acme-1", email="lee@acme.example", tiles_org="acme"))
    assert prod.get("/sites", headers=acme).json() == []  # org created, no sites yet
    assert prod.get(graph(site), headers=acme).status_code == 403  # demo's site
    with psycopg.connect(database_url) as conn:
        assert conn.execute("SELECT name FROM orgs WHERE slug = 'acme'").fetchone() == ("Acme",)
    demo_sites = prod.get("/sites", headers=bearer(token())).json()
    assert [s["id"] for s in demo_sites] == [site]


def test_roles_come_from_the_token_on_first_visit_then_from_the_membership(
    prod: TestClient, database_url: str, site: str
) -> None:
    prod.get(graph(site), headers=bearer(token(realm_access={"roles": ["tiles-viewer"]})))
    prod.get(graph(site), headers=bearer(token(realm_access={"roles": ["tiles-admin"]})))
    with psycopg.connect(database_url) as conn:
        rows = conn.execute(
            "SELECT u.email, u.oidc_subject, m.role FROM users u JOIN site_members m ON m.user_id = u.id"
        ).fetchall()
    assert rows == [("ana@example.com", "user-1", "viewer")]


def test_a_user_known_before_sign_in_is_linked_not_duplicated(database_url: str, site: str) -> None:
    with make_client(database_url, env="development") as dev:
        dev.get(graph(site), headers={"X-Tiles-User": "ana@example.com"})
        dev.get(graph(site), headers=bearer(token(name="Ana L.")))
    with psycopg.connect(database_url) as conn:
        rows = conn.execute("SELECT email, name, oidc_issuer, oidc_subject FROM users").fetchall()
    assert rows == [("ana@example.com", "Ana L.", ISSUER, "user-1")]


def test_unreachable_provider_is_a_503(database_url: str, site: str) -> None:
    settings = Settings(
        _env_file=None,
        env="production",
        data_keys=PRODUCTION_KEYS,
        database_url=database_url,
        oidc_issuer=ISSUER,
        oidc_jwks_url="http://127.0.0.1:1/certs",
    )
    with TestClient(create_app(settings)) as c:
        assert c.get("/me", headers=bearer(token())).status_code == 503


@pytest.mark.parametrize(
    ("claims", "role"),
    [
        ({}, "viewer"),
        ({"realm_access": {"roles": ["offline_access", "tiles-engineer"]}}, "engineer"),
        ({"realm_access": {"roles": ["tiles-engineer", "tiles-admin"]}}, "admin"),
        ({"roles": ["tiles-engineer"]}, "engineer"),
        # Bare names are other applications' roles, not Tiles privileges.
        ({"realm_access": {"roles": ["admin", "engineer"]}}, "viewer"),
        ({"roles": ["admin"]}, "viewer"),
        ({"realm_access": "nonsense"}, "viewer"),
    ],
)
def test_role_from_claims(claims: dict[str, Any], role: str) -> None:
    assert role_from_claims(claims) == role


def test_an_email_bound_to_another_sign_in_is_never_handed_over(prod: TestClient, database_url: str, site: str) -> None:
    assert prod.get(graph(site), headers=bearer(token(sub="ana-1"))).status_code == 200
    # Another subject (say, a reused or spoofed email at the provider) claims the same email.
    res = prod.get(graph(site), headers=bearer(token(sub="intruder-9")))
    assert (res.status_code, res.json()["detail"]) == (409, "This email already belongs to another sign-in")
    with psycopg.connect(database_url) as conn:
        assert conn.execute("SELECT oidc_subject FROM users").fetchall() == [("ana-1",)]


def test_a_known_sign_in_with_a_new_organisation_is_refused_not_a_500(prod: TestClient, site: str) -> None:
    assert prod.get(graph(site), headers=bearer(token())).status_code == 200
    moved = bearer(token(tiles_org="acme"))
    assert prod.get("/sites", headers=moved).status_code == 403
    assert prod.get("/sites", headers=bearer(token())).status_code == 200


def test_first_sign_in_creates_the_user_even_before_the_org_has_sites(
    prod: TestClient, database_url: str, site: str
) -> None:
    assert (
        prod.get("/sites", headers=bearer(token(sub="n-1", email="new@neworg.example", tiles_org="neworg"))).json()
        == []
    )
    with psycopg.connect(database_url) as conn:
        row = conn.execute(
            "SELECT o.slug, u.oidc_subject FROM users u JOIN orgs o ON o.id = u.org_id"
            " WHERE u.email = 'new@neworg.example'"
        ).fetchone()
    assert row == ("neworg", "n-1")


def test_unknown_signing_key_is_401_and_unreachable_discovery_is_503(database_url: str, site: str) -> None:
    class NoMatchingKey:
        def get_signing_key_from_jwt(self, _token: str) -> jwt.PyJWK:
            raise jwt.PyJWKClientError('Unable to find a signing key that matches: "rogue"')

    settings = Settings(
        _env_file=None, env="production", data_keys=PRODUCTION_KEYS, database_url=database_url, oidc_issuer=ISSUER
    )
    app = create_app(settings)
    app.state.verifier = TokenVerifier(settings, jwk_client=NoMatchingKey())
    with TestClient(app) as c:
        res = c.get("/me", headers=bearer(token()))
        assert res.status_code == 401
        assert res.headers["www-authenticate"].startswith("Bearer")
    # No JWKS URL configured: discovery at an unreachable issuer is a 503, not a 500.
    unreachable = Settings(
        _env_file=None,
        env="production",
        data_keys=PRODUCTION_KEYS,
        database_url=database_url,
        oidc_issuer="http://127.0.0.1:1/realms/x",
    )
    with TestClient(create_app(unreachable)) as c:
        assert c.get("/me", headers=bearer(token(iss="http://127.0.0.1:1/realms/x"))).status_code == 503
