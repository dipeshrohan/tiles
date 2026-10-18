"""The copilot's root-cause tool (T10.03): a machine's stop and the leads on its timeline before it."""

import statistics
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from test_agents import ENG, api, site  # noqa: F401 - api and site are fixtures
from test_copilot_tools import Run, refused, tool  # noqa: F401 - tool is a fixture

from tiles_api import api_timeline, root_cause
from tiles_api.evaluation import plant

HOUR = timedelta(hours=1)


def loaded(api: TestClient, site: str) -> datetime:  # noqa: F811
    """The evaluation's plant; its readings' end."""
    now = datetime.now(UTC)
    plant.load(api, site, ENG, now)
    return now.replace(minute=0, second=0, microsecond=0) - HOUR


def test_the_latest_stop_leads_to_the_signal_that_fell_before_it(api: TestClient, site: str, tool: Run) -> None:  # noqa: F811
    end = loaded(api, site)
    out = tool("root_cause", machine="DC-01")  # a word of its label, and its asset
    assert (out["machine"], out["label"], out["asset"]) == ("dc-01", "DC-01 die-casting cell", "DC-01")
    assert out["stop"] == {"at": end - 5 * HOUR, "tag": "dc01.downtime", "code": "DT-HYD", "planned": False}
    assert (out["looked_from"], out["looked_to"]) == (end - 17 * HOUR, end - 5 * HOUR)
    [lead] = out["leads"]  # the friction warnings came after it
    assert lead["kind"] == "signal" and lead["what"] == "dc01.hydraulic_pressure moved from about 150 to 131 bar"
    assert (lead["at"], lead["change_pct"]) == (end - 6 * HOUR, -12.7) and lead["robust_z"] <= -root_cause.MOVED
    # The same code came once in the 30 days before: two days earlier.
    assert out["same_code_before"] == {"count": 1, "latest": [end - 50 * HOUR]}
    assert "not proof" in out["note"]
    # The same, by its id or its asset in any case.
    assert tool("root_cause", machine="dc-01")["stop"] == out["stop"]
    assert tool("root_cause", machine="dc-01 die-casting cell")["stop"] == out["stop"]


def test_a_stop_near_the_time_asked_and_the_warnings_before(api: TestClient, site: str, tool: Run) -> None:  # noqa: F811
    end = loaded(api, site)
    tip = tool("root_cause", machine="DC-01", at=(end - 21 * HOUR).isoformat(), hours=6)
    assert tip["stop"]["code"] == "DT-TIP" and tip["same_code_before"]["count"] == 0
    assert tip["leads"] == []  # nothing moved: the pressure was steady
    # Without a stop near it, the hours before the time asked: the friction warnings, newest first,
    # then the changes (the plant model's commit, the signals' edits) made as the plant was loaded.
    now = datetime.now(UTC)
    out = tool("root_cause", machine="DC-01", at=now.isoformat())
    assert out["stop"] is None and out["same_code_before"] is None
    kinds = [lead["kind"] for lead in out["leads"]]
    assert kinds[:2] == ["warning", "warning"] and "change" in kinds
    first, second = out["leads"][:2]
    assert first["what"] == "Warning from dc01-friction on dc01.plunger_friction"
    assert first["hours_before_stop"] < second["hours_before_stop"]
    assert any(lead["what"] == "Line 2" for lead in out["leads"])


def test_what_it_cant_answer_says_why(api: TestClient, site: str, tool: Run) -> None:  # noqa: F811
    loaded(api, site)
    assert refused(tool, "root_cause") == (
        "Give the machine: its name in the plant model or its asset (graph_query lists them)"
    )
    missing = refused(tool, "root_cause", machine="DC-09")
    assert missing.startswith("No single machine 'DC-09' in the plant model; machines: DC-01 die-casting cell (DC-01)")
    assert refused(tool, "root_cause", machine="DC-02") == (
        "No unplanned stop of DC-02 in the last 30 days; give `at`, the time to look before"
    )
    assert refused(tool, "root_cause", machine="DC-01", hours="many").startswith("hours must be a whole number")


