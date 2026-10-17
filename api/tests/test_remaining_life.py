"""Remaining life (T9.01): each component's time to its wear limit, with an interval."""

import random
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_performance import send, signal_id

from tiles_api import api_remaining_life

NODES: list[tuple[str, str, str, dict[str, Any]]] = [
    ("line", "Line", "Line A", {}),
    ("m1", "Machine", "Welder 1", {}),
    ("m2", "Machine", "Welder 2", {}),
    ("plc1", "PLC", "PLC 1", {}),
    ("plc2", "PLC", "PLC 2", {}),
    ("tip1", "Signal", "Welder 1 tip power", {}),
    ("tip2", "Signal", "Welder 2 tip power", {}),
    ("cool2", "Signal", "Welder 2 coolant", {}),
]
EDGES = [("line", "contains", "m1"), ("line", "contains", "m2"), ("m1", "controlledBy", "plc1")]
EDGES += [
    ("m2", "controlledBy", "plc2"),
    ("plc1", "emits", "tip1"),
    ("plc2", "emits", "tip2"),
    ("plc2", "emits", "cool2"),
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
    end = datetime.now(UTC).replace(minute=0, second=0, microsecond=0)
    rng = random.Random(3)  # noqa: S311 - test data
    samples = []
    for h in range(96):  # four days, hourly: three of baseline, then the last day
        at = (end - timedelta(hours=96 - h)).isoformat()
        rising = 100 + max(0, h - 72) * 2  # tip 1 wears: 2 W an hour over the last day
        samples += [
            {"signal": "w1.tip", "at": at, "value": rising + rng.gauss(0, 0.5)},
            {"signal": "w2.tip", "at": at, "value": 100 + rng.gauss(0, 0.5)},  # steady
            {"signal": "w2.coolant", "at": at, "value": 20 + rng.gauss(0, 0.5)},
        ]
    send(api, site, samples)
    for tag, change in (
        ("w1.tip", {"node_id": "tip1", "wear_limit": 200, "wear_direction": "up", "unit": "W"}),
        ("w2.tip", {"node_id": "tip2", "wear_limit": 200, "wear_direction": "up"}),
        ("w2.coolant", {"node_id": "cool2"}),  # no wear limit: not a component
    ):
        res = api.patch(f"/sites/{site}/signals/{signal_id(api, site, tag)}", json=change, headers=ENG)
        assert res.status_code == 200, res.text


def life(api: TestClient, site: str, status: int = 200, **query: str) -> Any:  # noqa: F811
    res = api.get(f"/sites/{site}/remaining-life", params=query, headers=VIEWER)
    assert res.status_code == status, res.text
    return res.json()


def test_each_component_shows_its_time_to_its_limit_with_an_interval(api: TestClient, site: str) -> None:  # noqa: F811
    plant(api, site)
    out = life(api, site, place="line")
    assert [c["tag"] for c in out["components"]] == ["w1.tip", "w2.tip"]  # soonest first; the coolant has no limit
    tip1, tip2 = out["components"]
    assert (tip1["machine_label"], tip1["component"], tip1["unit"], tip1["limit"]) == (
        "Welder 1",
        "Welder 1 tip power",
        "W",
        200,
    )
    assert tip1["verdict"] == "wearing"
    # About 150 W now, climbing 2 W an hour: about 25 hours to 200 W.
    assert 20 < tip1["hours_to_limit"] < 30
    assert tip1["hours_earliest"] <= tip1["hours_to_limit"] <= tip1["hours_latest"]
    assert 40 < tip1["slope_per_day"] < 56
    # A steady signal gets there at its pace or never; it comes after the one that does.
    assert tip2["verdict"] == "stable"
    assert tip2["hours_to_limit"] is None or tip2["hours_to_limit"] > tip1["hours_to_limit"]
    # One machine, and the whole site.
    assert [c["tag"] for c in life(api, site, place="m2")["components"]] == ["w2.tip"]
    assert len(life(api, site)["components"]) == 2
    assert life(api, site, 404, place="nowhere")["code"] == "coverage.no_place"


def test_a_wear_limit_is_set_on_the_signal_and_cleared(api: TestClient, site: str) -> None:  # noqa: F811
    plant(api, site)
    sid = signal_id(api, site, "w1.tip")
    bad = api.patch(f"/sites/{site}/signals/{sid}", json={"wear_direction": "sideways"}, headers=ENG)
    assert bad.status_code == 422
    # A limit says which way wear moves the signal; a direction needs a limit.
    sid2 = signal_id(api, site, "w2.coolant")
    alone = api.patch(f"/sites/{site}/signals/{sid2}", json={"wear_limit": 30}, headers=ENG)
    assert (alone.status_code, alone.json()["code"]) == (422, "signal.wear_direction")
    alone = api.patch(f"/sites/{site}/signals/{sid}", json={"wear_limit": None}, headers=ENG)
    assert (alone.status_code, alone.json()["code"]) == (422, "signal.wear_direction")
    assert api.patch(f"/sites/{site}/signals/{sid}", json={"wear_limit": 1}, headers=VIEWER).status_code == 403
    res = api.patch(f"/sites/{site}/signals/{sid}", json={"wear_limit": None, "wear_direction": None}, headers=ENG)
    assert (res.json()["wear_limit"], res.json()["wear_direction"]) == (None, None)
    assert [c["tag"] for c in life(api, site)["components"]] == ["w2.tip"]


def test_past_its_limit_first_and_no_readings_last(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    plant(api, site)
    # Welder 2's tip is past a limit just set below it; the coolant has a limit but no history to judge.
    tip2, cool2 = signal_id(api, site, "w2.tip"), signal_id(api, site, "w2.coolant")
    assert api.patch(f"/sites/{site}/signals/{tip2}", json={"wear_limit": 90}, headers=ENG).status_code == 200
    cool = {"wear_limit": 10, "wear_direction": "down"}
    assert api.patch(f"/sites/{site}/signals/{cool2}", json=cool, headers=ENG).status_code == 200
    send(api, site, [{"signal": "w2.spare", "at": datetime.now(UTC).isoformat(), "value": 1}])
    ops = [
        {"kind": "addNode", "node": {"id": "spare2", "type": "Signal", "label": "Welder 2 spare", "props": {}}},
        {"kind": "addEdge", "edge": {"id": "plc2-spare", "from": "plc2", "rel": "emits", "to": "spare2"}},
    ]
    assert api.post(f"/sites/{site}/ontology/staged/batch", json=ops, headers=ENG).status_code == 201
    assert api.post(f"/sites/{site}/ontology/commits", json={"message": "spare"}, headers=ENG).status_code in (200, 201)
    spare = {"node_id": "spare2", "wear_limit": 5, "wear_direction": "up"}
    assert (
        api.patch(f"/sites/{site}/signals/{signal_id(api, site, 'w2.spare')}", json=spare, headers=ENG).status_code
        == 200
    )
    out = life(api, site, place="line")["components"]
    assert [(c["tag"], c["hours_to_limit"]) for c in out][:2] == [("w2.tip", 0), ("w1.tip", out[1]["hours_to_limit"])]
    assert out[-1]["tag"] == "w2.spare" and out[-1]["verdict"] == "not_enough_data"
    # More components than one request checks: the first ones, and `more`.
    monkeypatch.setattr(api_remaining_life, "MAX_COMPONENTS", 2)
    cut = life(api, site, place="line")
    assert (len(cut["components"]), cut["more"]) == (2, True)


def test_a_place_with_no_components(api: TestClient, site: str) -> None:  # noqa: F811
    ops = [{"kind": "addNode", "node": {"id": "line", "type": "Line", "label": "Line A", "props": {}}}]
    assert api.post(f"/sites/{site}/ontology/staged/batch", json=ops, headers=ENG).status_code == 201
    assert api.post(f"/sites/{site}/ontology/commits", json={"message": "a"}, headers=ENG).status_code in (200, 201)
    assert life(api, site, place="line") == {"place": "line", "components": [], "more": False}
