"""Line coverage (T7.01): what Tiles watches on each machine of a place, and what is missing."""

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_performance import send, signal_id

from tiles_api import coverage
from tiles_api.ontology import empty_graph

NODES = [
    ("site", "Site", "Plant", {}),
    ("line-a", "Line", "Line A", {}),
    ("m1", "Machine", "Press 1", {"asset": "P-1"}),  # the MES knows it as P-1
    ("m2", "Machine", "Press 2", {}),
    ("m3", "Machine", "Press 3", {}),
    ("m4", "Machine", "Spare press", {}),  # not on the line
    ("plc1", "PLC", "PLC 1", {}),
    ("plc2", "PLC", "PLC 2", {}),
    ("s1", "Signal", "Press 1 force", {}),
    ("s2", "Signal", "Press 1 temperature", {}),
    ("s3", "Signal", "Press 2 force", {}),
]
EDGES = [
    ("site", "contains", "line-a"),
    ("line-a", "contains", "m1"),
    ("line-a", "contains", "m2"),
    ("line-a", "contains", "m3"),
    ("m1", "controlledBy", "plc1"),
    ("m2", "controlledBy", "plc2"),
    ("plc1", "emits", "s1"),
    ("plc1", "emits", "s2"),
    ("plc2", "emits", "s3"),
]


def plant(api: TestClient, site: str) -> None:  # noqa: F811
    ops: list[dict[str, Any]] = [
        {"kind": "addNode", "node": {"id": i, "type": t, "label": label, "props": props}}
        for i, t, label, props in NODES
    ]
    ops += [{"kind": "addEdge", "edge": {"id": f"{a}-{r}-{b}", "from": a, "rel": r, "to": b}} for a, r, b in EDGES]
    assert api.post(f"/sites/{site}/ontology/staged/batch", json=ops, headers=ENG).status_code == 201
    assert api.post(f"/sites/{site}/ontology/commits", json={"message": "Line A"}, headers=ENG).status_code in (
        200,
        201,
    )
    at = datetime.now(UTC).replace(microsecond=0) - timedelta(hours=1)
    send(
        api,
        site,
        [
            {"signal": "p1.force", "at": at.isoformat(), "value": 10},
            {"signal": "p2.force", "at": at.isoformat(), "value": 11},
            {"signal": "mes.p1.downtime", "at": at.isoformat(), "value": "DT-1"},
            {"signal": "mes.p2.scrap", "at": at.isoformat(), "value": 1},
        ],
    )
    for tag, change in (
        ("p1.force", {"node_id": "s1"}),
        ("p2.force", {"node_id": "s3"}),
        ("mes.p1.downtime", {"event_kind": "downtime", "asset": "p-1"}),  # any case
        ("mes.p2.scrap", {"event_kind": "scrap", "asset": "Press 2"}),  # its label: no asset property
    ):
        res = api.patch(f"/sites/{site}/signals/{signal_id(api, site, tag)}", json=change, headers=ENG)
        assert res.status_code == 200, res.text
    res = api.post(
        f"/sites/{site}/detectors",
        json={"name": "p1-force", "signal_id": signal_id(api, site, "p1.force")},
        headers=ENG,
    )
    assert res.status_code == 201, res.text


def get(api: TestClient, site: str, status: int = 200, **query: str) -> Any:  # noqa: F811
    res = api.get(f"/sites/{site}/coverage", params=query, headers=VIEWER)
    assert res.status_code == status, res.text
    return res.json()


def test_each_machine_of_a_line_shows_what_is_watched_and_what_is_missing(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
) -> None:
    plant(api, site)
    out = get(api, site, place="line-a")
    by = {m["id"]: m for m in out["machines"]}
    assert [m["label"] for m in out["machines"]] == ["Press 1", "Press 2", "Press 3"]  # not the spare press
    p1, p2, p3 = by["m1"], by["m2"], by["m3"]
    assert (p1["asset"], p1["signal_nodes"], p1["signals"], p1["detectors"], p1["models"]) == ("P-1", 2, 1, 1, 0)
    assert p1["event_streams"] == [{"tag": "mes.p1.downtime", "kind": "downtime"}]
    assert p1["missing"] == []
    # A signal linked, no detector; its scrap matched by its label.
    assert (p2["asset"], p2["signals"], p2["detectors"]) == ("Press 2", 1, 0)
    assert p2["event_streams"] == [{"tag": "mes.p2.scrap", "kind": "scrap"}]
    assert p2["missing"] == ["detector"]
    # No PLC and no signal nodes: everything to do.
    assert p3["missing"] == ["signal_nodes", "event_stream"]
    assert out["totals"] == {"machines": 3, "covered": 1, "with_signals": 2, "with_detectors": 1, "with_events": 2}


def test_the_whole_site_a_machine_and_a_place_that_isnt(api: TestClient, site: str) -> None:  # noqa: F811
    plant(api, site)
    assert [m["id"] for m in get(api, site)["machines"]] == ["m1", "m2", "m3", "m4"]
    assert [m["id"] for m in get(api, site, place="m2")["machines"]] == ["m2"]
    assert get(api, site, 404, place="s1")["code"] == "coverage.no_place"  # a signal isn't a place
    assert get(api, site, 404, place="nowhere")["code"] == "coverage.no_place"


def test_signal_nodes_unlinked_and_contained() -> None:
    g = empty_graph()
    g["nodes"]["m"] = {"id": "m", "type": "Machine", "label": "M", "props": {}}
    g["nodes"]["s"] = {"id": "s", "type": "Signal", "label": "S", "props": {}}
    g["edges"]["e"] = {"id": "e", "from": "m", "rel": "contains", "to": "s"}
    assert coverage.signal_nodes(g, "m") == ["s"]  # a signal the machine contains itself counts
    row = {"signal_nodes": 1, "signals": 0, "detectors": 0, "event_streams": []}
    assert coverage.missing(row) == ["linked_tags", "event_stream"]
