"""The ROI report (T6.01): the pilot period against the baseline, from the site's events and warnings."""

from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_performance import HORIZON_H, plant, send


def roi(api: TestClient, site: str, status: int = 200, **body: Any) -> Any:  # noqa: F811
    res = api.post(f"/sites/{site}/roi", json={"horizon_hours": HORIZON_H, **body}, headers=VIEWER)
    assert res.status_code == status, res.text
    return res.json()


def setup(api: TestClient, site: str) -> dict[str, Any]:  # noqa: F811
    """The performance test's plant as the pilot, and before it a 20-day baseline with 10 stops on
    DC-01, 4 scrap readings (and one of 0, which isn't an event), and no detector watching."""
    p = plant(api, site)
    first, last = p["at"][0], p["at"][-1]
    b_end = first - timedelta(days=3)
    b_start = b_end - timedelta(days=20)
    stops = [
        {"signal": "mes.dc1.downtime", "at": (b_start + timedelta(days=2 * i + 1)).isoformat(), "value": "DT-SEIZURE"}
        for i in range(10)
    ]
    scrap = [
        {"signal": "mes.dc1.scrap", "at": (b_start + timedelta(days=4 * i + 2)).isoformat(), "value": v}
        for i, v in enumerate((2, 1, 0, 5, 1))
    ]
    send(api, site, stops + scrap)
    return {
        "baseline_start": b_start.isoformat(),
        "baseline_end": b_end.isoformat(),
        "pilot_start": first.isoformat(),
        "pilot_end": (last + timedelta(minutes=5)).isoformat(),
        "pilot_days": (last + timedelta(minutes=5) - first).total_seconds() / 86400,
    }


def test_the_pilot_is_compared_with_the_baseline(api: TestClient, site: str) -> None:  # noqa: F811
    s = setup(api, site)
    days = s.pop("pilot_days")
    out = roi(
        api,
        site,
        **s,
        hours_per_stop=2.5,
        hours_source="MES export 2026-06",
        cost_per_hour=1000,
        cost_per_scrap=50,
        currency="EUR",
    )
    b, p = out["periods"]["baseline"], out["periods"]["pilot"]
    assert b["counts"] == {"downtime": 10, "scrap": 4}
    assert b["rates"] == {"downtime": 0.5, "scrap": 0.2}
    # The pilot: DC-01's three stops and DC-02's one; one scrap reading that wasn't 0.
    assert p["counts"] == {"downtime": 4, "scrap": 1}
    assert p["by_asset"] == [
        {"asset": "DC-01", "downtime": 3, "scrap": 1},
        {"asset": "DC-02", "downtime": 1, "scrap": 0},
    ]
    a = out["avoided"]
    assert abs(a["stops"] - (0.5 * days - 4)) < 1e-9
    assert abs(a["downtime_hours"] - a["stops"] * 2.5) < 1e-9
    assert abs(a["scrap"] - (0.2 * days - 1)) < 1e-9
    assert abs(a["cost"] - (a["downtime_hours"] * 1000 + a["scrap"] * 50)) < 1e-6
    # No detector judged the baseline, so it has no warning figures; the pilot has Warning performance's.
    assert b["warnings"]["recall"] is None and b["warnings"]["median_warning_seconds"] is None
    assert (p["warnings"]["warnings"], p["warnings"]["caught"], p["warnings"]["precision"]) == (3, 3, 1)
    assert p["warnings"]["events"] == 3  # DC-01's stops: not its scrap, and DC-02 has no detector
    assert p["warnings"]["median_warning_seconds"] > 0
    md = out["markdown"]
    assert md.startswith("# ROI report\n")
    assert "| Unplanned stops per day | 0.50 |" in md
    assert "2.50 h per stop (MES export 2026-06)" in md
    assert "- Cost: downtime hours x 1,000 EUR per hour, plus scrap events x 50 EUR each." in md
    assert "| DC-01 | 10 | 4 | 3 | 1 |" in md
    assert f"`{out['digest']}`" in md


def test_the_same_data_gives_the_same_digest_and_a_new_reading_changes_it(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
) -> None:
    s = setup(api, site)
    s.pop("pilot_days")
    first = roi(api, site, **s)
    assert roi(api, site, **s)["digest"] == first["digest"]
    assert len(first["digest"]) == 64
    assert first["avoided"]["downtime_hours"] is None and first["avoided"]["cost"] is None  # no stop length given
    send(api, site, [{"signal": "mes.dc2.downtime", "at": s["baseline_start"], "value": "DT-TOOL"}])
    again = roi(api, site, **s)
    assert again["periods"]["baseline"]["counts"]["downtime"] == 11
    assert again["digest"] != first["digest"]
    assert roi(api, site, **s, cost_per_hour=1)["digest"] != again["digest"]  # the inputs count too


