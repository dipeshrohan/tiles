"""Factory ontology: a typed graph plus Git-like change management.

A line-for-line port of js/lib/ontology.ts. Both implementations run the
shared fixture suite in test/fixtures/ontology-parity.json, so behaviour and
error messages must stay identical. Graphs, ops and commits are plain
JSON-shaped dicts, exactly as the browser stores them.
"""

import copy
import math
import uuid
from typing import Any, Literal, NotRequired, TypedDict

PropValue = str | int | float | bool


class Node(TypedDict):
    id: str
    type: str
    label: str
    props: dict[str, PropValue]


# "from" is a Python keyword, hence the functional form.
Edge = TypedDict("Edge", {"id": str, "from": str, "rel": str, "to": str})


class Graph(TypedDict):
    nodes: dict[str, Node]
    edges: dict[str, Edge]


# An op is one of: addNode{node}, removeNode{id}, addEdge{edge}, removeEdge{id},
# setProp{id, key, value?}. Kept as a loose dict; validation happens in apply_op.
Op = dict[str, Any]


class DiffStats(TypedDict):
    nodes: int
    edges: int
    props: int


class Commit(TypedDict):
    id: str
    message: str
    author: str
    date: str
    ops: list[Op]
    inverses: list[Op]
    stats: DiffStats


class Repo(TypedDict):
    head: Graph
    history: list[Commit]
    staged: list[Op]


class HealthIssue(TypedDict):
    level: Literal["error", "warn", "info"]
    kind: Literal["dangling", "duplicate", "orphan", "missing-prop"]
    ref: str
    text: str


class HealthReport(TypedDict):
    issues: list[HealthIssue]
    score: int
    counts: dict[str, int]


class CommitInfo(TypedDict):
    message: str
    author: str
    date: NotRequired[str]


class OntologyError(ValueError):
    """An op or commit that doesn't fit the current graph."""


# Mirrors NODE_TYPES in js/lib/ontology.ts (required properties per type).
NODE_TYPES: dict[str, list[str]] = {
    "Site": ["location"],
    "Workcenter": [],
    "Line": [],
    "Machine": ["vendor"],
    "Process": [],
    "Material": [],
    "PLC": ["protocol"],
    "Signal": ["unit"],
    "Document": [],
    "Model": [],
}


def empty_graph() -> Graph:
    return {"nodes": {}, "edges": {}}


def _clone(g: Graph) -> Graph:
    return {"nodes": dict(g["nodes"]), "edges": dict(g["edges"])}


def apply_op(graph: Graph, op: Op) -> tuple[Graph, Op]:
    """Apply one op; return the new graph and the op that undoes it."""
    g = _clone(graph)
    kind = op.get("kind")
    if kind == "addNode":
        node = op["node"]
        if node["id"] in g["nodes"]:
            raise OntologyError(f"Node {node['id']} already exists")
        if node["type"] not in NODE_TYPES:
            raise OntologyError(f"Unknown node type {node['type']}")
        g["nodes"][node["id"]] = {
            "id": node["id"],
            "type": node["type"],
            "label": node["label"],
            "props": dict(node.get("props") or {}),
        }
        return g, {"kind": "removeNode", "id": node["id"]}
    if kind == "removeNode":
        existing = g["nodes"].get(op["id"])
        if existing is None:
            raise OntologyError(f"Node {op['id']} not found")
        attached = [e for e in g["edges"].values() if op["id"] in (e["from"], e["to"])]
        if attached:
            raise OntologyError(f"Node {op['id']} still has {len(attached)} relationship(s)")
        del g["nodes"][op["id"]]
        return g, {"kind": "addNode", "node": existing}
    if kind == "addEdge":
        e = op["edge"]
        if e["id"] in g["edges"]:
            raise OntologyError(f"Relationship {e['id']} already exists")
        if e["from"] not in g["nodes"] or e["to"] not in g["nodes"]:
            raise OntologyError(f"Relationship {e['id']} points at a missing node")
        g["edges"][e["id"]] = {"id": e["id"], "from": e["from"], "rel": e["rel"], "to": e["to"]}
        return g, {"kind": "removeEdge", "id": e["id"]}
    if kind == "removeEdge":
        edge = g["edges"].get(op["id"])
        if edge is None:
            raise OntologyError(f"Relationship {op['id']} not found")
        del g["edges"][op["id"]]
        return g, {"kind": "addEdge", "edge": edge}
    if kind == "setProp":
        target = g["nodes"].get(op["id"])
        if target is None:
            raise OntologyError(f"Node {op['id']} not found")
        key = op["key"]
        had = key in target["props"]
        props = dict(target["props"])
        if op.get("value") is None:
            props.pop(key, None)
        else:
            props[key] = op["value"]
        g["nodes"][op["id"]] = {**target, "props": props}
        inverse: Op = {"kind": "setProp", "id": op["id"], "key": key}
        if had:
            inverse["value"] = target["props"][key]
        return g, inverse
    raise OntologyError(f"Unknown op {kind}")


