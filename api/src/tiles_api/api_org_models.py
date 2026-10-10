"""An organisation's own models, served over HTTP (T4.15): organisation admins register a model
version with its spec and the endpoint that computes it (models/remote.py), then every site of the
organisation can try, bind and run it like a built-in model. A version's spec never changes (runs
refer to it): a new behaviour is a new version. Its endpoint and token may change, and it may be
archived. Each step is in the organisation's audit log; the token is sealed and never shown again.
"""

from datetime import datetime
from typing import Annotated, Any, Literal

import psycopg
from fastapi import APIRouter, HTTPException, Request, status
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, SecretStr, StrictFloat, StrictInt

from tiles_api import audit, sealed
from tiles_api.api_sites import OrgAdmin, OrgCaller
from tiles_api.models import remote
from tiles_api.models.registry import ModelError, ModelSpec, Param, Port, registry
from tiles_api.models.store import HTTP_MODELS
from tiles_api.store import one

router = APIRouter(tags=["models"])

Text = Annotated[str, Field(max_length=2000)]
Name = Annotated[str, Field(min_length=1, max_length=63)]
Number = StrictFloat | StrictInt


class PortIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name
    unit: Annotated[str, Field(max_length=40)]
    description: Text = ""
    per: Literal["sample", "window"] = "sample"


class ParamIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: Name
    unit: Annotated[str, Field(max_length=40)]
    default: Number
    min: Number | None = None
    max: Number | None = None
    description: Text = ""


class HttpModelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    key: Annotated[str, Field(min_length=2, max_length=63)]
    version: Annotated[str, Field(max_length=40, description="MAJOR.MINOR.PATCH")]
    name: Annotated[str, Field(min_length=1, max_length=120)]
    kind: Literal["virtual-sensor", "design"]
    domain: Annotated[str, Field(max_length=120)] = ""
    description: Text = ""
    inputs: Annotated[list[PortIn], Field(max_length=20)] = []
    outputs: Annotated[list[PortIn], Field(min_length=1, max_length=20)]
    params: Annotated[list[ParamIn], Field(max_length=50)] = []
    endpoint_url: Annotated[str, Field(min_length=1, max_length=2000)]
    token: Annotated[SecretStr, Field(max_length=4096)] | None = Field(
        None, description="Sent as `Authorization: Bearer <token>`; sealed, and never shown again"
    )


class HttpModelChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    endpoint_url: Annotated[str, Field(min_length=1, max_length=2000)] | None = None
    token: Annotated[SecretStr, Field(max_length=4096)] | None = Field(None, description="A new token")
    clear_token: bool = Field(False, description="Send no token from now on")
    archived: bool | None = Field(None, description="Archived: no new uses; runs made with it still show")


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


class HttpModelOut(BaseModel):
    key: str
    version: str
    name: str
    kind: str
    domain: str
    description: str
    inputs: list[PortOut]
    outputs: list[PortOut]
    params: list[ParamOut]
    endpoint_url: str
    has_token: bool
    created_at: datetime
    archived_at: datetime | None


def _shown(row: dict[str, Any]) -> dict[str, Any]:
    spec = row["spec"]
    return {
        "key": row["key"],
        "version": row["version"],
        "name": row["name"],
        "kind": row["kind"],
        "domain": row["domain"],
        "description": spec.get("description", ""),
        "inputs": spec.get("inputs", []),
        "outputs": spec.get("outputs", []),
        "params": spec.get("params", []),
        "endpoint_url": row["endpoint_url"],
        "has_token": row["endpoint_token"] is not None,
        "created_at": row["created_at"],
        "archived_at": row["archived_at"],
    }


def _url(request: Request, url: str) -> str:
    url = url.strip()
    problem = remote.endpoint_problem(url, request.app.state.settings)
    if problem:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, problem)
    return url


def _sealed(request: Request, caller: OrgCaller, token: SecretStr, key: str, version: str) -> str | None:
    plain = token.get_secret_value().strip()
    if not plain:
        return None
    keys = sealed.keys_of(request.app.state.settings)
    return sealed.seal(keys, plain, remote.token_context(caller.org_id, key, version))


def _audit(caller: OrgCaller, action: str, entity: str, before: Any = None, after: Any = None) -> None:
    audit.record_org(
        caller.conn,
        org_id=caller.org_id,
        actor_id=caller.user_id,
        actor_name=caller.name,
        action=action,
        entity_type="model",
        entity_id=entity,
        before=before,
        after=after,
    )


