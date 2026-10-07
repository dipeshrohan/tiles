"""Ontology persistence: the working graph, staged ops and commit history.

Every write takes a row lock on the site, so commits and reverts on one site
are serialised and `seq` stays gapless. Validation is the pure logic in
tiles_api.ontology, which the browser shares via the parity fixtures.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from psycopg.types.json import Jsonb

from tiles_api import ontology as o
from tiles_api.identity import User
from tiles_api.store import Conn, one


class NotFound(LookupError):
    pass


def iso(ts: datetime) -> str:
    """The browser's Date.toISOString() format: UTC, milliseconds, Z."""
    return ts.astimezone(UTC).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def lock_site(conn: Conn, site_id: uuid.UUID) -> None:
    if conn.execute("SELECT 1 FROM sites WHERE id = %s FOR UPDATE", [site_id]).fetchone() is None:
        raise NotFound("Site not found")


# Nodes and edges in ONE statement: under READ COMMITTED each statement sees
# its own snapshot, so two queries could pair old nodes with a newer commit's
# edges and show a dangling relationship that never existed.
HEAD_SQL = """
SELECT 'node' AS kind, id, type, label, props, NULL AS from_id, NULL AS rel, NULL AS to_id
FROM ontology_nodes WHERE site_id = %(site)s
UNION ALL
SELECT 'edge', id, NULL, NULL, NULL, from_id, rel, to_id
FROM ontology_edges WHERE site_id = %(site)s
ORDER BY kind DESC, id
"""


def load_head(conn: Conn, site_id: uuid.UUID) -> o.Graph:
    graph = o.empty_graph()
    for r in conn.execute(HEAD_SQL, {"site": site_id}):
        if r["kind"] == "node":
            graph["nodes"][r["id"]] = {"id": r["id"], "type": r["type"], "label": r["label"], "props": r["props"]}
        else:
            graph["edges"][r["id"]] = {"id": r["id"], "from": r["from_id"], "rel": r["rel"], "to": r["to_id"]}
    return graph


def load_staged(conn: Conn, site_id: uuid.UUID, user: User) -> list[o.Op]:
    rows = conn.execute(
        "SELECT op FROM staged_ops WHERE site_id = %s AND user_id = %s ORDER BY position", [site_id, user.id]
    )
    return [r["op"] for r in rows]


def working(conn: Conn, site_id: uuid.UUID, user: User) -> o.Graph:
    return o.apply_ops(load_head(conn, site_id), load_staged(conn, site_id, user))[0]


def _commit_row(r: dict[str, Any]) -> o.Commit:
    return {
        "id": r["id"],
        "message": r["message"],
        "author": r["author_name"],
        "date": iso(r["created_at"]),
        "ops": r["ops"],
        "inverses": r["inverses"],
        "stats": r["stats"],
    }


def history(conn: Conn, site_id: uuid.UUID, limit: int = 50, offset: int = 0) -> list[o.Commit]:
    rows = conn.execute(
        """
        SELECT id, message, author_name, created_at, ops, inverses, stats FROM commits
        WHERE site_id = %s ORDER BY seq DESC LIMIT %s OFFSET %s
        """,
        [site_id, limit, offset],
    )
    return [_commit_row(r) for r in rows]


def stage(conn: Conn, site_id: uuid.UUID, user: User, *ops: o.Op) -> list[o.Op]:
    """Stages ops in order, all or none: each is checked against the working
    graph including the ones before it, and they are written in one transaction."""
    lock_site(conn, site_id)
    staged = load_staged(conn, site_id, user)
    repo: o.Repo = {"head": load_head(conn, site_id), "history": [], "staged": staged}
    for op in ops:
        repo = o.stage(repo, op)
    with conn.cursor() as cur:
        cur.executemany(
            "INSERT INTO staged_ops (site_id, user_id, position, op) VALUES (%s, %s, %s, %s)",
            [(site_id, user.id, len(staged) + i, Jsonb(op)) for i, op in enumerate(ops)],
        )
    return repo["staged"]


