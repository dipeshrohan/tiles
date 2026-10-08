"""The model registry over HTTP (T3.01): the registered models, and evaluating one on given inputs."""

from typing import Annotated, Any

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field

from tiles_api.api_ontology import Ctx
from tiles_api.models import store  # importing the package registers the built-in models
from tiles_api.models.registry import MAX_POINTS, ModelError, evaluate, registry

router = APIRouter(tags=["models"])


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
    description: str
    inputs: list[PortOut]
    outputs: list[PortOut]
    params: list[ParamOut]


class EvaluateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: Annotated[str, Field(max_length=40)] | None = None  # the latest when left out
    inputs: dict[Annotated[str, Field(max_length=63)], Annotated[list[Any], Field(max_length=MAX_POINTS)]] = {}
    params: dict[Annotated[str, Field(max_length=63)], Any] = {}


class EvaluateOut(BaseModel):
    key: str
    version: str
    outputs: dict[str, list[float | None]]


def _synced(ctx: Ctx) -> None:
    try:
        store.sync(ctx.conn, ctx.org_id)
    except store.ModelChanged as e:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, str(e)) from e


@router.get("/sites/{site_id}/models", response_model=list[ModelOut])
def list_models(ctx: Ctx) -> list[dict[str, Any]]:
    """Every registered model version, by key then version. Also records new versions for your organisation."""
    _synced(ctx)
    return [store.describe(m) for m in registry.all()]


@router.get("/sites/{site_id}/models/{key}", response_model=list[ModelOut])
def model_versions(ctx: Ctx, key: str) -> list[dict[str, Any]]:
    """A model's versions, newest first."""
    _synced(ctx)
    versions = [store.describe(m) for m in reversed(registry.all()) if m.spec.key == key]
    if not versions:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"No model {key}")
    return versions


@router.post("/sites/{site_id}/models/{key}/evaluate", response_model=EvaluateOut)
def evaluate_model(ctx: Ctx, key: str, body: EvaluateIn) -> dict[str, Any]:
    """Run a model on the input series given (all one length) and its parameters (defaults if left out).

    Nothing is stored: this is for trying a model; the runner (T3.03) writes derived signals.
    """
    try:
        model = registry.get(key, body.version)
    except KeyError as e:
        raise HTTPException(status.HTTP_404_NOT_FOUND, e.args[0]) from e
    try:
        outputs = evaluate(model, body.inputs, body.params)
    except ModelError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    return {"key": model.spec.key, "version": model.spec.version, "outputs": outputs}
