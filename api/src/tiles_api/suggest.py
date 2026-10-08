"""Agentic ingestion v1 (T2.11): suggests the ontology node for each unmapped tag.

For a tag that no Signal node is linked to yet, it suggests either

- **link**: an existing Signal node that no tag is linked to, whose name (or its
  `tag` property) matches the tag and whose unit agrees; or
- **create**: a new Signal node for the tag, with a label and unit read from the
  tag, emitted by the PLC the tag most likely comes from. That PLC is the one
  that emits the signals of sibling tags (same prefix, already mapped), or else
  the one controlling the machine the tag names (`press1.temperature` →
  Machine "Press 1" → its PLC). The node carries the tag in its `tag` property,
  so once it is committed the tag links to it in one step.

Every suggestion has a score (0 to 1) and the reasons behind it, in words, so an
engineer can judge it. Accepting a link sets the signal's node; accepting a
creation stages the node and its relationship for the engineer to commit. The
rules are deterministic and run on the committed graph; no data leaves Tiles.
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass, field
from typing import Any, Literal

from tiles_api import ontology as o

LINK_THRESHOLD = 0.5  # below this a link is not suggested; a new node is
# Words that say what kind of node it is, not which one.
GENERIC = {"plc", "machine", "line", "cell", "signal", "the", "of", "and", "unit"}

# Quantity words in tag names → the unit a reading usually has.
QUANTITIES: list[tuple[tuple[str, ...], str, str]] = [
    (("temperature", "temp", "tmp"), "°C", "temperature"),
    (("dewpoint", "dew"), "°C", "dew point"),
    (("pressure", "pres", "psr"), "bar", "pressure"),
    (("force",), "kN", "force"),
    (("tension",), "N", "tension"),
    (("torque",), "N·m", "torque"),
    (("speed", "velocity", "vel"), "m/s", "speed"),
    (("rpm",), "rpm", "rotational speed"),
    (("current", "amps", "amp"), "A", "current"),
    (("voltage", "volt", "volts"), "V", "voltage"),
    (("power", "kw"), "kW", "power"),
    (("energy", "kwh"), "kWh", "energy"),
    (("flow", "flowrate"), "m³/h", "flow"),
    (("level",), "%", "level"),
    (("humidity", "rh"), "%RH", "humidity"),
    (("vibration", "vib"), "mm/s", "vibration"),
    (("position", "pos", "stroke"), "mm", "position"),
    (("thickness",), "µm", "thickness"),
    (("weight", "mass"), "kg", "weight"),
    (("count", "counter", "cycles", "shots"), "count", "count"),
    (("state", "status", "mode", "alarm", "running"), "state", "state"),
]


def tokens(text: str) -> list[str]:
    """A name as lower-case words and numbers: 'DC02_PlungerVel' → ['dc', '2', 'plunger', 'vel']."""
    spaced = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)  # camelCase
    words = re.findall(r"[a-z]+|\d+", spaced.lower())  # letters and numbers apart: 'oven3temp' → oven, 3, temp
    return [str(int(w)) if w.isdigit() else w for w in words]


def prefix(tag: str) -> str:
    """The equipment part of a tag: what comes before its last separator ('line2/press1.temp' → 'line2/press1')."""
    cut = max(tag.rfind(c) for c in "./:")
    return tag[:cut] if cut > 0 else ""


def quantity(tag_tokens: Iterable[str]) -> tuple[str, str] | None:
    """The unit and the quantity a tag's words name, if any."""
    words = set(tag_tokens)
    for names, unit, what in QUANTITIES:
        if words & set(names):
            return unit, what
    return None


def humanize(tag: str) -> str:
    """A label from a tag: 'press1.platen_temp' → 'Press 1 platen temp'."""
    words = tokens(tag)
    return " ".join(words).capitalize() if words else tag


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "signal"


def same_unit(a: str | None, b: Any) -> bool:
    return isinstance(b, str) and a is not None and a.strip().casefold() == b.strip().casefold()


