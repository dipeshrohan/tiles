"""Bulk ontology import and export (T2.13), as JSON or CSV.

Export writes the committed graph. Import reads a file into a graph and plans
the ops that turn the committed graph into it; they are staged like any other
change, so they are committed (or sent for review) by the engineer. Nothing in
a file is written straight to the history.

- **merge** adds the file's nodes and relationships and sets their properties;
  nothing else changes.
- **replace** also removes the nodes, relationships and properties that the
  file doesn't have, so the committed graph ends up exactly as the file.

Nodes and relationships are matched by id. The ops can't rename a node or
change its type, so a file that does is refused, naming each one.

CSV is one table: a `kind` column (`node` or `edge`), then `id`, `type`, `label`
(nodes), `from`, `rel`, `to` (relationships) and a `prop:<key>` column per
property. A cell that reads as a number or as true/false is that, unless it
starts with an apostrophe, which marks text (`'1.3` is the text 1.3, as in
spreadsheets; export writes text that way); an empty cell is no property.
"""

import csv
import io
import json
import math
from dataclasses import dataclass, field
from typing import Any, Literal

from tiles_api import ontology as o

Format = Literal["json", "csv"]
Mode = Literal["merge", "replace"]

FORMAT_NAME = "tiles-ontology"
MAX_NODES = 20_000
MAX_EDGES = 50_000
MAX_ID = 200
MAX_LABEL = 500
NODE_COLUMNS = ["kind", "id", "type", "label", "from", "rel", "to"]


class FileProblems(ValueError):
    """A file that can't be imported, with the problems found (the first 30)."""

    def __init__(self, problems: list[str]) -> None:
        super().__init__("; ".join(problems))
        self.problems = problems


# ---- export ------------------------------------------------------------------


def to_json(graph: o.Graph, meta: dict[str, Any]) -> str:
    nodes = [graph["nodes"][k] for k in sorted(graph["nodes"])]
    edges = [graph["edges"][k] for k in sorted(graph["edges"])]
    body = {"format": FORMAT_NAME, "version": 1, **meta, "nodes": nodes, "edges": edges}
    return json.dumps(body, ensure_ascii=False, indent=2) + "\n"


def _cell(value: o.PropValue) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str) and (value.startswith("'") or not isinstance(_read_cell(value), str)):
        return "'" + value  # text that would read back as a number or true/false (as in spreadsheets)
    return str(value)


def to_csv(graph: o.Graph) -> str:
    keys = sorted({k for n in graph["nodes"].values() for k in n["props"]})
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow([*NODE_COLUMNS, *(f"prop:{k}" for k in keys)])
    for nid in sorted(graph["nodes"]):
        n = graph["nodes"][nid]
        props = n["props"]
        writer.writerow(["node", n["id"], n["type"], n["label"], "", "", "", *(_safe(props, k) for k in keys)])
    for eid in sorted(graph["edges"]):
        e = graph["edges"][eid]
        writer.writerow(["edge", e["id"], "", "", e["from"], e["rel"], e["to"], *([""] * len(keys))])
    return out.getvalue()


def _safe(props: dict[str, o.PropValue], key: str) -> str:
    return _cell(props[key]) if key in props else ""


# ---- reading a file ------------------------------------------------------------


class _Problems:
    def __init__(self) -> None:
        self.items: list[str] = []
        self.more = 0

    def add(self, text: str) -> None:
        if len(self.items) < 30:
            self.items.append(text)
        else:
            self.more += 1

    def raise_if_any(self) -> None:
        if self.items:
            raise FileProblems(self.items + ([f"… and {self.more} more"] if self.more else []))


def _text(value: Any, what: str, problems: _Problems, *, limit: int, required: bool = True) -> str | None:
    if not isinstance(value, str) or (required and not value.strip()):
        problems.add(f"{what} must be text")
        return None
    if len(value) > limit or "\x00" in value:
        problems.add(f"{what} is too long or has a NUL character")
        return None
    return value


def _prop_value(value: Any) -> bool:
    return (isinstance(value, (str, bool, int)) or (isinstance(value, float) and math.isfinite(value))) and not (
        isinstance(value, str) and "\x00" in value
    )


