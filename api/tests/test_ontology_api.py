"""Ontology HTTP API against a real database."""

import json
import uuid
from collections.abc import Iterator
from pathlib import Path
from typing import Any, cast

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row

from tiles_api import ontology as o
from tiles_api import sealed
from tiles_api.main import create_app
from tiles_api.ontology_store import load_head
from tiles_api.seed import seed
from tiles_api.settings import Settings
from tiles_api.store import Conn

PRODUCTION_KEYS = sealed.new_key("test")  # production needs data keys (T5.06)

FIXTURES = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "ontology-parity.json"
CASES: list[dict[str, Any]] = json.loads(FIXTURES.read_text(encoding="utf-8"))["cases"]
ALICE = {"X-Tiles-User": "alice@example.com"}
BOB = {"X-Tiles-User": "bob@example.com"}


def node(i: str, t: str = "Machine", props: dict[str, Any] | None = None) -> dict[str, Any]:
    return {
        "kind": "addNode",
        "node": {"id": i, "type": t, "label": i, "props": {"vendor": "x"} if props is None else props},
    }


def edge(f: str, rel: str, t: str) -> dict[str, Any]:
    return {"kind": "addEdge", "edge": {"id": f"{f}-{rel}-{t}", "from": f, "rel": rel, "to": t}}


@pytest.fixture(scope="module")
def settings(database_url: str) -> Settings:
    return Settings(_env_file=None, env="test", database_url=database_url)


@pytest.fixture(scope="module")
def api(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as client:
        yield client


@pytest.fixture
def site(settings: Settings) -> str:
    """The demo site, with an empty ontology and no users."""
    with psycopg.connect(settings.database_url.get_secret_value()) as conn:
        conn.execute("TRUNCATE ontology_nodes, ontology_edges, commits, staged_ops, site_members, users CASCADE")
    return seed(settings)


def url(site: str, path: str) -> str:
    return f"/sites/{site}/ontology/{path}"


def test_sites_lists_the_demo_site(api: TestClient, site: str) -> None:
    assert api.get("/sites").json() == [{"id": site, "slug": "plant-1", "name": "Plant 1", "org": "demo"}]


def test_seed_is_idempotent(settings: Settings, site: str) -> None:
    assert seed(settings) == site


def test_stage_commit_history_and_revert(api: TestClient, site: str) -> None:
    for op in (node("a"), node("b"), edge("a", "feeds", "b")):
        assert api.post(url(site, "staged"), json=op, headers=ALICE).status_code == 201
    assert len(api.get(url(site, "staged"), headers=ALICE).json()) == 3
    assert api.get(url(site, "graph?view=head")).json() == {"nodes": {}, "edges": {}}
    assert set(api.get(url(site, "graph"), headers=ALICE).json()["nodes"]) == {"a", "b"}

    res = api.post(url(site, "commits"), json={"message": " first "}, headers=ALICE)
    assert res.status_code == 201
    first = res.json()
    assert first["message"] == "first"
    assert first["author"] == "alice"
    assert first["stats"] == {"nodes": 2, "edges": 1, "props": 0}
    assert first["date"].endswith("Z")
    assert api.get(url(site, "staged"), headers=ALICE).json() == []

    api.post(url(site, "staged"), json={"kind": "setProp", "id": "a", "key": "vendor", "value": "y"}, headers=ALICE)
    second = api.post(url(site, "commits"), json={"message": "second"}, headers=ALICE).json()
    assert api.get(url(site, "graph?view=head")).json()["nodes"]["a"]["props"] == {"vendor": "y"}

    reverted = api.post(url(site, f"commits/{second['id']}/revert"), headers=BOB).json()
    assert reverted["message"] == 'Revert "second"'
    assert reverted["author"] == "bob"
    head = api.get(url(site, "graph?view=head")).json()
    assert head["nodes"]["a"]["props"] == {"vendor": "x"}
    assert head["edges"]["a-feeds-b"] == {"id": "a-feeds-b", "from": "a", "rel": "feeds", "to": "b"}
    history = api.get(url(site, "commits")).json()
    assert [c["message"] for c in history] == ['Revert "second"', "second", "first"]
    assert [c["message"] for c in api.get(url(site, "commits?limit=1&offset=1")).json()] == ["second"]


def test_staged_changes_are_private_until_committed(api: TestClient, site: str) -> None:
    api.post(url(site, "staged"), json=node("a"), headers=ALICE)
    assert api.get(url(site, "staged"), headers=BOB).json() == []
    assert api.get(url(site, "graph"), headers=BOB).json()["nodes"] == {}
    api.post(url(site, "commits"), json={"message": "add a"}, headers=ALICE)
    assert set(api.get(url(site, "graph"), headers=BOB).json()["nodes"]) == {"a"}


def test_discard_clears_only_my_staged_ops(api: TestClient, site: str) -> None:
    api.post(url(site, "staged"), json=node("a"), headers=ALICE)
    api.post(url(site, "staged"), json=node("b"), headers=BOB)
    assert api.delete(url(site, "staged"), headers=ALICE).status_code == 204
    assert api.get(url(site, "staged"), headers=ALICE).json() == []
    assert len(api.get(url(site, "staged"), headers=BOB).json()) == 1


def test_commit_conflicting_with_a_newer_commit_is_refused(api: TestClient, site: str) -> None:
    api.post(url(site, "staged"), json=node("a"), headers=ALICE)
    api.post(url(site, "commits"), json={"message": "a"}, headers=ALICE)
    # Bob edits a while Alice removes it.
    api.post(url(site, "staged"), json={"kind": "setProp", "id": "a", "key": "k", "value": 1}, headers=BOB)
    api.post(url(site, "staged"), json={"kind": "removeNode", "id": "a"}, headers=ALICE)
    api.post(url(site, "commits"), json={"message": "drop a"}, headers=ALICE)
    res = api.post(url(site, "commits"), json={"message": "edit a"}, headers=BOB)
    assert res.status_code == 409
    assert res.json()["detail"] == "Node a not found"
    assert [c["message"] for c in api.get(url(site, "commits")).json()] == ["drop a", "a"]
    assert len(api.get(url(site, "staged"), headers=BOB).json()) == 1  # kept so Bob can discard


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "explode"},
        {"kind": "addNode"},
        {"kind": "addNode", "node": {"id": "", "type": "Line", "label": "x"}},
        {"kind": "addNode", "node": {"id": "a", "type": "Line", "label": "x", "props": {"k": [1]}}},
        {"kind": "addNode", "node": {"id": "a", "type": "Line", "label": "x", "extra": 1}},
        {"kind": "setProp", "id": "a", "key": "k", "value": {"nested": True}},
        {"kind": "setProp", "id": "a", "key": "k", "value": None},
        {"kind": "addEdge", "edge": {"id": "e", "rel": "feeds", "to": "b"}},
    ],
)
def test_malformed_ops_are_422(api: TestClient, site: str, body: dict[str, Any]) -> None:
    assert api.post(url(site, "staged"), json=body).status_code == 422


