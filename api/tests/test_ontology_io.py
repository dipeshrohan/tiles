"""Bulk ontology import and export (T2.13): file formats, the planned ops, and the API."""

import json
import time
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures

from tiles_api import ontology as o
from tiles_api import ontology_io as io_

PRESS: dict[str, Any] = {
    "id": "press",
    "type": "Machine",
    "label": "Press 1",
    # Text that looks like a number or true/false, or starts with an apostrophe, must stay text.
    "props": {"vendor": "Acme", "tonnage": 900, "model": "1.3", "flag": "true", "note": "'quoted"},
}
FORCE = {"id": "force", "type": "Signal", "label": "Force", "props": {"unit": "kN", "logged": True, "gain": 0.5}}
LINE = {"id": "line", "type": "Line", "label": "Line 1", "props": {}}
EMITS = {"id": "press-emits-force", "from": "press", "rel": "emits", "to": "force"}
CONTAINS = {"id": "line-contains-press", "from": "line", "rel": "contains", "to": "press"}


def graph(nodes: list[dict[str, Any]], edges: list[dict[str, Any]]) -> o.Graph:
    return {"nodes": {n["id"]: n for n in nodes}, "edges": {e["id"]: e for e in edges}}  # type: ignore[misc]


HEAD = graph([PRESS, FORCE, LINE], [EMITS, CONTAINS])


@pytest.mark.parametrize("fmt", ["json", "csv"])
def test_an_export_reads_back_as_the_same_graph(fmt: str) -> None:
    text = io_.to_json(HEAD, {"commit": "c1"}) if fmt == "json" else io_.to_csv(HEAD)
    assert io_.read(text, fmt) == HEAD  # type: ignore[arg-type]
    assert io_.plan(HEAD, io_.read(text, fmt), "replace").ops == []  # type: ignore[arg-type]


def test_csv_is_one_table_with_a_column_per_property() -> None:
    lines = io_.to_csv(HEAD).splitlines()
    assert lines[0] == (
        "kind,id,type,label,from,rel,to,prop:flag,prop:gain,prop:logged,prop:model,prop:note,prop:tonnage,prop:unit,prop:vendor"
    )
    assert lines[1] == "node,force,Signal,Force,,,,,0.5,true,,,,kN,"
    assert lines[3] == "node,press,Machine,Press 1,,,,'true,,,'1.3,''quoted,900,,Acme"
    assert lines[-1] == "edge,press-emits-force,,,press,emits,force,,,,,,,,"
    # Columns in any order, a BOM, blank lines; cells that read as numbers or true/false are those.
    text = "﻿prop:n,label,kind,id,type,from,rel,to,prop:s\n\n007,A,node,a,Line,,,,x 1\n1e3,B,node,b,Line,,,,\n"
    nodes = io_.from_csv(text)["nodes"]
    assert nodes["a"]["props"] == {"n": 7, "s": "x 1"}
    assert nodes["b"]["props"] == {"n": 1000.0}


def test_json_from_the_api_graph_reads_too() -> None:
    assert io_.from_json(json.dumps(HEAD)) == HEAD


@pytest.mark.parametrize(
    ("content", "fmt", "problem"),
    [
        ("{", "json", "Not valid JSON"),
        ("[]", "json", "must be a JSON object"),
        ('{"nodes": [{"id": "a", "type": "Robot", "label": "A"}]}', "json", "node 1: unknown type 'Robot'"),
        ('{"nodes": [{"id": "", "type": "Line", "label": "A"}]}', "json", "node 1: id must be text"),
        ('{"nodes": [{"id": "a", "type": "Line", "label": "A", "props": {"x": [1]}}]}', "json", "props must map"),
        (
            '{"nodes": [{"id": "a", "type": "Line", "label": "A"}, {"id": "a", "type": "Line", "label": "B"}]}',
            "json",
            "twice",
        ),
        ("kind,id,type,label\n", "csv", "Missing column(s): from, rel, to"),
        ("kind,id,type,label,from,rel,to\nthing,a,,,,,\n", "csv", "line 2: kind must be node or edge"),
    ],
)
def test_a_bad_file_says_what_is_wrong(content: str, fmt: str, problem: str) -> None:
    with pytest.raises(io_.FileProblems) as e:
        io_.read(content, fmt)  # type: ignore[arg-type]
    assert problem in str(e.value)


