"""An organisation's own models (T4.15): organisation admins register a model version with its
spec, computed by their endpoint over HTTP (models/remote.py) or by code from a GitHub repository at
a pinned commit, run in the sandbox (models/github.py). Every site of the organisation can then
try, bind and run it like a built-in model. A version's spec (and code) never changes (runs refer
to it): a new behaviour is a new version. An endpoint and its token may change, and any version may
be archived. Each step is in the organisation's audit log; tokens are sealed and never shown again.
"""

import urllib.parse
from dataclasses import dataclass
from datetime import datetime
from typing import Annotated, Any, Literal

import psycopg
from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from psycopg.types.json import Jsonb
from pydantic import BaseModel, ConfigDict, Field, SecretStr, StrictFloat, StrictInt, ValidationError

from tiles_api import audit, sealed
from tiles_api.api_models import ModelOut
from tiles_api.api_ontology import Auth
from tiles_api.api_sites import OrgAdmin, OrgCaller, org_admin
from tiles_api.models import github, remote, store
from tiles_api.models.registry import ModelError, ModelSpec, Param, Port, registry
from tiles_api.models.store import OWN_MODELS
from tiles_api.store import one, side_pool

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


class SpecIn(BaseModel):
    """A model version's spec, as registered (and as a model's tiles-model.json holds it)."""

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

    def to_spec(self) -> ModelSpec:
        """The spec, checked as a built-in model's is, and against the built-in models' keys."""
        try:
            spec = ModelSpec(
                key=self.key,
                version=self.version,
                name=self.name.strip(),
                kind=self.kind,
                domain=self.domain.strip(),
                description=self.description,
                inputs=tuple(Port(**p.model_dump()) for p in self.inputs),
                outputs=tuple(Port(**p.model_dump()) for p in self.outputs),
                params=tuple(Param(**(p.model_dump() | {"default": float(p.default)})) for p in self.params),
            )
        except ModelError as e:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
        if spec.kind == "design" and spec.inputs:
            raise HTTPException(
                status.HTTP_422_UNPROCESSABLE_CONTENT, "A design model takes parameters only, no inputs"
            )
        if spec.kind == "virtual-sensor" and not spec.inputs:
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "A virtual sensor needs at least one input")
        if any(m.spec.key == spec.key for m in registry.all()):
            raise HTTPException(status.HTTP_409_CONFLICT, f"{spec.key} is a built-in model's key: choose another")
        return spec


class HttpModelIn(SpecIn):
    endpoint_url: Annotated[str, Field(min_length=1, max_length=2000)]
    token: Annotated[SecretStr, Field(max_length=4096)] | None = Field(
        None, description="Sent as `Authorization: Bearer <token>`; sealed, and never shown again"
    )


class GithubSpecIn(SpecIn):
    """A model's tiles-model.json: its spec, and the file that defines run (model.py if left out)."""

    entry: Annotated[str, Field(max_length=200)] = "model.py"


class GithubModelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    repo: Annotated[str, Field(max_length=140, description="owner/name")]
    commit: Annotated[str, Field(max_length=40, description="The full commit SHA: the code never changes")]
    path: Annotated[str, Field(max_length=500, description="The model's directory; empty for the root")] = ""
    token: Annotated[SecretStr, Field(max_length=4096)] | None = Field(
        None, description="For a private repository: used to fetch the code this once, never kept"
    )


class ModelChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    endpoint_url: Annotated[str, Field(min_length=1, max_length=2000)] | None = None
    token: Annotated[SecretStr, Field(max_length=4096)] | None = Field(None, description="A new token")
    clear_token: bool = Field(False, description="Send no token from now on")
    archived: bool | None = Field(None, description="Archived: no new uses; runs made with it still show")


class OwnModelOut(ModelOut):
    endpoint_url: str | None = Field(None, description="Over HTTP: where it is computed")
    has_token: bool = False
    repo: str | None = Field(None, description="From GitHub: the repository, commit and directory")
    commit: str | None = None
    path: str | None = None
    code_sha256: str | None = Field(None, description="From GitHub: the SHA-256 of the code kept")
    created_at: datetime
    archived_at: datetime | None


