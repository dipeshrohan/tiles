"""Saved views (U5.06): a page's filters (its address's query), and its table's sort and columns,
kept under a name. A view is its owner's own until they share it with the site, which takes an
engineer: a shared view shows in everyone's list and menu. Only its owner changes a view; a site
admin may also delete a shared one. Every change is audited."""

import re
import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Response, status
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, field_validator

from tiles_api.api_ontology import ROLE_RANK, Ctx

router = APIRouter(tags=["Saved views"])

Page = Literal["warnings", "signals", "documents"]
MAX_VIEWS = 50  # a person's views on a site
KEY = re.compile(r"[a-z][a-z0-9_-]{0,31}")


class TablePrefs(BaseModel):
    """The table's sort, hidden columns and density, as the browser keeps them."""

    model_config = ConfigDict(extra="forbid")
    sort: dict[str, str] | None = None
    hidden: Annotated[list[str], Field(max_length=40)] = []
    density: Literal["comfortable", "compact"] = "comfortable"

    @field_validator("sort")
    @classmethod
    def _sort(cls, sort: dict[str, str] | None) -> dict[str, str] | None:
        if sort is None:
            return None
        if set(sort) != {"key", "dir"} or sort["dir"] not in ("asc", "desc") or not KEY.fullmatch(sort["key"]):
            raise ValueError("sort is {key, dir} with dir asc or desc")
        return sort

    @field_validator("hidden")
    @classmethod
    def _hidden(cls, hidden: list[str]) -> list[str]:
        if not all(KEY.fullmatch(h) for h in hidden):
            raise ValueError("hidden lists column keys")
        return hidden


def _query(query: dict[str, str]) -> dict[str, str]:
    if len(query) > 12:
        raise ValueError("At most 12 filters")
    for k, v in query.items():
        if not KEY.fullmatch(k):
            raise ValueError(f"Not a filter: {k[:40]!r}")
        if len(v) > 200:
            raise ValueError(f"The filter {k} is longer than 200 characters")
    return query


class ViewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    page: Page
    name: Annotated[str, Field(min_length=1, max_length=80)]
    query: dict[str, str] = Field(default_factory=dict, description="The page's filters, as in its address")
    table: TablePrefs | None = None
    shared: bool = False

    @field_validator("query")
    @classmethod
    def _q(cls, q: dict[str, str]) -> dict[str, str]:
        return _query(q)

    @field_validator("name")
    @classmethod
    def _name(cls, name: str) -> str:
        name = name.strip()
        if not name:
            raise ValueError("A view needs a name")
        return name


class ViewPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Annotated[str | None, Field(min_length=1, max_length=80)] = None
    query: dict[str, str] | None = None
    table: TablePrefs | None = None
    shared: bool | None = None

    @field_validator("query")
    @classmethod
    def _q(cls, q: dict[str, str] | None) -> dict[str, str] | None:
        return None if q is None else _query(q)


class View(BaseModel):
    id: uuid.UUID
    page: Page
    name: str
    query: dict[str, str]
    table: TablePrefs | None
    shared: bool
    mine: bool = Field(description="Whether you own it (and so may change it)")
    owner: str = Field(description="Its owner's name")
    updated_at: datetime


# Views you may see (yours, and those shared): one, or those of a page, or all.
VIEWS = """
    SELECT v.id, v.page, v.name, v.query, v.table_prefs AS table, v.shared, v.updated_at,
           v.owner_id = %(me)s AS mine, u.name AS owner
    FROM saved_views v JOIN users u ON u.id = v.owner_id
    WHERE (v.shared OR v.owner_id = %(me)s)
      AND (%(id)s::uuid IS NULL OR v.id = %(id)s)
      AND (%(page)s::text IS NULL OR v.page = %(page)s)
    ORDER BY v.page, v.owner_id <> %(me)s, lower(v.name), v.id
"""


def _one(ctx: Any, view_id: uuid.UUID) -> dict[str, Any]:
    row: dict[str, Any] | None = ctx.conn.execute(
        VIEWS,
        {"id": view_id, "me": ctx.user.id, "page": None},
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such view")
    return row


def _may_share(ctx: Any) -> None:
    if ROLE_RANK.get(ctx.user.role, -1) < ROLE_RANK["engineer"]:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            f"Your role on this site is {ctx.user.role}; sharing a view needs engineer or above",
        )


def _lock_owner(ctx: Any) -> None:
    """One change to a person's views on a site at a time: the name check and the limit hold."""
    ctx.conn.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended('saved_views:' || %s::text || ':' || %s::text, 0))",
        [ctx.site_id, ctx.user.id],
    )


