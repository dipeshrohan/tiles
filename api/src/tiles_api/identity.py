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

from fastapi import HTTPException

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
    not sign in (deactivated, or not through the organisation's enforced provider)."""
    if p.subject and not p.org_provider:
        enforced = conn.execute(
            "SELECT 1 FROM org_identity_providers WHERE org_id = %s AND enforced", [org_id]
        ).fetchone()
        if enforced:
            raise HTTPException(403, "Your organisation signs in through its own identity provider")
    user = _ensure_user(conn, p, org_id)
    if not user["active"] or user["deleted_at"] is not None:
        raise HTTPException(403, "Your account has been deactivated; ask your organisation's administrator")
    return user


def _ensure_user(conn: Conn, p: Principal, org_id: uuid.UUID) -> dict[str, object]:
    if p.subject:
        # Known by their identity-provider subject: refresh name and email.
        row = conn.execute(
            "UPDATE users SET email = %s, name = %s, last_seen_at = now()"
            " WHERE oidc_issuer = %s AND oidc_subject = %s"
            " RETURNING id, name, email, org_admin, org_id, active, deleted_at",
            [p.email, p.name, p.issuer, p.subject],
        ).fetchone()
        if row:
            if row["org_id"] != org_id:
                # Policy: an identity belongs to one organisation; moving it is an admin task.
                raise HTTPException(403, "Your sign-in belongs to another organisation")
            return row
        # A user created before sign-in (same email, no subject yet: by an admin or SCIM): link
        # them. The organisation's own provider vouches for its people, so it also takes over a
        # user bound to another issuer (this deployment's, before the organisation had one); never
        # one bound to itself under another subject.
        row = conn.execute(
            "UPDATE users SET oidc_issuer = %s, oidc_subject = %s, name = %s, last_seen_at = now()"
            " WHERE org_id = %s AND email = %s"
            " AND (oidc_subject IS NULL OR (%s AND oidc_issuer IS DISTINCT FROM %s))"
            " RETURNING id, name, email, org_admin, org_id, active, deleted_at",
            [p.issuer, p.subject, p.name, org_id, p.email, p.org_provider, p.issuer],
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
