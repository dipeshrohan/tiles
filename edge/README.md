# Tiles edge agent

A small agent that runs on the plant network and sends data out to Tiles ([ADR 003](../docs/adr/003-edge-agent.md)). It only ever connects out, over TLS, and opens no ports. Plant IT approves one outbound rule: the agent's host to the Tiles API on port 443.

It has one config file, the connection to Tiles and a heartbeat, so Tiles can show whether each agent and each of its connectors is working (T2.01). It reads OPC UA servers (T2.02) and MQTT brokers, including Sparkplug B (T2.03); a SQL connector (T2.05) comes next.

Readings are held in memory for now. Sending them to Tiles needs the disk buffer (T2.04) and the ingest endpoint (T2.06), which come next.

The core uses only the Python standard library (3.12 or newer), so it installs anywhere Python runs and can also be shipped as a single file. Each connector that needs a protocol library is an extra: `opcua` (`asyncua`) and `mqtt` (`paho-mqtt`). The container image includes both.

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

While running, the agent never gives up on a network problem. It retries with a growing, jittered delay (1 s, 2 s, 4 s … up to the heartbeat interval) and logs each failure.

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

## Install

- **With pip:** `pip install "./edge[opcua,mqtt]"` installs the `tiles-edge` command with both connectors. Leave out the extras you don't need.
- **As one file** (core only, no connectors): `python -m zipapp edge/src -m tiles_edge.cli:entry -p "/usr/bin/env python3" -o tiles-edge.pyz` builds `tiles-edge.pyz`, which runs with any Python 3.12+: `./tiles-edge.pyz check -c tiles-edge.toml`.
- **As a container** (with OPC UA and MQTT): `docker build -t tiles-edge edge`. The image runs as UID 10001, so make the token file that user's before mounting the config folder: `sudo chown 10001 /etc/tiles-edge/token` (keep mode 600), then
  `docker run -d --restart unless-stopped -v /etc/tiles-edge:/etc/tiles-edge:ro tiles-edge`.
  Or leave the file alone and pass the token as a secret environment variable instead: `--env-file` with `TILES_EDGE_TOKEN=tla_…`, and no `token_file` in the config.

## Develop

From `edge/`: `uv sync --all-extras`, then `uv run pytest -W error`, `uv run mypy` (strict), `uv run ruff check .` and `uv run ruff format .`. The tests run against a fake Tiles server, including over TLS with a throwaway certificate (they need `openssl`). The OPC UA tests run a real `asyncua` server, with its own certificates and trust list. The MQTT tests run a real broker (`amqtt`) over TLS, and the Sparkplug decoder is tested against payloads built byte by byte.
