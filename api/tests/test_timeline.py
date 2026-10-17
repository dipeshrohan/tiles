"""Machine timeline (T10.01): a machine's warnings, events, planned stops, changes and readings on one axis."""

from datetime import timedelta
from typing import Any

from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_performance import plant, signal_id

from tiles_api import api_timeline

NODES = [
    ("line", "Line", "Line 1", {}),
    ("dc1", "Machine", "Die caster 1", {"asset": "DC-01"}),
    ("dc2", "Machine", "Die caster 2", {"asset": "DC-02"}),
    ("plc1", "PLC", "PLC 1", {}),
    ("friction", "Signal", "Plunger friction", {}),
]
EDGES = [("line", "contains", "dc1"), ("line", "contains", "dc2"), ("dc1", "controlledBy", "plc1")]
EDGES += [("plc1", "emits", "friction")]


def commit(api: TestClient, site: str, ops: list[dict[str, Any]], message: str) -> None:  # noqa: F811
    assert api.post(f"/sites/{site}/ontology/staged/batch", json=ops, headers=ENG).status_code == 201
    res = api.post(f"/sites/{site}/ontology/commits", json={"message": message}, headers=ENG)
    assert res.status_code in (200, 201), res.text


def machine_plant(api: TestClient, site: str) -> dict[str, Any]:  # noqa: F811
    p = plant(api, site)
    ops: list[dict[str, Any]] = [
        {"kind": "addNode", "node": {"id": i, "type": t, "label": label, "props": props}}
        for i, t, label, props in NODES
    ]
    ops += [{"kind": "addEdge", "edge": {"id": f"{a}-{r}-{b}", "from": a, "rel": r, "to": b}} for a, r, b in EDGES]
    commit(api, site, ops, "Line 1")
    res = api.patch(
        f"/sites/{site}/signals/{signal_id(api, site, 'dc1.friction')}", json={"node_id": "friction"}, headers=ENG
    )
    assert res.status_code == 200, res.text
    return p


def timeline(api: TestClient, site: str, status: int = 200, **query: str) -> Any:  # noqa: F811
    res = api.get(f"/sites/{site}/timeline", params=query, headers=VIEWER)
    assert res.status_code == status, res.text
    return res.json()


def test_a_machines_warnings_events_stops_changes_and_readings_share_one_range(api: TestClient, site: str) -> None:  # noqa: F811
    p = machine_plant(api, site)
    at = p["at"]
    stop = api.post(
        f"/sites/{site}/planned-stops",
        json={
            "asset": "DC-01",
            "starts_at": (at[1090] - timedelta(minutes=5)).isoformat(),
            "ends_at": (at[1090] + timedelta(minutes=5)).isoformat(),
            "reason": "Lubrication",
        },
        headers=ENG,
    ).json()
    api.post(
        f"/sites/{site}/planned-stops",
        json={"asset": "DC-02", "starts_at": at[10].isoformat(), "ends_at": at[20].isoformat()},
        headers=ENG,
    )
    start = (at[0] - timedelta(hours=1)).isoformat()
    out = timeline(api, site, machine="dc1", **{"from": start})
    assert (out["label"], out["asset"], out["more"], out["more_signals"]) == ("Die caster 1", "DC-01", False, False)
    # Readings: the machine's linked tag, downsampled into the range.
    [series] = out["signals"]
    assert series["tag"] == "dc1.friction" and 0 < len(series["points"]) <= api_timeline.POINTS
    # Warnings: its detector's three, open.
    assert [w["detector"] for w in out["warnings"]] == [p["detector"]["name"]] * 3
    assert {w["status"] for w in out["warnings"]} == {"open"} and all(
        w["tag"] == "dc1.friction" for w in out["warnings"]
    )
    # Events: its own (DC-01's), not DC-02's; the lubrication stop within its planned stop is marked planned.
    assert [(e["kind"], e["code"], e["planned"]) for e in out["events"]] == [
        ("downtime", "DT-SEIZURE", False),
        ("downtime", "DT-LUBRICATION", True),
        ("scrap", "3", False),
        ("downtime", "DT-SEIZURE", False),
    ]
    # Planned stops: its asset's, not DC-02's.
    assert [s["id"] for s in out["planned"]] == [stop["id"]]
    # Changes: its detector made and run, the commit that made it and the edit of its signal, oldest first.
    detector = p["detector"]["name"]
    assert [(c["kind"], c["action"], c["subject"]) for c in out["changes"]] == [
        ("detector", "detector.create", detector),
        ("detector", "detector.run", detector),
        ("ontology", "Line 1", "#1"),
        ("signal", "signal.update", "dc1.friction"),
    ]
    assert out["changes"][0]["author"]


def test_a_commit_counts_when_it_touches_the_machine_its_plc_or_its_signals(api: TestClient, site: str) -> None:  # noqa: F811
    machine_plant(api, site)
    commit(api, site, [{"kind": "setProp", "id": "dc2", "key": "kind", "value": "die-caster"}], "DC-02 kind")
    commit(api, site, [{"kind": "setProp", "id": "plc1", "key": "ip", "value": "10.0.0.5"}], "PLC address")
    commit(api, site, [{"kind": "removeEdge", "id": "plc1-emits-friction"}], "Unhook friction")
    changes = [c["action"] for c in timeline(api, site, machine="dc1")["changes"] if c["kind"] == "ontology"]
    assert changes == ["Line 1", "PLC address", "Unhook friction"]  # not DC-02's


def test_a_warning_counts_while_it_is_out_in_the_range(api: TestClient, site: str) -> None:  # noqa: F811
    p = machine_plant(api, site)
    out = timeline(api, site, machine="dc1", **{"from": (p["at"][0] - timedelta(hours=1)).isoformat()})
    first = out["warnings"][0]
    assert first["ended_at"]  # it ended; a range from just before its end still shows it
    later = timeline(api, site, machine="dc1", **{"from": first["ended_at"]})
    assert later["warnings"][0]["id"] == first["id"]


def test_the_machine_and_the_range_are_checked(api: TestClient, site: str) -> None:  # noqa: F811
    machine_plant(api, site)
    assert timeline(api, site, 404, machine="nope")["code"] == "timeline.no_machine"
    assert timeline(api, site, 404, machine="line")["code"] == "timeline.no_machine"  # a place, not a machine
    long = timeline(api, site, 422, machine="dc1", **{"from": "2026-01-01T00:00:00Z", "to": "2026-03-01T00:00:00Z"})
    assert long["code"] == "timeline.range_too_long" and long["params"] == {"days": 31}
    inverted = timeline(api, site, 422, machine="dc1", **{"from": "2026-03-01T00:00:00Z", "to": "2026-02-01T00:00:00Z"})
    assert inverted["code"] == "series.range_inverted"
    # A machine without signals or events has an empty timeline.
    empty = timeline(api, site, machine="dc2")
    assert (empty["signals"], empty["warnings"], empty["changes"][0]["action"]) == ([], [], "Line 1")


def test_more_than_the_shown_items_says_so(api: TestClient, site: str, monkeypatch: Any) -> None:  # noqa: F811
    p = machine_plant(api, site)
    monkeypatch.setattr(api_timeline, "MAX_ITEMS", 2)
    out = timeline(api, site, machine="dc1", **{"from": (p["at"][0] - timedelta(hours=1)).isoformat()})
    assert out["more"] and len(out["events"]) == 2 and len(out["warnings"]) == 2
