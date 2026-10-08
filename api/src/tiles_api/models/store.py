"""Registered models in the database: each organisation's `models` rows follow the registry.

A model version is written once; if the registry's spec for a stored version
differs (someone changed a published model without a new version), syncing
refuses rather than rewrite history that runs refer to.
"""

import uuid
from typing import Any

from psycopg.types.json import Jsonb

from tiles_api.models.registry import Model, Registry, registry
from tiles_api.store import Conn


class ModelChanged(RuntimeError):
    pass


def sync(conn: Conn, org_id: uuid.UUID, models: Registry = registry) -> None:
    """Adds the registry's model versions the organisation doesn't have; checks the others."""
    stored = {
        (r["key"], r["version"]): r
        for r in conn.execute("SELECT key, version, name, kind, domain, spec FROM models WHERE org_id = %s", [org_id])
    }
    changed = []
    for model in models.all():
        s = model.spec
        row = stored.get((s.key, s.version))
        if row is None:
            conn.execute(
                """
                INSERT INTO models (org_id, key, version, name, domain, kind, spec)
                VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT (org_id, key, version) DO NOTHING
                """,
                [org_id, s.key, s.version, s.name, s.domain, s.kind, Jsonb(s.as_json())],
            )
        elif (row["name"], row["kind"], row["domain"], row["spec"]) != (s.name, s.kind, s.domain, s.as_json()):
            changed.append(f"{s.key} {s.version}")
    if changed:
        raise ModelChanged(
            f"Published model version(s) changed: {', '.join(changed)}. Give the change a new version instead."
        )


def describe(model: Model) -> dict[str, Any]:
    s = model.spec
    return {"key": s.key, "version": s.version, "name": s.name, "kind": s.kind, "domain": s.domain, **s.as_json()}
