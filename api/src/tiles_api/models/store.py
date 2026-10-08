"""Registered models in the database: an organisation's `models` row for a model version is
written when the version is first used, and never rewritten, since runs refer to it."""

import uuid
from typing import Any

from psycopg.types.json import Jsonb

from tiles_api.models.registry import Model
from tiles_api.store import Conn, one


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


def describe(model: Model) -> dict[str, Any]:
    s = model.spec
    return {"key": s.key, "version": s.version, "name": s.name, "kind": s.kind, "domain": s.domain, **s.as_json()}
