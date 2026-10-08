"""Data Explorer series (T2.10): a signal's readings over a range, as they are or in buckets."""

from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi.testclient import TestClient
from test_agents import ENG, VIEWER, api, site  # noqa: F401 - api and site are fixtures
from test_signals import by_tag

T0 = datetime(2026, 9, 1, 6, 0, tzinfo=UTC)
MINUTE = timedelta(minutes=1)


def load(api: TestClient, site: str, tag: str, values: list[Any], step: timedelta = MINUTE) -> str:  # noqa: F811
    imp = api.post(f"/sites/{site}/imports", json={"name": "plant.csv"}, headers=ENG).json()
    samples = [{"signal": tag, "at": (T0 + i * step).isoformat(), "value": v} for i, v in enumerate(values)]
    for i in range(0, len(samples), 10_000):
        res = api.post(
            f"/sites/{site}/imports/{imp['id']}/samples", json={"samples": samples[i : i + 10_000]}, headers=ENG
        )
        assert res.status_code == 200, res.text
    signal_id: str = by_tag(api, site, tag)["id"]
    return signal_id


def series(api: TestClient, site: str, signal: str, start: datetime, end: datetime, **extra: Any) -> Any:  # noqa: F811
    params = {"from": start.isoformat(), "to": end.isoformat(), **extra}
    return api.get(f"/sites/{site}/signals/{signal}/series", params=params, headers=VIEWER)


def test_few_readings_come_back_as_they_are(api: TestClient, site: str) -> None:  # noqa: F811
    sig = load(api, site, "press1.temperature", [20.0, 21.5, 19.0, 22.0, 20.5])
    res = series(api, site, sig, T0 + MINUTE, T0 + 4 * MINUTE, points=10)  # from included, to excluded
    assert res.status_code == 200, res.text
    body = res.json()
    assert (body["tag"], body["unit"], body["bucket_s"]) == ("press1.temperature", None, None)
    assert [(p["value"], p["min"], p["max"], p["n"]) for p in body["points"]] == [
        (21.5, 21.5, 21.5, 1),
        (19.0, 19.0, 19.0, 1),
        (22.0, 22.0, 22.0, 1),
    ]
    assert body["points"][0]["at"] == "2026-09-01T06:01:00Z"


def test_many_readings_are_bucketed_with_average_min_and_max(api: TestClient, site: str) -> None:  # noqa: F811
    # A day of minute readings: a slow ramp with one spike.
    values = [float(i % 60) for i in range(1440)]
    values[700] = 500.0
    sig = load(api, site, "line.speed", values)
    body = series(api, site, sig, T0, T0 + timedelta(days=1), points=24).json()
    assert body["bucket_s"] == 3600
    assert len(body["points"]) == 24
    first = body["points"][0]
    assert (first["at"], first["value"], first["min"], first["max"], first["n"]) == (
        "2026-09-01T06:00:00Z",
        29.5,
        0.0,
        59.0,
        60,
    )
    assert max(p["max"] for p in body["points"]) == 500.0  # the spike survives downsampling
    assert sum(p["n"] for p in body["points"]) == 1440
    # Buckets start at `from`, and never outnumber the points asked for.
    body = series(api, site, sig, T0 + timedelta(minutes=30), T0 + timedelta(hours=10, minutes=1), points=10).json()
    assert body["points"][0]["at"] == "2026-09-01T06:30:00Z"
    assert body["bucket_s"] == 3426.0 and len(body["points"]) == 10  # 9 h 31 min / 10, rounded up


def test_gaps_are_left_out(api: TestClient, site: str) -> None:  # noqa: F811
    sig = load(api, site, "a.flow", [1.0] * 60)
    load(api, site, "a.flow", [2.0] * 60)  # the same hour again: skipped
    body = series(api, site, sig, T0, T0 + timedelta(hours=6), points=12).json()
    assert [p["at"] for p in body["points"]] == ["2026-09-01T06:00:00Z", "2026-09-01T06:30:00Z"]


def test_true_false_count_as_one_and_zero_and_text_keeps_its_last(api: TestClient, site: str) -> None:  # noqa: F811
    running = load(api, site, "press1.running", [True, False, True, True])
    body = series(api, site, running, T0, T0 + timedelta(hours=1)).json()
    assert [p["value"] for p in body["points"]] == [1.0, 0.0, 1.0, 1.0]
    state = load(api, site, "press1.state", ["idle"] * 30 + ["running"] * 30)
    raw = series(api, site, state, T0, T0 + timedelta(hours=1)).json()
    assert (raw["points"][0]["text"], raw["points"][0]["value"]) == ("idle", None)
    bucketed = series(api, site, state, T0, T0 + timedelta(hours=1), points=10).json()
    assert [p["text"] for p in bucketed["points"]] == ["idle"] * 5 + ["running"] * 5


def test_bad_ranges_and_unknown_signals(api: TestClient, site: str) -> None:  # noqa: F811
    sig = load(api, site, "a.flow", [1.0])
    assert series(api, site, sig, T0, T0).status_code == 422
    assert series(api, site, sig, T0, T0 + timedelta(days=6 * 366)).status_code == 422
    assert series(api, site, sig, T0, T0 + MINUTE, points=5).status_code == 422
    naive = api.get(
        f"/sites/{site}/signals/{sig}/series",
        params={"from": "2026-09-01T06:00:00", "to": "2026-09-02T06:00:00"},
        headers=VIEWER,
    )
    assert naive.status_code == 422  # times need their zone
    missing = series(api, site, "00000000-0000-0000-0000-000000000000", T0, T0 + MINUTE)
    assert missing.status_code == 404


def test_exactly_as_many_readings_as_points_come_back_as_they_are(api: TestClient, site: str) -> None:  # noqa: F811
    sig = load(api, site, "a.flow", [float(i) for i in range(11)])
    ten = series(api, site, sig, T0, T0 + 10 * MINUTE, points=10).json()
    assert (ten["bucket_s"], len(ten["points"])) == (None, 10)
    eleven = series(api, site, sig, T0, T0 + 11 * MINUTE, points=10).json()
    assert eleven["bucket_s"] == 66.0 and len(eleven["points"]) <= 10
