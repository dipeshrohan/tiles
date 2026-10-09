"""An organisation's own sign-in (T5.05): its identity provider (a customer's Entra ID tenant, say)
and the tokens its SCIM client provisions users with.

Organisation admins set them. Tokens from the provider's issuer sign in to this organisation only;
its groups can map to Tiles roles; once a sign-in through it works, `enforced` refuses the
deployment's own issuer for the organisation. Turning that on needs a caller signed in through
the provider, so no one locks the organisation out with a provider that doesn't work.
"""

import hashlib
import secrets
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

import psycopg
from fastapi import APIRouter, HTTPException, Query, Request, Response, status
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, field_validator

from tiles_api import audit
from tiles_api.api_ontology import Auth
from tiles_api.api_sites import OrgAdmin, org_slug
from tiles_api.auth import OrgProvider
from tiles_api.identity import ensure_org, ensure_user
from tiles_api.store import DbConn, side_pool

router = APIRouter(tags=["organisation sign-in"])

SCIM_TOKEN_PREFIX = "tiles_scim_"  # noqa: S105 - a prefix, not a secret
PROVIDER_SQL = """
    SELECT o.slug, p.issuer, p.client_id, p.audience, p.scope, p.jwks_url, p.group_roles, p.enforced, p.updated_at
    FROM org_identity_providers p JOIN orgs o ON o.id = p.org_id
"""


def _provider(row: dict[str, Any]) -> OrgProvider:
    return OrgProvider(
        org=row["slug"],
        issuer=row["issuer"],
        client_id=row["client_id"],
        audience=row["audience"],
        scope=row["scope"],
        jwks_url=row["jwks_url"],
        group_roles=dict(row["group_roles"]),
    )


def _find(state: Any, where: str, value: str) -> OrgProvider | None:
    if not state.settings.database_url:
        return None
    try:
        with side_pool(state).connection() as conn:
            row = conn.execute(f"{PROVIDER_SQL} WHERE {where} = %s", [value]).fetchone()
    except psycopg.Error as e:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "Sign-in is unavailable; try again") from e
    return _provider(row) if row else None


def provider_by_issuer(state: Any, issuer: str) -> OrgProvider | None:
    """The organisation's provider whose tokens carry this issuer (auth.Verifiers asks)."""
    return _find(state, "p.issuer", issuer)


def provider_by_org(state: Any, slug: str) -> OrgProvider | None:
    """An organisation's provider, for the browser to sign in with (/auth/config?org=)."""
    return _find(state, "o.slug", slug)


def scim_token_hash(token: str) -> bytes:
    return hashlib.sha256(token.encode()).digest()


Role = Literal["viewer", "engineer", "admin"]


class ProviderIn(BaseModel):
    issuer: str = Field(
        description="The tokens' `iss`, exactly. Entra ID: https://login.microsoftonline.com/<tenant-id>/v2.0",
        max_length=500,
    )
    client_id: str = Field(min_length=1, max_length=200, description="The browser's client (a public SPA client)")
    audience: str = Field(min_length=1, max_length=500, description="The tokens' `aud`: Entra ID, the API app's ID")
    scope: str = Field(
        "openid email profile",
        max_length=500,
        description="What the browser asks for. Entra ID: openid profile email offline_access api://<api-app-id>/access",
    )
    jwks_url: str | None = Field(None, max_length=500, description="The signing keys; empty: from discovery")
    group_roles: dict[str, Role] = Field(
        default_factory=dict, description="The provider's group IDs (the `groups` claim) and the role each grants"
    )
    enforced: bool = Field(False, description="Refuse every other sign-in for this organisation")

    @field_validator("issuer")
    @classmethod
    def _issuer(cls, v: str) -> str:
        v = v.strip()
        if not v.startswith("https://") or any(c in v for c in "?# ") or v.endswith("/"):
            raise ValueError("The issuer is an https URL with no query, fragment or trailing slash")
        return v

    @field_validator("jwks_url")
    @classmethod
    def _jwks(cls, v: str | None) -> str | None:
        v = (v or "").strip() or None
        if v is not None and not v.startswith("https://"):
            raise ValueError("The signing keys' URL must be https")
        return v

    @field_validator("group_roles")
    @classmethod
    def _groups(cls, v: dict[str, Role]) -> dict[str, Role]:
        if len(v) > 100 or any(not g.strip() or len(g) > 200 for g in v):
            raise ValueError("Up to 100 group IDs, none empty")
        return v


