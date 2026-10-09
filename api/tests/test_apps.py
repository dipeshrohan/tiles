"""App Studio (T6.10): templates configured on a site as apps, without code, and run on its data."""

import json
from datetime import timedelta
from pathlib import Path
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_series import load

from tiles_api.app_templates import TEMPLATES, ConfigError, Param, Template, check_config

WEAR: dict[str, Any] = json.loads(
    (Path(__file__).resolve().parents[2] / "test" / "fixtures" / "wear-check.json").read_text()
)
HOUR = timedelta(hours=1)


def make(api: TestClient, site: str, name: str, template: str, **config: Any) -> Any:  # noqa: F811
    return api.post(f"/sites/{site}/apps", json={"name": name, "template": template, "config": config}, headers=ENG)


def test_templates_describe_their_settings(api: TestClient) -> None:  # noqa: F811
    templates = {t["id"]: t for t in api.get("/app-templates", headers=VIEWER).json()}
    assert set(templates) == {"wear-check", "spc-limits"}
    spc = {p["name"]: p for p in templates["spc-limits"]["params"]}
    assert spc["signal"]["kind"] == "signal"
    assert (spc["sigmas"]["default"], spc["sigmas"]["minimum"], spc["sigmas"]["maximum"]) == (3, 1, 6)
    assert [c[0] for c in spc["rules"]["choices"]] == [
        "beyond_limits",
        "two_of_three",
        "four_of_five",
        "run_of_eight",
        "trend_of_six",
    ]
    assert templates["wear-check"]["version"] == 1


def test_settings_are_checked_against_the_template() -> None:
    spc = TEMPLATES["spc-limits"]
    signal = "8d9d3a8e-0000-4000-8000-000000000001"
    clean = check_config(spc, {"signal": signal, "rules": ["trend_of_six", "beyond_limits"]})
    assert clean["rules"] == ["beyond_limits", "trend_of_six"]  # the template's order
    assert clean["sigmas"] == 3.0 and clean["bucket_minutes"] == 60.0
    with pytest.raises(ConfigError) as e:
        check_config(spc, {"signal": "nope", "sigmas": 9, "rules": [], "colour": "red"})
    assert e.value.problems == [
        "colour: SPC limits has no such setting",
        "signal: choose a signal",
        "sigmas: Limits at (sigma) must be from 1 to 6",
        "rules: Rules: choose at least one of beyond_limits, two_of_three, four_of_five, run_of_eight, trend_of_six",
    ]
    with pytest.raises(ConfigError, match="At most 5000 points"):
        check_config(spc, {"signal": signal, "bucket_minutes": 1, "baseline_hours": 24 * 90})
    with pytest.raises(ConfigError, match="The recent window must be a whole number of buckets"):
        check_config(TEMPLATES["wear-check"], {"signal": signal, "recent_hours": 1.5})
    with pytest.raises(ConfigError, match="The recent window needs at least 4 buckets"):
        check_config(TEMPLATES["wear-check"], {"signal": signal, "recent_hours": 2})
    with pytest.raises(ConfigError) as e:
        check_config(spc, {"signal": signal, "bucket_minutes": 45, "baseline_hours": 3, "recent_hours": 1})
    assert e.value.problems == ["recent_hours: The recent window must be a whole number of points"]
    one_bound = Template(
        "t",
        1,
        "T",
        "",
        (Param("cap", "Cap", "number", 1, maximum=10), Param("floor", "Floor", "number", 5, minimum=5)),
        run=lambda *_: {},
    )
    with pytest.raises(ConfigError) as e:
        check_config(one_bound, {"cap": 20, "floor": 1})
    assert e.value.problems == ["cap: Cap must be at most 10", "floor: Floor must be at least 5"]
    with pytest.raises(ConfigError, match="Signal is needed"):
        check_config(TEMPLATES["wear-check"], {})


def test_a_wear_check_app_answers_like_the_wear_check(api: TestClient, site: str) -> None:  # noqa: F811
    cathode = load(api, site, "w03.cathode_power", WEAR["cathode"], step=HOUR)
    res = make(api, site, "Welder 3 cathode tip", "wear-check", signal=cathode, baseline_hours=48, limit=1900)
    assert res.status_code == 201, res.text
    app = res.json()
    assert (app["number"], app["template"], app["template_version"], app["signal_tag"]) == (
        1,
        "wear-check",
        1,
        "w03.cathode_power",
    )
    assert app["config"]["threshold_percent"] == 5  # the default, filled in
    result = api.get(f"/sites/{site}/apps/1/result", headers=VIEWER)
    assert result.status_code == 200, result.text
    out = result.json()
    assert (out["status"], out["headline"]) == ("alert", "Wearing")
    assert out["text"].startswith("Wearing: the recent level is 1,785, 10.2% above the baseline of 1,620")
    assert [lv["label"] for lv in out["levels"]] == ["baseline", "limit"]
    assert len(out["points"]) == 72 and out["spans"][0]["label"] == "recent window"
    assert {f["label"] for f in out["facts"]} >= {"Change from the baseline", "Hours to the limit"}