def _graph(raw_nodes: list[Any], raw_edges: list[Any]) -> o.Graph:
    """A graph from parsed node and relationship records, or every problem with them."""
    problems = _Problems()
    if len(raw_nodes) > MAX_NODES or len(raw_edges) > MAX_EDGES:
        raise FileProblems([f"At most {MAX_NODES} nodes and {MAX_EDGES} relationships per file"])
    graph = o.empty_graph()
    for i, n in enumerate(raw_nodes, 1):
        where = f"node {i}"
        if not isinstance(n, dict):
            problems.add(f"{where} is not an object")
            continue
        nid = _text(n.get("id"), f"{where}: id", problems, limit=MAX_ID)
        ntype = n.get("type")
        label = _text(n.get("label", ""), f"{where}: label", problems, limit=MAX_LABEL, required=False)
        props = n.get("props") or {}
        if ntype not in o.NODE_TYPES:
            problems.add(f"{where}: unknown type {ntype!r} (one of {', '.join(o.NODE_TYPES)})")
        if not isinstance(props, dict) or not all(
            isinstance(k, str) and 0 < len(k) <= MAX_ID and _prop_value(v) for k, v in props.items()
        ):
            problems.add(f"{where}: props must map names to text, numbers or true/false")
            continue
        if nid is None or label is None or ntype not in o.NODE_TYPES:
            continue
        if nid in graph["nodes"]:
            problems.add(f"node {nid} appears twice")
            continue
        graph["nodes"][nid] = {"id": nid, "type": ntype, "label": label, "props": dict(props)}
    for i, e in enumerate(raw_edges, 1):
        where = f"relationship {i}"
        if not isinstance(e, dict):
            problems.add(f"{where} is not an object")
            continue
        values = [_text(e.get(k), f"{where}: {k}", problems, limit=MAX_ID) for k in ("id", "from", "rel", "to")]
        eid, frm, rel, to = values
        if eid is None or frm is None or rel is None or to is None:
            continue
        if eid in graph["edges"]:
            problems.add(f"relationship {eid} appears twice")
            continue
        graph["edges"][eid] = {"id": eid, "from": frm, "rel": rel, "to": to}
    problems.raise_if_any()
    return graph


def from_json(content: str) -> o.Graph:
    try:
        body = json.loads(content)
    except ValueError as e:
        raise FileProblems([f"Not valid JSON: {e}"]) from e
    if not isinstance(body, dict):
        raise FileProblems(["The file must be a JSON object with nodes and edges"])
    nodes, edges = body.get("nodes", []), body.get("edges", [])
    # Lists (our export) or id-keyed objects (the API's graph).
    nodes = list(nodes.values()) if isinstance(nodes, dict) else nodes
    edges = list(edges.values()) if isinstance(edges, dict) else edges
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise FileProblems(["nodes and edges must be lists"])
    return _graph(nodes, edges)


def _read_cell(text: str) -> o.PropValue:
    if text.startswith("'"):
        return text[1:]  # marked as text
    if text in ("true", "false"):
        return text == "true"
    try:
        number = float(text)
    except ValueError:
        return text
    if not math.isfinite(number):
        return text
    return int(number) if number.is_integer() and "." not in text and "e" not in text.lower() else number


def from_csv(content: str) -> o.Graph:
    rows = list(csv.reader(io.StringIO(content.lstrip("﻿"))))
    if not rows:
        raise FileProblems(["The file is empty"])
    header = [h.strip() for h in rows[0]]
    missing = [c for c in NODE_COLUMNS if c not in header]
    if missing:
        raise FileProblems([f"Missing column(s): {', '.join(missing)}"])
    col = {name: header.index(name) for name in NODE_COLUMNS}
    prop_cols = [(i, h[5:]) for i, h in enumerate(header) if h.startswith("prop:") and h[5:]]
    nodes: list[Any] = []
    edges: list[Any] = []
    problems = _Problems()
    for line, row in enumerate(rows[1:], 2):
        if not any(cell.strip() for cell in row):
            continue
        cell = {name: row[i] if i < len(row) else "" for name, i in col.items()}
        kind = cell["kind"].strip()
        if kind == "node":
            props = {key: _read_cell(row[i]) for i, key in prop_cols if i < len(row) and row[i] != ""}
            nodes.append({"id": cell["id"], "type": cell["type"].strip(), "label": cell["label"], "props": props})
        elif kind == "edge":
            edges.append({k: cell[k] for k in ("id", "from", "rel", "to")})
        else:
            problems.add(f"line {line}: kind must be node or edge, not {kind!r}")
    problems.raise_if_any()
    return _graph(nodes, edges)


