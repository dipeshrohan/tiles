"""Turning an authenticated principal into a Tiles user with a role on a site.

Organisations and users are created on first sign-in. A user's first visit to
a site makes them a member with the role their token grants (viewer unless it
carries tiles-engineer or tiles-admin); after that the stored membership is
what counts, so admins can change it (T1.17). A user deactivated or deleted
(through SCIM, T5.05) can't sign in, and an organisation that enforces its own
identity provider takes no other sign-in.
"""

import uuid
from dataclasses import dataclass

import psycopg
from fastapi import HTTPException

from tiles_api import audit
from tiles_api.auth import Principal
from tiles_api.store import Conn, one


@dataclass(frozen=True)
class User:
    id: uuid.UUID
    name: str
    email: str
    role: str


def ensure_org(conn: Conn, slug: str) -> uuid.UUID:
    name = slug.replace("-", " ").title()
    row = one(
        conn.execute(
            "INSERT INTO orgs (slug, name) VALUES (%s, %s) ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug"
            " RETURNING id",
            [slug, name],
        ).fetchone()
    )
    org_id: uuid.UUID = row["id"]
    return org_id


def ensure_user(conn: Conn, p: Principal, org_id: uuid.UUID) -> dict[str, object]:
    """The user `p` is in the organisation, created or linked on first sign-in; 403 when they may
    not sign in (deactivated, or not through the organisation's enforced provider). The
    organisation's provider is read here on every request, so removing it, or enforcing it, takes
    effect at once on every API process; a pending one is confirmed by its first sign-in, which
    only the admin who saved it can make."""
    provider = conn.execute(
        "SELECT p.issuer, p.enforced, p.verified_at, u.email AS confirmer FROM org_identity_providers p"
        " LEFT JOIN users u ON u.id = p.saved_by WHERE p.org_id = %s",
        [org_id],
    ).fetchone()
    confirming = False
    if p.org_provider:
        if provider is None or provider["issuer"] != p.issuer:
            raise HTTPException(
                401,
                "Your organisation no longer signs in this way",
                headers={"WWW-Authenticate": 'Bearer error="invalid_token"'},
            )
        if provider["verified_at"] is None:
            if p.email != provider["confirmer"]:
                raise HTTPException(403, "Your organisation's sign-in isn't confirmed yet")
            confirming = True
    elif p.subject and provider is not None and provider["enforced"]:
        raise HTTPException(403, "Your organisation signs in through its own identity provider")
    user = _ensure_user(conn, p, org_id)
    if not user["active"] or user["deleted_at"] is not None:
        raise HTTPException(403, "Your account has been deactivated; ask your organisation's administrator")
    if confirming:
        _confirm(conn, org_id, user)
    return user


def _confirm(conn: Conn, org_id: uuid.UUID, user: dict[str, object]) -> None:
    """The organisation's pending provider works, signed in through by the admin who saved it."""
    try:
        with conn.transaction():
            conn.execute(
                "UPDATE org_identity_providers SET verified_at = now() WHERE org_id = %s AND verified_at IS NULL",
                [org_id],
            )
    except psycopg.errors.UniqueViolation as e:
        raise HTTPException(409, "Another organisation has confirmed this provider") from e
    audit.record_org(
        conn,
        org_id=org_id,
        actor_id=user["id"],
        actor_name=str(user["name"]),
        action="org.identity_provider.confirm",
        entity_type="org_identity_provider",
        entity_id=str(org_id),
    )


def _ensure_user(conn: Conn, p: Principal, org_id: uuid.UUID) -> dict[str, object]:
    if p.subject:
        # Known by their identity-provider subject: refresh name and email (unless the email is
        # another user's now: SCIM may have renamed them, and given it to someone else).
        row = conn.execute(
            "UPDATE users SET name = %s, last_seen_at = now(), email = CASE WHEN EXISTS"
            " (SELECT 1 FROM users o WHERE o.org_id = users.org_id AND o.email = %s AND o.id <> users.id)"
            " THEN email ELSE %s END"
            " WHERE oidc_issuer = %s AND oidc_subject = %s"
            " RETURNING id, name, email, org_admin, org_id, active, deleted_at",
            [p.name, p.email, p.email, p.issuer, p.subject],
        ).fetchone()
        if row:
            if row["org_id"] != org_id:
                # Policy: an identity belongs to one organisation; moving it is an admin task.
                raise HTTPException(403, "Your sign-in belongs to another organisation")
            return row
        # A user created before sign-in (same email, no subject yet: by an admin or SCIM): link
        # them. A user bound to another issuer moves too: to the organisation's own provider from
        # this deployment's (before the organisation had one), and back if it is removed. Never
        # to another identity of the same issuer.
        row = conn.execute(
            "UPDATE users SET oidc_issuer = %s, oidc_subject = %s, name = %s, last_seen_at = now()"
            " WHERE org_id = %s AND email = %s AND (oidc_subject IS NULL OR oidc_issuer IS DISTINCT FROM %s)"
            " RETURNING id, name, email, org_admin, org_id, active, deleted_at",
            [p.issuer, p.subject, p.name, org_id, p.email, p.issuer],
        ).fetchone()
        if row:
            return row
        row = conn.execute(
            "INSERT INTO users (org_id, email, name, oidc_issuer, oidc_subject) VALUES (%s, %s, %s, %s, %s)"
            " ON CONFLICT (org_id, email) DO NOTHING RETURNING id, name, email, org_admin, org_id, active, deleted_at",
            [org_id, p.email, p.name, p.issuer, p.subject],
        ).fetchone()
        if row is None:
            # The email belongs to a user bound to a different sign-in: never hand it over.
            raise HTTPException(409, "This email already belongs to another sign-in")
        return row
    # The dev identity (never in production) acts as whoever owns the email.
    return one(
        conn.execute(
            "INSERT INTO users (org_id, email, name) VALUES (%s, %s, %s)"
            " ON CONFLICT (org_id, email) DO UPDATE SET last_seen_at = now()"
            " RETURNING id, name, email, org_admin, org_id, active, deleted_at",
            [org_id, p.email, p.name],
        ).fetchone()
    )


def resolve_user(conn: Conn, p: Principal, site_id: uuid.UUID, org_id: uuid.UUID, org_slug: str) -> User:
    """The requesting user and their role on `site_id`."""
    if p.org is not None and p.org != org_slug:
        raise HTTPException(403, "This site belongs to another organisation")
    user = ensure_user(conn, p, org_id)
    member = one(
        conn.execute(
            """
            INSERT INTO site_members (site_id, user_id, role) VALUES (%s, %s, %s)
            ON CONFLICT (site_id, user_id) DO UPDATE SET role = site_members.role
            RETURNING role
            """,
            [site_id, user["id"], p.role],
        ).fetchone()
    )
    role = "admin" if user["org_admin"] else str(member["role"])
    return User(id=user["id"], name=str(user["name"]), email=str(user["email"]), role=role)  # type: ignore[arg-type]
