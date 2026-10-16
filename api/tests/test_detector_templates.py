"""Detector templates (T7.02): a machine type's detector applied to every machine of that kind on a
line, each tuned by a backtest on its own history and kept with its report."""

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_performance import EVERY, FIXTURE, HORIZON_H, send, signal_id

from tiles_api.api_detector_templates import detector_name

NODES = [
    ("line", "Line", "Line A", {}),
    ("dc1", "Machine", "Die-caster 1", {"kind": "die-caster", "asset": "DC-01"}),
    ("dc2", "Machine", "Die-caster 2", {"kind": "Die-Caster", "asset": "DC-02"}),  # the case doesn't matter
    ("dc3", "Machine", "Die-caster 3", {"kind": "die-caster", "asset": "DC-03"}),
    ("dc4", "Machine", "Die-caster 4", {"kind": "die-caster", "asset": "DC-04"}),
    ("trim", "Machine", "Trim press", {"kind": "press"}),
    ("plc1", "PLC", "PLC 1", {}),
    ("plc2", "PLC", "PLC 2", {}),
    ("plc3", "PLC", "PLC 3", {}),
    ("plcT", "PLC", "PLC T", {}),
    ("s1", "Signal", "DC-01 plunger friction", {}),  # found by its label
    ("s2", "Signal", "DC-02 plunger", {"measure": "Friction"}),  # by its measure
    ("s2t", "Signal", "DC-02 temperature", {"measure": "temperature"}),
    ("s3", "Signal", "DC-03 friction", {}),  # no tag linked
    ("sT", "Signal", "Trim friction", {}),
]
EDGES = [("line", "contains", m) for m in ("dc1", "dc2", "dc3", "dc4", "trim")]
EDGES += [("dc1", "controlledBy", "plc1"), ("dc2", "controlledBy", "plc2"), ("dc3", "controlledBy", "plc3")]
EDGES += [("trim", "controlledBy", "plcT"), ("plc1", "emits", "s1"), ("plc2", "emits", "s2")]
EDGES += [("plc2", "emits", "s2t"), ("plc3", "emits", "s3"), ("plcT", "emits", "sT")]


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
    end = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=10)
    n = len(FIXTURE["values"])
    at = [end - (n - 1 - i) * EVERY for i in range(n)]
    samples = [
        {"signal": tag, "at": t.isoformat(), "value": v}
        for tag in ("dc1.friction", "dc2.friction", "trim.friction")
        for t, v in zip(at, FIXTURE["values"], strict=True)
    ]
    samples += [
        {"signal": "mes.dc1.downtime", "at": at[d["shot"]].isoformat(), "value": d["code"]} for d in FIXTURE["downtime"]
    ]
    send(api, site, samples)
    for tag, change in (
        ("dc1.friction", {"node_id": "s1"}),
        ("dc2.friction", {"node_id": "s2"}),
        ("trim.friction", {"node_id": "sT"}),
        ("mes.dc1.downtime", {"event_kind": "downtime", "asset": "DC-01"}),
    ):
        res = api.patch(f"/sites/{site}/signals/{signal_id(api, site, tag)}", json=change, headers=ENG)
        assert res.status_code == 200, res.text


TEMPLATE = {
    "name": "dc-friction",
    "machine_kind": "die-caster",
    "measure": "friction",
    "grid": {"window": [200], "k": [8.0, 4.0, 20.0], "persist": [3]},
    "horizon_seconds": HORIZON_H * 3600,
}