def read(content: str, fmt: Format) -> o.Graph:
    return from_json(content) if fmt == "json" else from_csv(content)


# ---- planning the ops ----------------------------------------------------------


@dataclass
class Plan:
    ops: list[o.Op] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)
    # Relationships skipped because the same one is already there under another id.
    duplicates: list[str] = field(default_factory=list)


def plan(head: o.Graph, target: o.Graph, mode: Mode) -> Plan:
    """The ops that bring `head` to `target` (merge: only adding and setting)."""
    problems = _Problems()
    # Merge may link the file's nodes to ones already in the ontology; replace keeps only the file's.
    known = target["nodes"] if mode == "replace" else head["nodes"] | target["nodes"]
    for eid, e in target["edges"].items():
        for end in dict.fromkeys((e["from"], e["to"])):
            if end not in known:
                where = "in the file" if mode == "replace" else "in the file or the ontology"
                problems.add(f"relationship {eid} points at {end}, which is not a node {where}")
    for nid, n in target["nodes"].items():
        have = head["nodes"].get(nid)
        if have and have["type"] != n["type"]:
            problems.add(f"node {nid} is a {have['type']}, not a {n['type']}: change its type by hand")
        elif have and have["label"] != n["label"]:
            problems.add(f"node {nid} is called {have['label']!r}, not {n['label']!r}: rename it by hand")
    problems.raise_if_any()

    remove_edges: list[o.Op] = []
    add_edges: list[o.Op] = []
    result = Plan()
    existing = {(e["from"], e["rel"], e["to"]): eid for eid, e in head["edges"].items()}
    for eid, e in target["edges"].items():
        same_id = head["edges"].get(eid)
        if same_id == e:
            continue
        if same_id is not None:  # same id, another relationship: it is replaced
            remove_edges.append({"kind": "removeEdge", "id": eid})
        elif (e["from"], e["rel"], e["to"]) in existing:
            result.duplicates.append(eid)
            continue
        add_edges.append({"kind": "addEdge", "edge": dict(e)})
    remove_nodes: list[o.Op] = []
    if mode == "replace":
        kept = {(e["from"], e["rel"], e["to"]) for e in target["edges"].values()}
        for eid, e in sorted(head["edges"].items()):
            if eid not in target["edges"] and (e["from"], e["rel"], e["to"]) not in kept:
                remove_edges.append({"kind": "removeEdge", "id": eid})
        remove_nodes = [
            {"kind": "removeNode", "id": nid} for nid in sorted(head["nodes"]) if nid not in target["nodes"]
        ]
    add_nodes: list[o.Op] = []
    set_props: list[o.Op] = []
    for nid in sorted(target["nodes"]):
        n = target["nodes"][nid]
        have = head["nodes"].get(nid)
        if have is None:
            add_nodes.append({"kind": "addNode", "node": {**n, "props": dict(n["props"])}})
            continue
        for key in sorted(n["props"]):
            value = n["props"][key]
            if key not in have["props"] or have["props"][key] != value or type(have["props"][key]) is not type(value):
                set_props.append({"kind": "setProp", "id": nid, "key": key, "value": value})
        if mode == "replace":
            set_props += [
                {"kind": "setProp", "id": nid, "key": key} for key in sorted(have["props"]) if key not in n["props"]
            ]
    result.ops = remove_edges + remove_nodes + add_nodes + set_props + add_edges
    result.counts = {
        "add_nodes": len(add_nodes),
        "remove_nodes": len(remove_nodes),
        "set_props": sum(1 for op in set_props if "value" in op),
        "remove_props": sum(1 for op in set_props if "value" not in op),
        "add_edges": len(add_edges),
        "remove_edges": len(remove_edges),
    }
    return result