@router.get("/org/models", response_model=list[HttpModelOut])
def list_http_models(caller: OrgAdmin) -> list[dict[str, Any]]:
    """Your organisation's models served over HTTP, archived ones too, by key then version (never
    their tokens)."""
    rows = caller.conn.execute(HTTP_MODELS + " ORDER BY key, created_at", [caller.org_id]).fetchall()
    return [_shown(r) for r in rows]


@router.post("/org/models", response_model=HttpModelOut, status_code=status.HTTP_201_CREATED)
def register_http_model(body: HttpModelIn, caller: OrgAdmin, request: Request) -> dict[str, Any]:
    """Register a model version computed by your endpoint: its spec (inputs, outputs, bounded
    parameters) and the https address Tiles posts each evaluation to. The host must be one the
    deployment allows (`TILES_MODEL_HOSTS`). A design model takes no inputs; a virtual sensor at
    least one. 409 if the version exists already: a version never changes, so give a new one."""
    try:
        spec = ModelSpec(
            key=body.key,
            version=body.version,
            name=body.name.strip(),
            kind=body.kind,
            domain=body.domain.strip(),
            description=body.description,
            inputs=tuple(Port(**p.model_dump()) for p in body.inputs),
            outputs=tuple(Port(**p.model_dump()) for p in body.outputs),
            params=tuple(Param(**(p.model_dump() | {"default": float(p.default)})) for p in body.params),
        )
    except ModelError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    if spec.kind == "design" and spec.inputs:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "A design model takes parameters only, no inputs")
    if spec.kind == "virtual-sensor" and not spec.inputs:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "A virtual sensor needs at least one input")
    if any(m.spec.key == spec.key for m in registry.all()):
        raise HTTPException(status.HTTP_409_CONFLICT, f"{spec.key} is a built-in model's key: choose another")
    url = _url(request, body.endpoint_url)
    token = _sealed(request, caller, body.token, spec.key, spec.version) if body.token else None
    try:
        with caller.conn.transaction():
            row = one(
                caller.conn.execute(
                    """
                INSERT INTO models (org_id, key, version, name, domain, kind, spec, source, endpoint_url,
                                    endpoint_token)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                RETURNING key, version, name, kind, domain, spec, endpoint_url, endpoint_token, archived_at, created_at
                """,
                    [
                        caller.org_id,
                        spec.key,
                        spec.version,
                        spec.name,
                        spec.domain,
                        spec.kind,
                        Jsonb(spec.as_json()),
                        remote.SOURCE,
                        url,
                        token,
                    ],
                ).fetchone()
            )
    except psycopg.errors.UniqueViolation:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{spec.key} {spec.version} is registered already: a version never changes, so give a new one",
        ) from None
    _audit(
        caller,
        "model.register",
        f"{spec.key}@{spec.version}",
        after={"name": spec.name, "kind": spec.kind, "endpoint_url": url, "token": token is not None},
    )
    return _shown(row)


@router.patch("/org/models/{key}/{version}", response_model=HttpModelOut)
def change_http_model(
    key: str, version: str, body: HttpModelChange, caller: OrgAdmin, request: Request
) -> dict[str, Any]:
    """Move a model version's endpoint, set or clear its token, or archive it (or bring it back).
    Its spec never changes."""
    row = caller.conn.execute(
        HTTP_MODELS + " AND key = %s AND version = %s FOR UPDATE", [caller.org_id, key, version]
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Your organisation has no model {key} {version} over HTTP")
    if body.token is not None and body.clear_token:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Give a new token or clear it, not both")
    url = row["endpoint_url"] if body.endpoint_url is None else _url(request, body.endpoint_url)
    token = row["endpoint_token"]
    if body.clear_token:
        token = None
    elif body.token is not None:
        token = _sealed(request, caller, body.token, key, version)
    archived = row["archived_at"] is not None if body.archived is None else body.archived
    updated = one(
        caller.conn.execute(
            """
        UPDATE models SET endpoint_url = %s, endpoint_token = %s,
               archived_at = CASE WHEN %s THEN coalesce(archived_at, now()) END
        WHERE org_id = %s AND key = %s AND version = %s AND source = 'http'
        RETURNING key, version, name, kind, domain, spec, endpoint_url, endpoint_token, archived_at, created_at
        """,
            [url, token, archived, caller.org_id, key, version],
        ).fetchone()
    )
    before = {
        "endpoint_url": row["endpoint_url"],
        "token": row["endpoint_token"] is not None,
        "archived": row["archived_at"] is not None,
    }
    after = {"endpoint_url": url, "token": token is not None, "archived": archived}
    if body.token is not None:
        after["token_replaced"] = True
    _audit(caller, "model.change", f"{key}@{version}", before=before, after=after)
    return _shown(updated)