def _shown(row: dict[str, Any]) -> dict[str, Any]:
    return store.describe_spec(remote.spec_of(row), row["source"]) | {
        "endpoint_url": row["endpoint_url"],
        "has_token": row["endpoint_token"] is not None,
        "repo": row["repo"],
        "commit": row["commit_sha"],
        "path": row["path"],
        "code_sha256": row["code_sha256"],
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


RETURNING = (
    " RETURNING key, version, name, kind, domain, spec, source, endpoint_url, endpoint_token, repo, commit_sha, path,"
    " entry, code_sha256, archived_at, created_at"
)


UPDATE_SQL = (
    "UPDATE models SET endpoint_url = %s, endpoint_token = %s,"  # noqa: S608 - constants
    " archived_at = CASE WHEN %s THEN coalesce(archived_at, now()) END"
    " WHERE org_id = %s AND key = %s AND version = %s AND source IN ('http', 'github')" + RETURNING
)


def _insert(caller: OrgCaller, spec: ModelSpec, columns: dict[str, Any]) -> dict[str, Any]:
    """Stores a new version; 409 if it exists: a version never changes."""
    values = {
        "org_id": caller.org_id,
        "key": spec.key,
        "version": spec.version,
        "name": spec.name,
        "domain": spec.domain,
        "kind": spec.kind,
        "spec": Jsonb(spec.as_json()),
    } | columns
    names = ", ".join(values)  # the code's own column names
    marks = ", ".join(["%s"] * len(values))
    try:
        with caller.conn.transaction():
            return one(
                caller.conn.execute(
                    f"INSERT INTO models ({names}) VALUES ({marks})" + RETURNING,  # noqa: S608 - fixed names
                    list(values.values()),
                ).fetchone()
            )
    except psycopg.errors.UniqueViolation:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            f"{spec.key} {spec.version} is registered already: a version never changes, so give a new one",
        ) from None


@router.get("/org/models", response_model=list[OwnModelOut])
def list_own_models(caller: OrgAdmin) -> list[dict[str, Any]]:
    """Your organisation's own models, over HTTP and from GitHub, archived ones too, by key then
    version (never their tokens or code)."""
    rows = caller.conn.execute(OWN_MODELS + " ORDER BY key, created_at", [caller.org_id]).fetchall()
    return [_shown(r) for r in rows]


@router.post("/org/models", response_model=OwnModelOut, status_code=status.HTTP_201_CREATED)
def register_http_model(body: HttpModelIn, caller: OrgAdmin, request: Request) -> dict[str, Any]:
    """Register a model version computed by your endpoint: its spec (inputs, outputs, bounded
    parameters) and the https address Tiles posts each evaluation to. The host must be one the
    deployment allows (`TILES_MODEL_HOSTS`). A design model takes no inputs; a virtual sensor at
    least one. 409 if the version exists already: a version never changes, so give a new one."""
    spec = body.to_spec()
    url = _url(request, body.endpoint_url)
    token = _sealed(request, caller, body.token, spec.key, spec.version) if body.token else None
    row = _insert(caller, spec, {"source": remote.SOURCE, "endpoint_url": url, "endpoint_token": token})
    _audit(
        caller,
        "model.register",
        f"{spec.key}@{spec.version}",
        after={"name": spec.name, "kind": spec.kind, "endpoint_url": url, "token": token is not None},
    )
    return _shown(row)


@dataclass(frozen=True)
class Fetched:
    repo: str
    commit: str
    path: str
    spec: ModelSpec
    entry: str
    code: bytes


def admin_first(principal: Auth, request: Request, org: Annotated[str | None, Query()] = None) -> None:
    """The organisation-admin check, on a short connection of its own given back before anything
    is fetched: no one else makes Tiles fetch, and a slow download holds no connection."""
    with side_pool(request.app.state).connection() as conn:
        org_admin(principal, conn, org)


