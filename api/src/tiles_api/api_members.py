"""Site membership: your role, the member list, and (admins) changing roles."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict

from tiles_api import audit
from tiles_api.api_ontology import Admin, Ctx
from tiles_api.store import one

router = APIRouter(tags=["members"])

RoleName = Literal["viewer", "engineer", "admin"]


class Member(BaseModel):
    user_id: uuid.UUID
    email: str
    name: str
    # The role that counts: organisation admins are admins on every site.
    role: RoleName
    site_role: RoleName
    org_admin: bool


class RoleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    role: RoleName


MEMBERS_SQL = """
SELECT u.id AS user_id, u.email, u.name, m.role AS site_role, u.org_admin,
       CASE WHEN u.org_admin THEN 'admin' ELSE m.role END AS role
FROM site_members m JOIN users u ON u.id = m.user_id
WHERE m.site_id = %s
"""


@router.get("/sites/{site_id}/me", response_model=Member)
def my_membership(ctx: Ctx) -> dict[str, Any]:
    """Your membership of this site (joining it on first visit), including your role."""
    row = ctx.conn.execute(MEMBERS_SQL + " AND u.id = %s", [ctx.site_id, ctx.user.id]).fetchone()
    if row is None:  # pragma: no cover - site_context just created it
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not a member")
    return row


@router.get("/sites/{site_id}/members", response_model=list[Member])
def list_members(ctx: Ctx) -> list[dict[str, Any]]:
    return ctx.conn.execute(MEMBERS_SQL + " ORDER BY u.email", [ctx.site_id]).fetchall()


@router.put("/sites/{site_id}/members/{user_id}", response_model=Member)
def set_role(ctx: Admin, user_id: uuid.UUID, body: RoleIn) -> dict[str, Any]:
    """Change a member's role on this site (admins only; not your own)."""
    if user_id == ctx.user.id:
        raise HTTPException(status.HTTP_409_CONFLICT, "Ask another admin to change your own role")
    # FOR UPDATE: a concurrent change to this member waits, and then this reads its result,
    # so each audit entry's "before" is the role its own update replaced.
    old = ctx.conn.execute(
        "SELECT role FROM site_members WHERE site_id = %s AND user_id = %s FOR UPDATE", [ctx.site_id, user_id]
    ).fetchone()
    updated = ctx.conn.execute(
        "UPDATE site_members SET role = %s WHERE site_id = %s AND user_id = %s RETURNING user_id",
        [body.role, ctx.site_id, user_id],
    ).fetchone()
    if updated is None or old is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Not a member of this site")
    if old["role"] != body.role:
        ctx.audit("member.role", "site_member", str(user_id), before={"role": old["role"]}, after={"role": body.role})
    return one(ctx.conn.execute(MEMBERS_SQL + " AND u.id = %s", [ctx.site_id, user_id]).fetchone())


class AuditEntry(BaseModel):
    id: int
    at: datetime
    actor_id: uuid.UUID | None
    actor_name: str
    action: str
    entity_type: str
    entity_id: str
    before: Any
    after: Any
    request_id: str | None


@router.get("/sites/{site_id}/audit", response_model=list[AuditEntry], tags=["audit"])
def audit_log(
    ctx: Admin, limit: Annotated[int, Query(ge=1, le=500)] = 100, offset: Annotated[int, Query(ge=0)] = 0
) -> list[dict[str, Any]]:
    """Every change on this site, newest first (admins only)."""
    return audit.entries(ctx.conn, ctx.site_id, limit, offset)
