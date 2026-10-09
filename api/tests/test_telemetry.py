"""Monitoring (T5.13): request and database spans, ingest and agent metrics, job runs.

Telemetry is set up once per process, here with in-memory exporters (in production with OTLP,
when OTEL_EXPORTER_OTLP_ENDPOINT is set)."""

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
    assert telemetry.configure("tiles-api", settings, reader=reader, exporter=exporter)
    yield reader, exporter
    PsycopgInstrumentor().uninstrument()  # the rest of the tests run plain


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
    telemetry.shutdown()
    assert [s for s in exporter.get_finished_spans() if s.kind.name == "SERVER"] == []  # health checks aren't traced


def test_ingest_counts_readings_and_their_delay(otel: Any, api: TestClient, site: str) -> None:
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
    assert delay.max >= 85  # the newest reading was about 88 s old


def test_agents_report_their_backlog_as_gauges(otel: Any, api: TestClient, site: str) -> None:
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
    time.sleep(11)  # past the gauges' 10 s cache

    def gauge(name: str) -> float:
        [p] = [p for p in points(reader, name) if p.attributes.get("agent") == "line-2"]
        return float(p.value)

    assert gauge("tiles.agent.buffer.queued") == 1200
    assert gauge("tiles.agent.buffer.dropped") == 4
    assert 590 < gauge("tiles.agent.buffer.oldest_age") < 700  # the ingest lag: ten minutes
    assert 0 <= gauge("tiles.agent.heartbeat_age") < 60


def test_job_runs_are_counted_with_their_outcome(
    otel: Any, site: str, database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    reader, _ = otel
    monkeypatch.setenv("TILES_DATABASE_URL", database_url)  # the jobs read their settings
    monkeypatch.setenv("TILES_ENV", "test")
    get_settings.cache_clear()
    monkeypatch.setattr(telemetry, "get_settings", get_settings)
    ok_before = total(reader, "tiles.job.runs", command="tiles-check-quality", outcome="ok")
    quality.main(["--site", site])
    assert total(reader, "tiles.job.runs", command="tiles-check-quality", outcome="ok") - ok_before == 1

    failed_before = total(reader, "tiles.job.runs", command="tiles-run-models", outcome="failed")
    from tiles_api.models import runner

    def broken(_conn: Any, _site: uuid.UUID | None = None) -> list[uuid.UUID]:
        return [uuid.uuid4()]  # a binding that isn't there: run() raises, the job exits 1

    monkeypatch.setattr(runner, "due", broken)
    with pytest.raises(SystemExit) as exited:
        runner.main([])
    assert exited.value.code == 1
    assert total(reader, "tiles.job.runs", command="tiles-run-models", outcome="failed") - failed_before == 1
    assert total(reader, "tiles.job.items", command="tiles-run-models", outcome="failed") >= 1
    durations = [p for p in points(reader, "tiles.job.duration") if p.attributes.get("command") == "tiles-run-models"]
    assert durations and durations[0].count >= 1


@pytest.fixture(autouse=True)
def fresh_settings() -> Iterator[None]:
    yield
    get_settings.cache_clear()
