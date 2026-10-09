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
- `tiles_job_last_run_age_seconds`, `tiles_job_last_failed`, `tiles_job_last_duration_seconds` and
  `tiles_job_failed_runs_last_hour`, per command: each scheduled job's last run, from the
  `job_runs` table the jobs write (a job process lives too briefly to keep counters; Prometheus's
  own `job` label is the service: tiles-api);
- `tiles_notifications_pending`, `tiles_notifications_oldest_pending_age_seconds` and
  `tiles_notifications_given_up_last_hour`, per site: the e-mail and Teams outbox.

The gauges are read from the database by every API process, at most every 10 seconds.

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
from datetime import UTC, datetime
from importlib.metadata import version
from typing import Any

import psycopg
from fastapi import FastAPI
from opentelemetry import metrics, trace
from opentelemetry.instrumentation.utils import suppress_instrumentation
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

_lock = threading.Lock()
_providers: tuple[TracerProvider, MeterProvider] | None = None
_watching = False
_job_items: ContextVar[list[int] | None] = ContextVar("tiles_job_items", default=None)
KEEP_RUNS_DAYS = 30


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

    # Anchored: only the health checks themselves, not a site's /signals/health or the like.
    FastAPIInstrumentor.instrument_app(app, excluded_urls=r"^https?://[^/]+/(health|ready)$")
    watch(lambda: psycopg.connect(settings.database_url.get_secret_value(), options=UNSCOPED, connect_timeout=5))


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


def job_rows(conn: Any) -> list[dict[str, Any]]:
    """Each command's last run (ages and durations in seconds) and its failed runs in the last hour."""
    cur = conn.cursor(row_factory=dict_row)
    return list(
        cur.execute(
            """
            SELECT DISTINCT ON (command) command,
                   extract(epoch FROM clock_timestamp() - finished_at)::float8 AS last_run_age,
                   (outcome = 'failed')::int AS last_failed,
                   extract(epoch FROM finished_at - started_at)::float8 AS last_duration,
                   count(*) FILTER (WHERE outcome = 'failed' AND finished_at > clock_timestamp() - interval '1 hour')
                       OVER (PARTITION BY command) AS failed_last_hour
            FROM job_runs
            ORDER BY command, finished_at DESC
            """
        )
    )


def notification_rows(conn: Any) -> list[dict[str, Any]]:
    """Each site's outbox: messages waiting (and the oldest one's age), and those given up lately."""
    cur = conn.cursor(row_factory=dict_row)
    return list(
        cur.execute(
            """
            SELECT s.slug AS site, count(n.id) AS pending,
                   coalesce(extract(epoch FROM clock_timestamp() - min(n.created_at))::float8, 0) AS oldest_pending_age,
                   (SELECT count(*) FROM notifications g
                    WHERE g.site_id = s.id AND g.failed_at > clock_timestamp() - interval '1 hour')
                       AS given_up_last_hour
            FROM sites s
            LEFT JOIN notifications n ON n.site_id = s.id AND n.sent_at IS NULL AND n.failed_at IS NULL
            GROUP BY s.id, s.slug
            """
        )
    )