def test_errors(api: TestClient, site: str) -> None:
    missing = uuid.uuid4()
    assert api.get(f"/sites/{missing}/ontology/graph").status_code == 404
    assert api.get("/sites/not-a-uuid/ontology/graph").status_code == 422
    res = api.post(url(site, "commits"), json={"message": "x"})
    assert (res.status_code, res.json()["detail"]) == (409, "Nothing to commit")
    res = api.post(url(site, "commits/c-nope/revert"))
    assert (res.status_code, res.json()["detail"]) == (404, "Commit c-nope not found")
    assert api.get(url(site, "graph"), headers={"X-Tiles-User": "not an email"}).status_code == 400


def test_production_refuses_requests_until_sign_in_exists(database_url: str, site: str) -> None:
    with TestClient(
        create_app(Settings(_env_file=None, env="production", data_keys=PRODUCTION_KEYS, database_url=database_url))
    ) as prod:
        assert prod.get(url(site, "graph")).status_code == 401
        assert prod.get("/sites").status_code == 401


def _norm_health(report: dict[str, Any]) -> dict[str, Any]:
    # The database returns nodes and edges sorted by id rather than in
    # insertion order, so compare issues as a set.
    return {**report, "issues": sorted(report["issues"], key=lambda i: (i["kind"], i["ref"], i["text"]))}


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_api_matches_the_shared_fixtures(api: TestClient, site: str, case: dict[str, Any]) -> None:
    """Replays each parity case through HTTP: the stored behaviour matches the browser's."""
    errors: list[str | None] = []
    for step in case["steps"]:
        if "stage" in step:
            res = api.post(url(site, "staged"), json=step["stage"])
        elif "discard" in step:
            res = api.delete(url(site, "staged"))
        elif "commit" in step:
            res = api.post(url(site, "commits"), json={"message": step["commit"]["message"]})
        else:
            history = api.get(url(site, "commits?limit=500")).json()
            index = step["revert"]
            target = history[index]["id"] if index < len(history) else f"missing-{index}"
            res = api.post(url(site, f"commits/{target}/revert"))
        errors.append(None if res.status_code < 300 else res.json()["detail"])

    expect = case["expect"]
    assert errors == expect["errors"]
    assert api.get(url(site, "graph?view=head")).json() == expect["head"]
    working = api.get(url(site, "graph")).json()
    assert working == expect["working"]
    assert api.get(url(site, "staged")).json() == expect["staged"]
    history = api.get(url(site, "commits?limit=500")).json()
    strip = ("id", "date", "author", "reviewer")  # reviewer: API only (T2.12)
    assert [{k: v for k, v in c.items() if k not in strip} for c in history] == [
        {k: v for k, v in c.items() if k not in strip} for c in expect["history"]
    ]
    health = json.loads(json.dumps(o.health_check(working)))
    assert _norm_health(health) == _norm_health(expect["health"])


