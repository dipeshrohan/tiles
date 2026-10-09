"""The copilot's tools (T4.02) on a site's real data: each one as the model calls it, with the
reasons it gives when it can't answer."""

import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import timedelta
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from psycopg.rows import dict_row
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_datasets import upload
from test_model_runner import SHOTS, bind, import_shots
from test_reviews import member, stage
from test_series import T0, load
from test_warnings import raise_warnings
from test_wear import FIXTURE

from tiles_api import copilot_tools
from tiles_api.api_ontology import SiteContext
from tiles_api.assistant import ToolError
from tiles_api.identity import User

HOUR = timedelta(hours=1)
Run = Callable[..., Any]


@pytest.fixture
def tool(api: TestClient, site: str, database_url: str) -> Run:  # noqa: F811
    """Calls a tool by name, as the engineer, the way the copilot does."""
    user = User(uuid.UUID(member(api, site, ENG)), "eng", "eng@example.com", "engineer")
    org = api.get(f"/sites/{site}/me", headers=ENG).json()

    @contextmanager
    def open_ctx() -> Iterator[SiteContext]:
        with psycopg.connect(database_url, row_factory=dict_row) as conn:
            org_id = conn.execute("SELECT org_id FROM sites WHERE id = %s", [site]).fetchone()
            assert org_id is not None and org
            yield SiteContext(conn, uuid.UUID(site), org_id["org_id"], user)

    tools = {t.name: t for t in copilot_tools.tools_for(open_ctx)}

    def run(tool_name: str, /, **args: Any) -> Any:
        return tools[tool_name].run(args)

    return run


def refused(run: Run, tool_name: str, /, **args: Any) -> str:
    with pytest.raises(ToolError) as e:
        run(tool_name, **args)
    return str(e.value)


def test_every_tool_is_described_for_the_model(tool: Run) -> None:
    specs = [t.spec() for t in copilot_tools.tools_for(lambda: None)]  # type: ignore[arg-type, return-value]
    assert [s["name"] for s in specs] == [
        "site_overview",
        "find_signals",
        "graph_query",
        "ontology_health",
        "time_series",
        "wear_check",
        "virtual_sensors",
        "events",
        "correlate",
    ]
    for s in specs:
        assert s["description"] and s["input_schema"]["type"] == "object", s["name"]


def test_the_ontology_graph_and_its_health(api: TestClient, site: str, tool: Run) -> None:  # noqa: F811
    def node(id_: str, type_: str, label: str, **props: str) -> dict[str, Any]:
        return {"kind": "addNode", "node": {"id": id_, "type": type_, "label": label, "props": props}}

    stage(
        api,
        site,
        node("line-2", "Line", "Welding Line 2"),
        node("w03", "Machine", "Tab Welder W-03", vendor="Vendor B"),
        node("plc-w03", "PLC", "PLC Welder-03"),  # no protocol
        node("spare", "Machine", "Spare press", vendor="Acme"),  # no relationships
        {"kind": "addEdge", "edge": {"id": "e1", "from": "line-2", "rel": "contains", "to": "w03"}},
        {"kind": "addEdge", "edge": {"id": "e2", "from": "w03", "rel": "controlledBy", "to": "plc-w03"}},
    )
    assert api.post(f"/sites/{site}/ontology/commits", json={"message": "welding"}, headers=ENG).status_code == 201
    one = tool("graph_query", node="tab welder w-03")
    assert one["node"]["id"] == "w03"
    assert sorted((link["direction"], link["rel"], link["node"]["label"]) for link in one["links"]) == [
        ("in", "contains", "Welding Line 2"),
        ("out", "controlledBy", "PLC Welder-03"),
    ]
    assert [n["label"] for n in tool("graph_query", type="Machine")["nodes"]] == ["Spare press", "Tab Welder W-03"]
    assert [n["id"] for n in tool("graph_query", query="vendor b")["nodes"]] == ["w03"]  # properties count
    assert refused(tool, "graph_query", node="Welder") == "No node 'Welder'; close: PLC Welder-03, Tab Welder W-03"
    assert refused(tool, "graph_query", type="Robot").startswith("type must be one of ")
    health = tool("ontology_health")
    kinds = {(i["kind"], i["ref"]) for i in health["issues"]}
    assert {("orphan", "spare"), ("missing-prop", "plc-w03")} <= kinds
    assert health["score"] < 100
    overview = tool("site_overview")
    assert overview["ontology_nodes_by_type"] == {"Line": 1, "Machine": 2, "PLC": 1}


