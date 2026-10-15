"""The model registry over HTTP (T3.01): the models a site can use (the built-in ones and its
organisation's own served over HTTP, T4.15), and evaluating one on given inputs."""

from typing import Annotated, Any

from fastapi import APIRouter, Request, status
from pydantic import BaseModel, ConfigDict, Field, StrictFloat, StrictInt

from tiles_api.api_ontology import Ctx
from tiles_api.errors import Problem
from tiles_api.models import store  # importing the package registers the built-in models
from tiles_api.models.registry import ModelError, evaluate
from tiles_api.models.remote import RemoteError

router = APIRouter(tags=["models"])

MAX_TRY = 100_000  # values per input series in one evaluate request


class PortOut(BaseModel):
    name: str
    unit: str
    description: str
    per: str


class ParamOut(BaseModel):
    name: str
    unit: str
    default: float
    min: float | None
    max: float | None
    description: str


class ModelOut(BaseModel):
    key: str
    version: str
    name: str
    kind: str
    domain: str
    source: str = Field(description="builtin, or http: the organisation's own, served by its endpoint (T4.15)")
    description: str
    inputs: list[PortOut]
    outputs: list[PortOut]
    params: list[ParamOut]


class EvaluateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Annotated[str, Field(max_length=40)] | None = None  # the latest when left out
    # Numbers only, and a bounded amount of them: this is for trying a model, not for bulk runs (T3.03).
    inputs: Annotated[
        dict[Annotated[str, Field(max_length=63)], Annotated[list[StrictFloat | StrictInt], Field(max_length=MAX_TRY)]],
        Field(max_length=20),
    ] = {}
    params: Annotated[dict[Annotated[str, Field(max_length=63)], StrictFloat | StrictInt], Field(max_length=50)] = {}


class EvaluateOut(BaseModel):
    key: str
    version: str
    outputs: dict[str, list[float | None]]


@router.get("/sites/{site_id}/models", response_model=list[ModelOut])
def list_models(ctx: Ctx, request: Request) -> list[dict[str, Any]]:
    """Every model version the site can use, by key then version: the built-in ones, then its
    organisation's own served over HTTP."""
    return [store.describe(m) for m in store.usable(ctx.conn, ctx.org_id, request.app.state.settings)]


def no_model(key: str, version: str | None) -> Problem:
    """404 for a model, or a version of it, that isn't there (store.find's KeyError)."""
    if version:
        return Problem(
            status.HTTP_404_NOT_FOUND,
            "model.version_not_found",
            f"No model {key} version {version}",
            key=key,
            version=version,
        )
    return Problem(status.HTTP_404_NOT_FOUND, "model.not_found", f"No model {key}", key=key)


@router.get("/sites/{site_id}/models/{key}", response_model=list[ModelOut])
def model_versions(ctx: Ctx, key: str, request: Request) -> list[dict[str, Any]]:
    """A model's versions, newest first."""
    usable = store.usable(ctx.conn, ctx.org_id, request.app.state.settings)
    versions = [store.describe(m) for m in reversed(usable) if m.spec.key == key]
    if not versions:
        raise Problem(status.HTTP_404_NOT_FOUND, "model.not_found", f"No model {key}", key=key)
    return versions


@router.post("/sites/{site_id}/models/{key}/evaluate", response_model=EvaluateOut)
def evaluate_model(ctx: Ctx, key: str, body: EvaluateIn, request: Request) -> dict[str, Any]:
    """Run a model on the input series given (all one length) and its parameters (defaults if left out).

    Nothing is stored: this is for trying a model; the runner (T3.03) writes derived signals. A
    model served over HTTP whose endpoint fails gives 502.
    """
    try:
        model = store.find(ctx.conn, ctx.org_id, request.app.state.settings, key, body.version)
    except KeyError as e:
        raise no_model(key, body.version) from e
    try:
        outputs = evaluate(model, body.inputs, body.params)
    except RemoteError as e:
        raise Problem(status.HTTP_502_BAD_GATEWAY, "model.remote_failed", str(e), reason=str(e)) from e
    except ModelError as e:
        raise Problem(status.HTTP_422_UNPROCESSABLE_CONTENT, "model.invalid", str(e), reason=str(e)) from e
    return {"key": model.spec.key, "version": model.spec.version, "outputs": outputs}
