"""Monitoring (T5.13): OpenTelemetry traces and metrics, pushed over OTLP to a collector.

Off unless the standard `OTEL_EXPORTER_OTLP_ENDPOINT` is set (the collector's address, e.g.
`http://otel-collector:4318`; the other `OTEL_*` variables, such as headers, apply as usual).
Then the API sends a span for every request and database statement (statement text with its
placeholders, never the values), and the API and the scheduled jobs send these metrics, named as
a Prometheus exporter shows them:

- `tiles_ingest_readings_total{source, stored}`: readings received from edge agents and imports,
  by whether they were new;
- `tiles_ingest_delay_seconds`: how old a batch's newest reading was when it arrived;
- `tiles_agent_heartbeat_age_seconds`, `tiles_agent_buffer_queued`,
  `tiles_agent_buffer_oldest_age_seconds`, `tiles_agent_buffer_dropped`, per site and agent: what
  each active agent last reported (the oldest reading still waiting on site is the ingest lag);
- `tiles_job_runs_total{command, outcome}`, `tiles_job_duration_seconds{command, outcome}` and
  `tiles_job_items_total{command, outcome}`: the scheduled jobs, by their command (Prometheus's
  own `job` label is the service: tiles-api, tiles-jobs);
- `tiles_notifications_total{outcome}`: e-mail and Teams messages sent, to retry or given up.

deploy/monitoring has a collector configuration, the alert rules and a dashboard.
"""

import functools
import os
import sys
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from importlib.metadata import version
from pathlib import Path
from typing import Any

import psycopg
from fastapi import FastAPI
from opentelemetry import metrics, trace
from opentelemetry.metrics import CallbackOptions, Observation
from opentelemetry.sdk.metrics import MeterProvider
from opentelemetry.sdk.metrics.export import MetricReader, PeriodicExportingMetricReader
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor, SpanExporter
from psycopg.rows import dict_row

from tiles_api.settings import Settings, get_settings
from tiles_api.store import UNSCOPED

VERSION = version("tiles-api")
METER = metrics.get_meter("tiles")  # a proxy: records nothing until configure() sets a provider

readings = METER.create_counter(
    "tiles.ingest.readings", unit="{reading}", description="Readings received, by source and whether they were new"
)
ingest_delay = METER.create_histogram(
    "tiles.ingest.delay", unit="s", description="Age of a batch's newest reading when the batch arrived"
)
job_runs = METER.create_counter("tiles.job.runs", unit="{run}", description="Scheduled job runs, by outcome")
job_items = METER.create_counter("tiles.job.items", unit="{item}", description="Items a job ran, by outcome")
job_duration = METER.create_histogram("tiles.job.duration", unit="s", description="How long a job run took")
notifications = METER.create_counter(
    "tiles.notifications", unit="{message}", description="Notifications sent, to retry or given up"
)

_lock = threading.Lock()
_providers: tuple[TracerProvider, MeterProvider] | None = None
_watching = False
current_job: ContextVar[str | None] = ContextVar("tiles_job", default=None)