def fetched_model(body: GithubModelIn, _admin: Annotated[None, Depends(admin_first)], request: Request) -> Fetched:
    """The model's code and spec from GitHub, bounded by GITHUB_TIMEOUT."""
    settings = request.app.state.settings
    if not settings.sandbox_url or settings.sandbox_token is None:
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "This deployment has no sandbox for models from GitHub: its operator sets TILES_SANDBOX_URL",
        )
    try:
        path = github.check_source(body.repo, body.commit, body.path)
        token = body.token.get_secret_value().strip() or None if body.token else None
        archive = github.fetch(body.repo, body.commit, token, GITHUB_TIMEOUT)
        found, code = github.pack(archive, path)
    except github.GithubError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    try:
        described = GithubSpecIn.model_validate(found)
    except ValidationError as e:
        where = f"{path}/{github.SPEC_FILE}" if path else github.SPEC_FILE
        problems = "; ".join(f"{'.'.join(map(str, err['loc']))}: {err['msg']}" for err in e.errors()[:5])
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, f"{where}: {problems}") from None
    return Fetched(body.repo, body.commit, path, described.to_spec(), described.entry, code)


GITHUB_TIMEOUT = 60.0


@router.post("/org/models/github", response_model=OwnModelOut, status_code=status.HTTP_201_CREATED)
def register_github_model(model: Annotated[Fetched, Depends(fetched_model)], caller: OrgAdmin) -> dict[str, Any]:
    """Register a model version from a GitHub repository at a full commit SHA: the directory
    (`path`) holds `tiles-model.json` (the spec, and the `entry` file, `model.py` unless named) and
    the Python files, whose `run(inputs, params)` the sandbox calls (the standard library only).
    The code is fetched once and kept, with its SHA-256; a private repository's token is used for
    that and not kept. Needs the deployment's sandbox (`TILES_SANDBOX_URL`)."""
    spec = model.spec
    sha = github.digest(model.code)
    row = _insert(
        caller,
        spec,
        {
            "source": github.SOURCE,
            "repo": model.repo,
            "commit_sha": model.commit,
            "path": model.path,
            "entry": model.entry,
            "code": model.code,
            "code_sha256": sha,
        },
    )
    _audit(
        caller,
        "model.register",
        f"{spec.key}@{spec.version}",
        after={
            "name": spec.name,
            "kind": spec.kind,
            "repo": model.repo,
            "commit": model.commit,
            "path": model.path,
            "code_sha256": sha,
        },
    )
    return _shown(row)


@router.patch("/org/models/{key}/{version}", response_model=OwnModelOut)
def change_own_model(key: str, version: str, body: ModelChange, caller: OrgAdmin, request: Request) -> dict[str, Any]:
    """Archive a model version (or bring it back); for one over HTTP, also move its endpoint or set
    or clear its token. Its spec, and a GitHub model's code, never change."""
    row = caller.conn.execute(
        OWN_MODELS + " AND key = %s AND version = %s FOR UPDATE", [caller.org_id, key, version]
    ).fetchone()
    if row is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"Your organisation has no model {key} {version} of its own")
    if row["source"] == github.SOURCE and (body.endpoint_url is not None or body.token is not None or body.clear_token):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "A model from GitHub has no endpoint or token: register a new version for new code",
        )
    if body.token is not None and body.clear_token:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "Give a new token or clear it, not both")
    url = row["endpoint_url"] if body.endpoint_url is None else _url(request, body.endpoint_url)
    moved = row["endpoint_url"] is not None and (
        urllib.parse.urlsplit(url).hostname != urllib.parse.urlsplit(row["endpoint_url"]).hostname
    )
    if moved and row["endpoint_token"] is not None and body.token is None and not body.clear_token:
        # The token was given for the old host: it isn't sent to another unless someone says so.
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_CONTENT,
            "The endpoint moves to another host: give its token, or clear_token to send none",
        )
    token = row["endpoint_token"]
    if body.clear_token:
        token = None
    elif body.token is not None:
        token = _sealed(request, caller, body.token, key, version)
    archived = row["archived_at"] is not None if body.archived is None else body.archived
    updated = one(
        caller.conn.execute(
            UPDATE_SQL,
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
