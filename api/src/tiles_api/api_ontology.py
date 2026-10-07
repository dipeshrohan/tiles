"""HTTP API for sites and the ontology: stage, discard, commit, revert, history."""

import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictFloat, StrictInt, StrictStr

from tiles_api import ontology as o
from tiles_api import ontology_store as store
from tiles_api.identity import User, resolve_user
from tiles_api.settings import Settings
from tiles_api.store import Conn, DbConn

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
    def __init__(self, conn: Conn, site_id: uuid.UUID, user: User) -> None:
        self.conn = conn
        self.site_id = site_id
        self.user = user


def site_context(site_id: uuid.UUID, request: Request, conn: DbConn) -> SiteContext:
    row = conn.execute("SELECT org_id FROM sites WHERE id = %s", [site_id]).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Site not found")
    settings: Settings = request.app.state.settings
    return SiteContext(conn, site_id, resolve_user(conn, settings, request, row["org_id"], site_id))


Ctx = Annotated[SiteContext, Depends(site_context, scope="function")]


def _run(fn: Any, *args: Any) -> Any:
    try:
        return fn(*args)
    except store.NotFound as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, str(e)) from e
    except o.OntologyError as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e


@router.get("/sites", response_model=list[Site], tags=["sites"])
def list_sites(conn: DbConn) -> list[dict[str, Any]]:
    return conn.execute(
        "SELECT s.id, s.slug, s.name, o.slug AS org FROM sites s JOIN orgs o ON o.id = s.org_id ORDER BY o.slug, s.slug"
    ).fetchall()


@router.get("/sites/{site_id}/ontology/graph", response_model=Graph, tags=["ontology"])
def get_graph(ctx: Ctx, view: Literal["head", "working"] = "working") -> o.Graph:
    """The committed graph (`head`), or head plus your staged changes (`working`)."""
    if view == "head":
        return store.load_head(ctx.conn, ctx.site_id)
    return _run(store.working, ctx.conn, ctx.site_id, ctx.user)  # type: ignore[no-any-return]


@router.get("/sites/{site_id}/ontology/staged", response_model=list[dict[str, Any]], tags=["ontology"])
def get_staged(ctx: Ctx) -> list[o.Op]:
    return store.load_staged(ctx.conn, ctx.site_id, ctx.user)


@router.post(
    "/sites/{site_id}/ontology/staged",
    response_model=list[dict[str, Any]],
    status_code=status.HTTP_201_CREATED,
    tags=["ontology"],
)
def stage_op(ctx: Ctx, op: OpIn) -> list[o.Op]:
    """Stage one change. It is checked against your working graph; returns all your staged ops."""
    return _run(store.stage, ctx.conn, ctx.site_id, ctx.user, _op_dict(op))  # type: ignore[no-any-return]


@router.delete("/sites/{site_id}/ontology/staged", status_code=status.HTTP_204_NO_CONTENT, tags=["ontology"])
def discard_staged(ctx: Ctx) -> None:
    store.discard(ctx.conn, ctx.site_id, ctx.user)


@router.get("/sites/{site_id}/ontology/commits", response_model=list[Commit], tags=["ontology"])
def get_history(
    ctx: Ctx, limit: Annotated[int, Query(ge=1, le=500)] = 50, offset: Annotated[int, Query(ge=0)] = 0
) -> list[o.Commit]:
    """Commit history, newest first."""
    return store.history(ctx.conn, ctx.site_id, limit, offset)


@router.post(
    "/sites/{site_id}/ontology/commits", response_model=Commit, status_code=status.HTTP_201_CREATED, tags=["ontology"]
)
def commit_staged(ctx: Ctx, body: CommitIn) -> o.Commit:
    """Commit your staged changes."""
    return _run(store.commit, ctx.conn, ctx.site_id, ctx.user, body.message)  # type: ignore[no-any-return]


@router.post(
    "/sites/{site_id}/ontology/commits/{commit_id}/revert",
    response_model=Commit,
    status_code=status.HTTP_201_CREATED,
    tags=["ontology"],
)
def revert_commit(ctx: Ctx, commit_id: str) -> o.Commit:
    """Undo a commit by committing its inverse operations."""
    return _run(store.revert, ctx.conn, ctx.site_id, ctx.user, commit_id)  # type: ignore[no-any-return]