def apply_ops(graph: Graph, ops: list[Op]) -> tuple[Graph, list[Op]]:
    """Apply ops in order; inverses come back in undo order (last op first)."""
    g = graph
    inverses: list[Op] = []
    for op in ops:
        g, inverse = apply_op(g, op)
        inverses.insert(0, inverse)
    return g, inverses


def diff_stats(ops: list[Op]) -> DiffStats:
    s: DiffStats = {"nodes": 0, "edges": 0, "props": 0}
    for op in ops:
        kind = op.get("kind")
        if kind == "addNode":
            s["nodes"] += 1
        elif kind == "removeNode":
            s["nodes"] -= 1
        elif kind == "addEdge":
            s["edges"] += 1
        elif kind == "removeEdge":
            s["edges"] -= 1
        elif kind == "setProp":
            s["props"] += -1 if op.get("value") is None else 1
    return s


def create_repo(graph: Graph | None = None) -> Repo:
    return {"head": graph or empty_graph(), "history": [], "staged": []}


def working_graph(repo: Repo) -> Graph:
    return apply_ops(repo["head"], repo["staged"])[0]


def stage(repo: Repo, op: Op) -> Repo:
    apply_op(working_graph(repo), op)  # validate against the working copy
    return {**repo, "staged": [*repo["staged"], op]}


def discard(repo: Repo) -> Repo:
    return {**repo, "staged": []}


def new_commit_id() -> str:
    return f"c{uuid.uuid4().hex[:12]}"


def make_commit(head: Graph, staged: list[Op], info: CommitInfo, now: str) -> tuple[Graph, Commit]:
    """Validate and build a commit of `staged` on top of `head`."""
    if not staged:
        raise OntologyError("Nothing to commit")
    message = (info.get("message") or "").strip()
    if not message:
        raise OntologyError("A commit needs a message")
    graph, inverses = apply_ops(head, staged)
    entry: Commit = {
        "id": new_commit_id(),
        "message": message,
        "author": info["author"],
        "date": info.get("date") or now,
        "ops": copy.deepcopy(staged),
        "inverses": inverses,
        "stats": diff_stats(staged),
    }
    return graph, entry


def commit(repo: Repo, info: CommitInfo, now: str = "") -> Repo:
    graph, entry = make_commit(repo["head"], repo["staged"], info, now)
    return {"head": graph, "history": [entry, *repo["history"]], "staged": []}


def revert_info(target: Commit, author: str, date: str | None = None) -> CommitInfo:
    info: CommitInfo = {"message": f'Revert "{target["message"]}"', "author": author}
    if date:
        info["date"] = date
    return info


def revert(repo: Repo, commit_id: str, author: str, date: str | None = None, now: str = "") -> Repo:
    target = next((c for c in repo["history"] if c["id"] == commit_id), None)
    if target is None:
        raise OntologyError(f"Commit {commit_id} not found")
    if repo["staged"]:
        raise OntologyError("Commit or discard staged changes first")
    return commit({**repo, "staged": target["inverses"]}, revert_info(target, author, date), now)


# ---- Health check -----------------------------------------------------------


def _js_round(x: float) -> int:
    """Math.round: halves round up, unlike Python's round()."""
    return math.floor(x + 0.5)


def health_check(graph: Graph) -> HealthReport:
    nodes = list(graph["nodes"].values())
    edges = list(graph["edges"].values())
    degree = {n["id"]: 0 for n in nodes}
    issues: list[HealthIssue] = []
    seen: dict[str, str] = {}
    for e in edges:
        src = graph["nodes"].get(e["from"])
        dst = graph["nodes"].get(e["to"])
        if src is None or dst is None:
            issues.append(
                {
                    "level": "error",
                    "kind": "dangling",
                    "ref": e["id"],
                    "text": f"Relationship {e['id']} points at a missing node",
                }
            )
            continue
        degree[e["from"]] = degree.get(e["from"], 0) + 1
        degree[e["to"]] = degree.get(e["to"], 0) + 1
        key = f"{e['from']}|{e['rel']}|{e['to']}"
        first = seen.get(key)
        if first:
            issues.append(
                {
                    "level": "warn",
                    "kind": "duplicate",
                    "ref": e["id"],
                    "text": f"Duplicate relationship {src['label']} —{e['rel']}→ {dst['label']} (also {first})",
                }
            )
        else:
            seen[key] = e["id"]
    for n in nodes:
        if degree.get(n["id"]) == 0:
            issues.append(
                {
                    "level": "warn",
                    "kind": "orphan",
                    "ref": n["id"],
                    "text": f'{n["type"]} "{n["label"]}" has no relationships',
                }
            )
        for req in NODE_TYPES.get(n["type"], []):
            if n["props"].get(req, "") == "":
                issues.append(
                    {
                        "level": "info",
                        "kind": "missing-prop",
                        "ref": n["id"],
                        "text": f'{n["type"]} "{n["label"]}" is missing "{req}"',
                    }
                )
    serious = sum(1 for i in issues if i["level"] != "info")
    score = max(0, _js_round(100 - serious * 100 / len(nodes))) if nodes else 100
    return {"issues": issues, "score": score, "counts": {"nodes": len(nodes), "edges": len(edges)}}
