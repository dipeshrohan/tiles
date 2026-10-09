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
- **Metrics**, named as Prometheus shows them. The `job` label is the service: `tiles-api`, or `tiles-jobs` for the scheduled jobs.

| Metric | Labels | Means |
|---|---|---|
| `tiles_ingest_readings_total` | `source` (edge, import), `stored` (new, not new) | Readings received |
| `tiles_ingest_delay_seconds` | | How old a batch's newest reading was when it arrived (histogram) |
| `tiles_agent_buffer_oldest_age_seconds` | `site`, `agent` | **The ingest lag**: the oldest reading still waiting on site |
| `tiles_agent_buffer_queued` | `site`, `agent` | Readings waiting in the agent's buffer |
| `tiles_agent_buffer_dropped` | `site`, `agent` | Readings the agent dropped because its buffer was full |
| `tiles_agent_heartbeat_age_seconds` | `site`, `agent` | Since the agent last called in |
| `tiles_job_runs_total` | `command`, `outcome` (ok, failed) | Scheduled job runs |
| `tiles_job_duration_seconds` | `command`, `outcome` | How long a run took (histogram) |
| `tiles_job_items_total` | `command`, `outcome` | Model bindings and detectors run |
| `tiles_notifications_total` | `outcome` (sent, retry, given up) | E-mail and Teams messages |
| `http_server_duration_milliseconds` | `http_status_code`, `http_target`, … | API requests (histogram) |

Every API process reports the agents' gauges, from what each agent last sent in its heartbeat. Combine them with `max by (site, agent)`, as the rules and the dashboard do.

## Alerts

| Alert | Fires when | Severity |
|---|---|---|
| TilesIngestLag | An agent's oldest waiting reading is over 15 minutes old, for 5 minutes | warning |
| TilesIngestLagCritical | Over an hour | critical |
| TilesAgentSilent | No heartbeat for 5 minutes, for 5 minutes | warning |
| TilesAgentDropping | An agent dropped readings in the last hour | critical |
| TilesJobFailing | A scheduled job failed in the last 30 minutes | warning |
| TilesJobStopped | A job hasn't run for an hour (30 minutes running) | warning |
| TilesNotificationsGivenUp | A notification was given up in the last hour | warning |
| TilesApiErrors | Over 5% of requests failed with a 5xx, for 10 minutes | critical |
| TilesApiSlow | The 95th percentile is over 2 seconds, for 15 minutes | warning |

Each alert's description says where to look first. CI runs `promtool test rules deploy/monitoring/alerts.test.yaml`, and `otelcol validate` on the collector configuration.