def enabled() -> bool:
    return bool(os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT"))


def configure(
    service: str,
    settings: Settings,
    reader: MetricReader | None = None,
    exporter: SpanExporter | None = None,
) -> bool:
    """Sets this process's providers, once: OTLP exporters when enabled(), or the given reader and
    exporter (tests). Whether telemetry is on."""
    global _providers
    with _lock:
        if _providers is not None:
            return True
        if reader is None and not enabled():
            return False
        from opentelemetry.exporter.otlp.proto.http.metric_exporter import OTLPMetricExporter
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.instrumentation.psycopg import PsycopgInstrumentor

        resource = Resource.create(
            {"service.name": service, "service.version": VERSION, "deployment.environment": settings.env}
        )
        tracer = TracerProvider(resource=resource)
        tracer.add_span_processor(BatchSpanProcessor(exporter or OTLPSpanExporter()))
        meter = MeterProvider(
            resource=resource, metric_readers=[reader or PeriodicExportingMetricReader(OTLPMetricExporter())]
        )
        trace.set_tracer_provider(tracer)
        metrics.set_meter_provider(meter)
        PsycopgInstrumentor().instrument(enable_commenter=False)
        _providers = (tracer, meter)
        return True


def shutdown() -> None:
    """Sends what is buffered: a job calls it before it exits."""
    if _providers is not None:
        for provider in _providers:
            provider.force_flush()


def instrument(app: FastAPI, settings: Settings) -> None:
    """Spans for the app's requests (not the health checks) and agent gauges, when telemetry is on."""
    if not configure("tiles-api", settings):
        return
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    FastAPIInstrumentor.instrument_app(app, excluded_urls="health,ready")
    watch_agents(lambda: psycopg.connect(settings.database_url.get_secret_value(), options=UNSCOPED))


def agent_rows(conn: Any) -> list[dict[str, Any]]:
    """What each active agent last reported, with ages in seconds (None: never seen, or nothing waits)."""
    cur = conn.cursor(row_factory=dict_row)
    return list(
        cur.execute(
            """
            SELECT s.slug AS site, a.name AS agent,
                   extract(epoch FROM clock_timestamp() - a.last_seen_at)::float8 AS heartbeat_age,
                   (a.last_status -> 'buffer' ->> 'queued')::bigint AS queued,
                   (a.last_status -> 'buffer' ->> 'dropped')::bigint AS dropped,
                   extract(epoch FROM clock_timestamp()
                           - (a.last_status -> 'buffer' ->> 'oldest_at')::timestamptz)::float8 AS oldest_age
            FROM edge_agents a JOIN sites s ON s.id = a.site_id
            WHERE a.revoked_at IS NULL AND a.last_seen_at IS NOT NULL
            """
        )
    )


def watch_agents(connect: Callable[[], Any], max_age_s: float = 10) -> None:
    """Gauges of every active agent's last report, read at most every `max_age_s` (each gauge is
    read on each export; one query serves them all)."""
    global _watching
    with _lock:
        if _watching:  # one set of gauges per process, however many apps it makes (tests)
            return
        _watching = True
    cache: dict[str, Any] = {"at": 0.0, "rows": []}
    guard = threading.Lock()

    def rows() -> list[dict[str, Any]]:
        with guard:
            if time.monotonic() - cache["at"] > max_age_s:
                try:
                    with connect() as conn:
                        cache["rows"] = agent_rows(conn)
                except psycopg.Error:
                    cache["rows"] = []  # no gauges this time, rather than a broken export
                cache["at"] = time.monotonic()
            return list(cache["rows"])

    def gauge(field: str) -> Callable[[CallbackOptions], Iterable[Observation]]:
        def observe(_options: CallbackOptions) -> Iterable[Observation]:
            for r in rows():
                value = r[field]
                if value is None and field == "oldest_age":
                    value = 0.0  # nothing waiting on site
                if value is not None:
                    yield Observation(value, {"site": r["site"], "agent": r["agent"]})

        return observe

    METER.create_observable_gauge(
        "tiles.agent.heartbeat_age", [gauge("heartbeat_age")], unit="s", description="Since the agent's last heartbeat"
    )
    METER.create_observable_gauge(
        "tiles.agent.buffer.queued", [gauge("queued")], description="Readings waiting in the agent's buffer"
    )
    METER.create_observable_gauge(
        "tiles.agent.buffer.oldest_age",
        [gauge("oldest_age")],
        unit="s",
        description="Age of the oldest reading waiting on site: the ingest lag",
    )
    METER.create_observable_gauge(
        "tiles.agent.buffer.dropped", [gauge("dropped")], description="Readings the agent dropped (buffer full)"
    )


@contextmanager
def job(name: str, settings: Settings) -> Iterator[None]:
    """A scheduled job's run: its outcome (failed when it exits non-zero or raises) and duration,
    sent before the process exits."""
    configure("tiles-jobs", settings)
    token = current_job.set(name)
    started = time.perf_counter()
    outcome = "failed"
    try:
        yield
        outcome = "ok"
    except SystemExit as e:
        outcome = "ok" if e.code in (0, None) else "failed"
        raise
    finally:
        attrs = {"command": name, "outcome": outcome}
        job_runs.add(1, attrs)
        job_duration.record(time.perf_counter() - started, attrs)
        current_job.reset(token)
        shutdown()


def job_main[**P, R](name: str) -> Callable[[Callable[P, R]], Callable[P, R]]:
    """Decorates a job command's main(): each call is a run of `name` (see job())."""

    def wrap(fn: Callable[P, R]) -> Callable[P, R]:
        @functools.wraps(fn)
        def run(*args: P.args, **kwargs: P.kwargs) -> R:
            with job(name, get_settings()):
                return fn(*args, **kwargs)

        return run

    return wrap


def job_name() -> str:
    """The running job's name, as its command is called."""
    return current_job.get() or Path(sys.argv[0]).name