def test_dev_users_become_engineers_on_the_site_they_open(api: TestClient, settings: Settings, site: str) -> None:
    api.get(url(site, "graph"), headers=ALICE)
    with psycopg.connect(settings.database_url.get_secret_value()) as conn:
        rows = conn.execute(
            "SELECT u.email, m.role FROM site_members m JOIN users u ON u.id = m.user_id WHERE m.site_id = %s",
            [site],
        ).fetchall()
    assert rows == [("alice@example.com", "engineer")]


def test_health_scores_head_or_working_graph(api: TestClient, settings: Settings, site: str) -> None:
    assert api.get(url(site, "health")).json() == {"issues": [], "score": 100, "counts": {"nodes": 0, "edges": 0}}
    for op in (node("a"), node("b", props={}), edge("a", "feeds", "b")):
        api.post(url(site, "staged"), json=op)
    api.post(url(site, "commits"), json={"message": "pair"})
    api.post(url(site, "staged"), json=node("lonely"))

    head = api.get(url(site, "health")).json()
    assert head["counts"] == {"nodes": 2, "edges": 1}
    assert [(i["kind"], i["ref"]) for i in head["issues"]] == [("missing-prop", "b")]
    assert head["score"] == 100  # info-level issues don't cost points

    working = api.get(url(site, "health?view=working")).json()
    assert ("orphan", "lonely") in [(i["kind"], i["ref"]) for i in working["issues"]]
    assert working["score"] == 67  # 1 orphan among 3 nodes

    # Edges stored without their nodes (e.g. by a future bulk import) are reported, not hidden.
    with psycopg.connect(settings.database_url.get_secret_value()) as conn:
        conn.execute(
            "INSERT INTO ontology_edges (site_id, id, from_id, rel, to_id) VALUES (%s, 'e9', 'a', 'feeds', 'ghost')",
            [site],
        )
    dangling = [i for i in api.get(url(site, "health")).json()["issues"] if i["kind"] == "dangling"]
    assert dangling == [
        {"level": "error", "kind": "dangling", "ref": "e9", "text": "Relationship e9 points at a missing node"}
    ]
    assert api.get(url(site, "health?view=nope")).status_code == 422


def test_null_value_is_refused_but_leaving_it_out_removes_the_property(api: TestClient, site: str) -> None:
    api.post(url(site, "staged"), json=node("a"))
    res = api.post(url(site, "staged"), json={"kind": "setProp", "id": "a", "key": "vendor", "value": None})
    assert res.status_code == 422
    assert "leave it out" in res.text
    assert api.post(url(site, "staged"), json={"kind": "setProp", "id": "a", "key": "vendor"}).status_code == 201
    assert api.get(url(site, "graph")).json()["nodes"]["a"]["props"] == {}


def test_head_graph_is_read_in_one_statement(settings: Settings, site: str) -> None:
    """Nodes and edges come from one snapshot (see HEAD_SQL), so a commit landing
    mid-read can't pair old nodes with new edges."""

    class Recording:
        def __init__(self, conn: Conn) -> None:
            self.conn = conn
            self.queries: list[str] = []

        def execute(self, query: Any, params: Any = None) -> Any:
            self.queries.append(str(query))
            return self.conn.execute(query, params)

    with psycopg.connect(settings.database_url.get_secret_value(), row_factory=dict_row) as conn:
        conn.execute(
            "INSERT INTO ontology_nodes (site_id, id, type, label)"
            " VALUES (%s, 'a', 'Line', 'A'), (%s, 'b', 'Line', 'B')",
            [site, site],
        )
        conn.execute(
            "INSERT INTO ontology_edges (site_id, id, from_id, rel, to_id) VALUES (%s, 'e', 'a', 'feeds', 'b')", [site]
        )
        rec = Recording(conn)
        graph = load_head(cast(Conn, rec), uuid.UUID(site))
    assert len(rec.queries) == 1
    assert graph == {
        "nodes": {
            "a": {"id": "a", "type": "Line", "label": "A", "props": {}},
            "b": {"id": "b", "type": "Line", "label": "B", "props": {}},
        },
        "edges": {"e": {"id": "e", "from": "a", "rel": "feeds", "to": "b"}},
    }


def test_batch_staging_is_all_or_nothing(api: TestClient, site: str) -> None:
    res = api.post(url(site, "staged/batch"), json=[node("a"), node("b"), edge("a", "feeds", "b")])
    assert res.status_code == 201
    assert len(res.json()) == 3
    # The third op clashes with the first: nothing of this batch is kept.
    res = api.post(url(site, "staged/batch"), json=[node("c"), edge("c", "feeds", "a"), node("c")])
    assert (res.status_code, res.json()["detail"]) == (409, "Node c already exists")
    assert len(api.get(url(site, "staged")).json()) == 3
    assert api.post(url(site, "staged/batch"), json=[]).status_code == 422
