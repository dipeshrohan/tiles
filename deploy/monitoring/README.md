# Monitoring Tiles

Tiles sends traces and metrics with OpenTelemetry. This directory, with the Helm chart's `files/`, has what turns them into dashboards and alerts.

| File | What it is |
|---|---|
| [otel-collector.yaml](otel-collector.yaml) | An OpenTelemetry Collector configuration. It receives OTLP from Tiles, offers the metrics to Prometheus on `:8889` and sends the traces to an OTLP backend (`TRACES_ENDPOINT`) |
| [../helm/tiles/files/alerts.yaml](../helm/tiles/files/alerts.yaml) | The Prometheus alert rules, tested by [alerts.test.yaml](alerts.test.yaml) |
| [../helm/tiles/files/grafana-dashboard.json](../helm/tiles/files/grafana-dashboard.json) | A Grafana dashboard: ingest, agents, jobs and the API |

## Turning it on

1. **Run a collector.** For example, use `otel/opentelemetry-collector-contrib` with `otel-collector.yaml`, and set `TRACES_ENDPOINT` to your trace backend (Tempo, Jaeger or a vendor's OTLP endpoint). Have Prometheus scrape the collector's `:8889`.
2. **Point Tiles at it.**
   - With the Helm chart: `--set monitoring.otlpEndpoint=http://otel-collector.monitoring:4318`.
   - Elsewhere: set `OTEL_EXPORTER_OTLP_ENDPOINT` for the API and the scheduled jobs. The standard `OTEL_*` variables apply, for example `OTEL_EXPORTER_OTLP_HEADERS` for a token.
3. **Load the alert rules and the dashboard.**
   - With the Prometheus Operator and Grafana's dashboard sidecar, set `monitoring.prometheusRule.enabled=true` and `monitoring.grafanaDashboard.enabled=true`. Add the labels your installation selects by.
   - Otherwise, load the two files from `deploy/helm/tiles/files/`.

Without `OTEL_EXPORTER_OTLP_ENDPOINT`, Tiles sends nothing and pays nothing for telemetry.

## What Tiles sends

- **Traces.** One span for every API request, except `/health` and `/ready`, carrying its `tiles.request_id`, the same id that the request's log lines carry. Under it, one span for every database statement: the statement with its placeholders, never the values.
- **Metrics**, named as Prometheus shows them. The `job` label is the service, `tiles-api`. The scheduled jobs send traces (as `tiles-jobs`) but no metrics: a job process lives a few seconds, too briefly for counters. Each run is written to the `job_runs` table instead (kept for 30 days), and the API reports every job's last run.

| Metric | Labels | Means |
|---|---|---|
| `tiles_ingest_readings_total` | `source` (edge, import), `stored` (new, not new, refused: sent under a model's derived signal) | Readings received |
| `tiles_ingest_delay_seconds` | | How old a batch's newest reading was when it arrived (histogram) |
| `tiles_agent_buffer_oldest_age_seconds` | `site`, `agent` | **The ingest lag**: the oldest reading still waiting on site |
| `tiles_agent_buffer_queued` | `site`, `agent` | Readings waiting in the agent's buffer |
| `tiles_agent_buffer_dropped` | `site`, `agent` | Readings the agent dropped because its buffer was full |
| `tiles_agent_heartbeat_age_seconds` | `site`, `agent` | Since the agent last called in |
| `tiles_job_last_run_age_seconds` | `command` | Since the job's last run finished |
| `tiles_job_last_failed` | `command` | 1 when its last run failed |
| `tiles_job_last_duration_seconds` | `command` | How long its last run took |
| `tiles_job_failed_runs_last_hour` | `command` | Its failed runs in the last hour |
| `tiles_notifications_pending` | `site` | E-mail and Teams messages waiting to be sent |
| `tiles_notifications_oldest_pending_age_seconds` | `site` | Since the oldest of them was queued |
| `tiles_notifications_given_up_last_hour` | `site` | Messages given up after their retries in the last hour |
| `http_server_duration_milliseconds` | `http_status_code`, `http_target`, … | API requests (histogram) |

Every API process reports the gauges: the agents' from what each last sent in its heartbeat, the jobs' and the outbox's from the database, read at most every 10 seconds. Combine them with `max by (…)`, as the rules and the dashboard do. A job that has never run has no series yet.

## Alerts

| Alert | Fires when | Severity |
|---|---|---|
| TilesIngestLag | An agent's oldest waiting reading is over 15 minutes old, for 5 minutes | warning |
| TilesIngestLagCritical | Over an hour | critical |
| TilesAgentSilent | No heartbeat for 5 minutes, for 5 minutes | warning |
| TilesAgentDropping | An agent dropped readings in the last hour | critical |
| TilesJobFailing | A scheduled job's runs have failed for 10 minutes | warning |
| TilesJobStopped | A job hasn't run for an hour, for 5 minutes | warning |
| TilesNotificationsGivenUp | A notification was given up in the last hour | warning |
| TilesNotificationsStuck | A notification has waited over 30 minutes, for 5 minutes | warning |
| TilesApiErrors | Over 5% of requests failed with a 5xx, for 10 minutes | critical |
| TilesApiSlow | The 95th percentile is over 2 seconds, for 15 minutes | warning |

Each alert's description says where to look first. CI runs `promtool test rules deploy/monitoring/alerts.test.yaml`, and `otelcol validate` on the collector configuration.