def test_a_template_makes_a_tuned_detector_for_each_die_caster_on_the_line(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
) -> None:
    plant(api, site)
    res = api.post(f"/sites/{site}/detector-templates", json=TEMPLATE, headers=ENG)
    assert res.status_code == 201, res.text
    t = res.json()
    assert (t["name"], t["created_by"], t["grid"]["direction"]) == ("dc-friction", "eng", ["above"])
    res = api.post(f"/sites/{site}/detector-templates/{t['id']}/apply", json={"place": "line"}, headers=ENG)
    assert res.status_code == 200, res.text
    by = {m["machine"]: m for m in res.json()["machines"]}
    assert sorted(by) == ["dc1", "dc2", "dc3", "dc4"]  # not the trim press
    assert [by[m]["result"] for m in ("dc1", "dc2", "dc3", "dc4")] == ["created", "created", "no_tag", "no_signal"]

    # DC-01 is tuned on its three stops: the best setting warns of all of them.
    dc1 = by["dc1"]
    assert (dc1["detector"], dc1["signal_tag"], dc1["events"], dc1["recall"]) == (
        "dc-friction-dc-01",
        "dc1.friction",
        3,
        1.0,
    )
    assert dc1["readings"] == len(FIXTURE["values"])
    # DC-02 has no downtime to score against: each setting's first value.
    dc2 = by["dc2"]
    assert (dc2["signal_tag"], dc2["events"], dc2["config"]["k"], dc2["recall"]) == ("dc2.friction", 0, 8.0, None)

    detectors = {d["name"]: d for d in api.get(f"/sites/{site}/detectors", headers=VIEWER).json()}
    assert sorted(detectors) == ["dc-friction-dc-01", "dc-friction-dc-02"]
    assert detectors["dc-friction-dc-01"]["asset"] == "DC-01"
    assert detectors["dc-friction-dc-01"]["config"] == dc1["config"]

    # Each detector keeps its own backtest report.
    bt = api.get(f"/sites/{site}/detectors/{dc1['detector_id']}/backtest", headers=VIEWER).json()
    assert (bt["template"], bt["events"], bt["recall"], bt["config"]) == ("dc-friction", 3, 1.0, dc1["config"])
    assert bt["report"].startswith("# Backtest: dc1.friction")
    bt2 = api.get(f"/sites/{site}/detectors/{dc2['detector_id']}/backtest", headers=VIEWER).json()
    assert "No unplanned downtime to score against" in bt2["report"]

    # Applied again, the machines that have it are left as they are.
    again = api.post(f"/sites/{site}/detector-templates/{t['id']}/apply", json={}, headers=ENG).json()
    assert [m["result"] for m in again["machines"]] == ["exists", "exists", "no_tag", "no_signal"]
    assert len(api.get(f"/sites/{site}/detectors", headers=VIEWER).json()) == 2

    audit = api.get(f"/sites/{site}/audit", headers={"X-Tiles-User": "admin@example.com"}).json()
    entries = audit["entries"] if isinstance(audit, dict) else audit
    actions = [e["action"] for e in entries]
    assert {"detector_template.create", "detector_template.apply", "detector.create"} <= set(actions)


def test_templates_are_engineers_and_named_once(api: TestClient, site: str) -> None:  # noqa: F811
    assert api.post(f"/sites/{site}/detector-templates", json=TEMPLATE, headers=VIEWER).status_code == 403
    t = api.post(f"/sites/{site}/detector-templates", json=TEMPLATE, headers=ENG).json()
    taken = api.post(f"/sites/{site}/detector-templates", json=TEMPLATE, headers=ENG)
    assert (taken.status_code, taken.json()["code"]) == (409, "template.name_taken")
    assert [x["name"] for x in api.get(f"/sites/{site}/detector-templates", headers=VIEWER).json()] == ["dc-friction"]
    nowhere = api.post(f"/sites/{site}/detector-templates/{t['id']}/apply", json={"place": "nope"}, headers=ENG)
    assert (nowhere.status_code, nowhere.json()["code"]) == (404, "coverage.no_place")
    assert api.delete(f"/sites/{site}/detector-templates/{t['id']}", headers=VIEWER).status_code == 403
    assert api.delete(f"/sites/{site}/detector-templates/{t['id']}", headers=ENG).status_code == 204
    gone = api.post(f"/sites/{site}/detector-templates/{t['id']}/apply", json={}, headers=ENG)
    assert (gone.status_code, gone.json()["code"]) == (404, "template.not_found")
    bad = dict(TEMPLATE, grid={"k": []})
    assert api.post(f"/sites/{site}/detector-templates", json=bad, headers=ENG).status_code == 422


def test_detector_names() -> None:
    assert detector_name("dc-friction", "DC-01") == "dc-friction-dc-01"
    assert detector_name("t", "Press 2 / Line A") == "t-press-2-line-a"
    assert detector_name("t", "///") == "t-machine"
    assert len(detector_name("a" * 40, "b" * 100)) <= 63
