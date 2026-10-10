"""Model bindings over HTTP (T3.03): bind a model version to a site's signals, see how its runs
go, run it now, or stop it. The runs themselves are in models/runner.py (`tiles-run-models`)."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, HTTPException, Request, status
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt

from tiles_api.api_ontology import Ctx, Editor, SiteContext
from tiles_api.models import runner, store
from tiles_api.models.registry import ModelError, check_params

router = APIRouter(tags=["models"])

Name = Annotated[str, Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,62}$")]


class WindowIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # gap: a window ends where readings pause longer than `seconds` (a shot); fixed: every `seconds`.
    kind: Literal["gap", "fixed"]
    seconds: Annotated[float, Field(gt=0, le=31 * 86400)]


class BindingIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name  # the derived signals are named <name>.<output>
    model: Annotated[str, Field(max_length=63)]
    version: Annotated[str, Field(max_length=40)] | None = None  # the latest when left out; pinned from then on
    # {model input: the site's signal id, or "@time" for seconds since the window began}
    inputs: Annotated[dict[Annotated[str, Field(max_length=63)], uuid.UUID | Literal["@time"]], Field(max_length=50)]
    params: Annotated[dict[Annotated[str, Field(max_length=63)], StrictFloat | StrictInt], Field(max_length=50)] = {}
    window: WindowIn
    # How late readings may arrive: a window runs once this much older than complete (default 5 min).
    lateness_seconds: Annotated[float, Field(ge=0, le=7 * 86400)] = 300
    # 0: inputs join at equal timestamps; above 0: other inputs' latest reading this close before.
    align_seconds: Annotated[float, Field(ge=0, le=3600)] = 0


class Endpoint(BaseModel):
    name: str  # the model's input or output
    signal_id: uuid.UUID | None  # None: @time
    tag: str


class Binding(BaseModel):
    id: uuid.UUID
    name: str
    model: str
    version: str
    inputs: list[Endpoint]
    outputs: list[Endpoint]
    params: dict[str, float]
    window: WindowIn
    lateness_seconds: float
    align_seconds: float
    enabled: bool
    done_until: datetime | None  # the end of the last window run
    last_run_at: datetime | None
    last_windows: int  # windows the last run ran
    last_failed: int  # of those, windows the model refused (skipped)
    last_error: str | None  # the first problem of the last run
    created_at: datetime


class RunOut(BaseModel):
    windows: int
    failed: int
    written: int
    done_until: datetime | None
    error: str | None
    caught_up: bool  # False: there is more to run (run again, or leave it to the scheduled runs)


SELECT = """
SELECT b.id, b.name, m.key AS model, m.version, b.inputs, b.outputs, b.params, b.window_kind, b.window_s,
       b.lateness_s AS lateness_seconds, b.align_s AS align_seconds, b.enabled, b.done_until, b.last_run_at,
       b.last_windows, b.last_failed, b.last_error, b.created_at
FROM model_bindings b JOIN models m ON m.id = b.model_id
WHERE b.site_id = %s
"""


def _shown(ctx: SiteContext, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ids = {uuid.UUID(s) for r in rows for s in [*r["inputs"].values(), *r["outputs"].values()] if s != runner.TIME}
    tags = {r["id"]: r["tag"] for r in ctx.conn.execute("SELECT id, tag FROM signals WHERE id = ANY(%s)", [list(ids)])}

    def ends(mapping: dict[str, str]) -> list[dict[str, Any]]:
        return [
            {"name": n, "signal_id": None, "tag": runner.TIME}
            if s == runner.TIME
            else {"name": n, "signal_id": s, "tag": tags.get(uuid.UUID(s), "(removed)")}
            for n, s in mapping.items()
        ]

    return [
        {
            **r,
            "inputs": ends(r["inputs"]),
            "outputs": ends(r["outputs"]),
            "window": {"kind": r["window_kind"], "seconds": r["window_s"]},
        }
        for r in rows
    ]


def _get(ctx: SiteContext, binding_id: uuid.UUID) -> dict[str, Any]:
    rows = ctx.conn.execute(SELECT + " AND b.id = %s", [ctx.site_id, binding_id]).fetchall()
    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No such model binding")
    return _shown(ctx, rows)[0]


@router.get("/sites/{site_id}/model-bindings", response_model=list[Binding])
def list_bindings(ctx: Ctx) -> list[dict[str, Any]]:
    """The site's model bindings, with how their last run went."""
    return _shown(ctx, ctx.conn.execute(SELECT + " ORDER BY b.name", [ctx.site_id]).fetchall())


