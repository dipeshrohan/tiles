"""Registered models in the database: an organisation's `models` row for a built-in model version
is written when the version is first used, and never rewritten, since runs refer to it. An
organisation's own models (T4.15), served over HTTP (remote.py) or from GitHub and run in the
sandbox (github.py), are rows it registers; `find` gives any kind."""

import uuid
from typing import Any

from psycopg.types.json import Jsonb

from tiles_api.models import github, remote
from tiles_api.models.registry import Model, ModelSpec, registry, version_key
from tiles_api.settings import Settings
from tiles_api.store import Conn, one

# An organisation's own model versions (T4.15), without their code (`find` reads it to run one).
OWN_MODELS = """
SELECT key, version, name, kind, domain, spec, source, endpoint_url, endpoint_token, repo, commit_sha, path, entry,
       code_sha256, archived_at, created_at
FROM models WHERE org_id = %s AND source IN ('http', 'github')
"""


class ModelChanged(RuntimeError):
    pass


def model_id(conn: Conn, org_id: uuid.UUID, model: Model) -> uuid.UUID:
    """The organisation's row for this model version, written the first time it is used (a run,
    T3.03). A stored version whose spec differs from the registry's is refused; the unit test on
    models/published.json keeps that from reaching a deployment."""
    s = model.spec
    conn.execute(
        """
        INSERT INTO models (org_id, key, version, name, domain, kind, spec)
        VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT (org_id, key, version) DO NOTHING
        """,
        [org_id, s.key, s.version, s.name, s.domain, s.kind, Jsonb(s.as_json())],
    )
    row = one(
        conn.execute(
            "SELECT id, name, kind, domain, spec FROM models WHERE org_id = %s AND key = %s AND version = %s",
            [org_id, s.key, s.version],
        ).fetchone()
    )
    if (row["name"], row["kind"], row["domain"], row["spec"]) != (s.name, s.kind, s.domain, s.as_json()):
        raise ModelChanged(f"Model {s.key} {s.version} was stored with another spec. Give the change a new version.")
    model_uuid: uuid.UUID = row["id"]
    return model_uuid


def own_model(
    row: dict[str, Any], org_id: uuid.UUID, settings: Settings, code: bytes | None = None
) -> remote.HttpModel | github.SandboxModel:
    """The model of an organisation's own `models` row: over HTTP, or from GitHub (with its code,
    to run it)."""
    spec = remote.spec_of(row)
    if row["source"] == github.SOURCE:
        return github.SandboxModel(spec, row["code_sha256"], row["entry"], code, org_id, settings)
    return remote.HttpModel(spec, row["endpoint_url"], row["endpoint_token"], org_id, settings)


def find(
    conn: Conn,
    org_id: uuid.UUID,
    settings: Settings,
    key: str,
    version: str | None = None,
    *,
    archived: bool = False,
) -> Model:
    """A model version the organisation can use, the latest unless one is named: one of its own
    (over HTTP or from GitHub; not archived, unless `archived`: what is already running with it, a binding
    or a queued sweep, keeps going), or else a built-in one. A key the organisation registered is
    its own, even if a later release adds a built-in model by that name. KeyError if there is none."""
    rows = conn.execute(OWN_MODELS + " AND key = %s", [org_id, key]).fetchall()
    if not rows:
        return registry.get(key, version)
    rows = [r for r in rows if (version is None or r["version"] == version) and (archived or r["archived_at"] is None)]
    if not rows:
        raise KeyError(f"No model {key}" + (f" version {version}" if version else ""))
    row = max(rows, key=lambda r: version_key(r["version"]))
    code = None
    if row["source"] == github.SOURCE:
        found = conn.execute(
            "SELECT code FROM models WHERE org_id = %s AND key = %s AND version = %s", [org_id, key, row["version"]]
        ).fetchone()
        code = bytes(found["code"]) if found else None
    return own_model(row, org_id, settings, code)


def usable(conn: Conn, org_id: uuid.UUID, settings: Settings) -> list[Model]:
    """Every model version the organisation can use: the built-in ones (but those whose key it uses
    itself), then its own (over HTTP or from GitHub) that aren't archived."""
    rows = conn.execute(OWN_MODELS, [org_id]).fetchall()
    taken = {r["key"] for r in rows}
    own = sorted((r for r in rows if r["archived_at"] is None), key=lambda r: (r["key"], version_key(r["version"])))
    builtin = [m for m in registry.all() if m.spec.key not in taken]
    return [*builtin, *(own_model(r, org_id, settings) for r in own)]


def source_of(model: Model) -> str:
    if isinstance(model, remote.HttpModel):
        return remote.SOURCE
    return github.SOURCE if isinstance(model, github.SandboxModel) else "builtin"


def describe(model: Model) -> dict[str, Any]:
    return describe_spec(model.spec, source_of(model))


def describe_spec(s: ModelSpec, source: str) -> dict[str, Any]:
    head = {"key": s.key, "version": s.version, "name": s.name, "kind": s.kind, "domain": s.domain, "source": source}
    return head | s.as_json()
