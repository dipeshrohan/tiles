"""Setpoint recommendations (T11.02) and their guard rails (T11.04): engineers set limits per
parameter; a sweep of the process model over the line's live state proposes a change within them;
someone else approves it, against the limits as they are then; the line applies it by hand. No
recommendation outside a limit is ever kept or approved, and every step is in the audit log."""

from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_reviews import ENG2

from tiles_api import recommend
from tiles_api.models.process import DiePorosity
from tiles_api.models.registry import ModelError

AT = datetime(2026, 5, 4, 10, 0, tzinfo=UTC)


def call(
    api: TestClient,  # noqa: F811
    method: str,
    path: str,
    who: dict[str, str] = ENG,
    status: int = 200,
    **body: Any,
) -> Any:
    res = api.request(method, path, json=body if method != "GET" else None, headers=who)
    assert res.status_code == status, res.text
    return res.json() if res.content else None


def limit(api: TestClient, site: str, param: str, low: float, high: float, status: int = 200) -> Any:  # noqa: F811
    return call(
        api, "PUT", f"/sites/{site}/recommendation-limits/die-porosity/{param}", status=status, min=low, max=high
    )


def live_line(api: TestClient, site: str) -> dict[str, str]:  # noqa: F811
    """A cell's last hour: its vacuum high (a filter clogging) and its die running cool."""
    imp = call(api, "POST", f"/sites/{site}/imports", status=201, name="the line")
    samples = []
    for i in range(12):
        at = (AT - timedelta(minutes=5 * i)).isoformat()
        samples += [
            {"signal": "dc01.vacuum_level", "at": at, "value": 120 + i % 3},
            {"signal": "dc01.die_temp", "at": at, "value": 214.0},
            {"signal": "dc01.intensification_pressure", "at": at, "value": 900.0},
        ]
    call(api, "POST", f"/sites/{site}/imports/{imp['id']}/samples", samples=samples)
    call(api, "POST", f"/sites/{site}/imports/{imp['id']}/finish")
    signals = call(api, "GET", f"/sites/{site}/signals?limit=50")["signals"]
    return {s["tag"]: s["id"] for s in signals}


def propose(api: TestClient, site: str, ids: dict[str, str], status: int = 201, **changes: Any) -> Any:  # noqa: F811
    body: dict[str, Any] = {
        "model": "die-porosity",
        "objective": "scrap_chance",
        "settable": ["die_temp_set", "intensification_set"],
        "state": {"hydrogen": 0.15, "die_temp_set": 232, "intensification_set": 900},
        "signals": {
            "vacuum": ids["dc01.vacuum_level"],
            "die_temp": ids["dc01.die_temp"],
            "intensification": ids["dc01.intensification_pressure"],
        },
        "at": AT.isoformat(),
        "asset": "DC-01",
    }
    return call(api, "POST", f"/sites/{site}/recommendations", status=status, **(body | changes))