class ProviderOut(ProviderIn):
    updated_at: datetime


class ScimTokenIn(BaseModel):
    name: str = Field(min_length=1, max_length=120, description="Which client uses it, e.g. Entra ID provisioning")


class ScimToken(BaseModel):
    id: uuid.UUID
    name: str
    created_at: datetime
    last_used_at: datetime | None
    revoked_at: datetime | None


class NewScimToken(ScimToken):
    token: str = Field(description="Shown once: give it to the SCIM client as its secret token")


class MyOrg(BaseModel):
    slug: str | None = Field(description="None: the development identity, with several organisations to choose from")
    name: str | None
    admin: bool = Field(description="Whether you manage the organisation: its sites, sign-in and SCIM tokens")


@router.get("/org", response_model=MyOrg)
def my_org(principal: Auth, conn: DbConn, org: Annotated[str | None, Query()] = None) -> MyOrg:
    """Your organisation, and whether you are its admin (an organisation admin, or someone whose
    sign-in grants admin). The development identity names one with `?org=`, or gets the only one."""
    slug = org_slug(principal, conn, org)
    if slug is None:
        return MyOrg(slug=None, name=None, admin=False)
    org_id = ensure_org(conn, slug)
    user = ensure_user(conn, principal, org_id)
    name = conn.execute("SELECT name FROM orgs WHERE id = %s", [org_id]).fetchone()
    return MyOrg(
        slug=slug, name=name["name"] if name else slug, admin=bool(user["org_admin"]) or principal.role == "admin"
    )


def _forget(request: Request) -> None:
    verifiers = request.app.state.verifiers
    if verifiers is not None:
        verifiers.forget()


@router.get("/org/identity-provider", response_model=ProviderOut | None)
def get_provider(caller: OrgAdmin) -> dict[str, Any] | None:
    """Your organisation's identity provider, or null when it signs in through this deployment's."""
    row: dict[str, Any] | None = caller.conn.execute(f"{PROVIDER_SQL} WHERE p.org_id = %s", [caller.org_id]).fetchone()
    return row


@router.put("/org/identity-provider", response_model=ProviderOut)
def set_provider(body: ProviderIn, caller: OrgAdmin, request: Request) -> dict[str, Any]:
    """Sets your organisation's identity provider. Its tokens then sign in to your organisation
    only. Turning `enforced` on needs you signed in through it (409 otherwise), so a provider that
    doesn't work can't lock everyone out; then no other sign-in reaches your organisation."""
    settings = request.app.state.settings
    if settings.oidc_issuer and body.issuer == settings.oidc_issuer.rstrip("/"):
        raise HTTPException(status.HTTP_409_CONFLICT, "That is this deployment's own issuer")
    conn = caller.conn
    before: dict[str, Any] | None = conn.execute(f"{PROVIDER_SQL} WHERE p.org_id = %s", [caller.org_id]).fetchone()
    if body.enforced and not (caller.via_provider and before and before["issuer"] == body.issuer):
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            "Save the provider first, then sign in through it and turn enforcement on: that shows it works",
        )
    try:
        with conn.transaction():
            conn.execute(
                """
                INSERT INTO org_identity_providers
                    (org_id, issuer, client_id, audience, scope, jwks_url, group_roles, enforced)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (org_id) DO UPDATE SET issuer = EXCLUDED.issuer, client_id = EXCLUDED.client_id,
                    audience = EXCLUDED.audience, scope = EXCLUDED.scope, jwks_url = EXCLUDED.jwks_url,
                    group_roles = EXCLUDED.group_roles, enforced = EXCLUDED.enforced, updated_at = now()
                """,
                [
                    caller.org_id,
                    body.issuer,
                    body.client_id,
                    body.audience,
                    body.scope,
                    body.jwks_url,
                    Jsonb(body.group_roles),
                    body.enforced,
                ],
            )
    except psycopg.errors.UniqueViolation as e:
        raise HTTPException(status.HTTP_409_CONFLICT, "Another organisation signs in with that issuer") from e
    row: dict[str, Any] = conn.execute(f"{PROVIDER_SQL} WHERE p.org_id = %s", [caller.org_id]).fetchone() or {}
    audit.record_org(
        conn,
        org_id=caller.org_id,
        actor_id=caller.user_id,
        actor_name=caller.name,
        action="org.identity_provider.set",
        entity_type="org_identity_provider",
        entity_id=str(caller.org_id),
        before=_audited(before),
        after=_audited(row),
    )
    _forget(request)
    return row


