"""Sample ingest (T2.06): agents post readings; each is stored once, in the samples hypertable."""

import time
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
from fastapi.testclient import TestClient
from test_agents import ADMIN, agent_auth, api, register, site  # noqa: F401 - api and site are fixtures

T0 = datetime(2026, 10, 1, 8, 0, tzinfo=UTC)


def reading(signal: str, at: datetime, value: Any, quality: str = "good") -> dict[str, Any]:
    return {"signal": signal, "at": at.isoformat(), "value": value, "quality": quality}


def post(api: TestClient, token: str, samples: list[dict[str, Any]]) -> Any:  # noqa: F811 - the fixture
    return api.post("/agent/samples", json={"samples": samples}, headers=agent_auth(token))


def stored(database_url: str, tag: str) -> list[tuple[Any, ...]]:
    with psycopg.connect(database_url) as conn:
        return conn.execute(
            "SELECT s.at, s.value, s.value_text, s.value_bool, s.quality, g.source FROM samples s"
            " JOIN signals g ON g.id = s.signal_id WHERE g.tag = %s ORDER BY s.at",
            [tag],
        ).fetchall()


def test_readings_are_stored_once_each(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    token = register(api, site)["token"]
    batch = [
        reading("press1.temperature", T0, 21.5),
        reading("press1.temperature", T0 + timedelta(seconds=1), 22),
        reading("press1.state", T0, "running", "uncertain"),
        reading("press1.running", T0, True),
    ]
    res = post(api, token, batch)
    assert res.status_code == 200, res.text
    assert res.json() == {"received": 4, "stored": 4}
    # The agent didn't see the answer and sends the batch again, with one new reading.
    again = post(api, token, [*batch, reading("press1.temperature", T0 + timedelta(seconds=2), 23.0)])
    assert again.json() == {"received": 5, "stored": 1}

    assert stored(database_url, "press1.temperature") == [
        (T0, 21.5, None, None, "good", "edge:edge-01"),
        (T0 + timedelta(seconds=1), 22.0, None, None, "good", "edge:edge-01"),
        (T0 + timedelta(seconds=2), 23.0, None, None, "good", "edge:edge-01"),
    ]
    assert stored(database_url, "press1.state") == [(T0, None, "running", None, "uncertain", "edge:edge-01")]
    assert stored(database_url, "press1.running") == [(T0, None, None, True, "good", "edge:edge-01")]


def test_signals_belong_to_the_agents_site(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    token = register(api, site)["token"]
    assert post(api, token, [reading("line2.speed", T0, 1.0)]).status_code == 200
    with psycopg.connect(database_url) as conn:
        row = conn.execute("SELECT site_id::text FROM signals WHERE tag = 'line2.speed'").fetchone()
    assert row == (site,)


def test_only_agents_may_send(api: TestClient, site: str) -> None:  # noqa: F811
    batch = [reading("press1.temperature", T0, 1.0)]
    assert api.post("/agent/samples", json={"samples": batch}).status_code == 401
    assert api.post("/agent/samples", json={"samples": batch}, headers=ADMIN).status_code == 401
    assert post(api, "tla_not-a-real-token", batch).status_code == 401
    new = register(api, site)
    api.delete(f"/sites/{site}/agents/{new['agent']['id']}", headers=ADMIN)
    assert post(api, new["token"], batch).status_code == 401


def test_a_batch_with_a_bad_reading_stores_nothing(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    token = register(api, site)["token"]
    good = reading("press1.pressure", T0, 3.5)
    for bad in (
        reading("Press 1", T0, 1.0),  # not a signal tag
        reading("press1.pressure", T0, None),
        {**good, "at": "2026-10-01T08:00:00"},  # no time zone
        {**good, "surprise": 1},
        reading("press1.pressure", datetime.now(UTC) + timedelta(days=2), 1.0),
        reading("press1.pressure", T0, "x" * 1001),
    ):
        res = post(api, token, [good, bad])
        assert res.status_code == 422, bad
    assert stored(database_url, "press1.pressure") == []
    ahead = post(api, token, [reading("press1.pressure", datetime.now(UTC) + timedelta(days=2), 1.0)])
    assert "more than a day ahead" in ahead.json()["detail"]
    assert post(api, token, [good] * 10_001).status_code == 422  # too many at once


def test_a_late_reading_goes_into_a_compressed_chunk(api: TestClient, site: str, database_url: str) -> None:  # noqa: F811
    token = register(api, site)["token"]
    old = T0 - timedelta(days=30)
    assert post(api, token, [reading("oven.temperature", old, 180.0)]).json()["stored"] == 1
    with psycopg.connect(database_url) as conn:
        conn.execute("SELECT compress_chunk(c, if_not_compressed => true) FROM show_chunks('samples') c")
    late = [reading("oven.temperature", old, 180.0), reading("oven.temperature", old + timedelta(seconds=1), 181.0)]
    assert post(api, token, late).json() == {"received": 2, "stored": 1}
    assert [r[1] for r in stored(database_url, "oven.temperature")] == [180.0, 181.0]


def test_policies_compress_after_a_week_and_keep_five_years(database_url: str) -> None:
    with psycopg.connect(database_url) as conn:
        jobs: dict[str, str] = dict(
            conn.execute(
                "SELECT proc_name, config->>(CASE proc_name WHEN 'policy_retention' THEN 'drop_after'"
                " ELSE 'compress_after' END) FROM timescaledb_information.jobs WHERE hypertable_name = 'samples'"
            ).fetchall()
        )
    assert jobs == {"policy_compression": "7 days", "policy_retention": "5 years"}


def test_ingest_keeps_up_with_5000_readings_a_second(api: TestClient, site: str) -> None:  # noqa: F811
    """The done-when of T2.06: sustained 5k samples/s. 100 signals at 1 Hz for 10 minutes,
    sent the way an agent's forwarder does: batches of 5,000, one after another."""
    token = register(api, site)["token"]
    readings = [
        reading(f"bench.signal{n:03}", T0 + timedelta(seconds=second), float(second))
        for second in range(600)
        for n in range(100)
    ]
    started = time.perf_counter()
    for i in range(0, len(readings), 5000):
        res = post(api, token, readings[i : i + 5000])
        assert res.json()["stored"] == 5000, res.text
    rate = len(readings) / (time.perf_counter() - started)
    assert rate >= 5000, f"{rate:.0f} samples/s"