def watch(connect: Callable[[], Any], max_age_s: float = 10) -> None:
    """Gauges of the agents' last reports, the jobs' last runs and the notification outbox, read at
    most every `max_age_s` (each gauge is read on each export; one connection serves them all). When
    the database can't be read, the last values stay."""
    global _watching
    with _lock:
        if _watching:  # one set of gauges per process, however many apps it makes (tests)
            return
        _watching = True
    queries = {"agents": agent_rows, "jobs": job_rows, "notifications": notification_rows}
    cache: dict[str, Any] = {"at": float("-inf"), **{k: [] for k in queries}}
    guard = threading.Lock()

    def rows(kind: str) -> list[dict[str, Any]]:
        with guard:
            if time.monotonic() - cache["at"] > max_age_s:
                cache["at"] = time.monotonic()  # a failure isn't retried at every export either
                try:
                    with suppress_instrumentation(), connect() as conn:  # not a trace of its own each time
                        for k, query in queries.items():
                            cache[k] = query(conn)
                except psycopg.Error as e:
                    print(f"tiles telemetry: can't read the gauges ({e})", file=sys.stderr)
            return list(cache[kind])

    def gauge(
        kind: str, field: str, labels: tuple[str, ...], default: float | None = None
    ) -> Callable[[CallbackOptions], Iterable[Observation]]:
        def observe(_options: CallbackOptions) -> Iterable[Observation]:
            for r in rows(kind):
                value = r[field] if r[field] is not None else default
                if value is not None:
                    yield Observation(value, {label: r[label] for label in labels})

        return observe

    def add(name: str, kind: str, field: str, description: str, unit: str = "", default: float | None = None) -> None:
        labels = {"agents": ("site", "agent"), "jobs": ("command",), "notifications": ("site",)}[kind]
        METER.create_observable_gauge(name, [gauge(kind, field, labels, default)], unit=unit, description=description)

    add("tiles.agent.heartbeat_age", "agents", "heartbeat_age", "Since the agent's last heartbeat", "s")
    add("tiles.agent.buffer.queued", "agents", "queued", "Readings waiting in the agent's buffer")
    add(
        "tiles.agent.buffer.oldest_age",
        "agents",
        "oldest_age",
        "Age of the oldest reading waiting on site: the ingest lag",
        "s",
        default=0.0,  # nothing waiting on site
    )
    add("tiles.agent.buffer.dropped", "agents", "dropped", "Readings the agent dropped (buffer full)")
    add("tiles.job.last_run_age", "jobs", "last_run_age", "Since the job's last run finished", "s")
    add("tiles.job.last_failed", "jobs", "last_failed", "1 when the job's last run failed")
    add("tiles.job.last_duration", "jobs", "last_duration", "How long the job's last run took", "s")
    add("tiles.job.failed_runs_last_hour", "jobs", "failed_last_hour", "The job's failed runs in the last hour")
    add("tiles.notifications.pending", "notifications", "pending", "Notifications waiting to be sent")
    add(
        "tiles.notifications.oldest_pending_age",
        "notifications",
        "oldest_pending_age",
        "Age of the oldest notification waiting to be sent",
        "s",
    )
    add(
        "tiles.notifications.given_up_last_hour",
        "notifications",
        "given_up_last_hour",
        "Notifications given up after their retries in the last hour",
    )


def count_item(ok: bool) -> None:
    """An item the running job ran (a binding, a detector), for its run's record."""
    items = _job_items.get()
    if items is not None:
        items[0 if ok else 1] += 1


def record_run(
    settings: Settings, name: str, outcome: str, started: datetime, finished: datetime, items: list[int]
) -> None:
    """Writes a job's run to `job_runs` (and forgets runs over 30 days old). A failure to write it
    is printed, not raised: the job's own outcome stands."""
    try:
        with (
            suppress_instrumentation(),
            psycopg.connect(
                settings.database_url.get_secret_value(), autocommit=True, options=UNSCOPED, connect_timeout=5
            ) as conn,
        ):
            conn.execute(
                "INSERT INTO job_runs (command, outcome, started_at, finished_at, items_ok, items_failed)"
                " VALUES (%s, %s, %s, %s, %s, %s)",
                [name, outcome, started, finished, items[0], items[1]],
            )
            conn.execute(
                "DELETE FROM job_runs WHERE command = %s AND finished_at < now() - make_interval(days => %s)",
                [name, KEEP_RUNS_DAYS],
            )
    except psycopg.Error as e:
        print(f"{name}: run not recorded ({e})", file=sys.stderr)


@contextmanager
def job(name: str, settings: Settings) -> Iterator[None]:
    """A scheduled job's run: recorded in `job_runs` with its outcome (failed when it exits non-zero
    or raises), duration and items; its spans are sent before the process exits."""
    configure("tiles-jobs", settings)
    items = [0, 0]
    items_token = _job_items.set(items)
    started = datetime.now(UTC)
    outcome = "failed"
    try:
        yield
        outcome = "ok"
    except SystemExit as e:
        outcome = "ok" if e.code in (0, None) else "failed"
        raise
    finally:
        record_run(settings, name, outcome, started, datetime.now(UTC), items)
        _job_items.reset(items_token)
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
