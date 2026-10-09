"""Monitoring (T5.13): request and database spans, ingest and agent metrics, job runs.

Telemetry is set up once per process, here with in-memory exporters (in production with OTLP,
when OTEL_EXPORTER_OTLP_ENDPOINT is set)."""

import os
import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import psycopg
import pytest
from fastapi.testclient import TestClient
from opentelemetry.instrumentation.psycopg import PsycopgInstrumentor
from opentelemetry.sdk.metrics.export import InMemoryMetricReader
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from psycopg.rows import dict_row
from test_warnings import raise_warnings

from tiles_api import quality, telemetry
from tiles_api.main import create_app
from tiles_api.seed import seed
from tiles_api.settings import Settings, get_settings

ENG = {"X-Tiles-User": "eng@example.com"}
ADMIN = {"X-Tiles-User": "admin@example.com"}


@pytest.fixture(scope="module")
def otel(database_url: str) -> Iterator[tuple[InMemoryMetricReader, InMemorySpanExporter]]:
    reader, exporter = InMemoryMetricReader(), InMemorySpanExporter()
    settings = Settings(_env_file=None, env="test", database_url=database_url)
    assert telemetry._providers is None, "this process set up telemetry already"
    endpoint = os.environ.pop("OTEL_EXPORTER_OTLP_ENDPOINT", None)  # never a real collector from here
    assert telemetry.configure("tiles-api", settings, reader=reader, exporter=exporter)
    yield reader, exporter
    PsycopgInstrumentor().uninstrument()  # the rest of the tests run plain
    if telemetry._providers is not None:
        tracer, meter = telemetry._providers
        tracer.shutdown()
        meter.shutdown()
    if endpoint is not None:
        os.environ["OTEL_EXPORTER_OTLP_ENDPOINT"] = endpoint


@pytest.fixture(scope="module")
def api(otel: Any, database_url: str) -> Iterator[TestClient]:
    with TestClient(create_app(Settings(_env_file=None, env="test", database_url=database_url))) as client:
        yield client


@pytest.fixture(scope="module")
def site(api: TestClient, database_url: str) -> str:
    site_id = seed(Settings(_env_file=None, database_url=database_url))
    api.get(f"/sites/{site_id}/me", headers=ADMIN)
    with psycopg.connect(database_url) as conn:
        conn.execute(
            "UPDATE site_members SET role = 'admin' WHERE user_id = (SELECT id FROM users WHERE email = %s)",
            ["admin@example.com"],
        )
    return site_id


def points(reader: InMemoryMetricReader, name: str) -> list[Any]:
    data = reader.get_metrics_data()
    if data is None:
        return []
    return [
        p
        for rm in data.resource_metrics
        for sm in rm.scope_metrics
        for m in sm.metrics
        if m.name == name
        for p in m.data.data_points
    ]


def total(reader: InMemoryMetricReader, name: str, **attrs: str) -> float:
    return float(sum(p.value for p in points(reader, name) if all(p.attributes.get(k) == v for k, v in attrs.items())))


def test_requests_and_their_queries_become_spans(otel: Any, api: TestClient, site: str) -> None:
    _, exporter = otel
    telemetry.shutdown()  # earlier requests' spans out of the way
    exporter.clear()
    res = api.get(f"/sites/{site}/signals", headers=ENG)
    assert res.status_code == 200
    telemetry.shutdown()  # the batch processor sends what it holds
    spans = exporter.get_finished_spans()
    # A trace meets its log lines through the request id.
    [server] = [
        s
        for s in spans
        if s.kind.name == "SERVER" and s.attributes.get("tiles.request_id") == res.headers["x-request-id"]
    ]
    assert server.attributes.get("http.route") == "/sites/{site_id}/signals"
    queries = [s for s in spans if s.attributes.get("db.system") == "postgresql"]
    assert queries, "no database spans"
    # The request's own statements are in its trace (the pool's checks, in its own threads, aren't).
    queries = [s for s in queries if s.context.trace_id == server.context.trace_id]
    assert queries, "the request's statements aren't in its trace"
    statements = " ".join(str(s.attributes.get("db.statement", "")) for s in queries)
    assert "%s" in statements and site not in statements  # placeholders, never the values
    exporter.clear()
    telemetry.shutdown()
    exporter.clear()
    api.get("/health")
    api.get("/ready")
    telemetry.shutdown()
    assert [s for s in exporter.get_finished_spans() if s.kind.name == "SERVER"] == []  # health checks aren't traced
    assert api.get(f"/sites/{site}/ontology/health", headers=ENG).status_code == 200
    telemetry.shutdown()
    routes = [s.attributes.get("http.route") for s in exporter.get_finished_spans() if s.kind.name == "SERVER"]
    assert routes == ["/sites/{site_id}/ontology/health"]  # a page named like them is