@dataclass
class Suggestion:
    signal_id: str
    tag: str
    kind: Literal["link", "create"]
    score: float
    node_id: str  # the node to link, or the one to create
    node_label: str
    reasons: list[str]
    ops: list[o.Op] = field(default_factory=list)  # for "create": what to stage

    def as_dict(self) -> dict[str, Any]:
        return {
            "signal_id": self.signal_id,
            "tag": self.tag,
            "kind": self.kind,
            "score": round(self.score, 3),
            "node_id": self.node_id,
            "node_label": self.node_label,
            "reasons": self.reasons,
            "ops": self.ops,
        }


class Suggester:
    """Suggestions for one site: its committed graph and its signals (dicts with id, tag, unit, node_id)."""

    def __init__(self, graph: o.Graph, signals: list[dict[str, Any]], reserved: Iterable[str] = ()) -> None:
        self.graph = graph
        self.nodes = graph["nodes"]
        self.edges = list(graph["edges"].values())
        linked = {s["node_id"] for s in signals if s.get("node_id")}
        # Signal nodes no tag is linked to yet: candidates for a link.
        self.free = [n for n in self.nodes.values() if n["type"] == "Signal" and n["id"] not in linked]
        self.signals = signals
        self.emitter = {e["to"]: e["from"] for e in self.edges if e["rel"] == "emits"}
        self.controller = {e["from"]: e["to"] for e in self.edges if e["rel"] == "controlledBy"}
        self.reserved = set(reserved)  # node ids taken elsewhere (staged, or suggested for another tag)
        self._tokens = {
            n["id"]: (set(tokens(n["label"])) | set(tokens(n["id"]))) - {n["type"].lower()} for n in self.nodes.values()
        }
        # Mapped tags by prefix, for the sibling rule.
        self.by_prefix: dict[str, list[dict[str, Any]]] = {}
        for s in signals:
            if s.get("node_id"):
                self.by_prefix.setdefault(prefix(s["tag"]), []).append(s)

    def node_tokens(self, node: o.Node) -> set[str]:
        return self._tokens[node["id"]]

    def plc_for(self, tag: str, tag_tokens: list[str]) -> tuple[str | None, str | None]:
        """The PLC a tag most likely comes from, and why."""
        # 1. Sibling tags (same prefix) already mapped: the PLC that emits their signals.
        pre = prefix(tag)
        if pre:
            votes: dict[str, int] = {}
            for s in self.by_prefix.get(pre, []):
                node = s.get("node_id")
                if node and s["tag"] != tag and node in self.emitter:
                    votes[self.emitter[node]] = votes.get(self.emitter[node], 0) + 1
            if votes:
                plc = max(sorted(votes), key=lambda p: votes[p])
                n = votes[plc]
                return plc, f"{n} other tag(s) under {pre} come from {self.nodes[plc]['label']}"
        # 2. A machine (or PLC) the tag names: all the numbers in its name, and a word of it ('DC-02' in
        # 'dc02.metal_pressure' names 'Die-caster DC-02'). The most words matched wins.
        words = set(tag_tokens)
        best: tuple[int, o.Node] | None = None
        for node in self.nodes.values():
            if node["type"] not in ("Machine", "PLC"):
                continue
            name = self.node_tokens(node) - GENERIC
            numbers = {w for w in name if w.isdigit()}
            named = name & words
            if not numbers <= words or not (named - numbers):
                continue
            if best is None or len(named) > best[0]:
                best = (len(named), node)
        if best is None:
            return None, None
        node = best[1]
        if node["type"] == "PLC":
            return node["id"], f"the tag names {node['label']}"
        controller = self.controller.get(node["id"])
        if controller is None:
            return None, f"the tag names {node['label']}, which has no PLC in the ontology"
        return controller, f"the tag names {node['label']}, controlled by {self.nodes[controller]['label']}"

    def link_score(self, tag: str, tag_tokens: list[str], unit: str | None, node: o.Node) -> tuple[float, list[str]]:
        reasons: list[str] = []
        made_for = node["props"].get("tag")
        if made_for == tag:
            return 1.0, [f"{node['label']} was created for this tag"]
        if made_for:
            return 0.0, reasons  # it was created for another tag
        name = self.node_tokens(node)
        words = set(tag_tokens)
        if not name or not words:
            return 0.0, reasons
        overlap = len(name & words) / len(name | words)
        score = overlap
        if overlap:
            reasons.append(f"the names share {', '.join(sorted(name & words))}")
        # A number in the node's name the tag doesn't have names another one ('zone 1' is not 'zone2').
        if {w for w in name if w.isdigit()} - words:
            score -= 0.5
        node_unit = node["props"].get("unit")
        if unit and isinstance(node_unit, str):
            if same_unit(unit, node_unit):
                score += 0.2
                reasons.append(f"both in {node_unit}")
            else:
                score -= 0.3
                reasons.append(f"units differ ({unit} and {node_unit})")
        return max(0.0, min(1.0, score)), reasons

    def suggest(self, signal: dict[str, Any]) -> Suggestion:
        tag: str = signal["tag"]
        unit: str | None = signal.get("unit")
        tag_tokens = tokens(tag)
        plc, why_plc = self.plc_for(tag, tag_tokens)

        best: tuple[float, o.Node, list[str]] | None = None
        for node in self.free:
            score, reasons = self.link_score(tag, tag_tokens, unit, node)
            if plc and self.emitter.get(node["id"]) == plc and score < 1.0:
                score = min(1.0, score + 0.15)
                reasons.append(f"emitted by {self.nodes[plc]['label']}")
            if best is None or score > best[0]:
                best = (score, node, reasons)
        if best and best[0] >= LINK_THRESHOLD:
            score, node, reasons = best
            return Suggestion(signal["id"], tag, "link", score, node["id"], node["label"], reasons)

        # A new Signal node for the tag.
        q = quantity(tag_tokens)
        node_unit = unit or (q[0] if q else "")
        reasons = []
        if unit:
            reasons.append(f"its unit is {unit}")
        elif q:
            reasons.append(f"'{q[1]}' in the name suggests {q[0]}")
        else:
            reasons.append("no unit found: set one before committing")
        node_id = f"signal-{slug(tag)}"
        k = 2
        while node_id in self.nodes or node_id in self.reserved:
            node_id = f"signal-{slug(tag)}-{k}"
            k += 1
        label = humanize(tag)
        props: dict[str, o.PropValue] = {"tag": tag}
        if node_unit:
            props["unit"] = node_unit
        ops: list[o.Op] = [
            {"kind": "addNode", "node": {"id": node_id, "type": "Signal", "label": label, "props": props}}
        ]
        score = 0.4
        if plc:
            ops.append(
                {
                    "kind": "addEdge",
                    "edge": {"id": f"{plc}-emits-{node_id}", "from": plc, "rel": "emits", "to": node_id},
                }
            )
            reasons.insert(0, f"emitted by {self.nodes[plc]['label']}: {why_plc}")
            score += 0.4
        else:
            reasons.insert(0, why_plc or "no machine or PLC found in the tag: link the node yourself after creating it")
        if node_unit:
            score += 0.2
        return Suggestion(signal["id"], tag, "create", min(1.0, score), node_id, label, reasons, ops)

    def all(self, unmapped: Iterable[dict[str, Any]]) -> list[Suggestion]:
        """Suggestions for the unmapped signals. Each free node is suggested for at most one tag: the
        tags most sure of a link choose first, and a node taken is no longer offered to the others. New
        nodes get distinct ids."""
        pending = list(unmapped)
        first = {s["id"]: self.suggest(s) for s in pending}
        free, reserved = self.free, set(self.reserved)
        result: list[Suggestion] = []
        try:
            for signal in sorted(pending, key=lambda s: (-first[s["id"]].score, s["tag"])):
                suggestion = first[signal["id"]]
                # Suggest again only if the first answer was taken by a tag before this one.
                if suggestion.node_id in self.reserved:
                    suggestion = self.suggest(signal)
                if suggestion.kind == "link":
                    self.free = [n for n in self.free if n["id"] != suggestion.node_id]
                self.reserved.add(suggestion.node_id)
                result.append(suggestion)
        finally:
            self.free, self.reserved = free, reserved
        return sorted(result, key=lambda s: s.tag)