@router.post("/sites/{site_id}/model-bindings", response_model=Binding, status_code=status.HTTP_201_CREATED)
def bind(ctx: Editor, body: BindingIn, request: Request) -> dict[str, Any]:
    """Bind a model version to the site's signals. Its outputs become new signals, <name>.<output>,
    from source model:<key>@<version>; the runner fills them from then on, starting with the
    history already stored."""
    try:
        model = store.find(ctx.conn, ctx.org_id, request.app.state.settings, body.model, body.version)
    except KeyError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, e.args[0]) from e
    spec = model.spec
    if spec.kind == "design":
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            f"{spec.key} is a design model: it takes no signals, so it is run with evaluate, not bound",
        )
    problems = []
    wanted = {p.name for p in spec.inputs}
    if set(body.inputs) != wanted:
        problems.append(f"inputs must be exactly {', '.join(sorted(wanted))}")
    signal_ids = [s for s in body.inputs.values() if s != runner.TIME]
    if not signal_ids:
        problems.append("at least one input must be a signal")
    found = {
        r["id"]
        for r in ctx.conn.execute(
            "SELECT id FROM signals WHERE site_id = %s AND id = ANY(%s)", [ctx.site_id, signal_ids]
        )
    }
    missing = [str(s) for s in signal_ids if s not in found]
    if missing:
        problems.append(f"not signals of this site: {', '.join(missing)}")
    try:
        params = check_params(spec, body.params)
    except ModelError as e:
        problems.append(str(e))
        params = {}
    if problems:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "; ".join(problems))
    if ctx.conn.execute(
        "SELECT 1 FROM model_bindings WHERE site_id = %s AND name = %s", [ctx.site_id, body.name]
    ).fetchone():
        raise HTTPException(status.HTTP_409_CONFLICT, f"A model binding is already called {body.name}")

    source = f"model:{spec.key}@{spec.version}"
    outputs: dict[str, str] = {}
    for port in spec.outputs:
        tag = f"{body.name}.{port.name}"
        row = ctx.conn.execute(
            """
            INSERT INTO signals (site_id, tag, source, unit, description) VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (site_id, tag) DO NOTHING RETURNING id
            """,
            [ctx.site_id, tag, source, port.unit or None, port.description],
        ).fetchone()
        if row is None:
            raise HTTPException(status.HTTP_409_CONFLICT, f"The site already has a signal {tag}")
        outputs[port.name] = str(row["id"])
    try:
        model_id = store.model_id(ctx.conn, ctx.org_id, model)
    except store.ModelChanged as e:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(e)) from e
    inputs = {k: str(v) for k, v in body.inputs.items()}
    binding_id = ctx.conn.execute(
        """
        INSERT INTO model_bindings (site_id, name, model_id, inputs, params, outputs, window_kind, window_s,
                                    lateness_s, align_s, created_by)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) RETURNING id
        """,
        [
            ctx.site_id,
            body.name,
            model_id,
            Jsonb(inputs),
            Jsonb(params),
            Jsonb(outputs),
            body.window.kind,
            body.window.seconds,
            body.lateness_seconds,
            body.align_seconds,
            ctx.user.id,
        ],
    ).fetchone()["id"]  # type: ignore[index]
    ctx.audit(
        "model.bind",
        "model_binding",
        str(binding_id),
        after={"name": body.name, "model": source, "inputs": inputs, "params": params, "outputs": outputs},
    )
    return _get(ctx, binding_id)


@router.post("/sites/{site_id}/model-bindings/{binding_id}/run", response_model=RunOut)
def run_now(ctx: Editor, binding_id: uuid.UUID, request: Request) -> dict[str, Any]:
    """Run the binding on its new data now (one batch of readings: `caught_up` says whether more
    is left, for the next call or the scheduled runs)."""
    if not _get(ctx, binding_id)["enabled"]:
        raise HTTPException(status.HTTP_409_CONFLICT, "This model binding is stopped")
    result = runner.run(ctx.conn, binding_id, batches=1, settings=request.app.state.settings)
    out = {
        "windows": result.windows,
        "failed": result.failed,
        "written": result.written,
        "done_until": result.done_until,
        "error": result.error,
        "caught_up": result.caught_up,
    }
    done = result.done_until.isoformat() if result.done_until else None
    ctx.audit("model.run", "model_binding", str(binding_id), after=out | {"done_until": done})
    return out


@router.delete("/sites/{site_id}/model-bindings/{binding_id}", status_code=status.HTTP_204_NO_CONTENT)
def stop(ctx: Editor, binding_id: uuid.UUID) -> None:
    """Stop running the binding. What it computed stays; its derived signals keep their readings."""
    binding = _get(ctx, binding_id)
    if binding["enabled"]:
        ctx.conn.execute("UPDATE model_bindings SET enabled = false WHERE id = %s", [binding_id])
        ctx.audit("model.stop", "model_binding", str(binding_id), before={"name": binding["name"]})