def spc_readings() -> list[float]:
    """A week of steady hourly readings (alternating 100 and 101), then a day drifting up."""
    steady = [100.0 + (i % 2) for i in range(7 * 24)]
    return steady + [100.5 + 0.4 * i for i in range(24)]


def test_an_spc_app_finds_the_drift_and_says_which_rules(api: TestClient, site: str) -> None:  # noqa: F811
    signal = load(api, site, "oven.zone2_temp", spc_readings(), step=HOUR)
    res = make(api, site, "Oven zone 2", "spc-limits", signal=signal)
    assert res.status_code == 201, res.text
    out = api.get(f"/sites/{site}/apps/{res.json()['number']}/result", headers=VIEWER).json()
    assert (out["status"], out["headline"]) == ("alert", "Out of control")
    assert [lv["label"] for lv in out["levels"]] == ["centre", "upper limit", "lower limit"]
    assert out["levels"][0]["value"] == pytest.approx(100.5)
    rules = {s["label"] for s in out["spans"]}
    assert {"a point beyond a control limit", "six points in a row rising or falling"} <= rules
    assert out["text"].startswith("Out of control: ")
    assert "the centre is 100.5" in out["text"]
    # Only the first rule, and wider limits: fewer signals.
    narrow = make(api, site, "Oven zone 2, beyond limits only", "spc-limits", signal=signal, rules=["beyond_limits"])
    calm = api.get(f"/sites/{site}/apps/{narrow.json()['number']}/result", headers=VIEWER).json()
    assert {s["label"] for s in calm["spans"]} == {"a point beyond a control limit"}

    steady = load(api, site, "oven.zone3_temp", [100.0 + (i % 2) for i in range(8 * 24)], step=HOUR)
    quiet = make(api, site, "Oven zone 3", "spc-limits", signal=steady)
    out = api.get(f"/sites/{site}/apps/{quiet.json()['number']}/result", headers=VIEWER).json()
    assert (out["status"], out["spans"]) == ("ok", [])
    assert out["text"].startswith("In control: no rule broken in the recent 24 buckets")

    few = load(api, site, "oven.zone4_temp", [100.0, 101.0], step=HOUR)
    sparse = make(api, site, "Oven zone 4", "spc-limits", signal=few)
    out = api.get(f"/sites/{site}/apps/{sparse.json()['number']}/result", headers=VIEWER).json()
    assert out["status"] == "no_data"
    assert out["text"].startswith("Not enough readings")


def test_engineers_change_and_archive_apps_and_everything_is_audited(
    api: TestClient,  # noqa: F811
    site: str,  # noqa: F811
    database_url: str,
) -> None:
    signal = load(api, site, "oven.zone2_temp", spc_readings(), step=HOUR)
    assert make(api, site, "Oven", "spc-limits", signal=signal).status_code == 201
    changed = api.put(
        f"/sites/{site}/apps/1", json={"name": "Oven zone 2", "config": {"signal": signal, "sigmas": 2.5}}, headers=ENG
    )
    assert changed.status_code == 200, changed.text
    assert (changed.json()["name"], changed.json()["config"]["sigmas"]) == ("Oven zone 2", 2.5)
    assert [a["name"] for a in api.get(f"/sites/{site}/apps", headers=VIEWER).json()] == ["Oven zone 2"]
    assert api.delete(f"/sites/{site}/apps/1", headers=ENG).status_code == 204
    assert api.get(f"/sites/{site}/apps", headers=VIEWER).json() == []
    assert api.get(f"/sites/{site}/apps/1/result", headers=VIEWER).status_code == 404
    # Numbers aren't reused.
    assert make(api, site, "Oven again", "spc-limits", signal=signal).json()["number"] == 2
    with psycopg.connect(database_url) as conn:
        actions = [
            r[0]
            for r in conn.execute(
                "SELECT action FROM audit_log WHERE entity_type = 'app' AND site_id = %s ORDER BY id", [site]
            )
        ]
    assert actions == ["app.create", "app.update", "app.archive", "app.create"]


def test_requests_are_checked(api: TestClient, site: str) -> None:  # noqa: F811
    signal = load(api, site, "oven.zone2_temp", [1.0, 2.0])
    # Viewers read, engineers write.
    res = api.post(
        f"/sites/{site}/apps",
        json={"name": "x", "template": "spc-limits", "config": {"signal": signal}},
        headers=VIEWER,
    )
    assert res.status_code == 403
    bad = make(api, site, "x", "spc-limits", signal=signal, sigmas=12)
    assert (bad.status_code, bad.json()["detail"]) == (422, "sigmas: Limits at (sigma) must be from 1 to 6")
    assert make(api, site, "x", "no-such-template", signal=signal).status_code == 422
    # Another site's signal, or none at all.
    assert make(api, site, "x", "spc-limits", signal="00000000-0000-4000-8000-000000000000").status_code == 404
    assert make(api, site, " x", "spc-limits", signal=signal).status_code == 422  # a name with edge spaces
    assert api.put(f"/sites/{site}/apps/9", json={"name": "x", "config": {}}, headers=ENG).status_code == 404