def _audited(row: dict[str, Any]) -> dict[str, Any]:
    return {k: row[k] for k in ("page", "name", "query", "table", "shared")}


@router.get("/sites/{site_id}/views", response_model=list[View])
def list_views(ctx: Ctx, page: Page | None = None) -> list[dict[str, Any]]:
    """Your saved views and those shared with the site (of one page, or every page), by page and
    name, yours first."""
    rows: list[dict[str, Any]] = ctx.conn.execute(VIEWS, {"me": ctx.user.id, "id": None, "page": page}).fetchall()
    return rows


@router.post("/sites/{site_id}/views", response_model=View, status_code=status.HTTP_201_CREATED)
def create_view(ctx: Ctx, body: ViewIn) -> dict[str, Any]:
    """Save a view. Any member keeps their own; sharing it with the site needs engineer or above.
    A name you already use on the page is refused (409)."""
    if body.shared:
        _may_share(ctx)
    _lock_owner(ctx)
    count = ctx.conn.execute(
        "SELECT count(*) AS n FROM saved_views WHERE site_id = %s AND owner_id = %s", [ctx.site_id, ctx.user.id]
    ).fetchone()
    if count and count["n"] >= MAX_VIEWS:
        raise HTTPException(status.HTTP_409_CONFLICT, f"You have {MAX_VIEWS} saved views here: delete one first")
    row = ctx.conn.execute(
        """
        INSERT INTO saved_views (site_id, owner_id, page, name, query, table_prefs, shared)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (site_id, owner_id, page, name) DO NOTHING
        RETURNING id
        """,
        [
            ctx.site_id,
            ctx.user.id,
            body.page,
            body.name,
            Jsonb(body.query),
            Jsonb(body.table.model_dump()) if body.table else None,
            body.shared,
        ],
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_409_CONFLICT, f"You already have a view named {body.name} on this page")
    view = _one(ctx, row["id"])
    ctx.audit("view.create", "saved_view", str(row["id"]), after=_audited(view))
    return view


@router.patch("/sites/{site_id}/views/{view_id}", response_model=View)
def update_view(ctx: Ctx, view_id: uuid.UUID, body: ViewPatch) -> dict[str, Any]:
    """Rename a view of yours, change what it keeps, or share or unshare it. A shared view (or one
    being shared) is the site's: changing it needs engineer or above."""
    _lock_owner(ctx)
    before = _one(ctx, view_id)
    if not before["mine"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only its owner changes a view")
    if before["shared"] or body.shared:
        _may_share(ctx)
    changes = body.model_dump(exclude_unset=True)
    if not changes:
        return before
    name = changes["name"].strip() if changes.get("name") is not None else None
    if "name" in changes and not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "A view needs a name")
    if name is not None:
        taken = ctx.conn.execute(
            "SELECT 1 FROM saved_views WHERE site_id = %s AND owner_id = %s AND page = %s AND name = %s AND id <> %s",
            [ctx.site_id, ctx.user.id, before["page"], name, view_id],
        ).fetchone()
        if taken:
            raise HTTPException(status.HTTP_409_CONFLICT, f"You already have a view named {name} on this page")
    ctx.conn.execute(
        """
        UPDATE saved_views SET
            name = coalesce(%(name)s, name),
            query = coalesce(%(query)s, query),
            table_prefs = CASE WHEN %(set_table)s THEN %(table)s ELSE table_prefs END,
            shared = coalesce(%(shared)s, shared),
            updated_at = now()
        WHERE id = %(id)s
        """,
        {
            "id": view_id,
            "name": name,
            "query": Jsonb(changes["query"]) if changes.get("query") is not None else None,
            "set_table": "table" in changes,
            "table": Jsonb(changes["table"]) if changes.get("table") is not None else None,
            "shared": changes.get("shared"),
        },
    )
    after = _one(ctx, view_id)
    ctx.audit("view.update", "saved_view", str(view_id), before=_audited(before), after=_audited(after))
    return after


@router.delete("/sites/{site_id}/views/{view_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_view(ctx: Ctx, view_id: uuid.UUID) -> Response:
    """Delete a view of yours; a site admin may also delete a shared one."""
    view = _one(ctx, view_id)
    if not view["mine"] and ROLE_RANK.get(ctx.user.role, -1) < ROLE_RANK["admin"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Only its owner or a site admin deletes a shared view")
    ctx.conn.execute("DELETE FROM saved_views WHERE id = %s", [view_id])
    ctx.audit("view.delete", "saved_view", str(view_id), before=_audited(view))
    return Response(status_code=status.HTTP_204_NO_CONTENT)