def test_merge_adds_and_sets_and_removes_nothing() -> None:
    target = graph(
        [{**PRESS, "props": {"vendor": "Bosch"}}, {"id": "temp", "type": "Signal", "label": "Temp", "props": {}}],
        [{"id": "press-emits-temp", "from": "press", "rel": "emits", "to": "temp"}],
    )
    planned = io_.plan(HEAD, target, "merge")
    assert planned.ops == [
        {"kind": "addNode", "node": {"id": "temp", "type": "Signal", "label": "Temp", "props": {}}},
        {"kind": "setProp", "id": "press", "key": "vendor", "value": "Bosch"},
        {"kind": "addEdge", "edge": {"id": "press-emits-temp", "from": "press", "rel": "emits", "to": "temp"}},
    ]
    assert planned.counts == {
        "add_nodes": 1,
        "remove_nodes": 0,
        "set_props": 1,
        "remove_props": 0,
        "add_edges": 1,
        "remove_edges": 0,
    }
    o.apply_ops(HEAD, planned.ops)  # they apply


def test_replace_makes_the_ontology_the_file() -> None:
    target = graph([{**PRESS, "props": {**PRESS["props"], "tonnage": 900.0}}, LINE], [CONTAINS])
    planned = io_.plan(HEAD, target, "replace")
    assert planned.ops == [
        {"kind": "removeEdge", "id": "press-emits-force"},
        {"kind": "removeNode", "id": "force"},
        {"kind": "setProp", "id": "press", "key": "tonnage", "value": 900.0},  # 900 and 900.0 differ in JSON
    ]
    assert o.apply_ops(HEAD, planned.ops)[0] == target


def test_relationships_by_id_and_by_what_they_join() -> None:
    moved = {**EMITS, "to": "line"}  # same id, another relationship: replaced
    twin = {**CONTAINS, "id": "contains-2"}  # another id, the same relationship: skipped
    planned = io_.plan(HEAD, graph([PRESS, FORCE, LINE], [moved, twin]), "merge")
    assert planned.ops == [{"kind": "removeEdge", "id": "press-emits-force"}, {"kind": "addEdge", "edge": moved}]
    assert planned.duplicates == ["contains-2"]
    # Replace keeps the relationship the twin repeats, under its old id.
    replaced = io_.plan(HEAD, graph([PRESS, FORCE, LINE], [EMITS, twin]), "replace")
    assert (replaced.ops, replaced.duplicates) == ([], ["contains-2"])


def test_renames_and_new_types_are_refused_and_merge_may_link_to_existing_nodes() -> None:
    with pytest.raises(io_.FileProblems) as e:
        io_.plan(HEAD, graph([{**PRESS, "label": "Press A"}, {**LINE, "type": "Cell"}], []), "merge")
    assert e.value.problems == [
        "node press is called 'Press 1', not 'Press A': rename it by hand",
        "node line is a Line, not a Cell: change its type by hand",
    ]
    link = {"id": "line-contains-new", "from": "line", "rel": "contains", "to": "new"}
    new = {"id": "new", "type": "Machine", "label": "New", "props": {}}
    assert io_.plan(HEAD, graph([new], [link]), "merge").counts["add_edges"] == 1
    with pytest.raises(io_.FileProblems) as e:
        io_.plan(HEAD, graph([new], [link]), "replace")
    assert e.value.problems == ["relationship line-contains-new points at line, which is not a node in the file"]


def test_a_large_import_plans_and_applies_quickly() -> None:
    nodes = [{"id": f"n{i}", "type": "Signal", "label": f"N{i}", "props": {"unit": "°C"}} for i in range(5000)]
    edges = [{"id": f"e{i}", "from": f"n{i}", "rel": "feeds", "to": f"n{i + 1}"} for i in range(4999)]
    start = time.perf_counter()
    planned = io_.plan(o.empty_graph(), io_.from_json(json.dumps({"nodes": nodes, "edges": edges})), "merge")
    o.apply_ops(o.empty_graph(), planned.ops)
    assert len(planned.ops) == 9999
    assert time.perf_counter() - start < 5


