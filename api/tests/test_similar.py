"""Similar past warnings (T10.02): the earlier warnings most like one, how they ended, what followed."""

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_performance import plant

from tiles_api import api_similar, similar

T0 = datetime(2026, 10, 1, tzinfo=UTC)


def seen(**kw: Any) -> similar.Seen:
    base: dict[str, Any] = {
        "signal": "s1",
        "detector": "d1",
        "asset": "DC-01",
        "side": "above",
        "peak": 20.0,
        "baseline": 10.0,
        "threshold": 15.0,
        "started_at": T0,
        "until": T0 + timedelta(hours=1),
    }
    return similar.Seen(**(base | kw))


def test_two_warnings_are_alike_by_what_they_share_and_how_far_and_long_they_went() -> None:
    a = seen()
    assert (a.severity, a.hours) == (2.0, 1.0)
    assert similar.score(a, seen()) == (1.0, ["signal", "detector", "asset", "side"])
    # Twice as far past the threshold: severity counts half.
    s, shared = similar.score(a, seen(peak=30.0))
    assert s == round(1 - similar.WEIGHTS["severity"] / 2, 3) and shared == ["signal", "detector", "asset", "side"]
    # Another signal and detector on the same machine, the other side.
    s, shared = similar.score(a, seen(signal="s2", detector="d2", side="below", peak=0.0, threshold=5.0))
    assert shared == ["asset"] and s == round(
        similar.WEIGHTS["asset"] + similar.WEIGHTS["severity"] + similar.WEIGHTS["duration"], 3
    )
    # Nothing shared and far apart: not similar.
    far = seen(signal="x", detector="y", asset=None, side="below", peak=100.0, until=T0 + timedelta(days=3))
    assert similar.score(a, far)[0] < similar.MIN_SCORE
    # No band between baseline and threshold: severity 1. No asset: never shared.
    assert seen(threshold=10.0).severity == 1.0
    assert "asset" not in similar.score(seen(asset=None), seen(asset=None))[1]


def found(api: TestClient, site: str, warning: str, status: int = 200, **query: Any) -> Any:  # noqa: F811
    res = api.get(f"/sites/{site}/warnings/{warning}/similar", params=query, headers=VIEWER)
    assert res.status_code == status, res.text
    return res.json()


def test_a_warnings_earlier_likes_with_their_outcomes_and_what_followed(api: TestClient, site: str) -> None:  # noqa: F811
    plant(api, site)  # DC-01's friction detector raised three warnings; seizures followed two
    warnings = api.get(f"/sites/{site}/warnings", params={"state": "all"}, headers=VIEWER).json()
    first, second, latest = sorted(warnings, key=lambda w: w["started_at"])
    res = api.post(
        f"/sites/{site}/warnings/{first['id']}/resolve",
        json={"outcome": "true_alarm", "note": "Plunger seized"},
        headers=ENG,
    )
    assert res.status_code == 200, res.text
    out = found(api, site, latest["id"])
    assert (out["warning_id"], out["asset"], out["compared"]) == (latest["id"], "DC-01", 2)
    assert {w["id"] for w in out["similar"]} == {first["id"], second["id"]}  # only earlier ones
    assert all(w["shared"] == ["signal", "detector", "asset", "side"] for w in out["similar"])
    assert out["similar"][0]["score"] >= out["similar"][1]["score"] >= similar.MIN_SCORE
    by_id = {w["id"]: w for w in out["similar"]}
    assert (by_id[first["id"]]["outcome"], by_id[first["id"]]["resolution_note"]) == ("true_alarm", "Plunger seized")
    assert out["outcomes"] == {"true_alarm": 1, "false_alarm": 0, "unknown": 0, "open": 1}
    # What followed: DC-01's first event within a day of each warning's start.
    for w in out["similar"]:
        f = w["followed"]
        assert f is None or (f["kind"] in ("downtime", "scrap") and 0 <= f["hours_after"] <= 24)
    assert out["followed"] == sum(1 for w in out["similar"] if w["followed"])
    assert out["followed"] >= 1
    # The earliest has nothing before it; `limit` shows fewer.
    assert found(api, site, first["id"])["similar"] == []
    assert len(found(api, site, latest["id"], limit=1)["similar"]) == 1
    assert found(api, site, "00000000-0000-0000-0000-000000000000", 404)["code"] == "warning.not_found"


def test_batch_tables_that_name_its_machine_or_tag_are_suggested(api: TestClient, site: str) -> None:  # noqa: F811
    plant(api, site)
    latest = api.get(f"/sites/{site}/warnings", params={"state": "all"}, headers=VIEWER).json()[0]

    def dataset(name: str, columns: list[str], rows: list[dict[str, Any]], description: str = "") -> str:
        body = {"name": name, "description": description, "columns": [{"name": c, "kind": "text"} for c in columns]}
        res = api.post(f"/sites/{site}/datasets", json=body, headers=ENG)
        assert res.status_code == 201, res.text
        res = api.post(f"/sites/{site}/datasets/{res.json()['id']}/rows", json={"rows": rows}, headers=ENG)
        assert res.status_code == 200, res.text
        return str(res.json() and body["name"])

    dataset("Shift log", ["machine", "ok"], [{"machine": "DC-01", "ok": "yes"}])  # a row names it
    dataset("Spare parts", ["machine"], [{"machine": "DC-02"}])  # another machine's
    dataset("Friction batches", ["dc1.friction", "ok"], [{"dc1.friction": "12", "ok": "no"}])  # its tag
    dataset("Batches", ["id"], [{"id": "1"}], description="Batches cast on dc-01")  # named
    dataset("DC-010 batches", ["id"], [{"id": "1"}])  # another machine: DC-01 isn't a word of it
    out = found(api, site, latest["id"])["datasets"]
    assert [(d["name"], d["why"], d["matched"]) for d in out] == [
        ("Batches", "name", "DC-01"),
        ("Friction batches", "column", "dc1.friction"),
        ("Shift log", "value", "DC-01"),
    ]
    assert len(out) <= api_similar.MAX_DATASETS


def test_a_batch_tables_first_rows_are_looked_through(api: TestClient, site: str, monkeypatch: Any) -> None:  # noqa: F811
    plant(api, site)
    latest = api.get(f"/sites/{site}/warnings", params={"state": "all"}, headers=VIEWER).json()[0]
    body = {"name": "Log", "columns": [{"name": "machine", "kind": "text"}]}
    dataset = api.post(f"/sites/{site}/datasets", json=body, headers=ENG).json()["id"]
    rows = [{"machine": "DC-02"}, {"machine": "DC-02"}, {"machine": "DC-01"}]
    assert api.post(f"/sites/{site}/datasets/{dataset}/rows", json={"rows": rows}, headers=ENG).status_code == 200
    assert [d["name"] for d in found(api, site, latest["id"])["datasets"]] == ["Log"]
    monkeypatch.setattr(api_similar, "ROWS_CHECKED", 2)
    assert found(api, site, latest["id"])["datasets"] == []