@router.delete("/org/identity-provider", status_code=status.HTTP_204_NO_CONTENT)
def delete_provider(caller: OrgAdmin, request: Request) -> Response:
    """Removes your organisation's identity provider: its tokens stop working at once, and people
    sign in through this deployment's issuer again."""
    conn = caller.conn
    before: dict[str, Any] | None = conn.execute(f"{PROVIDER_SQL} WHERE p.org_id = %s", [caller.org_id]).fetchone()
    if before is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Your organisation has no identity provider")
    conn.execute("DELETE FROM org_identity_providers WHERE org_id = %s", [caller.org_id])
    audit.record_org(
        conn,
        org_id=caller.org_id,
        actor_id=caller.user_id,
        actor_name=caller.name,
        action="org.identity_provider.delete",
        entity_type="org_identity_provider",
        entity_id=str(caller.org_id),
        before=_audited(before),
    )
    _forget(request)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


def _audited(row: dict[str, Any] | None) -> dict[str, Any] | None:
    if row is None:
        return None
    return {k: v for k, v in row.items() if k not in ("slug", "updated_at")}


SCIM_TOKENS = "SELECT id, name, created_at, last_used_at, revoked_at FROM scim_tokens"


@router.get("/org/scim-tokens", response_model=list[ScimToken])
def list_scim_tokens(caller: OrgAdmin) -> list[dict[str, Any]]:
    """Your organisation's SCIM tokens, newest first (never the tokens themselves)."""
    return caller.conn.execute(f"{SCIM_TOKENS} WHERE org_id = %s ORDER BY created_at DESC", [caller.org_id]).fetchall()


@router.post("/org/scim-tokens", response_model=NewScimToken, status_code=status.HTTP_201_CREATED)
def create_scim_token(body: ScimTokenIn, caller: OrgAdmin) -> dict[str, Any]:
    """A token for your identity provider's SCIM client (`/scim/v2`), which then creates, updates
    and deactivates your organisation's users. It is shown once; only its hash is kept."""
    token = SCIM_TOKEN_PREFIX + secrets.token_urlsafe(32)
    row: dict[str, Any] = (
        caller.conn.execute(
            "INSERT INTO scim_tokens (org_id, name, token_hash, created_by) VALUES (%s, %s, %s, %s)"
            " RETURNING id, name, created_at, last_used_at, revoked_at",
            [caller.org_id, body.name.strip(), scim_token_hash(token), caller.user_id],
        ).fetchone()
        or {}
    )
    audit.record_org(
        caller.conn,
        org_id=caller.org_id,
        actor_id=caller.user_id,
        actor_name=caller.name,
        action="scim_token.create",
        entity_type="scim_token",
        entity_id=str(row["id"]),
        after={"name": row["name"]},
    )
    return {**row, "token": token}


@router.delete("/org/scim-tokens/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_scim_token(token_id: uuid.UUID, caller: OrgAdmin) -> Response:
    """Revokes a SCIM token: it stops working at once."""
    row = caller.conn.execute(
        "UPDATE scim_tokens SET revoked_at = now() WHERE id = %s AND org_id = %s AND revoked_at IS NULL RETURNING name",
        [token_id, caller.org_id],
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such active SCIM token in your organisation")
    audit.record_org(
        caller.conn,
        org_id=caller.org_id,
        actor_id=caller.user_id,
        actor_name=caller.name,
        action="scim_token.revoke",
        entity_type="scim_token",
        entity_id=str(token_id),
        before={"name": row["name"]},
    )
    return Response(status_code=status.HTTP_204_NO_CONTENT)
