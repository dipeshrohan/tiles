# Tiles edge agent

A small agent that runs on the plant network and sends data out to Tiles ([ADR 003](../docs/adr/003-edge-agent.md)). It only ever connects out, over TLS, and opens no ports. Plant IT approves one outbound rule: the agent's host to the Tiles API on port 443.

This is the skeleton (T2.01). It has the config file, the connection to Tiles and a heartbeat, so Tiles can show whether each agent is online. The OPC UA, MQTT and SQL connectors (T2.02, T2.03, T2.05) and the disk buffer (T2.04) build on it.

It uses only the Python standard library (3.12 or newer), so it installs anywhere Python runs and can also be shipped as a single file.

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

While running, the agent never gives up on a network problem. It retries with a growing, jittered delay (1 s, 2 s, 4 s … up to the heartbeat interval) and logs each failure.

## Install

- **With pip:** `pip install ./edge` installs the `tiles-edge` command.
- **As one file:** `python -m zipapp edge/src -m tiles_edge.cli:entry -p "/usr/bin/env python3" -o tiles-edge.pyz` builds `tiles-edge.pyz`, which runs with any Python 3.12+: `./tiles-edge.pyz check -c tiles-edge.toml`.
- **As a container:** `docker build -t tiles-edge edge`. The image runs as UID 10001, so make the token file that user's before mounting the config folder: `sudo chown 10001 /etc/tiles-edge/token` (keep mode 600), then
  `docker run -d --restart unless-stopped -v /etc/tiles-edge:/etc/tiles-edge:ro tiles-edge`.
  Or leave the file alone and pass the token as a secret environment variable instead: `--env-file` with `TILES_EDGE_TOKEN=tla_…`, and no `token_file` in the config.

## Develop

From `edge/`: `uv sync`, then `uv run pytest -W error`, `uv run mypy` (strict), `uv run ruff check .` and `uv run ruff format .`. The tests run against a fake Tiles server, including over TLS with a throwaway certificate (they need `openssl`).
