# Tiles edge agent

A small agent that runs on the plant network and sends data out to Tiles ([ADR 003](../docs/adr/003-edge-agent.md)). It only ever connects out, over TLS, and opens no ports. Plant IT approves one outbound rule: the agent's host to the Tiles API on port 443.

It has one config file, the connection to Tiles and a heartbeat, so Tiles can show whether each agent and each of its connectors is working (T2.01). It reads OPC UA servers (T2.02), MQTT brokers, including Sparkplug B (T2.03), and SQL databases such as MES and quality systems (T2.05).

Readings wait in a buffer on disk until Tiles has them, so a network cut or a restart loses nothing (T2.04). Tiles stores them in TimescaleDB (T2.06), adding each new signal tag to the site's signals.

The core uses only the Python standard library (3.12 or newer), so it installs anywhere Python runs and can also be shipped as a single file. Each connector that needs a protocol library is an extra: `opcua` (`asyncua`), `mqtt` (`paho-mqtt`), `postgresql` (`psycopg`) and `sqlserver` (Microsoft's `mssql-python`). SQLite needs nothing extra. The container image includes them all.

## Set it up

1. **Register the agent in Tiles.** A site admin does this once per agent. The answer holds the agent's token, which is shown only once:

   ```bash
   curl -X POST https://tiles.example.com/sites/<site-id>/agents \
     -H "Authorization: Bearer <your sign-in token>" -H 'content-type: application/json' \
     -d '{"name": "edge-01"}'
   ```

   Save the `token` (it starts with `tla_`) to a file only the agent's user can read, e.g. `/etc/tiles-edge/token` with mode 600.

2. **Write the config file**, `/etc/tiles-edge/tiles-edge.toml`:

   ```toml
   [tiles]
   url = "https://tiles.example.com"
   token_file = "token"             # relative to this file; or set TILES_EDGE_TOKEN
   # ca_file = "ca.pem"             # also trust this CA, e.g. a TLS-inspecting proxy's
   # timeout_seconds = 10

   [agent]
   heartbeat_seconds = 30           # 5 to 3600
   # buffer_path = "/var/lib/tiles-edge/buffer.sqlite"   # the default; relative paths are from this file
   # buffer_max_samples = 20000000  # then the oldest make room
   ```

   The URL must use `https`. Plain `http` is accepted only for `localhost`, for development. Certificates are always verified, against the system's CAs plus `ca_file`. The agent honours `HTTPS_PROXY` and `NO_PROXY`.

3. **Check it:** `tiles-edge check -c /etc/tiles-edge/tiles-edge.toml` validates the file and sends one heartbeat.

4. **Run it** as a service: `tiles-edge run -c /etc/tiles-edge/tiles-edge.toml`. It logs one JSON object per line to stderr and stops cleanly on SIGTERM.

Tiles lists each site's agents at `GET /sites/<site-id>/agents`, with `online`, `offline` (three heartbeats missed) or `never seen`. An admin revokes an agent with `DELETE /sites/<site-id>/agents/<agent-id>`; its token stops working at once.

### Exit codes

| Code | Meaning |
|---|---|
| 0 | stopped cleanly (`run`), or the heartbeat was accepted (`check`) |
| 1 | `check` couldn't reach Tiles |
| 2 | the config file is missing or invalid; the message says what to fix |
| 3 | Tiles rejected the agent (unknown or revoked token): register it again |
| 4 | `check` reached Tiles, but a connector couldn't connect; the output says why |
| 5 | `run` couldn't open its buffer file (locked, the disk full or failing); the message says why. The service retries it |

While running, the agent never gives up on a network problem. It retries with a growing, jittered delay (1 s, 2 s, 4 s … up to the heartbeat interval) and logs each failure.

## The buffer: no readings lost

`tiles-edge run` writes every reading to a SQLite file (`buffer_path`, by default `/var/lib/tiles-edge/buffer.sqlite`) before anything else happens to it. A forwarder sends the oldest readings to Tiles in batches of up to 5,000, in the order they arrived, and deletes a batch only once Tiles has accepted it. So:

- **When the network is cut**, readings pile up on disk and the forwarder retries with a growing delay, up to a minute. When the network is back, the backlog goes out oldest first, then new readings follow.
- **When the agent restarts** (or the host does), the file is still there and sending resumes where it stopped. A batch that was in flight when the agent stopped is sent again; Tiles keeps one reading per signal and time, so nothing is doubled.
- **The file is bounded.** At `buffer_max_samples` readings (20 million by default, a few GB), the oldest make room and are counted as dropped. Size it for the longest outage you want to ride out: one signal a second is 86,400 readings a day.
- **A reading Tiles can never take** (it answers that it is invalid) is set aside and counted as rejected, so it can't hold up the rest. The forwarder halves a refused batch until the bad reading is alone, so the good ones around it still go; a batch Tiles finds too large is split the same way. If Tiles rejects the agent's token, readings are kept until it is registered again.
- **If the disk is full or failing**, readings that can't be written are counted as dropped, and the status says why until writing works again. The connectors carry on.
- **The file is private**: the agent creates it, and its folder if needed, readable by the agent's user only.

Every heartbeat reports the buffer: readings waiting, the oldest one's time, how many were sent, dropped and rejected, and the current problem, if any. Tiles shows it under Settings → Edge agents. `tiles-edge check` doesn't use the buffer.

The agent's user must be able to write the buffer's folder. The container image has `/var/lib/tiles-edge` for it; mount a volume there so the buffer survives upgrades.

## Read an OPC UA server

Each `[[opcua]]` section in the config is one OPC UA server, and each `[[opcua.signals]]` maps one of its nodes to a Tiles signal ID:

```toml
[[opcua]]
name = "press-line"
endpoint = "opc.tcp://10.0.0.5:4840"
security = "Basic256Sha256-SignAndEncrypt"   # the default
certificate = "opcua/agent.der"              # this agent's application certificate…
private_key = "opcua/agent.pem"              # …and its key
server_certificate = "opcua/server.der"      # the server's certificate, pinned
# application_uri = "urn:tiles-edge:press-line"  # default: urn:tiles-edge:<host name>
# username = "tiles"                         # if the server wants a user as well
# password_file = "opcua/password"
# publishing_interval_ms = 1000

[[opcua.signals]]
node = "ns=2;s=Press1.Temperature"
signal = "press1.temperature"
```

**Security.** Sessions are signed and encrypted by default. The other choices are `Basic256Sha256-Sign`, and `Aes128Sha256RsaOaep` or `Aes256Sha256RsaPss` with `-Sign` or `-SignAndEncrypt`. `security = "None"` also needs `allow_unsecured = true`, so nobody turns encryption off by accident.

The server's certificate is pinned. Before each connection the agent compares the certificate the server presents with `server_certificate`, and refuses to connect if they differ. It never simply trusts whatever answers on that address.

**Setting up a connector.** These commands need neither the agent's Tiles token nor any `[[opcua.signals]]` yet, since `browse` is how you find the nodes to map:

1. `tiles-edge opcua cert` creates the agent's certificate and key, and prints the certificate's SHA-256 fingerprint. Running it again keeps the existing pair. Give `agent.der` to the OPC UA server's admin, who adds it to the server's trusted certificates.
2. `tiles-edge opcua server-cert` shows the server's certificate and its fingerprint. Compare the fingerprint with the one the server's admin sees. If they match, pin it with `--save <that fingerprint>`; the command prints the exact line to run. The second run pins the certificate only if the server still presents that same fingerprint. It refuses otherwise, so a certificate swapped in between can't get pinned.
3. `tiles-edge opcua browse` lists the server's nodes with their IDs, to find the ones to map. `--node` starts lower in the tree; `--depth` sets how many levels to show.
4. `tiles-edge check` connects to each server once, then sends a heartbeat that carries those results. Its output gives each connector's result.

With several `[[opcua]]` sections, choose one with `--connector <name>`.

**Running.** Each connector subscribes to its nodes and reports `ok`, `degraded` or `down`, with the reason, in every heartbeat. `degraded` means some nodes couldn't be subscribed; those are retried every 30 seconds, so a tag that appears later is picked up. `down` means none could be, or the server can't be reached. An agent takes at most 100 connectors. Tiles shows this under Settings → Edge agents. If the server goes away, the connector reconnects with a growing delay, up to a minute, and checks the pinned certificate again each time.

Numbers, booleans and text become readings, with the server's source timestamp and quality (good, uncertain or bad). Arrays and structures are skipped and counted.

## Read an MQTT broker

Each `[[mqtt]]` section is one broker, and each `[[mqtt.topics]]` says how to read one topic:

```toml
[[mqtt]]
name = "line-2"
broker = "mqtts://broker.plant.local:8883"   # mqtts:// with the certificate and host name checked
# ca_file = "mqtt/ca.pem"                    # trust this CA too (e.g. the plant's own)
# client_certificate = "mqtt/agent.pem"      # if the broker wants a client certificate…
# client_key = "mqtt/agent.key"
# username = "tiles"                         # …or a user, with its password file
# password_file = "mqtt/password"
# client_id = "tiles-edge-line-2"            # default: 23 letters and digits, fixed per host and connector
# qos = 1                                    # 0 or 1

[[mqtt.topics]]                              # the payload is the value: 21.5, true, "running"
topic = "plant/press1/temperature"
format = "value"
signal = "press1.temperature"

[[mqtt.topics]]                              # a JSON object
topic = "plant/press1/state"
format = "json"
signal = "press1.speed"
value_path = "data.speed"                    # dotted key path; default "value"
time_path = "data.ts"                        # optional: epoch milliseconds or ISO 8601 with a time zone

[[mqtt.topics]]                              # Sparkplug B: many metrics per message
topic = "spBv1.0/plant/+/edge-1/#"           # wildcards allowed here
format = "sparkplug"
metrics = { "Press1/Current" = "press1.current", "Press1/Running" = "press1.running" }
```

`value` and `json` topics carry one signal each, so they can't use wildcards. In Sparkplug topics, `+` must be a whole level and `#` the whole last level. Sparkplug metrics keep their own timestamps.

Metrics sent by alias are matched to their names from the edge node's or device's BIRTH message. The aliases are forgotten on its DEATH, and also whenever the agent reconnects to the broker: a node may have restarted with new aliases in the meantime. Until the next BIRTH, metrics sent by alias are counted in the status, not guessed. Compressed payloads (DEFLATE or GZIP) are unpacked, up to 16 MiB. Scalar metrics are read: integers, floats, booleans, text and date-times. Datasets and templates are skipped. NCMD, DCMD and STATE messages carry no measurements and are ignored.

**Security.** `mqtt://` without TLS needs `allow_unsecured = true` as well, and never takes a password.

**Running.** The connector reports `ok`, `degraded` (the broker refused some subscriptions) or `down` (it can't connect or log in, or its certificate isn't trusted), with the reason. A message that can't be read is skipped and counted, and the status names the last one. If the broker goes away, the connector reconnects with a growing delay, up to a minute. `tiles-edge check` also connects to each broker once.

## Read a SQL database

Each `[[sql]]` section is one database, and each `[[sql.queries]]` is a query the agent runs every `poll_seconds` for rows it hasn't read yet:

```toml
[[sql]]
name = "mes"
engine = "postgresql"                  # postgresql, sqlserver or sqlite
host = "mes-db.plant.local"
# port = 5432                          # default: 5432, or 1433 for sqlserver
database = "mes"
username = "tiles_reader"              # give this user read access only
password_file = "sql/password"
# ca_file = "sql/ca.pem"               # postgresql: trust this CA instead of the system's
# timezone = "Europe/Berlin"           # for date-times stored without a time zone; default UTC
# poll_seconds = 60
# max_rows = 10000                     # per query and poll; more rows follow straight away
# timeout_seconds = 60                 # per query

[[sql.queries]]                        # one column per signal
name = "quality"
query = """
SELECT id, measured_at, temperature, thickness
FROM quality_results
WHERE id > :watermark
ORDER BY id
"""
watermark = "id"                       # increases with every new row
start = 0                              # where the first poll begins
time = "measured_at"                   # each reading's time; default: the watermark column
columns = { temperature = "line1.temperature", thickness = "line1.thickness" }

[[sql.queries]]                        # one reading per row
name = "historian"
query = "SELECT seq, at, tag, value FROM readings WHERE seq > :watermark ORDER BY seq"
watermark = "seq"
start = 0
time = "at"
signal_column = "tag"
value_column = "value"
signals = { "TT-101" = "press1.temperature", "PT-7" = "press1.pressure" }
```

For SQLite, set `path = "/data/quality.sqlite"` instead of the host, database and user settings.

**The watermark.** Each poll binds `:watermark` to the largest watermark value read so far, and that position is saved with the readings in the agent's buffer, in the same transaction. A restart therefore neither skips rows nor reads them twice. Use `>` with a column that only increases: an identity column or insert sequence is best. A time works too. Rows that share one time are never split across two polls: when a batch ends partway through them, they are left for the next poll. A transaction that commits late with an earlier time would be missed, though, so for a time column, poll a little behind, e.g. `AND measured_at < now() - interval '1 minute'`. Write `start` the way the column holds it: a number, or a TOML date-time (`start = 2026-01-01T00:00:00`). To read a range again, change `start`; the agent then begins there once more.

A query must end with `ORDER BY` the watermark column, ascending, before any other column (`ORDER BY measured_at, id` is fine). A poll that still gets rows out of order stops with an error instead of skipping rows. `timeout_seconds` limits each query on every engine.

**Read only.** A query must be a single `SELECT` (or `WITH … SELECT`). Every poll runs in a transaction that is rolled back, PostgreSQL sessions are read-only, and SQLite files are opened read-only. Still, give the agent a user that can only read.

**MES events.** Downtime and scrap reach Tiles the same way: as readings whose value is the code (T3.10). One reading per stop, on a signal per machine, for example:

```toml
[[sql.queries]]
name = "downtime"
query = "SELECT id, stopped_at, machine, reason_code FROM downtime WHERE id > :watermark ORDER BY id"
watermark = "id"
start = 0
time = "stopped_at"
signal_column = "machine"
value_column = "reason_code"
signals = { "DC-01" = "mes.dc1.downtime", "DC-02" = "mes.dc2.downtime" }
```

Then, on the Signals page, mark each such signal as a downtime (or scrap) event stream and name its asset, and give the machine's detectors the same asset. The Warning performance page matches their warnings to the events.

**Values.** Numbers, booleans and text become readings; date-times become text. NULL is skipped. Values that can't be readings (such as binary data or infinite numbers) are skipped and counted. Rows whose `signal_column` value isn't in `signals` are counted as unmapped. Times stored without a time zone are taken to be in `timezone`.

**Security.** PostgreSQL and SQL Server connections use TLS, and the server's certificate must chain to a trusted CA and name the host. `tls = false` needs `allow_unsecured = true` as well. PostgreSQL trusts the system's CAs, or `ca_file` instead. The SQL Server driver trusts the system's CAs and checks `host` against the certificate's DNS names, so give the server's name, not its address. If the database's certificate comes from the plant's own CA, add that CA to the system's trusted certificates. In the container, mount a bundle of the public CAs plus the plant's (`cat /etc/ssl/certs/ca-certificates.crt plant-ca.pem > bundle.pem`) and set `SSL_CERT_FILE` to it; the connection to Tiles uses the same bundle.

**Running.** The connector reports `ok`, `degraded` (some queries fail; the status says which and why) or `down` (it can't connect, or no query works). If the database goes away, the connector reconnects with a growing delay, up to a minute. `tiles-edge check` connects, runs each query once and checks its columns, without reading any rows.

## Install

- **As a systemd service** (recommended on a Linux host): [`deploy/tiles-edge.service`](deploy/tiles-edge.service) runs the agent sandboxed: no privileges, a read-only system, nothing listening. Its comments give the install commands; [hybrid mode](../docs/hybrid.md) explains the firewall rules.
- **With pip:** `pip install "./edge[opcua,mqtt,postgresql,sqlserver]"` installs the `tiles-edge` command with every connector. Leave out the extras you don't need. The SQL Server driver also needs `libltdl7`, `libkrb5-3` and `libgssapi-krb5-2` (Debian and Ubuntu package names).
- **As one file** (core only, no connectors): `python -m zipapp edge/src -m tiles_edge.cli:entry -p "/usr/bin/env python3" -o tiles-edge.pyz` builds `tiles-edge.pyz`, which runs with any Python 3.12+: `./tiles-edge.pyz check -c tiles-edge.toml`.
- **As a container** (with every connector): `docker build -t tiles-edge edge`. The image runs as UID 10001, so make the token file that user's before mounting the config folder: `sudo chown 10001 /etc/tiles-edge/token` (keep mode 600), then
  `docker run -d --restart unless-stopped -v /etc/tiles-edge:/etc/tiles-edge:ro -v tiles-edge-buffer:/var/lib/tiles-edge tiles-edge`.
  Or leave the file alone and pass the token as a secret environment variable instead: `--env-file` with `TILES_EDGE_TOKEN=tla_…`, and no `token_file` in the config.

## Develop

From `edge/`: `uv sync --all-extras`, then `uv run pytest -W error`, `uv run mypy` (strict), `uv run ruff check .` and `uv run ruff format .`. The tests run against a fake Tiles server, including over TLS with a throwaway certificate (they need `openssl`). The OPC UA tests run a real `asyncua` server, with its own certificates and trust list. The MQTT tests run a real broker (`amqtt`) over TLS, and the Sparkplug decoder is tested against payloads built byte by byte. The SQL tests use SQLite, and real PostgreSQL and SQL Server databases in Docker with TLS certificates from a test CA. Without Docker those are skipped, unless `TILES_EDGE_TEST_DOCKER=1` is set (as in CI), which makes them required. The buffer tests cut Tiles off for an hour's worth of readings, restart the agent in the middle, and check that every reading arrives in order.