def test_signals_their_readings_and_wear(api: TestClient, site: str, tool: Run) -> None:  # noqa: F811
    load(api, site, "w03.cathode_power", FIXTURE["cathode"], step=HOUR)
    found = tool("find_signals", query="cathode")
    assert [s["tag"] for s in found["signals"]] == ["w03.cathode_power"]
    series = tool("time_series", tag="W03.CATHODE_POWER")  # tags match whatever the case
    assert (series["readings"], series["bucket_s"]) == (24, None)  # the day up to the latest reading
    assert series["summary"]["last"] == FIXTURE["cathode"][-1]
    assert series["summary"]["max"] == max(FIXTURE["cathode"][-24:])
    whole = tool("time_series", tag="w03.cathode_power", **{"from": T0.isoformat()}, points=10)
    assert (whole["readings"], len(whole["points"]) <= 10, whole["bucket_s"] is not None) == (72, True, True)
    worn = tool("wear_check", tag="w03.cathode_power", baseline_hours=48, limit=1900)
    assert (worn["verdict"], worn["buckets"]) == ("wearing", 72)
    assert worn["text"].startswith("Wearing: the recent level is 1,785")
    assert refused(tool, "time_series", tag="w03.cathode") == "No signal tagged 'w03.cathode'; close: w03.cathode_power"
    assert refused(tool, "time_series", tag="") == "Give the signal's tag (find_signals searches them)"
    assert refused(tool, "time_series", tag="w03.cathode_power", to="yesterday").startswith("to must be an ISO 8601")
    assert refused(tool, "wear_check", tag="w03.cathode_power", direction="sideways").startswith("direction:")
    assert "recent_hours must be a whole number of buckets" in refused(
        tool, "wear_check", tag="w03.cathode_power", recent_hours=1.5
    )


def test_virtual_sensors_with_their_inputs_and_outputs(api: TestClient, site: str, tool: Run) -> None:  # noqa: F811
    import_shots(api, site, SHOTS[:3])
    binding = bind(api, site).json()
    assert api.post(f"/sites/{site}/model-bindings/{binding['id']}/run", headers=ENG).status_code == 200
    out = tool("virtual_sensors")["virtual_sensors"]
    assert [b["name"] for b in out] == ["dc1-plunger"]
    b = out[0]
    assert (b["model_key"], b["enabled"]) == ("plunger-friction", True)
    assert b["inputs"]["t"] == "@time"
    assert b["inputs"]["v"]["tag"] == "dc1.v"
    assert {o["tag"] for o in b["outputs"].values()} >= {"dc1-plunger.friction"}
    assert all(o["last_value"] is not None for o in b["outputs"].values())
    assert refused(tool, "virtual_sensors", name="press") == "No virtual sensor named like 'press'"


def test_warnings_and_events(api: TestClient, site: str, tool: Run) -> None:  # noqa: F811
    raise_warnings(api, site)
    since = (T0 - timedelta(days=400)).isoformat()
    warnings = tool("events", since=since)["warnings"]
    assert len(warnings) == 3
    assert warnings[0]["started_at"] > warnings[-1]["started_at"]  # newest first
    assert {w["tag"] for w in warnings} == {warnings[0]["tag"]}
    assert tool("events", since=since, tag=warnings[0]["tag"], limit=1)["warnings"] == warnings[:1]
    assert tool("events")["warnings"] == []  # by default the last 30 days only
    down = load(api, site, "dc2.downtime", ["DT-1", "DT-7"], step=HOUR)
    res = api.patch(f"/sites/{site}/signals/{down}", json={"event_kind": "downtime", "asset": "DC-2"}, headers=ENG)
    assert res.status_code == 200, res.text
    recorded = tool("events", kind="events", since=(T0 - HOUR).isoformat(), asset="DC-2")["events"]
    assert [(e["tag"], e["kind"], e["value"]) for e in recorded] == [
        ("dc2.downtime", "downtime", "DT-7"),
        ("dc2.downtime", "downtime", "DT-1"),
    ]
    assert refused(tool, "events", kind="alarms") == 'kind must be "warnings" or "events"'


def test_the_correlation_finder_on_a_batch_table(api: TestClient, site: str, tool: Run) -> None:  # noqa: F811
    assert refused(tool, "correlate", dataset="cutter") == "No dataset 'cutter'; the site's datasets: none uploaded yet"
    upload(api, site)
    assert refused(tool, "correlate", dataset="cutter") == (
        "No dataset 'cutter'; the site's datasets: cutter batches (720 rows)"
    )
    assert refused(tool, "correlate", dataset="Cutter Batches").startswith(
        "Say which column is the outcome; cutter batches has: id (text), material (text), tension (number)"
    )
    variables = ["tension", "speed", "humidity", "bladeAge", "rollDiameter"]
    out = tool("correlate", dataset="cutter batches", outcome="ng", split="material", variables=variables)
    assert (out["rows"], out["findings_total"], len(out["findings"])) == (720, 10, 10)
    assert out["explanations"][0].startswith("anode: failed batches ran tension higher")
    assert refused(tool, "correlate", dataset="cutter batches", outcome="ng", split="ng").endswith(
        "Split by another column than the outcome"
    )
    assert (
        refused(tool, "correlate", dataset="cutter batches", outcome="colour") == "No column 'colour' in this dataset"
    )


def test_tools_only_read(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    @contextmanager
    def open_ctx() -> Iterator[SiteContext]:
        with psycopg.connect(database_url, row_factory=dict_row) as conn:
            yield SiteContext(conn, uuid.UUID(site), uuid.uuid4(), User(uuid.uuid4(), "x", "x@example.com", "admin"))

    def write(ctx: SiteContext, _args: dict[str, Any]) -> None:
        ctx.conn.execute("UPDATE sites SET name = 'Hacked' WHERE id = %s", [ctx.site_id])

    with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
        copilot_tools._read_only(open_ctx, write)({})
    assert api.get("/sites", headers=VIEWER).json()[0]["name"] != "Hacked"
