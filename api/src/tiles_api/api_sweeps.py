"""Parameter sweeps over HTTP (T4.12): start one (engineers), follow its progress, cancel it,
read its result. The sweep runs in the background after the request (sweeps.run); an identical
sweep that is already done is answered from its result at once.
"""

import math
import uuid
from datetime import datetime
from typing import Annotated, Any

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request, Response, status
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt, field_validator, model_validator

from tiles_api import api_runs, sweeps
from tiles_api.api_ontology import Ctx, Editor, SiteContext
from tiles_api.models import store
from tiles_api.models.registry import ModelError, check_params
from tiles_api.store import one, side_pool

router = APIRouter(tags=["sweeps"])

Number = StrictFloat | StrictInt


class Axis(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, serialize_by_alias=True)
    param: Annotated[str, Field(min_length=1, max_length=63)]
    from_: Number = Field(alias="from")
    to: Number
    steps: Annotated[int, Field(ge=2, le=sweeps.MAX_STEPS)]

    @field_validator("from_", "to")
    @classmethod
    def _finite(cls, v: float) -> float:
        if not math.isfinite(v):
            raise ValueError("must be a finite number")
        return v


class SweepIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model: Annotated[str, Field(min_length=1, max_length=100)]
    version: Annotated[str | None, Field(max_length=40)] = None
    params: Annotated[dict[Annotated[str, Field(max_length=63)], Number], Field(max_length=50)] = {}
    x: Axis
    y: Axis | None = None
    project: uuid.UUID | None = None

    @model_validator(mode="after")
    def _axes(self) -> "SweepIn":
        if self.y and self.y.param == self.x.param:
            raise ValueError("Sweep two different parameters")
        if self.x.steps * (self.y.steps if self.y else 1) > sweeps.MAX_POINTS:
            raise ValueError(f"At most {sweeps.MAX_POINTS:,} points in one sweep")
        return self


class Sweep(BaseModel):
    id: uuid.UUID
    model: str
    version: str
    params: dict[str, float]
    x: dict[str, Any]
    y: dict[str, Any] | None
    project: uuid.UUID | None
    status: str
    total: int
    done: int
    error: str | None
    cancel_requested: bool
    created_by: str
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    cached: bool = False  # answered from an identical sweep's result
    result: dict[str, Any] | None = None  # when done: the grid, its axes, min and max


COLUMNS = """id, model_key AS model, version, params, x, y, project_id AS project, status, total, done, error,
       cancel_requested, created_by, created_at, started_at, finished_at"""
SHOWN = f"SELECT {COLUMNS} FROM sweeps WHERE site_id = %(site)s"  # noqa: S608 - constants
ONE = f"SELECT {COLUMNS}, result FROM sweeps WHERE site_id = %(site)s AND id = %(id)s"  # noqa: S608


def _sweep(ctx: SiteContext, sweep_id: uuid.UUID, *, result: bool = True) -> dict[str, Any]:
    row = ctx.conn.execute(ONE, {"site": ctx.site_id, "id": sweep_id}).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such sweep on this site")
    return row if result else row | {"result": None}


@router.post("/sites/{site_id}/sweeps", response_model=Sweep, status_code=status.HTTP_202_ACCEPTED)
def start_sweep(
    ctx: Editor, request: Request, response: Response, background: BackgroundTasks, body: SweepIn
) -> dict[str, Any]:
    """Start a sweep (202: it runs in the background), or answer from an identical one's result (200)."""
    model = api_runs._model(body.model, body.version)
    spec = model.spec
    try:
        full = check_params(spec, body.params)
        # Both ends of each axis checked as the model checks a parameter (known, within bounds).
        for axis in (a for a in (body.x, body.y) if a is not None):
            for end in (axis.from_, axis.to):
                check_params(spec, body.params | {axis.param: end})
    except ModelError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    if (
        body.project is not None
        and not ctx.conn.execute(
            "SELECT 1 FROM design_projects WHERE site_id = %s AND id = %s", [ctx.site_id, body.project]
        ).fetchone()
    ):
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such design project on this site")
    x = body.x.model_dump(by_alias=True)
    y = body.y.model_dump(by_alias=True) if body.y else None
    key = sweeps.cache_key(model, full, x, y)
    cached = ctx.conn.execute(
        "SELECT id FROM sweeps WHERE site_id = %s AND cache_key = %s AND status = 'done' ORDER BY finished_at DESC"
        " LIMIT 1",
        [ctx.site_id, key],
    ).fetchone()
    if cached:
        response.status_code = status.HTTP_200_OK
        return _sweep(ctx, cached["id"]) | {"cached": True}
    try:
        model_id = store.model_id(ctx.conn, ctx.org_id, model)
    except store.ModelChanged as e:
        raise HTTPException(status.HTTP_409_CONFLICT, str(e)) from e
    total = body.x.steps * (body.y.steps if body.y else 1)
    sweep_id = one(
        ctx.conn.execute(
            """
            INSERT INTO sweeps (site_id, project_id, model_id, model_key, version, params, x, y, cache_key, total,
                                created_by_id, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
            """,
            [
                ctx.site_id,
                body.project,
                model_id,
                spec.key,
                spec.version,
                Jsonb(full),
                Jsonb(x),
                Jsonb(y),
                key,
                total,
                ctx.user.id,
                ctx.user.name,
            ],
        ).fetchone()
    )["id"]
    ctx.audit(
        "sweep.start",
        "sweep",
        str(sweep_id),
        after={"model": spec.key, "version": spec.version, "x": x, "y": y, "points": total},
    )
    pool = side_pool(request.app.state)  # it runs after the request, outside its connection count
    background.add_task(sweeps.drain, pool.connection)  # after the request's transaction commits
    return _sweep(ctx, sweep_id)


@router.get("/sites/{site_id}/sweeps", response_model=list[Sweep])
def list_sweeps(ctx: Ctx, limit: Annotated[int, Query(ge=1, le=100)] = 20) -> list[dict[str, Any]]:
    """The site's latest sweeps, without their results."""
    return ctx.conn.execute(
        SHOWN + " ORDER BY created_at DESC LIMIT %(limit)s", {"site": ctx.site_id, "limit": limit}
    ).fetchall()


@router.get("/sites/{site_id}/sweeps/{sweep_id}", response_model=Sweep)
def get_sweep(ctx: Ctx, sweep_id: uuid.UUID) -> dict[str, Any]:
    """A sweep's progress (`done` of `total` points), and its result once done."""
    return _sweep(ctx, sweep_id)


@router.post("/sites/{site_id}/sweeps/{sweep_id}/cancel", response_model=Sweep)
def cancel_sweep(ctx: Editor, sweep_id: uuid.UUID) -> dict[str, Any]:
    """Stop a sweep: one still queued at once, a running one after the chunk it is on."""
    row = _sweep(ctx, sweep_id, result=False)
    if row["status"] not in ("queued", "running"):
        raise HTTPException(status.HTTP_409_CONFLICT, f"The sweep is already {row['status']}")
    ctx.conn.execute(
        """
        UPDATE sweeps SET cancel_requested = true,
               status = CASE WHEN status = 'queued' THEN 'cancelled' ELSE status END,
               finished_at = CASE WHEN status = 'queued' THEN now() ELSE finished_at END
        WHERE id = %s
        """,
        [sweep_id],
    )
    ctx.audit("sweep.cancel", "sweep", str(sweep_id), before={"status": row["status"], "done": row["done"]})
    return _sweep(ctx, sweep_id, result=False)
