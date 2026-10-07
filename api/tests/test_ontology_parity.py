"""Run the shared ontology fixture suite against the Python port.

The same file is checked against js/lib/ontology.ts by
test/ontology-parity.test.js, so passing here means both implementations agree.
"""

import json
import re
from pathlib import Path
from typing import Any

import pytest

from tiles_api import ontology as o

FIXTURES = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "ontology-parity.json"
NODE: o.Node = {"id": "a", "type": "Line", "label": "A", "props": {}}
CASES: list[dict[str, Any]] = json.loads(FIXTURES.read_text(encoding="utf-8"))["cases"]


def run_case(steps: list[dict[str, Any]]) -> dict[str, Any]:
    repo = o.create_repo()
    errors: list[str | None] = []
    for step in steps:
        try:
            if "stage" in step:
                repo = o.stage(repo, step["stage"])
            elif "discard" in step:
                repo = o.discard(repo)
            elif "commit" in step:
                repo = o.commit(repo, step["commit"])
            elif "revert" in step:
                index = step["revert"]
                target = repo["history"][index]["id"] if index < len(repo["history"]) else f"missing-{index}"
                repo = o.revert(repo, target, step["author"], step["date"])
            else:
                raise AssertionError(f"Unknown step {step}")
            errors.append(None)
        except o.OntologyError as e:
            errors.append(str(e))
    working = o.working_graph(repo)
    return {
        "errors": errors,
        "head": repo["head"],
        "working": working,
        "staged": repo["staged"],
        "history": [{k: v for k, v in c.items() if k != "id"} for c in repo["history"]],
        "health": o.health_check(working),
    }


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_python_matches_typescript(case: dict[str, Any]) -> None:
    # A JSON round trip, as the TypeScript side does, so both compare plain JSON.
    actual = json.loads(json.dumps(run_case(case["steps"])))
    assert actual == case["expect"]


def test_suite_covers_every_op_and_issue_kind() -> None:
    ops = {s["stage"]["kind"] for c in CASES for s in c["steps"] if "stage" in s}
    assert ops == {"addNode", "removeNode", "addEdge", "removeEdge", "setProp"}
    issues = {i["kind"] for c in CASES for i in c["expect"]["health"]["issues"]}
    assert issues >= {"duplicate", "orphan", "missing-prop"}


def test_health_reports_dangling_edges() -> None:
    # Ops can't create a dangling edge, but stored graphs (or imports) can.
    graph: o.Graph = {
        "nodes": {"a": {"id": "a", "type": "Line", "label": "A", "props": {}}},
        "edges": {"e": {"id": "e", "from": "a", "rel": "feeds", "to": "gone"}},
    }
    report = o.health_check(graph)
    assert [(i["kind"], i["ref"]) for i in report["issues"]] == [("dangling", "e"), ("orphan", "a")]
    assert report["score"] == 0


def test_score_rounds_halves_up_like_javascript() -> None:
    # 8 nodes, 3 orphans: 100 - 3 * 100 / 8 = 62.5. Math.round gives 63;
    # Python's round() would give 62.
    nodes: dict[str, o.Node] = {k: {"id": k, "type": "Line", "label": k, "props": {}} for k in "abcdefgh"}
    pairs = [("a", "b"), ("c", "d"), ("e", "a")]
    edges: dict[str, o.Edge] = {f"{f}{t}": {"id": f"{f}{t}", "from": f, "rel": "feeds", "to": t} for f, t in pairs}
    assert o.health_check({"nodes": nodes, "edges": edges})["score"] == 63


def test_commits_without_a_date_get_the_current_time() -> None:
    iso = re.compile(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$")
    repo = o.commit(o.stage(o.create_repo(), {"kind": "addNode", "node": NODE}), {"message": "m", "author": "a"})
    assert iso.match(repo["history"][0]["date"])
    repo = o.revert(repo, repo["history"][0]["id"], "a")
    assert iso.match(repo["history"][0]["date"])
