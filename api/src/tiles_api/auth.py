"""Authentication: OpenID Connect bearer tokens, plus a dev identity.

Production accepts only valid bearer tokens from the configured issuer.
Elsewhere a request without a token acts as the dev user (or the email in an
X-Tiles-User header), so tests, curl and the local stack work without a
sign-in. A token that is present is always verified; a bad one is a 401.
"""

import json
import re
import threading
import urllib.request
from dataclasses import dataclass
from typing import Any, Literal

import jwt
from fastapi import HTTPException, Request

from tiles_api.settings import Settings

Role = Literal["viewer", "engineer", "admin"]
EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}$")
SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,62}$")
ALGORITHMS = ["RS256", "RS384", "RS512", "ES256", "ES384", "PS256"]


@dataclass(frozen=True)
class Principal:
    """Who is calling, before we know which site they are opening."""

    email: str
    name: str
    # Organisation slug from the token; None for the dev identity, which
    # belongs to whichever organisation owns the site it opens.
    org: str | None
    role: Role  # role for sites they open for the first time
    issuer: str | None = None
    subject: str | None = None


def unauthorized(message: str) -> HTTPException:
    return HTTPException(401, message, headers={"WWW-Authenticate": 'Bearer error="invalid_token"'})


class TokenVerifier:
    """Checks signature, issuer, audience and expiry of OIDC access tokens."""

    def __init__(self, settings: Settings, jwk_client: Any = None) -> None:
        if not settings.oidc_issuer:
            raise ValueError("oidc_issuer is not set")
        self.issuer = settings.oidc_issuer.rstrip("/")
        self.audience = settings.oidc_audience
        self._jwks_url = settings.oidc_jwks_url
        self._client = jwk_client
        self._lock = threading.Lock()

    def _jwk_client(self) -> Any:
        with self._lock:
            if self._client is None:
                url = self._jwks_url or discover_jwks_url(self.issuer)
                self._client = jwt.PyJWKClient(url, cache_keys=True, lifespan=3600, timeout=5)
            return self._client

    def verify(self, token: str) -> dict[str, Any]:
        try:
            key = self._jwk_client().get_signing_key_from_jwt(token)
            claims: dict[str, Any] = jwt.decode(
                token,
                key.key,
                algorithms=ALGORITHMS,
                audience=self.audience,
                issuer=self.issuer,
                leeway=30,
                options={"require": ["exp", "iss", "sub", "aud"]},
            )
        except jwt.PyJWKClientConnectionError as e:
            # Fetching the provider's keys failed: not the token's fault.
            raise HTTPException(503, "Sign-in provider is unreachable") from e
        except (jwt.PyJWKClientError, jwt.PyJWTError) as e:
            # Includes a token signed with a key the provider doesn't have.
            raise unauthorized(f"Invalid token: {e}") from e
        return claims


def discover_jwks_url(issuer: str) -> str:
    url = f"{issuer}/.well-known/openid-configuration"
    try:
        with urllib.request.urlopen(url, timeout=5) as res:  # noqa: S310 - configured https/http issuer
            jwks_uri = json.load(res).get("jwks_uri")
    except (OSError, ValueError) as e:  # URLError, HTTPError and timeouts are OSErrors; bad JSON a ValueError
        raise jwt.PyJWKClientConnectionError(f"discovery failed: {type(e).__name__}") from e
    if not isinstance(jwks_uri, str):
        raise jwt.PyJWKClientConnectionError("issuer has no jwks_uri")
    return jwks_uri


def role_from_claims(claims: dict[str, Any]) -> Role:
    """Highest Tiles role in the token: tiles-admin or tiles-engineer, otherwise viewer.

    Only the tiles- names count, in Keycloak realm roles or a `roles` claim: realm
    roles are shared by every application in the realm, so a bare "admin" there
    says nothing about Tiles.
    """
    roles: set[str] = set()
    realm = claims.get("realm_access")
    if isinstance(realm, dict) and isinstance(realm.get("roles"), list):
        roles.update(str(r) for r in realm["roles"])
    if isinstance(claims.get("roles"), list):
        roles.update(str(r) for r in claims["roles"])
    for role in ("admin", "engineer"):
        if f"tiles-{role}" in roles:
            return role
    return "viewer"


def principal_from_claims(claims: dict[str, Any], settings: Settings) -> Principal:
    email = str(claims.get("email") or "").strip().lower()
    if not EMAIL.match(email):
        raise unauthorized("Token has no usable email claim")
    name = str(claims.get("name") or claims.get("preferred_username") or email.split("@")[0])[:200]
    org = str(claims.get("tiles_org") or settings.oidc_default_org).strip().lower()
    if not SLUG.match(org):
        raise unauthorized("Token has an invalid tiles_org claim")
    return Principal(
        email=email,
        name=name,
        org=org,
        role=role_from_claims(claims),
        issuer=str(claims["iss"]),
        subject=str(claims["sub"]),
    )


def verifier(request: Request) -> TokenVerifier | None:
    state = request.app.state
    settings: Settings = state.settings
    if not settings.oidc_issuer:
        return None
    if getattr(state, "verifier", None) is None:
        state.verifier = TokenVerifier(settings)
    v: TokenVerifier = state.verifier
    return v


def authenticate(request: Request) -> Principal:
    settings: Settings = request.app.state.settings
    header = request.headers.get("authorization", "")
    if header:
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise unauthorized("Authorization must be a Bearer token")
        v = verifier(request)
        if v is None:
            raise unauthorized("Sign-in is not configured on this server")
        return principal_from_claims(v.verify(token.strip()), settings)
    if settings.env == "production":
        raise unauthorized("Sign in to use Tiles")
    email = (request.headers.get("x-tiles-user") or settings.dev_user_email).strip().lower()
    if not EMAIL.match(email):
        raise HTTPException(400, "X-Tiles-User must be an email address")
    name = settings.dev_user_name if email == settings.dev_user_email.lower() else email.split("@")[0]
    return Principal(email=email, name=name, org=None, role="engineer")
