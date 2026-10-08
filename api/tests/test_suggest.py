"""Agentic ingestion v1 (T2.11): suggestions for unmapped tags, scored against a labelled plant."""

import json
from pathlib import Path
from typing import Any

from test_agents import api, site  # noqa: F401 - api and site are fixtures

from tiles_api import ontology as o
from tiles_api.suggest import Suggester, Suggestion, humanize, prefix, quantity, tokens

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "suggestions.json").read_text())


def plant() -> o.Graph:
    nodes = {n["id"]: n for n in FIXTURE["graph"]["nodes"]}
    edges: dict[str, o.Edge] = {}
    for e in FIXTURE["graph"]["edges"]:
        eid = f"{e['from']}-{e['rel']}-{e['to']}"
        edges[eid] = {"id": eid, "from": e["from"], "rel": e["rel"], "to": e["to"]}
    return {"nodes": nodes, "edges": edges}


def signals() -> list[dict[str, Any]]:
    mapped = [{"id": f"sig-{i}", **m} for i, m in enumerate(FIXTURE["mapped"])]
    cases = [
        {"id": f"case-{i}", "tag": c["tag"], "unit": c["unit"], "node_id": None} for i, c in enumerate(FIXTURE["cases"])
    ]
    return mapped + cases


def matches(s: Suggestion, expect: dict[str, Any]) -> bool:
    if s.kind != expect["kind"]:
        return False
    if s.kind == "link":
        return bool(s.node_id == expect["node_id"])
    node = s.ops[0]["node"]
    emits = [op["edge"]["from"] for op in s.ops[1:] if op["edge"]["rel"] == "emits"]
    return bool((emits[0] if emits else None) == expect["plc"] and node["props"].get("unit") == expect["unit"])


def test_tags_read_as_words_numbers_and_quantities() -> None:
    assert tokens("DC02_PlungerVel") == ["dc", "2", "plunger", "vel"]
    assert tokens("Line2/Oven-3:ZoneTemp") == ["line", "2", "oven", "3", "zone", "temp"]
    assert (prefix("line2/press1.temp"), prefix("temp")) == ("line2/press1", "")
    assert humanize("press1.platen_temp") == "Press 1 platen temp"
    assert quantity(tokens("press1.temperature")) == ("°C", "temperature")
    assert quantity(tokens("c01.blade_age")) is None


def test_the_suggestions_match_what_an_engineer_would_pick() -> None:
    all_signals = signals()
    unmapped = [s for s in all_signals if s["node_id"] is None]
    suggestions = {s.signal_id: s for s in Suggester(plant(), all_signals).all(unmapped)}
    misses = []
    for i, case in enumerate(FIXTURE["cases"]):
        s = suggestions[f"case-{i}"]
        if not matches(s, case["expect"]):
            misses.append((case["tag"], s.as_dict()))
    accepted = 1 - len(misses) / len(FIXTURE["cases"])
    assert accepted >= 0.7, misses  # the task's acceptance bar
    assert misses == []  # and on this plant, every one


def test_a_link_says_why_and_a_new_node_is_ready_to_stage() -> None:
    all_signals = signals()
    by_tag = {s.tag: s for s in Suggester(plant(), all_signals).all([s for s in all_signals if not s["node_id"]])}
    link = by_tag["dc02.plunger_vel"]
    assert link.score >= 0.8
    assert "both in m/s" in link.reasons and "emitted by PLC DC-02" in link.reasons
    new = by_tag["press1.temperature"]
    assert new.ops == [
        {
            "kind": "addNode",
            "node": {
                "id": "signal-press1-temperature",
                "type": "Signal",
                "label": "Press 1 temperature",
                "props": {"tag": "press1.temperature", "unit": "°C"},
            },
        },
        {
            "kind": "addEdge",
            "edge": {
                "id": "plc-press1-emits-signal-press1-temperature",
                "from": "plc-press1",
                "rel": "emits",
                "to": "signal-press1-temperature",
            },
        },
    ]
    assert new.reasons[0] == "emitted by PLC Press 1: 1 other tag(s) under press1 come from PLC Press 1"
    assert by_tag["w03.current"].reasons[0] == "the tag names Welder W-03, which has no PLC in the ontology"
    assert by_tag["c01.blade_age"].reasons[-1] == "no unit found: set one before committing"
    # The staged ops apply to the graph as they are.
    g = plant()
    for op in new.ops:
        g, _ = o.apply_op(g, op)
    assert "signal-press1-temperature" in g["nodes"]