def test_a_planned_stop_is_said_to_be_planned(api: TestClient, site: str, tool: Run) -> None:  # noqa: F811
    end = loaded(api, site)
    res = api.put(f"/sites/{site}/planned-codes", json={"codes": ["DT-HYD"]}, headers=ENG)
    assert res.status_code == 200, res.text
    # The latest unplanned stop is now the tip change; asked at the planned one, it says it was planned.
    assert tool("root_cause", machine="DC-01")["stop"]["code"] == "DT-TIP"
    asked = tool("root_cause", machine="DC-01", at=(end - 5 * HOUR).isoformat())["stop"]
    assert (asked["code"], asked["planned"]) == ("DT-HYD", True)


def test_moved_is_in_robust_units_of_the_readings_before() -> None:
    t0 = datetime(2026, 10, 1, tzinfo=UTC)

    def at(values: list[float]) -> list[dict[str, Any]]:
        return [{"at": t0 + i * HOUR, "value": v, "min": v, "max": v, "n": 1} for i, v in enumerate(values)]

    m = root_cause.moved(at([10, 11, 9, 10, 12, 4]), t0 + 5 * HOUR)
    assert m is not None
    spread = 1.4826 * statistics.median(abs(v - 10) for v in [10, 11, 9, 10, 12])
    assert (m["median_before"], m["furthest"], m["change"], m["change_pct"]) == (10, 4, -6, -60.0)
    assert (m["robust_z"], m["off_flat_line"], m["bucketed"]) == (round(-6 / spread, 1), False, False)
    assert root_cause.moved(at([10, 11]), t0 + 2 * HOUR) is None  # too few before
    # Off a flat line there is no spread to measure by: no z, said so.
    flat = root_cause.moved(at([5, 5, 5, 5, 6]), t0 + 4 * HOUR)
    assert flat is not None and (flat["robust_z"], flat["off_flat_line"]) == (None, True)
    still = root_cause.moved(at([5, 5, 5, 5, 5]), t0 + 4 * HOUR)
    assert still is not None and (still["robust_z"], still["off_flat_line"]) == (None, False)
    # A fall below a negative median is a negative change.
    below = root_cause.moved(at([-10, -11, -9, -10, -20]), t0 + 4 * HOUR)
    assert below is not None and below["change_pct"] == -100.0


def test_a_bucket_counts_by_its_min_and_max() -> None:
    t0 = datetime(2026, 10, 1, tzinfo=UTC)
    buckets = [{"at": t0 + i * HOUR, "value": 100.0, "min": 99.0, "max": 101.0, "n": 60} for i in range(6)]
    buckets[5] = {"at": t0 + 5 * HOUR, "value": 99.0, "min": 70.0, "max": 101.0, "n": 60}  # a short drop
    m = root_cause.moved(buckets, t0 + 5 * HOUR)
    assert m is not None
    assert (m["furthest"], m["furthest_at"], m["bucketed"]) == (70.0, t0 + 5 * HOUR, True)  # read, not averaged
    assert m["robust_z"] is not None and m["robust_z"] <= -root_cause.MOVED


def test_leads_are_moves_of_a_few_spreads_or_off_a_flat_line() -> None:
    lead = {"change_pct": -12.0, "robust_z": -4.0, "off_flat_line": False}
    assert root_cause._is_lead(lead)
    assert not root_cause._is_lead({**lead, "robust_z": -2.0})
    assert not root_cause._is_lead({**lead, "change_pct": 0.5})  # a tiny change, however steady before
    assert root_cause._is_lead({**lead, "robust_z": None, "off_flat_line": True})
    assert root_cause._is_lead({**lead, "robust_z": None, "off_flat_line": True, "change_pct": None})  # from 0


def test_every_linked_signal_is_looked_at_not_the_timelines_first_few(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    tool: Run,  # noqa: F811
    monkeypatch: Any,
) -> None:
    # The timeline page charts the first few signals by tag; a machine on a PLC with many has more.
    loaded(api, site)
    monkeypatch.setattr(api_timeline, "MAX_SIGNALS", 0)
    out = tool("root_cause", machine="DC-01")
    assert [s["tag"] for s in out["signals"]] == ["dc01.hydraulic_pressure"]
    assert [lead["what"] for lead in out["leads"]] == ["dc01.hydraulic_pressure moved from about 150 to 131 bar"]
