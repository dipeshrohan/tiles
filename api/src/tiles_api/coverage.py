"""Line coverage (T7.01): for each machine at or under a place of the ontology, what Tiles watches
and what is missing.

A machine's signals are the Signal nodes its PLCs emit (Machine controlledBy PLC emits Signal) and
those it contains itself, as the Plant page finds them (js/lib/plant.ts). A signal node counts once
a catalogue tag is linked to it (signals.node_id). Its detectors and model bindings are the enabled
ones on those tags. Its event streams are the catalogue's event signals (downtime, scrap, other)
whose asset is the machine's: the node's `asset` property when it has one, else its label, exactly
as written, the way Warning performance matches events to detectors' assets.

What is missing, in the order it must be done: a signal node or a linked tag, then a detector, then
an event stream (without which its warnings can't be scored).
"""

import uuid
from typing import Any

from tiles_api import ontology_store
from tiles_api.ontology import Graph
from tiles_api.store import Conn

PLACES = ("Enterprise", "Site", "Workcenter", "Line", "Cell", "Machine")  # js/lib/ontology.ts HIERARCHY


class NoPlace(LookupError):
    """The place named isn't a place of the committed ontology."""


class Index:
    """The graph's relationships, read once: each node's targets by relationship, and the places
    that contain each node (in the graph's order), so a large plant isn't scanned per node."""

    def __init__(self, graph: Graph) -> None:
        self.graph = graph
        self.outs: dict[tuple[str, str], list[str]] = {}
        self.containers: dict[str, list[str]] = {}
        for e in graph["edges"].values():
            if e["to"] not in graph["nodes"]:
                continue
            self.outs.setdefault((e["from"], e["rel"]), []).append(e["to"])
            if e["rel"] == "contains" and self.is_place(e["from"]):
                self.containers.setdefault(e["to"], []).append(e["from"])

    def out(self, node: str, rel: str) -> list[str]:
        return self.outs.get((node, rel), [])

    def is_place(self, node: str) -> bool:
        found = self.graph["nodes"].get(node)
        return found is not None and found["type"] in PLACES

    def parent_place(self, node: str) -> str | None:
        """The first place that contains it, as js/lib/plant.ts parentPlace takes it."""
        return next(iter(self.containers.get(node, [])), None)


def machines_under(index: Index, place: str | None) -> list[str]:
    """Every machine at or under `place` (every machine of the site without one), by name."""
    nodes = index.graph["nodes"]
    found: list[str] = []
    if place is None:
        found = [n for n, node in nodes.items() if node["type"] == "Machine"]
    else:
        if not index.is_place(place):
            raise NoPlace(place)
        seen: set[str] = set()
        stack = [place]
        while stack:
            at = stack.pop()
            if at in seen:
                continue
            seen.add(at)
            if nodes[at]["type"] == "Machine":
                found.append(at)
            stack += [c for c in index.out(at, "contains") if index.is_place(c) and index.parent_place(c) == at]
    return sorted(found, key=lambda n: (nodes[n]["label"].lower(), n))


def signal_nodes(index: Index, machine: str) -> list[str]:
    """The machine's Signal nodes: those its PLCs emit and those it contains itself."""
    nodes = index.graph["nodes"]
    found = [s for plc in index.out(machine, "controlledBy") for s in index.out(plc, "emits")]
    found += [c for c in index.out(machine, "contains") if nodes[c]["type"] == "Signal"]
    return sorted({s for s in found if nodes[s]["type"] == "Signal"})


def asset_of(graph: Graph, machine: str) -> str:
    """The name the MES knows the machine by: its `asset` property, else its label."""
    node = graph["nodes"][machine]
    asset = node["props"].get("asset")
    return str(asset).strip() if isinstance(asset, str) and asset.strip() else node["label"]


def report(conn: Conn, site_id: uuid.UUID, place: str | None) -> dict[str, Any]:
    """The coverage of every machine at or under `place`, and the totals."""
    graph = ontology_store.load_head(conn, site_id)
    index = Index(graph)
    machines = machines_under(index, place)
    nodes = {m: signal_nodes(index, m) for m in machines}
    every = sorted({n for ns in nodes.values() for n in ns})
    linked = {
        r["node_id"]: r
        for r in conn.execute(
            "SELECT id, tag, node_id FROM signals WHERE site_id = %s AND node_id = ANY(%s)", [site_id, every]
        ).fetchall()
    }
    ids = [r["id"] for r in linked.values()]
    detectors: dict[uuid.UUID, int] = {}
    for r in conn.execute(
        "SELECT signal_id, count(*) AS n FROM detectors WHERE site_id = %s AND enabled AND signal_id = ANY(%s)"
        " GROUP BY signal_id",
        [site_id, ids],
    ).fetchall():
        detectors[r["signal_id"]] = r["n"]
    bindings = conn.execute(
        "SELECT id, inputs FROM model_bindings WHERE site_id = %s AND enabled", [site_id]
    ).fetchall()
    events = conn.execute(
        "SELECT tag, event_kind, asset FROM signals"
        " WHERE site_id = %s AND event_kind IS NOT NULL AND asset IS NOT NULL ORDER BY tag",
        [site_id],
    ).fetchall()
    rows = []
    for m in machines:
        mine = [linked[n] for n in nodes[m] if n in linked]
        tag_ids = {r["id"] for r in mine}
        asset = asset_of(graph, m)
        streams = [{"tag": e["tag"], "kind": e["event_kind"]} for e in events if e["asset"] == asset]
        models = sum(1 for b in bindings if tag_ids & {_uuid(v) for v in b["inputs"].values()})
        row = {
            "id": m,
            "label": graph["nodes"][m]["label"],
            "asset": asset,
            "signal_nodes": len(nodes[m]),
            "signals": len(mine),
            "detectors": sum(detectors.get(i, 0) for i in tag_ids),
            "models": models,
            "event_streams": streams,
        }
        row["missing"] = missing(row)
        rows.append(row)
    return {
        "place": place,
        "machines": rows,
        "totals": {
            "machines": len(rows),
            "covered": sum(1 for r in rows if not r["missing"]),
            "with_signals": sum(1 for r in rows if r["signals"]),
            "with_detectors": sum(1 for r in rows if r["detectors"]),
            "with_events": sum(1 for r in rows if r["event_streams"]),
        },
    }


def missing(row: dict[str, Any]) -> list[str]:
    """What a machine still needs, in the order to do it."""
    out = []
    if not row["signal_nodes"]:
        out.append("signal_nodes")  # no Signal node under its PLCs in the ontology
    elif not row["signals"]:
        out.append("linked_tags")  # Signal nodes, but no catalogue tag linked to them
    if row["signals"] and not row["detectors"]:
        out.append("detector")
    if not row["event_streams"]:
        out.append("event_stream")
    return out


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None