def test_once_created_the_node_links_to_its_tag_in_one_step() -> None:
    g = plant()
    g["nodes"]["signal-press1-temperature"] = {
        "id": "signal-press1-temperature",
        "type": "Signal",
        "label": "Press 1 temperature",
        "props": {"tag": "press1.temperature", "unit": "°C"},
    }
    sig = {"id": "x", "tag": "press1.temperature", "unit": None, "node_id": None}
    s = Suggester(g, [sig]).suggest(sig)
    assert (s.kind, s.node_id, s.score) == ("link", "signal-press1-temperature", 1.0)


def test_a_node_is_offered_to_one_tag_only() -> None:
    g = plant()
    twins = [
        {"id": "a", "tag": "dc02.plunger_vel", "unit": "m/s", "node_id": None},
        {"id": "b", "tag": "dc02.plunger_velocity_raw", "unit": "m/s", "node_id": None},
    ]
    result = {s.signal_id: s for s in Suggester(g, twins).all(twins)}
    links = [s for s in result.values() if s.kind == "link"]
    assert [s.signal_id for s in links] == ["a"] or [s.signal_id for s in links] == ["b"]
    assert len({s.node_id for s in links}) == len(links)


def test_suggest_stage_commit_and_link_through_the_api(api: Any, site: str) -> None:  # noqa: F811
    from test_agents import ENG, VIEWER
    from test_signals import backfill, by_tag

    base = f"/sites/{site}/ontology"
    ops = [
        {
            "kind": "addNode",
            "node": {"id": "machine-press1", "type": "Machine", "label": "Press 1", "props": {"vendor": "Acme"}},
        },
        {
            "kind": "addNode",
            "node": {"id": "plc-press1", "type": "PLC", "label": "PLC Press 1", "props": {"protocol": "OPC UA"}},
        },
        {
            "kind": "addEdge",
            "edge": {"id": "e1", "from": "machine-press1", "rel": "controlledBy", "to": "plc-press1"},
        },
    ]
    assert api.post(f"{base}/staged/batch", json=ops, headers=ENG).status_code == 201
    assert api.post(f"{base}/commits", json={"message": "press 1"}, headers=ENG).status_code == 201
    backfill(api, site, {"press1.temperature": [21.0]})

    res = api.get(f"/sites/{site}/signals/suggestions", headers=VIEWER)
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["unmapped"] == 1
    (s,) = body["suggestions"]
    assert (s["kind"], s["node_id"], s["tag"]) == ("create", "signal-press1-temperature", "press1.temperature")
    assert s["reasons"][0] == "emitted by PLC Press 1: the tag names Press 1, controlled by PLC Press 1"

    # Accept: stage the ops, commit; the tag then links to its new node in one step.
    assert api.post(f"{base}/staged/batch", json=s["ops"], headers=ENG).status_code == 201
    assert api.post(f"{base}/commits", json={"message": "add press1.temperature"}, headers=ENG).status_code == 201
    (link,) = api.get(f"/sites/{site}/signals/suggestions", headers=VIEWER).json()["suggestions"]
    assert (link["kind"], link["node_id"], link["score"]) == ("link", "signal-press1-temperature", 1.0)
    sig = by_tag(api, site, "press1.temperature")
    patched = api.patch(f"/sites/{site}/signals/{sig['id']}", json={"node_id": link["node_id"]}, headers=ENG)
    assert patched.status_code == 200
    assert api.get(f"/sites/{site}/signals/suggestions", headers=VIEWER).json() == {"unmapped": 0, "suggestions": []}
