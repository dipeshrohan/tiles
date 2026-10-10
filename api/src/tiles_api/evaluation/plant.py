"""The plant the copilot's evaluation asks about (T4.06): a die-casting line with two cells, their
PLCs, five signals, two warnings, downtime events and a start-up SOP. It is loaded through the API,
as a site's own data would be, and is the same every time but for its times, which end an hour
before it is loaded, so the copilot's default windows (the last day, the last 30 days) find them.

The cases (cases.json) are written against what is here: change both together. `load` checks the
detector raised the warnings the cases expect.
"""

from datetime import datetime, timedelta
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from fastapi.testclient import TestClient

HOUR = timedelta(hours=1)
MINUTE = timedelta(minutes=1)

SOP = (
    "SOP 14: Start-up of die-casting cells DC-01 and DC-02\nPurpose: a safe start-up after a stop. Applies to Line 2.",
    "Before start-up, check the hydraulic pressure of the shot cylinder.\n"
    "It must be between 140 and 160 bar. Below 140 bar, call maintenance.",
    "Plunger tip: lubricate every 500 shots and replace the plunger tip after 20000 shots.\n"
    "Record each replacement in the maintenance log.",
)


def hydraulic_pressure() -> list[float]:
    """72 hourly readings in bar: 146 to 154, a peak of 158 at hour 60, ending at 152."""
    values = [150.0 + ((i * 7) % 9) - 4 for i in range(72)]
    values[60] = 158.0
    values[71] = 152.0
    return values


def shot_speed() -> list[float]:
    """72 hourly readings in m/s: 4.4 and 4.6 in turn, so the mean is 4.5 and the last is 4.6."""
    return [4.4 if i % 2 == 0 else 4.6 for i in range(72)]


def die_temperature() -> list[float]:
    """72 hourly readings in °C: 200 for two days, then rising by 1 °C an hour to 224."""
    return [200.0 if i < 48 else 200.0 + (i - 47) for i in range(72)]


def plunger_friction() -> list[float]:
    """400 readings a minute apart, in kN: 10.0 to 10.4, with two excursions to 15 (two warnings)."""
    values = [10.0 + ((i * 3) % 5) * 0.1 for i in range(400)]
    for start in (150, 300):
        for i in range(start, start + 10):
            values[i] = 15.0
    return values


DOWNTIME = (("DT-HYD", 50), ("DT-TIP", 20), ("DT-HYD", 5))  # (code, hours before the end)

NODES: tuple[tuple[str, str, str, dict[str, str]], ...] = (
    ("line-2", "Line", "Line 2", {}),
    ("dc-01", "Machine", "DC-01 die-casting cell", {"vendor": "Bühler"}),
    ("dc-02", "Machine", "DC-02 die-casting cell", {"vendor": "Idra"}),
    ("plc-dc01", "PLC", "PLC DC-01", {"protocol": "OPC UA"}),
    ("plc-dc02", "PLC", "PLC DC-02", {"protocol": "MQTT"}),
    ("sig-dc01-hp", "Signal", "DC-01 hydraulic pressure", {"unit": "bar"}),
    ("trim-press", "Machine", "Old trim press", {"vendor": "Schuler"}),  # no relationships: an orphan
)
EDGES = (
    ("line-2", "contains", "dc-01"),
    ("line-2", "contains", "dc-02"),
    ("dc-01", "controlledBy", "plc-dc01"),
    ("dc-02", "controlledBy", "plc-dc02"),
    ("plc-dc01", "emits", "sig-dc01-hp"),
)
WARNINGS = 2  # what the detector on dc01.plunger_friction raises


class PlantError(RuntimeError):
    """The plant didn't load as the cases expect."""


def _ok(res: Any, what: str) -> Any:
    if res.status_code >= 300:
        raise PlantError(f"{what}: {res.status_code} {res.text[:300]}")
    return res.json() if res.content else None


