"""Who is making the request.

Placeholder until single sign-on (T1.16): in development and test, requests
act as the user named in the X-Tiles-User header (an email address) or the
configured dev user, created on first sight. Production refuses them.
"""

import re
import uuid
from dataclasses import dataclass

from fastapi import HTTPException, Request

from tiles_api.settings import Settings
from tiles_api.store import Conn, one

EMAIL = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}$")


@dataclass(frozen=True)
class User:
    id: uuid.UUID
    name: str
    email: str
    role: str


def resolve_user(conn: Conn, settings: Settings, request: Request, org_id: uuid.UUID, site_id: uuid.UUID) -> User:
    """The requesting user and their role on `site_id`.

    Dev users are created on first sight and made engineers on the site they
    open. Single sign-on (T1.16) will replace this with real memberships.
    """
    if settings.env == "production":
        raise HTTPException(401, "Sign-in is not available yet")
    email = (request.headers.get("x-tiles-user") or settings.dev_user_email).strip().lower()
    if not EMAIL.match(email):
        raise HTTPException(400, "X-Tiles-User must be an email address")
    name = settings.dev_user_name if email == settings.dev_user_email.lower() else email.split("@")[0]
    user = one(
        conn.execute(
            """
            INSERT INTO users (org_id, email, name) VALUES (%s, %s, %s)
            ON CONFLICT (org_id, email) DO UPDATE SET last_seen_at = now()
            RETURNING id, name, email, org_admin
            """,
            [org_id, email, name],
        ).fetchone()
    )
    member = one(
        conn.execute(
            """
            INSERT INTO site_members (site_id, user_id, role) VALUES (%s, %s, 'engineer')
            ON CONFLICT (site_id, user_id) DO UPDATE SET role = site_members.role
            RETURNING role
            """,
            [site_id, user["id"]],
        ).fetchone()
    )
    role = "admin" if user["org_admin"] else member["role"]
    return User(id=user["id"], name=user["name"], email=user["email"], role=role)
