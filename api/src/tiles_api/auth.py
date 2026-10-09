"""Authentication: OpenID Connect bearer tokens, plus a dev identity.

Production accepts only valid bearer tokens: from the configured issuer, or
from an organisation's own identity provider (T5.05, a customer's Entra ID
tenant, say), whose tokens sign in to that organisation only. Elsewhere a
request without a token acts as the dev user (or the email in an X-Tiles-User
header), so tests, curl and the local stack work without a sign-in. A token
that is present is always verified; a bad one is a 401.
"""

import ipaddress
import json
import re
import socket
import threading
import time
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
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
    # Signed in through the organisation's own identity provider (its slug is `org`).
    org_provider: bool = False


@dataclass(frozen=True)
class OrgProvider:
    """An organisation's own identity provider (migration 0027)."""

    org: str
    issuer: str
    client_id: str
    audience: str
    scope: str
    jwks_url: str | None = None
    group_roles: dict[str, str] = field(default_factory=dict)
    # Confirmed by the admin who saved it signing in through it; until then it takes them only.
    verified: bool = True
    confirmer: str | None = None  # that admin's email, while pending


def unauthorized(message: str) -> HTTPException:
    return HTTPException(401, message, headers={"WWW-Authenticate": 'Bearer error="invalid_token"'})


class TokenVerifier:
    """Checks signature, issuer, audience and expiry of OIDC access tokens."""

    def __init__(
        self,
        issuer: str,
        audience: str,
        jwks_url: str | None = None,
        jwk_client: Any = None,
        public_only: bool = False,
    ) -> None:
        self.issuer = issuer.rstrip("/")
        self.audience = audience
        self._jwks_url = jwks_url
        self._client = jwk_client
        # An organisation's provider, whose addresses its admins chose: fetched only from public
        # addresses, never the cluster's own services.
        self._public_only = public_only
        self._lock = threading.Lock()

    def _jwk_client(self) -> Any:
        with self._lock:
            if self._client is None:
                if self._public_only:
                    public_https(self._jwks_url or self.issuer)
                url = self._jwks_url or discover_jwks_url(self.issuer)
                if self._public_only:
                    public_https(url)
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


def public_https(url: str) -> None:
    """Refuses (as an unreachable provider) an address that isn't https, or whose host resolves to
    a private, loopback, link-local or otherwise non-public address."""
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        raise jwt.PyJWKClientConnectionError("the provider's address must be https")
    try:
        found = socket.getaddrinfo(parts.hostname, parts.port or 443, proto=socket.IPPROTO_TCP)
    except OSError as e:
        raise jwt.PyJWKClientConnectionError("the provider's host doesn't resolve") from e
    for *_, address in found:
        if not ipaddress.ip_address(str(address[0]).split("%")[0]).is_global:
            raise jwt.PyJWKClientConnectionError("the provider's host isn't a public address")


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


def role_from_claims(claims: dict[str, Any], group_roles: dict[str, str] | None = None) -> Role:
    """Highest Tiles role in the token: tiles-admin or tiles-engineer, otherwise viewer.

    Only the tiles- names count, in Keycloak realm roles or a `roles` claim (Entra ID's app
    roles): realm roles are shared by every application in the realm, so a bare "admin" there
    says nothing about Tiles. An organisation's provider may also map its groups (the `groups`
    claim: Entra ID gives their object IDs) to roles.
    """
    roles: set[str] = set()
    realm = claims.get("realm_access")
    if isinstance(realm, dict) and isinstance(realm.get("roles"), list):
        roles.update(str(r) for r in realm["roles"])
    if isinstance(claims.get("roles"), list):
        roles.update(str(r) for r in claims["roles"])
    if group_roles and isinstance(claims.get("groups"), list):
        roles.update(f"tiles-{group_roles[g]}" for g in map(str, claims["groups"]) if g in group_roles)
    for role in ("admin", "engineer"):
        if f"tiles-{role}" in roles:
            return role
    return "viewer"


def email_from_claims(claims: dict[str, Any]) -> str:
    """The user's email: `email`, or for Entra ID, whose access tokens often lack it, the sign-in
    name (`preferred_username`, `upn`), which is an email address there."""
    for name in ("email", "preferred_username", "upn"):
        value = str(claims.get(name) or "").strip().lower()
        if EMAIL.match(value):
            return value
    raise unauthorized("Token has no usable email claim")


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


def principal_from_org_claims(claims: dict[str, Any], provider: OrgProvider) -> Principal:
    """A token from an organisation's own provider: that organisation, whatever the token claims
    (`tiles_org` is ignored), so a customer's tenant can never sign in to another."""
    email = email_from_claims(claims)
    name = str(claims.get("name") or email.split("@")[0])[:200]
    return Principal(
        email=email,
        name=name,
        org=provider.org,
        role=role_from_claims(claims, provider.group_roles),
        issuer=str(claims["iss"]),
        subject=str(claims["sub"]),
        org_provider=True,
    )


PROVIDER_TTL = 60.0  # seconds an issuer's providers (or their absence) are remembered
UNKNOWN_MAX = 1000  # unknown issuers remembered at most (then forgotten, not the known ones)
ISSUER = re.compile(r"^https://[^/?#\s]{1,253}(/[^?#\s]{0,240})?$")