def test_a_recommendation_within_its_limits_is_approved_by_someone_else_and_applied(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    call(api, "GET", f"/sites/{site}/me", who=ENG2)
    ids = live_line(api, site)
    limit(api, site, "die_temp_set", 222, 242)
    limit(api, site, "intensification_set", 880, 920)
    listed = call(api, "GET", f"/sites/{site}/recommendation-limits", who=VIEWER)
    assert [(x["param"], x["min"], x["max"], x["unit"]) for x in listed] == [
        ("die_temp_set", 222, 242, "°C"),
        ("intensification_set", 880, 920, "bar"),
    ]
    rec = propose(api, site, ids)
    # The live state: each signal's median over the hour before; the rest as given or the model's defaults.
    assert rec["state"]["vacuum"] == 121 and rec["state"]["die_temp"] == 214 and rec["state"]["buildup"] == 24
    assert rec["sources"]["vacuum"]["tag"] == "dc01.vacuum_level" and rec["sources"]["vacuum"]["readings"] == 12
    # The die runs cool: its set point is lowered as far as the limit lets it; the pressure, already on set, stays.
    assert rec["proposal"] == {"die_temp_set": 222, "intensification_set": 900}
    assert rec["limits"] == {"die_temp_set": {"min": 222, "max": 242}, "intensification_set": {"min": 880, "max": 920}}
    now, proposed = rec["expected"]["now"], rec["expected"]["proposed"]
    assert proposed["scrap_chance"] < now["scrap_chance"] and proposed["porosity"] < now["porosity"]
    assert (rec["number"], rec["status"], rec["asset"], rec["mine"]) == (1, "proposed", "DC-01", True)
    # Its proposer can't approve it; another engineer does.
    assert call(api, "POST", f"/sites/{site}/recommendations/1/approve", status=403)["code"] == "recommendation.own"
    approved = call(api, "POST", f"/sites/{site}/recommendations/1/approve", who=ENG2, note="Try on the next shift")
    assert (approved["status"], approved["decided_by"], approved["mine"]) == ("approved", "eng2", False)
    early = (AT - timedelta(days=1)).isoformat()
    refused = call(api, "POST", f"/sites/{site}/recommendations/1/applied", status=422, at=early)
    assert refused["code"] == "recommendation.applied_before_approval"
    done = call(api, "POST", f"/sites/{site}/recommendations/1/applied", note="Set on the TCU at 14:00")
    assert (done["status"], done["applied_by"], done["applied_note"]) == ("applied", "eng", "Set on the TCU at 14:00")
    assert call(api, "GET", f"/sites/{site}/recommendations", who=VIEWER) == []  # nothing open
    assert [r["number"] for r in call(api, "GET", f"/sites/{site}/recommendations?show=all&asset=DC-01")] == [1]
    # Every step is in the audit log.
    with psycopg.connect(database_url) as conn:
        actions = [
            r[0]
            for r in conn.execute(
                "SELECT action FROM audit_log WHERE site_id = %s AND action LIKE 'recommendation.%%' ORDER BY at, id",
                [site],
            )
        ]
    assert actions == [
        "recommendation.limit",
        "recommendation.limit",
        "recommendation.propose",
        "recommendation.approve",
        "recommendation.applied",
    ]


def test_a_recommendation_outside_a_limit_is_refused(api: TestClient, site: str) -> None:  # noqa: F811
    call(api, "GET", f"/sites/{site}/me", who=ENG2)
    ids = live_line(api, site)
    # A parameter without a limit can't be recommended at all.
    limit(api, site, "die_temp_set", 222, 242)
    assert propose(api, site, ids, status=422)["code"] == "recommendation.no_limit"
    limit(api, site, "intensification_set", 880, 920)
    rec = propose(api, site, ids)
    # The limits tighten after the sweep: approving it now would set the die outside them, so it is refused.
    limit(api, site, "die_temp_set", 226, 238)
    refused = call(api, "POST", f"/sites/{site}/recommendations/{rec['number']}/approve", who=ENG2, status=409)
    assert (refused["code"], refused["params"]["param"]) == ("recommendation.outside_limit", "die_temp_set")
    assert call(api, "GET", f"/sites/{site}/recommendations/{rec['number']}")["status"] == "proposed"
    # A limit removed: the same.
    call(api, "DELETE", f"/sites/{site}/recommendation-limits/die-porosity/die_temp_set", status=204)
    refused = call(api, "POST", f"/sites/{site}/recommendations/{rec['number']}/approve", who=ENG2, status=422)
    assert refused["code"] == "recommendation.no_limit"
    # Rejected instead, by its proposer (withdrawn).
    rejected = call(api, "POST", f"/sites/{site}/recommendations/{rec['number']}/reject", note="Limits changed")
    assert (rejected["status"], rejected["decision_note"]) == ("rejected", "Limits changed")
    # Limits must be within the model's own bounds, their min at most their max.
    assert limit(api, site, "die_temp_set", 240, 230, status=422)["code"] == "recommendation.bad_limit"
    assert limit(api, site, "die_temp_set", 100, 230, status=422)["code"] == "recommendation.bad_limit"
    assert limit(api, site, "nozzle", 1, 2, status=404)["code"] == "recommendation.no_param"


def test_a_recommendation_needs_the_live_state_and_something_better(api: TestClient, site: str) -> None:  # noqa: F811
    ids = live_line(api, site)
    limit(api, site, "die_temp_set", 222, 242)
    limit(api, site, "intensification_set", 880, 920)
    # No reading in the hour before: the state isn't known, so nothing is guessed.
    stale = propose(api, site, ids, status=422, at=(AT + timedelta(hours=2)).isoformat())
    assert (stale["code"], stale["params"]["tag"]) == ("recommendation.no_live_reading", "dc01.vacuum_level")
    # On its set points already, with nothing else to move: no better setting.
    calm = propose(
        api,
        site,
        ids,
        status=409,
        signals={},
        state={"die_temp": 232, "die_temp_set": 232, "intensification": 900, "intensification_set": 900},
    )
    assert calm["code"] == "recommendation.no_better"
    # A model taking input series can't recommend settings; a viewer can't propose.
    assert propose(api, site, ids, status=422, model="plunger-friction")["code"] == "recommendation.not_design"
    assert propose(api, site, ids, status=422, settable=["nozzle"])["code"] == "recommendation.no_param"
    res = api.post(f"/sites/{site}/recommendations", json={}, headers=VIEWER)
    assert res.status_code in (403, 422)


# ---- the sweep and the guard rail, pure -----------------------------------------------------


STATE = {p.name: float(p.default) for p in DiePorosity.spec.params}


def test_the_sweep_stays_inside_its_limits_and_moves_only_what_helps() -> None:
    state = STATE | {"die_temp": 214.0, "vacuum": 121.0}
    limits = {"die_temp_set": recommend.Limit(222, 242), "intensification_set": recommend.Limit(880, 920)}
    got = recommend.sweep(DiePorosity(), state, limits, "porosity", steps=11)
    assert got.proposal == {"die_temp_set": 222, "intensification_set": 900}
    assert recommend.breaches(got.proposal, limits) == []
    assert got.points == 11 * 11  # the current set points (232 °C, 900 bar) are on the grid already
    # Inside a narrower window the best is its edge, never beyond.
    narrow = {"die_temp_set": recommend.Limit(228, 236)}
    assert recommend.sweep(DiePorosity(), state, narrow, "porosity").proposal == {"die_temp_set": 228}


def test_breaches_name_values_outside_or_without_a_limit() -> None:
    limits = {"a": recommend.Limit(0, 10)}
    assert recommend.breaches({"a": 10}, limits) == []
    assert recommend.breaches({"a": 10.5, "b": 1}, limits) == ["a", "b"]
    assert recommend.grid(recommend.Limit(0, 10), 3, 4) == [0, 4, 5, 10]
    assert recommend.grid(recommend.Limit(0, 10), 3, 12) == [0, 5, 10]  # outside: not swept
    assert recommend.grid(recommend.Limit(5, 5), 3, 5) == [5]


def test_the_sweep_refuses_what_it_cant_take() -> None:
    with pytest.raises(recommend.NoBetter):
        recommend.sweep(DiePorosity(), STATE, {"die_temp_set": recommend.Limit(222, 242)}, "porosity")
    with pytest.raises(ModelError, match="no output"):
        recommend.sweep(DiePorosity(), STATE, {"die_temp_set": recommend.Limit(222, 242)}, "nothing")
    three = {p: recommend.Limit(0, 1) for p in ("vacuum", "hydrogen", "speed")}
    with pytest.raises(ModelError, match="one or two"):
        recommend.sweep(DiePorosity(), STATE, three, "porosity")
    with pytest.raises(ModelError, match="points"):
        two = {"vacuum": recommend.Limit(0, 100), "hydrogen": recommend.Limit(0, 0.4)}
        recommend.sweep(DiePorosity(), STATE, two, "porosity", steps=41)