def _import(
    api: "TestClient", site: str, who: dict[str, str], tag: str, start: datetime, step: timedelta, values: list[Any]
) -> str:
    imp = _ok(api.post(f"/sites/{site}/imports", json={"name": f"{tag}.csv"}, headers=who), f"import {tag}")
    samples = [{"signal": tag, "at": (start + i * step).isoformat(), "value": v} for i, v in enumerate(values)]
    _ok(
        api.post(f"/sites/{site}/imports/{imp['id']}/samples", json={"samples": samples}, headers=who),
        f"readings of {tag}",
    )
    return _signal(api, site, who, tag)


def _signal(api: "TestClient", site: str, who: dict[str, str], tag: str) -> str:
    found = _ok(api.get(f"/sites/{site}/signals", params={"q": tag}, headers=who), f"signal {tag}")
    return str(next(s["id"] for s in found["signals"] if s["tag"] == tag))


def load(api: "TestClient", site: str, who: dict[str, str], now: datetime) -> None:
    """Loads the plant into `site` as the engineer `who` (headers), its readings ending an hour
    before `now`."""
    end = now.replace(minute=0, second=0, microsecond=0) - HOUR
    hourly = end - 71 * HOUR
    ops: list[dict[str, Any]] = [
        {"kind": "addNode", "node": {"id": i, "type": t, "label": label, "props": props}}
        for i, t, label, props in NODES
    ]
    ops += [
        {"kind": "addEdge", "edge": {"id": f"{a}-{rel}-{b}", "from": a, "rel": rel, "to": b}} for a, rel, b in EDGES
    ]
    _ok(api.post(f"/sites/{site}/ontology/staged/batch", json=ops, headers=who), "the ontology")
    _ok(api.post(f"/sites/{site}/ontology/commits", json={"message": "Line 2"}, headers=who), "the ontology's commit")

    units = {
        "dc01.hydraulic_pressure": ("bar", hydraulic_pressure()),
        "dc01.shot_speed": ("m/s", shot_speed()),
        "dc02.die_temperature": ("°C", die_temperature()),
    }
    for tag, (unit, values) in units.items():
        signal = _import(api, site, who, tag, hourly, HOUR, values)
        _ok(api.patch(f"/sites/{site}/signals/{signal}", json={"unit": unit}, headers=who), f"unit of {tag}")

    friction = plunger_friction()
    signal = _import(api, site, who, "dc01.plunger_friction", end - (len(friction) - 1) * MINUTE, MINUTE, friction)
    _ok(api.patch(f"/sites/{site}/signals/{signal}", json={"unit": "kN"}, headers=who), "unit of the friction")
    detector = _ok(
        api.post(
            f"/sites/{site}/detectors",
            json={"name": "dc01-friction", "signal_id": signal, "window": 50, "asset": "DC-01"},
            headers=who,
        ),
        "the detector",
    )
    opened = _ok(api.post(f"/sites/{site}/detectors/{detector['id']}/run", headers=who), "the detector's run")["opened"]
    if opened != WARNINGS:
        raise PlantError(f"The detector raised {opened} warnings, not the {WARNINGS} the cases expect")

    imp = _ok(api.post(f"/sites/{site}/imports", json={"name": "stops.csv"}, headers=who), "the downtime import")
    stops = [{"signal": "dc01.downtime", "at": (end - h * HOUR).isoformat(), "value": code} for code, h in DOWNTIME]
    _ok(api.post(f"/sites/{site}/imports/{imp['id']}/samples", json={"samples": stops}, headers=who), "the stops")
    downtime = _signal(api, site, who, "dc01.downtime")
    _ok(
        api.patch(f"/sites/{site}/signals/{downtime}", json={"event_kind": "downtime", "asset": "DC-01"}, headers=who),
        "the downtime events",
    )

    _ok(
        api.post(
            f"/sites/{site}/documents",
            params={"title": "SOP 14 die-casting start-up", "filename": "SOP-14.txt"},
            content="\f".join(SOP).encode(),
            headers={**who, "Content-Type": "text/plain"},
        ),
        "the SOP",
    )