class Verifiers:
    """The token verifiers of this API: the configured issuer's, and organisations' providers',
    looked up by the token's issuer (from the database, remembered for a minute). Whether a
    provider still holds, and its enforcement, are checked against the database on every request
    (identity.ensure_user), so a removed provider stops at once."""

    def __init__(self, settings: Settings, lookup: Any, jwk_client: Any = None) -> None:
        self.settings = settings
        self._lookup = lookup  # issuer -> tuple[OrgProvider, ...]
        self._jwk_client = jwk_client  # tests: one stand-in for every issuer's keys
        self._lock = threading.Lock()
        self._known: dict[str, tuple[float, tuple[OrgProvider, ...]]] = {}
        self._unknown: dict[str, float] = {}
        self._verifiers: dict[tuple[str, str, str | None], TokenVerifier] = {}

    def _verifier(self, issuer: str, audience: str, jwks_url: str | None, public_only: bool) -> TokenVerifier:
        key = (issuer, audience, jwks_url)
        with self._lock:
            if key not in self._verifiers:
                self._verifiers[key] = TokenVerifier(issuer, audience, jwks_url, self._jwk_client, public_only)
            return self._verifiers[key]

    def providers(self, issuer: str, now: float | None = None) -> tuple[OrgProvider, ...]:
        """The organisations' providers with this issuer: the confirmed one, or those pending."""
        now = time.monotonic() if now is None else now
        if not ISSUER.match(issuer):
            return ()
        with self._lock:
            known = self._known.get(issuer)
            if known and known[0] > now:
                return known[1]
            if self._unknown.get(issuer, 0.0) > now:
                return ()
        found: tuple[OrgProvider, ...] = tuple(self._lookup(issuer))
        with self._lock:
            if any(p.verified for p in found):
                self._known[issuer] = (now + PROVIDER_TTL, found)
                self._unknown.pop(issuer, None)
            elif found:
                # Pending only: not remembered, so its confirmation (on any API process) counts
                # at once. Only organisation admins make pending providers, and briefly.
                self._known.pop(issuer, None)
                self._unknown.pop(issuer, None)
            else:
                if len(self._unknown) >= UNKNOWN_MAX:
                    self._unknown.clear()  # random issuers can't fill memory, nor evict real ones
                self._unknown[issuer] = now + PROVIDER_TTL
                self._known.pop(issuer, None)
        return found

    def forget(self) -> None:
        """After an organisation's provider changes: look it up again."""
        with self._lock:
            self._known.clear()
            self._unknown.clear()

    def principal(self, token: str) -> Principal:
        try:
            unverified = jwt.decode(token, options={"verify_signature": False})
        except jwt.PyJWTError as e:
            raise unauthorized(f"Invalid token: {e}") from e
        issuer = str(unverified.get("iss") or "").rstrip("/")
        settings = self.settings
        if settings.oidc_issuer and issuer == settings.oidc_issuer.rstrip("/"):
            v = self._verifier(issuer, settings.oidc_audience, settings.oidc_jwks_url, False)
            return principal_from_claims(v.verify(token), settings)
        candidates = self.providers(issuer)
        provider = next((p for p in candidates if p.verified), None)
        if provider is None and candidates:
            # Pending providers take only the admin who saved them, signing in to confirm.
            email = email_from_claims(unverified)
            provider = next((p for p in candidates if p.confirmer == email), None)
        if provider is None:
            raise unauthorized("Tokens from this issuer aren't accepted here")
        v = self._verifier(provider.issuer, provider.audience, provider.jwks_url, True)
        principal = principal_from_org_claims(v.verify(token), provider)
        if not provider.verified and principal.email != provider.confirmer:
            raise unauthorized("Tokens from this issuer aren't accepted here")
        return principal


def make_verifiers(state: Any, jwk_client: Any = None) -> Verifiers:
    """The app's verifiers, finding organisations' providers in its database."""
    from tiles_api.org_sign_in import provider_by_issuer

    return Verifiers(state.settings, lambda issuer: provider_by_issuer(state, issuer), jwk_client)


def verifiers(request: Request) -> Verifiers:
    state = request.app.state
    if getattr(state, "verifiers", None) is None:
        state.verifiers = make_verifiers(state)
    v: Verifiers = state.verifiers
    return v


def authenticate(request: Request) -> Principal:
    settings: Settings = request.app.state.settings
    header = request.headers.get("authorization", "")
    if header:
        scheme, _, token = header.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise unauthorized("Authorization must be a Bearer token")
        return verifiers(request).principal(token.strip())
    if settings.env == "production":
        raise unauthorized("Sign in to use Tiles")
    email = (request.headers.get("x-tiles-user") or settings.dev_user_email).strip().lower()
    if not EMAIL.match(email):
        raise HTTPException(400, "X-Tiles-User must be an email address")
    name = settings.dev_user_name if email == settings.dev_user_email.lower() else email.split("@")[0]
    return Principal(email=email, name=name, org=None, role="engineer")