def test_a_stop_at_the_boundary_counts_once_and_times_are_utc(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
) -> None:
    s = setup(api, site)
    s.pop("pilot_days")
    s["baseline_end"] = s["pilot_start"]
    before = roi(api, site, **s)["periods"]
    send(api, site, [{"signal": "mes.dc2.downtime", "at": s["pilot_start"], "value": "DT-TOOL"}])
    out = roi(api, site, **s)
    after = out["periods"]
    assert after["baseline"]["counts"] == before["baseline"]["counts"]
    assert after["pilot"]["counts"]["downtime"] == before["pilot"]["counts"]["downtime"] + 1
    # The same moments written with another offset: the same report, said in UTC.
    shifted = {k: datetime.fromisoformat(v).astimezone(timezone(timedelta(hours=2))).isoformat() for k, v in s.items()}
    again = roi(api, site, 200, **shifted)
    assert again["digest"] == out["digest"]
    assert again["periods"]["pilot"]["start"].endswith("Z") or again["periods"]["pilot"]["start"].endswith("+00:00")
    assert "UTC" in again["markdown"] and "h per stop" not in again["markdown"]  # no stop length given
    assert "- Cost:" not in again["markdown"]


def test_rates_per_thousand_parts_and_codes(api: TestClient, site: str) -> None:  # noqa: F811
    s = setup(api, site)
    s.pop("pilot_days")
    out = roi(api, site, **s, baseline_parts=40_000, pilot_parts=5_000)
    b, p = out["periods"]["baseline"], out["periods"]["pilot"]
    assert b["rates"] == {"downtime": 0.25, "scrap": 0.1}
    assert p["rates"] == {"downtime": 0.8, "scrap": 0.2}
    assert out["avoided"]["stops"] == 0.25 * 5 - 4
    assert "per 1,000 parts" in out["markdown"]
    # Codes narrow the stops, not the scrap.
    only = roi(api, site, **s, codes=["DT-SEIZURE"])
    assert only["periods"]["pilot"]["counts"] == {"downtime": 2, "scrap": 1}
    assert only["periods"]["baseline"]["counts"] == {"downtime": 10, "scrap": 4}


def test_periods_are_checked(api: TestClient, site: str) -> None:  # noqa: F811
    s = setup(api, site)
    s.pop("pilot_days")
    backwards = roi(api, site, 422, **(s | {"baseline_end": s["baseline_start"]}))
    assert backwards["code"] == "roi.empty"
    overlap = roi(api, site, 422, **(s | {"baseline_end": s["pilot_end"]}))
    assert overlap["code"] == "roi.order"
    assert roi(api, site, 422, **s, currency="euro")["detail"]
    assert roi(api, site, 422, **s, surprise=1)["detail"]  # nothing but the report's inputs
    naive = roi(api, site, 422, **(s | {"pilot_start": s["pilot_start"][:19]}))
    assert naive["detail"]


def test_an_engineer_reads_the_same_report(api: TestClient, site: str) -> None:  # noqa: F811
    s = setup(api, site)
    s.pop("pilot_days")
    res = api.post(f"/sites/{site}/roi", json={"horizon_hours": HORIZON_H, **s}, headers=ENG)
    assert res.status_code == 200
    assert res.json()["digest"] == roi(api, site, **s)["digest"]


def test_the_avoided_cost_per_machine_and_per_model(api: TestClient, site: str) -> None:  # noqa: F811
    s = setup(api, site)
    days = s.pop("pilot_days")
    out = roi(api, site, **s, hours_per_stop=2.5, cost_per_hour=1000, cost_per_scrap=50, currency="EUR")
    a = out["avoided"]
    # Per machine: DC-01 had all the baseline's stops and scrap; DC-02 had none, so its one pilot stop is -1.
    by = {m["asset"]: m for m in out["by_machine"]}
    assert sorted(by) == ["DC-01", "DC-02"]
    assert by["DC-01"]["baseline"] == {"downtime": 10, "scrap": 4}
    assert by["DC-01"]["pilot"] == {"downtime": 3, "scrap": 1}
    assert abs(by["DC-01"]["avoided"]["stops"] - (0.5 * days - 3)) < 1e-9
    assert by["DC-02"]["avoided"]["stops"] == -1
    # The rows add up to the totals.
    for k in ("stops", "downtime_hours", "scrap", "cost"):
        assert abs(sum(m["avoided"][k] for m in out["by_machine"]) - a[k]) < 1e-6
    # Per model: the one detector warned first of DC-01's three stops: the whole share.
    (model,) = out["by_model"]
    assert (model["detector"], model["stops_warned"], model["share"]) == ("dc1-friction", 3, 1)
    assert abs(model["stops"] - a["stops"]) < 1e-9 and abs(model["cost"] - a["downtime_hours"] * 1000) < 1e-6
    md = out["markdown"]
    assert "## By machine" in md and "| DC-02 | -1 | -2.5 | 0 | -2,500 EUR |" in md
    assert "| dc1-friction | 3 | 100% |" in md
    # Without the cost inputs, the breakdowns say so too.
    bare = roi(api, site, **s)
    assert bare["by_machine"][0]["avoided"]["cost"] is None and bare["by_model"][0]["cost"] is None


def test_no_detector_warned_of_a_stop(api: TestClient, site: str) -> None:  # noqa: F811
    s = setup(api, site)
    s.pop("pilot_days")
    s["pilot_end"] = (datetime.fromisoformat(s["pilot_start"]) + timedelta(minutes=1)).isoformat()
    out = roi(api, site, **s)
    assert out["by_model"] == []
    assert "No detector warned of a stop in the pilot period." in out["markdown"]