def discard(conn: Conn, site_id: uuid.UUID, user: User) -> list[o.Op]:
    """Drops the user's staged ops and returns exactly the ones dropped (read under the site lock)."""
    lock_site(conn, site_id)
    dropped = load_staged(conn, site_id, user)
    conn.execute("DELETE FROM staged_ops WHERE site_id = %s AND user_id = %s", [site_id, user.id])
    return dropped


def _write_ops(conn: Conn, site_id: uuid.UUID, ops: list[o.Op]) -> None:
    """Apply already-validated ops to the stored graph."""
    for op in ops:
        kind = op["kind"]
        if kind == "addNode":
            n = op["node"]
            conn.execute(
                "INSERT INTO ontology_nodes (site_id, id, type, label, props) VALUES (%s, %s, %s, %s, %s)",
                [site_id, n["id"], n["type"], n["label"], Jsonb(n.get("props") or {})],
            )
        elif kind == "removeNode":
            conn.execute("DELETE FROM ontology_nodes WHERE site_id = %s AND id = %s", [site_id, op["id"]])
        elif kind == "addEdge":
            e = op["edge"]
            conn.execute(
                "INSERT INTO ontology_edges (site_id, id, from_id, rel, to_id) VALUES (%s, %s, %s, %s, %s)",
                [site_id, e["id"], e["from"], e["rel"], e["to"]],
            )
        elif kind == "removeEdge":
            conn.execute("DELETE FROM ontology_edges WHERE site_id = %s AND id = %s", [site_id, op["id"]])
        elif kind == "setProp":
            if op.get("value") is None:
                conn.execute(
                    "UPDATE ontology_nodes SET props = props - %s WHERE site_id = %s AND id = %s",
                    [op["key"], site_id, op["id"]],
                )
            else:
                conn.execute(
                    "UPDATE ontology_nodes SET props = props || %s WHERE site_id = %s AND id = %s",
                    [Jsonb({op["key"]: op["value"]}), site_id, op["id"]],
                )
        else:  # pragma: no cover - apply_op rejected it already
            raise o.OntologyError(f"Unknown op {kind}")


def _record(conn: Conn, site_id: uuid.UUID, user: User, ops: list[o.Op], message: str, reverts: str | None) -> o.Commit:
    _, entry = o.make_commit(load_head(conn, site_id), ops, {"message": message, "author": user.name}, "")
    _write_ops(conn, site_id, entry["ops"])
    row = one(
        conn.execute(
            """
        INSERT INTO commits (site_id, id, seq, message, author_id, author_name, ops, inverses, stats, reverts)
        VALUES (%s, %s, (SELECT coalesce(max(seq), 0) + 1 FROM commits WHERE site_id = %s),
                %s, %s, %s, %s, %s, %s, %s)
        RETURNING id, message, author_name, created_at, ops, inverses, stats
        """,
            [
                site_id,
                entry["id"],
                site_id,
                entry["message"],
                user.id,
                user.name,
                Jsonb(entry["ops"]),
                Jsonb(entry["inverses"]),
                Jsonb(entry["stats"]),
                reverts,
            ],
        ).fetchone()
    )
    return _commit_row(row)


def commit(conn: Conn, site_id: uuid.UUID, user: User, message: str) -> o.Commit:
    lock_site(conn, site_id)
    entry = _record(conn, site_id, user, load_staged(conn, site_id, user), message, None)
    conn.execute("DELETE FROM staged_ops WHERE site_id = %s AND user_id = %s", [site_id, user.id])
    return entry


def revert(conn: Conn, site_id: uuid.UUID, user: User, commit_id: str) -> o.Commit:
    lock_site(conn, site_id)
    target = conn.execute(
        "SELECT id, message, author_name, created_at, ops, inverses, stats FROM commits WHERE site_id = %s AND id = %s",
        [site_id, commit_id],
    ).fetchone()
    if target is None:
        raise NotFound(f"Commit {commit_id} not found")
    if load_staged(conn, site_id, user):
        raise o.OntologyError("Commit or discard staged changes first")
    info = o.revert_info(_commit_row(target), user.name)
    return _record(conn, site_id, user, target["inverses"], info["message"], target["id"])