# ---- over the API ----------------------------------------------------------------


def base(site: str) -> str:  # noqa: F811
    return f"/sites/{site}/ontology"


def test_export_import_round_trip_through_the_api(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    content = io_.to_json(HEAD, {})
    body = {"format": "json", "content": content, "name": "plant.json"}
    assert api.post(f"{base(site)}/import", json=body, headers=VIEWER).status_code == 403
    preview = api.post(f"{base(site)}/import", json={**body, "dry_run": True}, headers=ENG).json()
    assert (preview["total"], preview["staged"], preview["counts"]["add_nodes"]) == (5, False, 3)
    assert api.get(f"{base(site)}/staged", headers=ENG).json() == []  # a preview stages nothing

    res = api.post(f"{base(site)}/import", json=body, headers=ENG)
    assert res.status_code == 200, res.text
    assert res.json()["staged"] is True
    assert len(api.get(f"{base(site)}/staged", headers=ENG).json()) == 5
    again = api.post(f"{base(site)}/import", json=body, headers=ENG)
    assert (again.status_code, again.json()["detail"]) == (409, "Commit, send or discard your staged changes first")
    assert api.post(f"{base(site)}/commits", json={"message": "import"}, headers=ENG).status_code == 201

    exported = api.get(f"{base(site)}/export", headers=VIEWER)
    assert exported.headers["content-type"].startswith("application/json")
    assert 'filename="plant-1-ontology.json"' in exported.headers["content-disposition"]
    data = exported.json()
    assert (data["format"], data["version"], data["site"]["slug"]) == ("tiles-ontology", 1, "plant-1")
    assert data["commit"] == api.get(f"{base(site)}/commits", headers=VIEWER).json()[0]["id"]
    assert io_.from_json(exported.text) == HEAD
    csv_text = api.get(f"{base(site)}/export?format=csv", headers=VIEWER).text
    assert io_.from_csv(csv_text) == HEAD

    # Importing the export again changes nothing.
    same = api.post(f"{base(site)}/import", json={"format": "csv", "content": csv_text, "mode": "replace"}, headers=ENG)
    assert (same.json()["total"], same.json()["staged"]) == (0, False)
    with psycopg.connect(database_url) as conn:
        audit = conn.execute(
            "SELECT after FROM audit_log WHERE site_id = %s AND action = 'ontology.import'", [site]
        ).fetchall()
    assert [a[0]["name"] for a in audit] == ["plant.json"]  # one: previews and no-ops leave none


def test_a_bad_import_is_explained(api: TestClient, site: str) -> None:  # noqa: F811
    bad = {"format": "json", "content": '{"nodes": [{"id": "a", "type": "Robot", "label": "A"}]}'}
    res = api.post(f"{base(site)}/import", json=bad, headers=ENG)
    assert res.status_code == 422
    assert res.json()["detail"].startswith("The file can't be imported: node 1: unknown type 'Robot'")
    assert api.post(f"{base(site)}/import", json={**bad, "format": "xml"}, headers=ENG).status_code == 422


def test_a_relationship_the_file_moves_frees_what_it_joined() -> None:
    # e1 now joins other nodes; the file's new e2 joins what e1 did: it is not a duplicate.
    moved = {**CONTAINS, "rel": "feeds", "to": "force"}
    again = {**CONTAINS, "id": "contains-again"}
    planned = io_.plan(HEAD, graph([PRESS, FORCE, LINE], [EMITS, moved, again]), "replace")
    assert planned.duplicates == []
    after = o.apply_ops(HEAD, planned.ops)[0]
    assert {(e["from"], e["rel"], e["to"]) for e in after["edges"].values()} == {
        ("press", "emits", "force"),
        ("line", "feeds", "force"),
        ("line", "contains", "press"),
    }


def test_a_relationship_twice_in_the_file_is_added_once() -> None:
    twin = {**EMITS, "id": "emits-2"}
    planned = io_.plan(graph([PRESS, FORCE], []), graph([PRESS, FORCE], [EMITS, twin]), "merge")
    assert [op["edge"]["id"] for op in planned.ops] == ["emits-2"]  # the first in id order
    assert planned.duplicates == ["press-emits-force"]


def test_csv_keeps_every_value_exactly_and_never_runs_as_a_formula() -> None:
    tricky = {
        "big": 12345678901234567890,
        "empty": "",
        "formula": '=HYPERLINK("http://example.com","x")',
        "minus": "-5 text",
        "negative": -5,
        "underscored": "1_000",
        "tiny": 1e-7,
    }
    nodes = [{"id": "=id", "type": "Line", "label": "+label", "props": tricky}, {**LINE, "label": "@line"}]
    g = graph(nodes, [{"id": "-e", "from": "=id", "rel": "=rel", "to": "line"}])
    text = io_.to_csv(g)
    assert io_.from_csv(text) == g
    assert io_.plan(g, io_.from_csv(text), "replace").ops == []
    for row in text.splitlines()[1:]:
        for cell in row.split(","):
            assert not cell.startswith(("=", "+", "@")), cell  # a spreadsheet would run it
    assert ",-5," in text  # a negative number stays a number


def test_a_node_without_a_label_or_a_long_relationship_name_is_refused() -> None:
    with pytest.raises(io_.FileProblems) as e:
        io_.from_json('{"nodes": [{"id": "a", "type": "Line"}]}')
    assert e.value.problems == ["node 1: label must be text"]
    rel = "r" * 101
    edge = {"id": "e", "from": "a", "rel": rel, "to": "a"}
    with pytest.raises(io_.FileProblems) as e:
        io_.from_json(json.dumps({"nodes": [{**LINE, "id": "a"}], "edges": [edge]}))
    assert e.value.problems == ["relationship 1: rel is too long or has a NUL character"]


def test_replacing_keeps_many_relationships_and_removes_many_nodes_quickly() -> None:
    # Each node removal checks the node has no relationships left: not by scanning them all.
    chain = [{"id": f"n{i}", "type": "Line", "label": f"N{i}", "props": {}} for i in range(5000)]
    spare = [{"id": f"x{i}", "type": "Line", "label": f"X{i}", "props": {}} for i in range(5000)]
    edges = [{"id": f"e{i}", "from": f"n{i}", "rel": "feeds", "to": f"n{i + 1}"} for i in range(4999)]
    head = io_.from_json(json.dumps({"nodes": chain + spare, "edges": edges}))
    target = io_.from_json(json.dumps({"nodes": chain, "edges": edges}))
    start = time.perf_counter()
    planned = io_.plan(head, target, "replace")
    o.apply_ops(head, planned.ops)
    assert planned.counts == {**planned.counts, "remove_nodes": 5000, "remove_edges": 0}
    assert time.perf_counter() - start < 2


def test_staging_waits_for_the_ontology_the_preview_showed(api: TestClient, site: str) -> None:  # noqa: F811
    body = {"format": "json", "content": io_.to_json(graph([LINE], []), {}), "dry_run": True}
    preview = api.post(f"{base(site)}/import", json=body, headers=ENG).json()
    assert preview["commit"] is None  # no commits yet
    # Someone commits meanwhile: the preview is out of date.
    other = {"X-Tiles-User": "eng2@example.com"}
    assert api.post(f"{base(site)}/staged", json={"kind": "addNode", "node": PRESS}, headers=other).status_code == 201
    assert api.post(f"{base(site)}/commits", json={"message": "press"}, headers=other).status_code == 201
    stale = api.post(
        f"{base(site)}/import", json={**body, "dry_run": False, "expect_commit": preview["commit"]}, headers=ENG
    )
    assert (stale.status_code, stale.json()["detail"]) == (
        409,
        "The ontology has changed since the preview: check the changes again",
    )
    fresh = api.post(f"{base(site)}/import", json={**body, "mode": "replace"}, headers=ENG).json()
    assert fresh["counts"]["remove_nodes"] == 1  # the new press, which the first preview didn't show
    staged = api.post(
        f"{base(site)}/import",
        json={**body, "mode": "replace", "dry_run": False, "expect_commit": fresh["commit"]},
        headers=ENG,
    )
    assert staged.json()["staged"] is True