def test_ingest_counts_readings_and_their_delay(otel: Any, api: TestClient, site: str, database_url: str) -> None:
    reader, _ = otel
    token = api.post(f"/sites/{site}/agents", json={"name": "press-01"}, headers=ADMIN).json()["token"]
    auth = {"Authorization": f"Bearer {token}"}
    new_before = total(reader, "tiles.ingest.readings", source="edge", stored="new")
    old_before = total(reader, "tiles.ingest.readings", source="edge", stored="not new")
    delays_before = sum(p.count for p in points(reader, "tiles.ingest.delay"))
    at = datetime.now(UTC) - timedelta(seconds=90)
    batch = {
        "samples": [
            {"signal": "press-01.force", "at": (at + timedelta(seconds=i)).isoformat(), "value": i} for i in range(3)
        ]
    }
    assert api.post("/agent/samples", json=batch, headers=auth).json() == {"received": 3, "stored": 3}
    assert api.post("/agent/samples", json=batch, headers=auth).json() == {"received": 3, "stored": 0}
    assert total(reader, "tiles.ingest.readings", source="edge", stored="new") - new_before == 3
    assert total(reader, "tiles.ingest.readings", source="edge", stored="not new") - old_before == 3
    [delay] = points(reader, "tiles.ingest.delay")
    assert delay.count - delays_before == 2

    # Readings sent under a model's derived signal are refused, not counted as already stored.
    with psycopg.connect(database_url) as conn:
        conn.execute("INSERT INTO signals (site_id, tag, source) VALUES (%s, 'press-01.wear', 'model:wear')", [site])
    refused_before = total(reader, "tiles.ingest.readings", source="edge", stored="refused")
    derived = {"samples": [{"signal": "press-01.wear", "at": at.isoformat(), "value": 1}]}
    assert api.post("/agent/samples", json=derived, headers=auth).json() == {"received": 1, "stored": 0}
    assert total(reader, "tiles.ingest.readings", source="edge", stored="refused") - refused_before == 1
    assert total(reader, "tiles.ingest.readings", source="edge", stored="not new") - old_before == 3
    assert delay.max >= 85  # the newest reading was about 88 s old


