# Hybrid mode: an edge agent on site, Tiles in the cloud (T5.11)

In hybrid mode the plant keeps its data sources where they are. An **edge agent** on a machine in the plant network reads them and sends the readings **out** to Tiles in the cloud: Tiles' managed cloud, or the customer's own cloud account. Nothing outside reaches into the plant: there is no inbound rule, no VPN and no remote access.

This page is for plant IT and OT, and for whoever approves the firewall change.

```
 Plant network (OT)                         │  DMZ / IT network   │        Cloud
                                            │                     │
 OPC UA server ◀─┐                          │                     │
 MQTT broker   ◀─┼── reads ── edge agent ───┼── HTTPS, out only ──┼──▶ Tiles API ── TimescaleDB
 SQL historian ◀─┘    (its buffer on disk)  │   (via your proxy)  │       │
                                            │                     │       └─▶ the identity provider, mail, Teams
```

## What the agent does, and doesn't

- **It reads.** OPC UA, MQTT (Sparkplug B too) and SQL databases, as its configuration lists. It never writes to them: SQL polls are rolled back, and OPC UA and MQTT are only read and subscribed. See the [edge agent](../edge/README.md).
- **It sends** readings in batches, and a heartbeat with its status, to the API: one HTTPS host, port 443.
- **It keeps** what it couldn't send in a bounded buffer on disk, and sends it in order once Tiles can be reached again. By default the buffer holds 20 million readings, about a day at 230 readings a second; raise `buffer_max_samples` for more. When the buffer is full, the oldest readings go, and the agent counts them ([the buffer](../edge/README.md#the-buffer-no-readings-lost)).
- **It listens on nothing,** accepts no commands from outside, and loads no plugins.
- **It authenticates** with its own token, which only a site admin can make, which Tiles stores only as a hash, and which an admin can revoke. It verifies Tiles' certificate on every connection, against the system's CAs and, if you give one, your proxy's.

## Firewall rules

### On site

| From | To | Port | Why |
|---|---|---|---|
| The agent's host | The Tiles API host, for example `api.tiles.example.com` | TCP 443 (HTTPS) | Readings and heartbeats. Allow the host name if your firewall can; its addresses may change |
| The agent's host | Your HTTP proxy, if all traffic leaves through one | The proxy's port | Instead of the rule above: the agent honours `HTTPS_PROXY` and `NO_PROXY`. If the proxy inspects TLS, give the agent its CA (`ca_file`) |
| The agent's host | The OPC UA servers, MQTT brokers and SQL databases it reads | Their ports: OPC UA 4840 (or the server's), MQTT over TLS 8883, PostgreSQL 5432, SQL Server 1433 | Reading the plant's data, inside the plant network |
| The agent's host | Your time servers | UDP 123 (NTP) | Readings carry their time; a drifting clock shifts them. The service waits for the clock to be synchronised once `systemd-time-wait-sync` (or `chrony-wait`) is enabled |
| The agent's host | Your DNS servers | UDP and TCP 53 | Resolving Tiles' host name |

**Inbound to the agent's host: nothing.** No rule is needed from the internet, the cloud or the DMZ. Tiles never opens a connection to the plant.

Where IEC 62443 zones apply, put the agent in the DMZ or a conduit zone between the OT and IT networks. Allow it into the OT zone to read the listed servers only, and out to the API (or proxy) only.

### In the cloud

The API and its scheduled jobs connect out to these hosts only:

| To | Port | When |
|---|---|---|
| The identity provider: the issuer's host (`oidc.issuer`) and its signing keys' host. When the keys are on another host (Google's are), set `oidc.jwksUrl` or add the host to `hosts`: the chart can't discover it | 443 | Always: it checks sign-in tokens against the provider's keys |
| The mail relay (`smtp.host`) | Its port, usually 587 | When notifications by e-mail are on |
| Hosts under `webhook.office.com`, `logic.azure.com` and `api.powerplatform.com` (up to three labels deep: the regional Workflows hosts) | 443 | When a site posts warnings to a Teams channel. Tiles refuses any other host for a webhook |
| `api.anthropic.com` | 443 | When the copilot is on: it sends people's questions, and the data its tools read to answer them |
| The OpenTelemetry Collector (`monitoring.otlpEndpoint`) | Usually 4318 | When monitoring is on |
| The database and Redis | 5432, 6379 | In the cluster, or yours |

**Enforcing it.** With Cilium (and its DNS proxy), the chart turns this list into policy: set `networkPolicy.egressAllowlist.enabled=true`, or `egress_allowlist = { enabled = true }` in Terraform.

- **The API and jobs** may reach only the hosts above, worked out from the settings, plus any you add: `hosts` for an external database's or Redis's host, `namespaces` for in-cluster services, `cidrs` for addresses. A host in the cluster can't be named this way, so the chart allows its namespace instead: write it as `name.namespace.svc` (as in `http://otel-collector.monitoring.svc:4318`), or a bare name for one in Tiles' own namespace; a two-part `name.namespace` would be taken for a host outside.
- **The web app, the database and Redis** may only look up names: they need nothing outside.
- **Where it works:** on AKS, this needs Advanced Container Networking Services' security, which the Azure module turns on (`fqdn_policies`), and the managed environment enables the allowlist by default. Without Cilium, use your firewall's FQDN rules for the same list, for example Azure Firewall in front of the cluster's egress.

## Installing the agent

On a Linux machine in the plant network (Python 3.12 or later, or Docker):

1. **Register it in Tiles**, as a site admin: **Set up a site** → *Connect an edge agent*, or the Settings page. Its token is shown once.
2. **Install it** as a sandboxed systemd service ([`edge/deploy/tiles-edge.service`](../edge/deploy/tiles-edge.service); its comments give the commands):
   - **The service user:** a system user, `tiles-edge`.
   - **The software:** a virtual environment in `/opt/tiles-edge` with the connectors you need.
   - **Its files:** the config file and the token (mode 600, the agent's own) in `/etc/tiles-edge`.
   - **Start it:** `systemctl enable --now tiles-edge`.

   Or run the container image: see the [edge agent's install section](../edge/README.md#install).
3. **Configure** the Tiles URL, the sources and the signals in `/etc/tiles-edge/tiles-edge.toml` ([edge agent](../edge/README.md#set-it-up)). Check it with `tiles-edge check -c /etc/tiles-edge/tiles-edge.toml`.
4. **Watch it arrive:** the wizard and Settings show the agent online, with its connectors and buffer.

### The service's sandbox

The unit runs the agent with no privileges and as little of the system as it needs:

- **Its own user and nothing more:** no capabilities, and no way to gain any.
- **The file system:** read-only, except its buffer (`/var/lib/tiles-edge`). Home directories and devices are hidden, and it gets a private `/tmp`.
- **The kernel:** its tunables, modules, logs and clock are off limits, and only the usual system calls are allowed.
- **The network:** internet and local sockets only, and it can't listen on any port. To also limit where it may connect, uncomment `IPAddressDeny=any` and list the API's (or the proxy's) addresses and the servers it reads in `IPAddressAllow=`.

`systemd-analyze security tiles-edge` rates the unit 1.1 ("OK"): what remains is the network access it needs. CI installs the agent with this unit, checks that score, and runs the agent against a real Tiles API until it reports online.

## When things go wrong

| What happens | What the agent does | What you see |
|---|---|---|
| The internet or Tiles is down | Keeps reading into its buffer, and retries with backoff | The agent shows offline in Tiles. When it is back, the readings arrive in order; the ingest-lag alert fires if it is behind for over 15 minutes |
| The buffer fills up | Drops the oldest readings, and counts them | The agent's *dropped* count in Settings, and the `TilesAgentDropping` alert |
| A source is down | Retries it; the other sources go on | That connector's status (down, with the reason) in the agent's heartbeat |
| The token is revoked | Stops (exit code 3), its buffer kept; the service doesn't restart it | The agent offline in Tiles, and "Tiles rejected this agent" in its log. Register it again, replace the token file and start it |
| The machine restarts | Starts again with the buffer as it was, and its SQL watermarks | Nothing lost |

[Monitoring](../deploy/monitoring/README.md) covers the agents' gauges (heartbeat age, buffer, ingest lag) and their alerts.

## For the security review

- **The design is outbound only:** see the [threat model](security/threat-model.md) (STRIDE for the agent, and the IEC 62443-4-2 gap list).
- **The cloud side's controls:** see the [readiness plan](security/compliance-readiness.md).
- **What the agent sends:** readings (signal, time, value, quality) and its status: version, host name, connector states and buffer counts. Its config file and token never leave the host. The token is sent only in the `Authorization` header, over TLS.
