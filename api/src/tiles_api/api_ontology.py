"""HTTP API for sites and the ontology: stage, discard, commit, revert, history."""

import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, status
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr, model_validator

from tiles_api import audit
from tiles_api import ontology as o
from tiles_api import ontology_store as store
from tiles_api.auth import Principal, authenticate
from tiles_api.identity import User, ensure_org, ensure_user, resolve_user
from tiles_api.store import Conn, DbConn, scope_to_site

router = APIRouter()

Id = Annotated[str, Field(min_length=1, max_length=200)]
PropValue = StrictStr | StrictInt | StrictFloat | StrictBool


class NodeIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: Id
    type: Annotated[str, Field(min_length=1, max_length=50)]
    label: Annotated[str, Field(max_length=500)]
    props: dict[Annotated[str, Field(min_length=1, max_length=200)], PropValue] = {}


class EdgeIn(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    id: Id
    from_: Id = Field(alias="from")
    rel: Annotated[str, Field(min_length=1, max_length=100)]
    to: Id


class AddNode(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["addNode"]
    node: NodeIn


class RemoveNode(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["removeNode"]
    id: Id


class AddEdge(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["addEdge"]
    edge: EdgeIn


class RemoveEdge(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["removeEdge"]
    id: Id


class SetProp(BaseModel):
    """Sets a property; leaving out `value` removes it."""

    model_config = ConfigDict(extra="forbid")
    kind: Literal["setProp"]
    id: Id
    key: Annotated[str, Field(min_length=1, max_length=200)]
    value: PropValue | None = None

    @model_validator(mode="before")
    @classmethod
    def _no_explicit_null(cls, data: Any) -> Any:
        # Omitting `value` removes the property; null is not a property value.
        if isinstance(data, dict) and "value" in data and data["value"] is None:
            raise ValueError("value must not be null; leave it out to remove the property")
        return data


OpIn = Annotated[AddNode | RemoveNode | AddEdge | RemoveEdge | SetProp, Field(discriminator="kind")]


class Graph(BaseModel):
    nodes: dict[str, dict[str, Any]]
    edges: dict[str, dict[str, Any]]


class DiffStats(BaseModel):
    nodes: int
    edges: int
    props: int


class Commit(BaseModel):
    id: str
    message: str
    author: str
    date: str
    ops: list[dict[str, Any]]
    inverses: list[dict[str, Any]]
    stats: DiffStats
    reviewer: str | None = None  # who approved it, if it went through a review (T2.12)


class CommitIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: Annotated[str, Field(max_length=2000)]


class Site(BaseModel):
    id: uuid.UUID
    slug: str
    name: str
    org: str


def _op_dict(op: AddNode | RemoveNode | AddEdge | RemoveEdge | SetProp) -> o.Op:
    # exclude_none drops an absent setProp value, matching the browser's JSON.
    return op.model_dump(by_alias=True, exclude_none=True)


class SiteContext:
    """A request (or a copilot tool call) on one site, as one user. Its transaction is scoped to
    the site (T5.04): the database's row security then shows and accepts only that site's rows."""

    def __init__(self, conn: Conn, site_id: uuid.UUID, org_id: uuid.UUID, user: User) -> None:
        self.conn = conn
        self.site_id = site_id
        self.org_id = org_id
        self.user = user
        scope_to_site(conn, site_id)

    def audit(self, action: str, entity_type: str, entity_id: str, before: Any = None, after: Any = None) -> None:
        audit.record(
            self.conn,
            org_id=self.org_id,
            site_id=self.site_id,
            actor_id=self.user.id,
            actor_name=self.user.name,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            before=before,
            after=after,
        )


Auth = Annotated[Principal, Depends(authenticate)]


def site_context(site_id: uuid.UUID, principal: Auth, conn: DbConn) -> SiteContext:
    row = conn.execute(
        "SELECT s.org_id, o.slug FROM sites s JOIN orgs o ON o.id = s.org_id WHERE s.id = %s", [site_id]
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Site not found")
    scope_to_site(conn, site_id)  # before anything reads or writes the site's rows (T5.04)
    user = resolve_user(conn, principal, site_id, row["org_id"], row["slug"])
    return SiteContext(conn, site_id, row["org_id"], user)


Ctx = Annotated[SiteContext, Depends(site_context, scope="function")]

ROLE_RANK = {"viewer": 0, "engineer": 1, "admin": 2}


def can_edit(conn: Conn, site_id: uuid.UUID, org_id: uuid.UUID, user_id: uuid.UUID) -> bool:
    """Whether a user is an engineer or admin of a site: a member with that role, or an admin of
    its organisation (who manages every site, whether they have visited it yet or not)."""
    row = conn.execute(
        """
        SELECT CASE WHEN u.org_admin THEN 'admin' ELSE m.role END AS role
        FROM users u LEFT JOIN site_members m ON m.user_id = u.id AND m.site_id = %s
        WHERE u.id = %s AND u.org_id = %s
        """,
        [site_id, user_id, org_id],
    ).fetchone()
    return row is not None and ROLE_RANK.get(row["role"], -1) >= ROLE_RANK["engineer"]


def require_role(minimum: str) -> Any:
    """Dependency: the site context, if the user's role on the site is at least `minimum`."""

    def check(ctx: Ctx) -> SiteContext:
        if ROLE_RANK.get(ctx.user.role, -1) < ROLE_RANK[minimum]:
            raise HTTPException(
                status.HTTP_403_FORBIDDEN, f"Your role on this site is {ctx.user.role}; this needs {minimum} or above"
            )
        return ctx

    check.minimum_role = minimum  # type: ignore[attr-defined]  # read by the API reference (apidoc.py)
    return check


# Every write endpoint takes one of these instead of Ctx (T1.17).
Editor = Annotated[SiteContext, Depends(require_role("engineer"), scope="function")]
Admin = Annotated[SiteContext, Depends(require_role("admin"), scope="function")]


def _run(fn: Any, *args: Any) -> Any:
    try:
        return fn(*args)
    except store.NotFound as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    except o.OntologyError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e


@router.get("/sites", response_model=list[Site], tags=["sites"])
def list_sites(conn: DbConn, principal: Auth) -> list[dict[str, Any]]:
    """Sites in your organisation (every site for the dev identity)."""
    sql = "SELECT s.id, s.slug, s.name, o.slug AS org FROM sites s JOIN orgs o ON o.id = s.org_id"
    if principal.org is None:
        return conn.execute(sql + " ORDER BY o.slug, s.slug").fetchall()
    # First sign-in creates the organisation and the user, even before any site exists.
    ensure_user(conn, principal, ensure_org(conn, principal.org))
    return conn.execute(sql + " WHERE o.slug = %s ORDER BY s.slug", [principal.org]).fetchall()


@router.get("/sites/{site_id}/ontology/graph", response_model=Graph, tags=["ontology"])
def get_graph(ctx: Ctx, view: Literal["head", "working"] = "working") -> o.Graph:
    """The committed graph (`head`), or head plus your staged changes (`working`)."""
    if view == "head":
        return store.load_head(ctx.conn, ctx.site_id)
    return _run(store.working, ctx.conn, ctx.site_id, ctx.user)  # type: ignore[no-any-return]


class HealthIssue(BaseModel):
    level: Literal["error", "warn", "info"]
    kind: Literal["dangling", "duplicate", "orphan", "missing-prop"]
    ref: str
    text: str


class HealthReport(BaseModel):
    issues: list[HealthIssue]
    score: int
    counts: dict[str, int]


@router.get("/sites/{site_id}/ontology/health", response_model=HealthReport, tags=["ontology"])
def get_health(ctx: Ctx, view: Literal["head", "working"] = "head") -> o.HealthReport:
    """Health check: dangling or duplicate relationships, orphans and missing required properties.

    Scores the committed graph by default; `view=working` includes your staged changes.
    """
    graph = (
        store.load_head(ctx.conn, ctx.site_id)
        if view == "head"
        else _run(store.working, ctx.conn, ctx.site_id, ctx.user)
    )
    return o.health_check(graph)


@router.get("/sites/{site_id}/ontology/staged", response_model=list[dict[str, Any]], tags=["ontology"])
def get_staged(ctx: Ctx) -> list[o.Op]:
    """Your staged changes to the ontology, not yet committed (each person stages their own)."""
    return store.load_staged(ctx.conn, ctx.site_id, ctx.user)


@router.post(
    "/sites/{site_id}/ontology/staged",
    response_model=list[dict[str, Any]],
    status_code=status.HTTP_201_CREATED,
    tags=["ontology"],
)
def stage_op(ctx: Editor, op: OpIn) -> list[o.Op]:
    """Stage one change. It is checked against your working graph; returns all your staged ops."""
    staged: list[o.Op] = _run(store.stage, ctx.conn, ctx.site_id, ctx.user, _op_dict(op))
    ctx.audit("ontology.stage", "staged_ops", str(ctx.user.id), after={"ops": [_op_dict(op)]})
    return staged


@router.post(
    "/sites/{site_id}/ontology/staged/batch",
    response_model=list[dict[str, Any]],
    status_code=status.HTTP_201_CREATED,
    tags=["ontology"],
)
def stage_ops(ctx: Editor, ops: Annotated[list[OpIn], Body(min_length=1, max_length=2000)]) -> list[o.Op]:
    """Stage several changes, all or none (e.g. a node and its relationship). Returns all your staged ops."""
    added = [_op_dict(op) for op in ops]
    staged: list[o.Op] = _run(store.stage, ctx.conn, ctx.site_id, ctx.user, *added)
    ctx.audit("ontology.stage", "staged_ops", str(ctx.user.id), after={"ops": added})
    return staged


@router.delete("/sites/{site_id}/ontology/staged", status_code=status.HTTP_204_NO_CONTENT, tags=["ontology"])
def discard_staged(ctx: Ctx) -> None:
    """Throw away your staged changes. Open to every member, so a user demoted to viewer can drop old work."""
    dropped = store.discard(ctx.conn, ctx.site_id, ctx.user)
    if dropped:
        ctx.audit("ontology.discard", "staged_ops", str(ctx.user.id), before={"ops": dropped})


@router.get("/sites/{site_id}/ontology/commits", response_model=list[Commit], tags=["ontology"])
def get_history(
    ctx: Ctx, limit: Annotated[int, Query(ge=1, le=500)] = 50, offset: Annotated[int, Query(ge=0)] = 0
) -> list[o.Commit]:
    """Commit history, newest first."""
    return store.history(ctx.conn, ctx.site_id, limit, offset)


@router.post(
    "/sites/{site_id}/ontology/commits", response_model=Commit, status_code=status.HTTP_201_CREATED, tags=["ontology"]
)
def commit_staged(ctx: Editor, body: CommitIn) -> o.Commit:
    """Commit your staged changes."""
    entry: o.Commit = _run(store.commit, ctx.conn, ctx.site_id, ctx.user, body.message)
    ctx.audit("ontology.commit", "commit", entry["id"], after=entry)
    return entry


@router.post(
    "/sites/{site_id}/ontology/commits/{commit_id}/revert",
    response_model=Commit,
    status_code=status.HTTP_201_CREATED,
    tags=["ontology"],
)
def revert_commit(ctx: Editor, commit_id: str) -> o.Commit:
    """Undo a commit by committing its inverse operations."""
    entry: o.Commit = _run(store.revert, ctx.conn, ctx.site_id, ctx.user, commit_id)
    ctx.audit("ontology.revert", "commit", entry["id"], before={"reverted": commit_id}, after=entry)
    return entry