def test_job_runs_are_recorded_with_their_outcome(
    otel: Any, site: str, database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("TILES_DATABASE_URL", database_url)  # the jobs read their settings
    monkeypatch.setenv("TILES_ENV", "test")
    get_settings.cache_clear()
    monkeypatch.setattr(telemetry, "get_settings", get_settings)

    def last(command: str) -> dict[str, Any]:
        with psycopg.connect(database_url, row_factory=dict_row) as conn:
            row = conn.execute(
                "SELECT * FROM job_runs WHERE command = %s ORDER BY id DESC LIMIT 1", [command]
            ).fetchone()
        assert row
        return row

    quality.main(["--site", site])
    run = last("tiles-check-quality")
    assert run["outcome"] == "ok" and run["finished_at"] >= run["started_at"]

    from tiles_api.models import runner

    def broken(_conn: Any, _site: uuid.UUID | None = None) -> list[uuid.UUID]:
        return [uuid.uuid4()]  # a binding that isn't there: run() raises, the job exits 1

    monkeypatch.setattr(runner, "due", broken)
    with pytest.raises(SystemExit) as exited:
        runner.main([])
    assert exited.value.code == 1
    run = last("tiles-run-models")
    assert (run["outcome"], run["items_ok"], run["items_failed"]) == ("failed", 0, 1)

    # Runs over 30 days old are forgotten when the command next runs.
    with psycopg.connect(database_url) as conn:
        conn.execute(
            "INSERT INTO job_runs (command, outcome, started_at, finished_at)"
            " VALUES ('tiles-check-quality', 'ok', now() - interval '31 days', now() - interval '31 days')"
        )
    quality.main(["--site", site])
    with psycopg.connect(database_url) as conn:
        old = conn.execute("SELECT count(*) FROM job_runs WHERE finished_at < now() - interval '30 days'").fetchone()
    assert old == (0,)


def test_a_run_that_cant_be_recorded_keeps_its_outcome(
    otel: Any, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    settings = Settings(_env_file=None, env="test", database_url="postgresql://nobody@127.0.0.1:1/none")
    with pytest.raises(SystemExit) as exited, telemetry.job("tiles-detect", settings):
        raise SystemExit(3)
    assert exited.value.code == 3
    assert "tiles-detect: run not recorded" in capsys.readouterr().err


def test_agents_jobs_and_notifications_are_gauges(otel: Any, api: TestClient, site: str, database_url: str) -> None:
    reader, _ = otel
    token = api.post(f"/sites/{site}/agents", json={"name": "line-2"}, headers=ADMIN).json()["token"]
    oldest = datetime.now(UTC) - timedelta(minutes=10)
    beat = {
        "version": "0.1.0",
        "started_at": datetime.now(UTC).isoformat(),
        "heartbeat_seconds": 30,
        "buffer": {"queued": 1200, "oldest_at": oldest.isoformat(), "dropped": 4},
    }
    assert api.post("/agent/heartbeat", json=beat, headers={"Authorization": f"Bearer {token}"}).status_code == 200
    # The outbox: one message waiting for 20 minutes, one given up just now, one sent.
    first, second, third = raise_warnings(api, site)
    with psycopg.connect(database_url) as conn:
        conn.execute("DELETE FROM notifications WHERE site_id = %s", [site])
        conn.execute(
            """
            INSERT INTO notifications (site_id, warning_id, kind, channel, created_at, sent_at, failed_at)
            VALUES (%(site)s, %(a)s, 'warning_raised', 'teams', now() - interval '20 minutes', NULL, NULL),
                   (%(site)s, %(b)s, 'warning_raised', 'teams', now() - interval '2 hours', NULL, now()),
                   (%(site)s, %(c)s, 'warning_raised', 'teams', now() - interval '3 hours', now(), NULL)
            """,
            {"site": site, "a": first, "b": second, "c": third},
        )
        slug = conn.execute("SELECT slug FROM sites WHERE id = %s", [site]).fetchone()
    assert slug
    time.sleep(11)  # past the gauges' 10 s cache

    def gauge(name: str, **labels: str) -> float:
        [p] = [p for p in points(reader, name) if all(p.attributes.get(k) == v for k, v in labels.items())]
        return float(p.value)

    assert gauge("tiles.agent.buffer.queued", agent="line-2") == 1200
    assert gauge("tiles.agent.buffer.dropped", agent="line-2") == 4
    assert 590 < gauge("tiles.agent.buffer.oldest_age", agent="line-2") < 700  # the ingest lag: ten minutes
    assert 0 <= gauge("tiles.agent.heartbeat_age", agent="line-2") < 60

    # The previous test's runs: quality went well, the model runner failed.
    assert gauge("tiles.job.last_failed", command="tiles-check-quality") == 0
    assert gauge("tiles.job.last_failed", command="tiles-run-models") == 1
    assert gauge("tiles.job.failed_runs_last_hour", command="tiles-run-models") >= 1
    assert 0 <= gauge("tiles.job.last_run_age", command="tiles-run-models") < 600
    assert gauge("tiles.job.last_duration", command="tiles-check-quality") >= 0

    assert gauge("tiles.notifications.pending", site=slug[0]) == 1
    assert 1190 < gauge("tiles.notifications.oldest_pending_age", site=slug[0]) < 1300
    assert gauge("tiles.notifications.given_up_last_hour", site=slug[0]) == 1


@pytest.fixture(autouse=True)
def fresh_settings() -> Iterator[None]:
    yield
    get_settings.cache_clear()
