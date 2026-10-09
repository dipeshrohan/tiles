# Tiles administrator guide

This guide is for the people who install, configure and run Tiles for a site. It covers the architecture, installing, sign-in, people and roles, edge agents, notifications, the copilot, the scheduled jobs, security operations and troubleshooting.

It links to the detailed references rather than repeating them:

- [API settings and endpoints](../../api/README.md)
- [Helm chart](../../deploy/helm/tiles/README.md)
- [Edge agent](../../edge/README.md)
- [Secrets, encryption and key rotation](../runbooks/secrets-and-encryption.md)
- [Backups and restore](../runbooks/backups.md)
- [Threat model](../security/threat-model.md)
- [Load test and sizing](../load-test.md)
- [Releasing, upgrades and rollbacks](../releasing.md)

## 1. Architecture at a glance

```
 Plant network              │  Tiles (cloud or your own cluster)                    │  Third parties
                            │                                                       │
 OPC UA / MQTT / SQL ──┐    │   ┌──────────┐      ┌───────────────────────────┐     │
                       ▼    │   │ Web app  │      │ PostgreSQL + TimescaleDB  │     │
 Edge agent ── HTTPS out ───┼─▶ │ (static) │      │ (row security per site)   │     │
 (buffer on disk)           │   └──────────┘      └─────────────▲─────────────┘     │
                            │   ┌──────────┐                    │                   │
 Browsers ─────── HTTPS ────┼─▶ │ Tiles API│ ───────────────────┤                   │
                            │   │ (FastAPI)│ ──▶ Redis          │                   │
                            │   └────┬─────┘                    │                   │
                            │        │      Scheduled jobs (cron) ──────────────────┼─▶ SMTP, Teams webhooks
                            │        └──────────────────────────────────────────────┼─▶ Identity provider (OIDC)
                            │                       copilot ────────────────────────┼─▶ Anthropic API
```

| Part | What it does |
|---|---|
| Web app | Static files that run in the browser. It reads the API's address from the server and signs people in with your identity provider. |
| API | A FastAPI service on port 8000. It checks sign-in tokens, enforces roles, writes the audit log and stores readings. |
| Database | PostgreSQL 17 with the TimescaleDB extension. It holds everything: the ontology, signals and readings, warnings, runs, conversations, the audit log and sealed credentials. |
| Redis | A dependency the API checks on `/ready`. |
| Scheduled jobs | Commands from the API package, run by cron or Kubernetes CronJobs. They check data quality, run models and detectors, send notifications and run sweeps. |
| Edge agents | Small agents on the plant network. They read OPC UA servers, MQTT brokers and SQL databases, buffer readings on disk and send them to the API. They only connect out and open no ports. |
| Identity provider | Your OpenID Connect provider. Tiles stores no passwords. |

The [threat model](../security/threat-model.md) describes the trust boundaries in detail.

## 2. Installing

### Evaluation with Docker Compose

Use Docker Compose to try Tiles on one machine. From the repository root:

1. Run `docker compose up --build --wait`.
2. Open http://localhost:5173. The API is at http://localhost:8000 (`/health`, `/ready`, `/docs`).
3. Sign in through Keycloak at http://localhost:8080 with one of the realm's users: `demo`/`demo` (engineer), `admin`/`admin` (admin) or `viewer`/`viewer` (viewer).

Compose starts these services:

| Service | Address | Notes |
|---|---|---|
| `web` | http://localhost:5173 | The app |
| `api` | http://localhost:8000 | Runs with `TILES_ENV=development`, so the dev identity is on |
| `db` | localhost:5432 | PostgreSQL 17 with TimescaleDB |
| `redis` | localhost:6379 | |
| `migrate` | | Applies migrations and creates the demo site (`tiles-seed`), then exits |
| `keycloak` | http://localhost:8080 | The `tiles` realm from `keycloak/tiles-realm.json` |

Ports bind to 127.0.0.1 only. The passwords are for local use only. To change the database password, set `TILES_DB_PASSWORD` in your shell or a root `.env` file, then run `docker compose down -v` (this deletes the data). To try the copilot, set `TILES_ANTHROPIC_API_KEY` and `TILES_COPILOT_MODEL` the same way. Compose doesn't run the scheduled jobs; run them by hand with `docker compose exec api <command>` if you need them.

Do not use Compose for production.

### Production with the Helm chart

The Helm chart installs the API, the web app, the scheduled jobs as CronJobs and, for evaluation only, a database and Redis. Follow the [chart README](../../deploy/helm/tiles/README.md) for the commands. Before you install, decide the following.

| Decision | What to do |
|---|---|
| Addresses | Set `url` (where people open the app) and `apiUrl` (where browsers reach the API). With the ingress, these must be two different host names. |
| Image versions | Pin a release (`1.2.3`) or a commit (`sha-<full commit>`) in `images.api.tag` and `images.web.tag`, with `pullPolicy: IfNotPresent`. The default `main` follows the main branch. |
| Database | Turn off the bundled database (`database.bundled=false`). Use a managed PostgreSQL 17 with TimescaleDB and point-in-time recovery. The login must be able to create a role, because a migration adds `tiles_app` for row security. If it can't, see [Row security](#row-security). |
| Redis | Turn off the bundled Redis (`redis.bundled=false`) and give `tiles_redis_url` in your Secret. |
| Secrets | Create a Kubernetes Secret from your secret manager and set `secrets.existingSecret`. If it has `tiles_data_keys`, set `secrets.generateDataKey=false`. See [Secrets as files](#secrets-as-files). |
| Ingress and TLS | Enable the ingress (`ingress.enabled`, `ingress.className`, `ingress.tlsSecret`). Keep the request body limit at 16 MB or more: agents post up to 10,000 readings at once. |
| Sign-in | Set `oidc.issuer` and the other `oidc.*` values (section 3). Production refuses every request without it. |
| Capacity | Set `api.replicas`, `api.workers` and `api.dbPoolMax`. The database sees up to replicas × workers × (dbPoolMax + 4) connections, so keep its `max_connections` above that, plus the jobs. See [Capacity](#capacity). |

`env: production` is the chart's default. In production the API refuses requests without a token, and it won't start without data keys. `helm install` refuses settings that can't work, such as production without an issuer, before it creates anything.

The API applies database migrations as each pod starts, one pod at a time (`api.migrateOnStart`). Set `api.seedDemo=true` only if you want the demo organisation and site.

After you change the Secret, change `secrets.revision` (for example to today's date) in the same `helm upgrade`. The API reads its settings once, when it starts. The jobs read them on every run.

Settings the chart doesn't cover go in `extraEnv`:

```yaml
extraEnv:
  - name: TILES_DB_WAIT_SECONDS
    value: '10'
```

The full list of settings is in the [API README](../../api/README.md#configuration).

### With Terraform

[deploy/terraform](../../deploy/terraform/README.md) installs the same chart:

- **`customer-hosted`:** on a cluster you run. The [install guide](../install.md) walks through it.
- **`managed-azure`:** Tiles' managed cloud, in two stages: the AKS cluster and the storage for the database's backups, then Tiles on it.

The Terraform module makes the Secret from sensitive variables, generating a data key if you give none. Those values then sit in Terraform's state, so keep the state in an encrypted backend. To keep secrets out of Terraform, give your own Secret instead (`existing_secret`). Its namespace enforces the restricted Pod Security Standard.

## 3. Sign-in

Tiles uses OpenID Connect for sign-in. The browser signs in with the Authorization Code flow and PKCE as a public client. The API checks each access token's signature against the provider's published keys, and checks its issuer, audience and expiry. Keycloak is used in development. In production, use your own provider (for example Entra ID).

### Configure the identity provider

1. Create a public client for the browser, `tiles-web` by default, with PKCE (S256).
2. Add the app's address (`url`) as a valid redirect URI and as a web origin. The browser returns to the page it signed in from, so allow every path, for example `https://tiles.example.com/*`.
3. Make access tokens carry the API's audience, `tiles-api` by default. In Keycloak, add an audience mapper to the client.
4. Make sure access tokens carry an `email` claim. A token without a usable email is refused. The display name comes from `name`, then `preferred_username`.
5. Create the roles `tiles-viewer`, `tiles-engineer` and `tiles-admin`, and assign them to people. Tiles reads them from Keycloak realm roles (`realm_access.roles`) or from a top-level `roles` claim. Only these names count; a bare `admin` role means nothing to Tiles.
6. If you have more than one organisation, add a `tiles_org` claim with the organisation's slug: lowercase letters, digits and hyphens, up to 63 characters. Without it, users join `TILES_OIDC_DEFAULT_ORG`.

**An organisation's own provider.** Besides the deployment's provider above, each organisation can sign its people in with its own, for example its Microsoft Entra ID tenant. That provider's tokens reach that organisation only. Its admins can also provision people from their directory with SCIM. See [Entra ID and SCIM](entra-id.md).

### Configure Tiles

| Setting | Helm value | Default | Meaning |
|---|---|---|---|
| `TILES_OIDC_ISSUER` | `oidc.issuer` | unset (sign-in off) | The issuer. It must equal the tokens' `iss` claim exactly: the address browsers use. |
| `TILES_OIDC_JWKS_URL` | `oidc.jwksUrl` | discovered from the issuer | Where the API fetches signing keys. Set it only if the API reaches the provider at another address. |
| `TILES_OIDC_AUDIENCE` | `oidc.audience` | `tiles-api` | The audience tokens must carry. |
| `TILES_OIDC_CLIENT_ID` | `oidc.clientId` | `tiles-web` | The client the browser signs in as. |
| `TILES_OIDC_DEFAULT_ORG` | `oidc.defaultOrg` | `demo` | The organisation for tokens without a `tiles_org` claim. |
| `TILES_CORS_ORIGINS` | set from `url` | `["http://localhost:5173"]` | Browser origins allowed to call the API. |

`GET /auth/config` tells the browser the issuer and client ID. `GET /me` tells you who the API thinks you are.

The provider's signing-key rotation needs nothing from you. The API fetches the published keys as tokens name them.

### The dev identity

Outside production (`TILES_ENV` is `development` or `test`), a request without a token acts as `TILES_DEV_USER_EMAIL` (default `demo@example.com`), or as the email in an `X-Tiles-User` header. This lets tests and `curl` work without sign-in. A token that is present is always checked. In production, a request without a token gets 401. Never run a reachable instance outside production mode.

## 4. Organisations, sites and people

### How users and memberships are created

- **Organisations** are created on the first sign-in that names them, from the `tiles_org` claim or `TILES_OIDC_DEFAULT_ORG`.
- **Users** are created on first sign-in and are known by their issuer and subject. An identity belongs to one organisation. A user who later signs in with another organisation's claim gets 403.
- **Or users are provisioned** by the organisation's directory through SCIM, before their first sign-in, and deactivated or deleted there. A deactivated user gets 403 ([Entra ID and SCIM](entra-id.md)).
- **Memberships** are created on a user's first visit to a site. They get the highest role their token grants: `tiles-admin` gives admin, `tiles-engineer` gives engineer, anything else gives viewer.
- **After that, the stored membership counts.** Changing someone's roles at the identity provider doesn't change their role on a site they have already visited.
- Users see only their own organisation's sites.

**Creating a site.** Organisation admins, and anyone whose sign-in grants `tiles-admin`, create sites on the **Set up a site** page, or with `POST /sites`. The creator becomes the site's admin, and the creation is the first entry in its audit log. The page then walks the site through its setup, and shows how far it is:

1. its plant outlined in the ontology;
2. an edge agent registered and calling in;
3. tags mapped to Signal nodes;
4. the first dashboard, a machine's Plant page with live readings.

`GET /sites/{id}/onboarding` gives the same progress.

**Organisation admins** are still made in the database: there is no page for it yet. `tiles-seed` creates the demo organisation (`demo`) and site (`plant-1`). As the migration login:

```sql
-- Make a user an organisation admin.
UPDATE users SET org_admin = true WHERE email = 'jane@example.com' AND org_id = (SELECT id FROM orgs WHERE slug = 'acme');
```

This SQL change is not in the audit log, so record it yourself.

### Roles

| Role | Can |
|---|---|
| Viewer | Read the site. Discard their own staged ontology changes. Use the copilot. |
| Engineer | Also stage, commit and revert ontology changes, review change requests, and use every other write action (detectors, model bindings, imports, signals, warnings, runs and so on). |
| Admin | Also change other members' roles, require a review for every ontology change, register and revoke edge agents, set the Teams channel, and read the audit log, the notification outbox and copilot usage. |
| Organisation admin | Admin on every site of the organisation (`users.org_admin`). |

### Change a member's role

There is no page for this yet. Use the API as a site admin:

1. List the members: `GET /sites/{site_id}/members`. It lists everyone who has signed in to the site; organisation admins are admins of every site whether listed or not.
2. Set the role: `PUT /sites/{site_id}/members/{user_id}` with `{"role": "engineer"}` (`viewer`, `engineer` or `admin`).

You can't change your own role; ask another admin. The change is audited as `member.role`. A demoted engineer can still discard their own staged changes.

### The audit log

Every write is recorded in the audit log in the same transaction as the change. Each entry has the actor, the time, the action, the entity, the before and after values, and the request ID. The table refuses updates and deletes. Failed writes and no-ops leave no entry. The [API README](../../api/README.md#audit-log) lists every action.

Site admins see the latest 50 entries under **Settings → Audit log**. To export the full log, page through `GET /sites/{site_id}/audit?limit=500&offset=0` (newest first, up to 500 per page), increasing `offset` until a page comes back empty. For example:

```bash
offset=0
while :; do
  page=$(curl -s -H "Authorization: Bearer $TOKEN" \
    "https://api.tiles.example.com/sites/$SITE/audit?limit=500&offset=$offset")
  [ "$(echo "$page" | jq length)" -eq 0 ] && break
  echo "$page" | jq -c '.[]' >> audit.jsonl
  offset=$((offset + 500))
done
```

The request ID in each entry matches the `request_id` in the API's logs.

## 5. Edge agents

An edge agent runs on the plant network, reads OPC UA servers, MQTT brokers (including Sparkplug B) and SQL databases, and sends readings to the API. It buffers readings on disk, so a network cut or a restart loses nothing. Each agent authenticates with its own token, not a person's sign-in.

### Register an agent

1. As a site admin, open **Settings → Edge agents**.
2. Enter a name (letters, digits, dot, dash or underscore, up to 63 characters; unique per site) and select **Register agent**.
3. Copy the token (it starts with `tla_`) now. Tiles stores only its hash and never shows it again. The page also shows a starting config file.

You can also register with `POST /sites/{site_id}/agents` and `{"name": "edge-01"}`.

### Install and configure it on site

Follow the [edge agent README](../../edge/README.md). In short:

1. Install the agent with pip, as a single zipapp file (core only) or as the container image.
2. Save the token to a file only the agent's user can read, for example `/etc/tiles-edge/token` with mode 600. The container runs as UID 10001.
3. Write `/etc/tiles-edge/tiles-edge.toml`. Set `[tiles] url` to the API's address (`apiUrl`), which must use `https`.
4. Add a section for each connector: `[[opcua]]`, `[[mqtt]]` or `[[sql]]`.
5. Run `tiles-edge check -c /etc/tiles-edge/tiles-edge.toml`. It validates the config, tests each connector and sends one heartbeat.
6. Run `tiles-edge run -c /etc/tiles-edge/tiles-edge.toml` as a service.

Put the buffer (`/var/lib/tiles-edge/buffer.sqlite` by default) and the token file on an encrypted disk. Size `buffer_max_samples` for the longest outage you want to survive.

### Connectors

| Connector | Reads | Notes |
|---|---|---|
| OPC UA | Subscribed nodes | Signed and encrypted by default. The server's certificate is always pinned. `tiles-edge opcua cert`, `server-cert` and `browse` help set it up. |
| MQTT | Topics, as plain values, JSON or Sparkplug B | TLS with the certificate and host name checked. |
| SQL | Polled queries from a saved watermark | SQLite, PostgreSQL and SQL Server. Read-only: every poll is rolled back. Give the agent a database user that can only read. |

Each connector reports `ok`, `degraded` or `down` with a reason in every heartbeat.

### Agent health

**Settings → Edge agents** lists each agent with its status, host, version, connectors and buffer:

| Status | Meaning |
|---|---|
| `online` | A heartbeat arrived within three heartbeat intervals. |
| `offline` | Three heartbeats have been missed. |
| `never seen` | Registered, but no heartbeat has arrived. |

The buffer summary shows readings waiting, the oldest one's time, and how many were sent, dropped and rejected.

### Revoke an agent

As a site admin, revoke the agent in **Settings → Edge agents**, or call `DELETE /sites/{site_id}/agents/{agent_id}`. Its token stops working at once and the name becomes free. The agent keeps its buffered readings until it is registered again.

To rotate an agent's token, register a new agent, put its token on the host, restart the agent, check its heartbeat, then revoke the old one.

### Firewall rules

The agent only connects out. Plant IT needs to approve:

- **Outbound** from the agent's host to the Tiles API host on TCP 443 (HTTPS). The agent honours `HTTPS_PROXY` and `NO_PROXY`. If a proxy inspects TLS, give the agent its CA with `ca_file`.
- **Inside the plant network**, from the agent's host to the servers it reads: the OPC UA endpoints, MQTT brokers and SQL databases you configure.
- **No inbound rules.** Tiles never connects to the agent. Commands, when there are any, travel back in the heartbeat answer.

[Hybrid mode](../hybrid.md) has the full tables for plant IT: both sides, proxies, time sync, the cloud's egress allowlist and the agent's sandboxed service.

## 6. Notifications

Tiles announces two things:

- **A new warning:** by email to the site's engineers and admins who asked for every new warning, and to the site's Teams channel if one is set. Only warnings found within an hour of when the detector could have found them are announced, so a detector catching up on old history doesn't send alarms.
- **A warning assigned to you by someone else:** by email to you. This is on until you turn it off.

### Email (SMTP)

| Setting | Helm value | Default | Meaning |
|---|---|---|---|
| `TILES_SMTP_HOST` | `smtp.host` | unset (no email) | The mail server |
| `TILES_SMTP_PORT` | `smtp.port` | `587` | |
| `TILES_SMTP_STARTTLS` | `smtp.starttls` | `true` | Upgrade to TLS before logging in |
| `TILES_SMTP_USER` | `smtp.user` | unset | SMTP login, if needed |
| `TILES_SMTP_PASSWORD` | `tiles_smtp_password` in the Secret | unset | SMTP password |
| `TILES_SMTP_FROM` | `smtp.from` | `Tiles <tiles@example.com>` | The sender |
| `TILES_APP_URL` | set from `url` | `http://localhost:5173` | The app's address, for links in messages |

### The Teams channel

1. In Microsoft Teams, create a Workflows webhook (or an incoming webhook) for the channel.
2. As a site admin, open **Settings → Notifications**, paste the URL under **Microsoft Teams channel**, choose whether to **Post every new warning there**, and select **Save**.

Only `https` URLs on Microsoft's webhook hosts are accepted: `*.webhook.office.com`, `*.logic.azure.com` and `*.api.powerplatform.com`. Redirects are not followed. Anyone with the URL can post to the channel, so Tiles seals it with a data key, never shows it again, and audits only its host. To change it, create a new webhook, set it, then delete the old one in Teams.

### Preferences

Each engineer or admin chooses in **Settings → Notifications**:

- **Every new warning on this site** (`on_raised`): off until they turn it on.
- **A warning someone assigns to me** (`on_assigned`): on by default.

Someone demoted to viewer, or removed from the site, gets no more messages.

### The outbox and retries

Messages wait in an outbox, queued in the same transaction as what they announce. The `tiles-notify` job sends the due ones.

- Each message is sent at least once. A message sent just before the job dies is sent again.
- A failure is retried after 1, 2, 4, 8 and 16 minutes, then given up.
- A message is given up at once when retrying can't help, for example when the Teams channel was removed.
- A Teams message whose URL can't be opened (its data key isn't set) is held, not given up, and goes once the key is back.
- If `TILES_SMTP_HOST` is unset, emails fail with "Email is not set up" and are eventually given up.

Site admins see the messages, and why pending ones failed, in **Settings → Notifications**, or with `GET /sites/{site_id}/notifications?state=failed`.

## 7. The copilot

The copilot answers questions about a site using Claude through the Anthropic API, with tools that read the site's own data as the person who asked. Its tools only read, except that engineers and admins can have it propose an ontology change. A proposal is a change request that another engineer must approve; the copilot never commits anything itself.

### Enable it

The copilot is off until both settings are set:

| Setting | Helm | Meaning |
|---|---|---|
| `TILES_ANTHROPIC_API_KEY` | `tiles_anthropic_api_key` in the Secret | Your Anthropic API key. Keep it in a secret store. |
| `TILES_COPILOT_MODEL` | `copilot.model` | The model ID to answer with. Choose a current one from Anthropic's model documentation. |

Restart the API after setting them (with Helm, change `secrets.revision`). `GET /sites/{site_id}/copilot` answers `{"configured": true}` once it is on. While it is off, asking returns 503 and the Copilot page falls back to its built-in skills.

The API must be able to reach the Anthropic API over HTTPS.

### Cost controls

Tokens are counted as "billed tokens", weighted by price: an output token counts five, a cache write one and a quarter, and a cache read a tenth. The prompt is cached, so follow-up calls mostly read from the cache.

| Setting | Default | Meaning |
|---|---|---|
| `TILES_COPILOT_MAX_TOKENS` | `2048` | The most the model writes per call |
| `TILES_COPILOT_MAX_ROUNDS` | `8` | The most model calls (tool rounds) per question |
| `TILES_COPILOT_QUESTION_TOKENS` | `200000` | Billed tokens one question may use; the model isn't called again past it |
| `TILES_COPILOT_ORG_DAILY_TOKENS` (Helm `copilot.orgDailyTokens`) | `5000000` | Billed tokens an organisation may use per UTC day |
| `TILES_COPILOT_ORG_QUESTIONS_PER_MINUTE` | `30` | Questions an organisation may ask per minute |
| `TILES_COPILOT_USER_QUESTIONS_PER_MINUTE` | `6` | Questions one person may ask per minute |

Set any limit to `0` to turn it off. A question over a rate limit or the daily budget is refused with 429 and `Retry-After`; the daily budget resets at midnight UTC. A question that reaches its own budget, or the organisation's budget while it is answered, stops with an "over budget" error. Both are checked before each model call, so the last call can go a little past them.

Set the limits other than `orgDailyTokens` through `extraEnv` in Helm.

### The usage dashboard

Site admins see **Settings → Copilot usage** (`GET /sites/{site_id}/copilot/usage`). For each UTC day it shows:

- questions and how they ended, and answers the grounding check flagged;
- tokens, and the share of input read from the cache;
- the median and 95th percentile time to the first text and to the whole answer.

It also shows usage by person, the limits, and how much of today's organisation budget is used. Admins can read the answers people rated with `GET /sites/{site_id}/copilot/feedback`. Conversations themselves are private to their user.

To rotate the API key, create a new key with Anthropic, update the secret, restart the API, then revoke the old key.

## 8. Scheduled jobs

Each job is a command from the API package. It runs over every site, then exits. With Helm, each is a CronJob; schedules are in UTC. A run that overlaps the next makes the next one wait (`concurrencyPolicy: Forbid`), and a run is stopped after 30 minutes (`jobDefaults.activeDeadlineSeconds`).

| Command | What it does | Helm job | Default schedule |
|---|---|---|---|
| `tiles-check-quality` | Checks every signal for gaps, stuck values, out-of-range values, flagged readings, unit mismatches and silent edge tags over the 24 hours before each signal's latest reading (`--site`, `--hours`) | `checkQuality` | every 15 minutes |
| `tiles-run-models` | Runs every enabled model binding on its new readings and writes the derived signals (`--site`) | `runModels` | every 5 minutes |
| `tiles-detect` | Feeds every enabled detector its new readings and raises or ends warnings (`--site`) | `detect` | every 5 minutes |
| `tiles-notify` | Sends due notifications by email and to Teams | `notify` | every minute |
| `tiles-run-sweeps` | Runs sweeps left queued, or left running by a worker with no heartbeat for 2 minutes | `runSweeps` | every 2 minutes |

To run a job now with Helm: `kubectl create job check-now --from=cronjob/tiles-check-quality`. To turn one off, set `jobs.<name>.enabled=false`.

Other commands you run by hand:

| Command | What it does |
|---|---|
| `tiles-migrate upgrade` / `current` / `history` / `downgrade <rev>` | Applies or inspects database migrations. The API applies them on start with Helm. |
| `tiles-seed` | Creates the demo organisation and site if they don't exist. |
| `tiles-rotate-keys` | Makes a new data key (`--new-key <id>`) or re-seals stored credentials with the first key. |
| `tiles-backtest` | Replays a signal's history with detector settings and scores the warnings against a CSV of events. |
| `tiles-loadtest` | Runs the load test (see [load-test.md](../load-test.md)). |

### When a job fails

- Each binding, detector, site or message is handled in its own transaction. One failing doesn't undo or stop the others.
- The command prints a line for each item, with failures on stderr, and exits with code 1 if any item failed. Each run is recorded in the `job_runs` table, and with monitoring on, alerts fire when a job keeps failing or stops running ([monitoring](../../deploy/monitoring/README.md)).
- Model bindings and detectors save where they got to (`done_until`, the detector's state), so the next successful run catches up. Nothing is lost by a missed run.
- `tiles-notify` keeps failed messages for retry (see [The outbox and retries](#the-outbox-and-retries)) and tells you to read `GET /sites/{id}/notifications` for why.
- A binding's or detector's last error is shown with it in the app (`GET /sites/{id}/model-bindings`, `GET /sites/{id}/detectors`).
- Detectors and bindings hold back readings newer than `lateness_seconds` (default 5 minutes) for late data. Readings that arrive later than that, for a time a detector has passed, are not fed to it. Set the allowance to cover how late your data can be.

## 9. Security operations

### Data keys and rotation

Credentials stored in the database (today, the Teams webhook URLs) are sealed with AES-256-GCM using a data key from `TILES_DATA_KEYS`. The value is `id:base64key`, comma-separated; the first key seals and any key opens. In production the API won't start without data keys.

- Make a key with `tiles-rotate-keys --new-key k1`.
- With Helm and no `tiles_data_keys` in your Secret, the chart generates a key in `<release>-generated`. **Back that Secret up**: without it, sealed credentials can't be opened.
- Rotate keys with `tiles-rotate-keys` as described in the [secrets runbook](../runbooks/secrets-and-encryption.md#data-keys-tiles_data_keys). Keep a retired key until no backup sealed with it remains.

### Secrets as files

Every setting can come from an environment variable or from a file. Set `TILES_SECRETS_DIR` to a directory with one file per setting, named as its variable (`tiles_data_keys`; case doesn't matter). Environment variables and `api/.env` win over the files. The Helm chart mounts your Secret this way, never as environment variables.

| Secret key | Holds |
|---|---|
| `tiles_database_url` | `postgresql://…`, with `sslmode=verify-full` when the database is on another host |
| `tiles_redis_url` | The Redis connection |
| `tiles_data_keys` | The data keys |
| `tiles_smtp_password` | The SMTP password |
| `tiles_anthropic_api_key` | The Anthropic API key |

Never put a secret in the repository, an image, `values.yaml` or a log. The [secrets runbook](../runbooks/secrets-and-encryption.md) covers where each secret lives, encryption at rest, rotating each one and what to do if one leaks.

### Row security

Each site's data is protected by PostgreSQL row-level security as well as by roles. A request sees only its own site's rows, even if a query forgets to filter by site. The API's connections switch to the `tiles_app` role, which can't skip the policies. Jobs and migrations see every site.

The migration creates `tiles_app`. On a managed database whose login may not create roles, the migration skips it. If the API logs in as a different role from the one that ran the migrations, grant it `tiles_app`. Never give the API's login `BYPASSRLS`. See the [API README](../../api/README.md#site-level-permissions-in-the-database-t504) for details.

### Backups

Back up the database with point-in-time recovery (5-minute recovery point, 35 days' retention plus 12 monthly backups), and keep the data keys in your secrets manager, never with the database backups. Restore a backup into a scratch server every month. Follow the [backups runbook](../runbooks/backups.md) for the setup, the restore procedure and the drill.

### Upgrades and rollbacks

Follow [releasing.md](../releasing.md). In outline:

1. Make sure a recent backup restores.
2. Pin the new version in `images.api.tag` and `images.web.tag` and run `helm upgrade`. The API pods apply new migrations as they start, one at a time.
3. Check `/ready` and the app, then watch the jobs' next runs.

Read the release notes before upgrading. For example, the upgrade that introduced `api.workers` doubled the API's database connections.

### Capacity

The [load test](../load-test.md) met 10,000 readings a second and 50 people with 2 API pods of 2 workers each, 0.5 to 1 CPU and up to 1.5 GB each, and a 4-CPU, 16 GB database.

- Each API process opens up to `TILES_DB_POOL_MAX` (10) connections for requests plus `TILES_DB_SIDE_POOL_MAX` (4) for streaming copilot answers and sweeps. Keep the database's `max_connections` above replicas × workers × 14, plus the jobs.
- At the full rate, plan about 850 GB for the first 7 days of uncompressed readings, then about 8 GB a day compressed.
- To scale, add API pods.

## 10. Troubleshooting

### Health checks

| Endpoint | Answers |
|---|---|
| `GET /health` | 200 while the process runs. It doesn't touch dependencies. Use it for liveness. |
| `GET /ready` | 200 when PostgreSQL and Redis answer within `TILES_READY_TIMEOUT` (2 seconds), otherwise 503 with which check is `unavailable`. Use it for readiness. |

`/ready` never includes connection details. The reason is in the API's log as `readiness check failed`, with the check's name and the error type.

### Logs

The API writes one JSON object per line to standard output, with `time`, `level`, `logger` and `message`. Each request logs a `request` line with `request_id`, `method`, `path`, `status` and `duration_ms`. Set the level with `TILES_LOG_LEVEL` (Helm `logLevel`).

Every response carries an `X-Request-ID` header. If a client sends one, the API uses it. When someone reports an error, ask for the request ID and search the logs for it. Audit entries carry the same ID.

The edge agent logs one JSON object per line to standard error. The jobs print one line per item, with failures on standard error.

### Common problems

| Symptom | Likely cause | What to do |
|---|---|---|
| 401 "Sign in to use Tiles" | Production and no token | Check that the browser has sign-in configured: `GET /auth/config` should show `enabled: true`. |
| 401 "Invalid token: …" | Wrong issuer, audience or expiry, or a key the provider doesn't publish | Check that `TILES_OIDC_ISSUER` equals the token's `iss` exactly and that the token's `aud` includes `TILES_OIDC_AUDIENCE`. Check the server's clock. |
| 401 "Token has no usable email claim" | The access token lacks `email` | Add the email claim to access tokens at the provider. |
| 401 "Token has an invalid tiles_org claim" | The claim isn't a slug | Use lowercase letters, digits and hyphens. |
| 401 "Sign-in is not configured on this server" | A token was sent but `TILES_OIDC_ISSUER` is unset | Set the issuer. |
| 503 "Sign-in provider is unreachable" | The API can't fetch the provider's keys | Check the API's network path to the issuer, or set `TILES_OIDC_JWKS_URL` to an address the API can reach. |
| 403 "This site belongs to another organisation" or "Your sign-in belongs to another organisation" | The user's `tiles_org` doesn't match | Check the claim. Moving a user between organisations is a database task. |
| 409 "This email already belongs to another sign-in" | Another identity already uses this email in the organisation | Find the existing user in the `users` table and resolve it. |
| The browser can't reach the API (CORS errors) | `TILES_CORS_ORIGINS` doesn't list the app's origin | With Helm, check `url`. |
| An agent shows `offline` | Three heartbeats missed | On the host, check that the service runs and read its log. Run `tiles-edge check`: exit code 1 means it can't reach Tiles (firewall, proxy, DNS, TLS); 3 means its token was revoked or is unknown; 4 means a connector can't connect. Readings stay buffered meanwhile. |
| An agent shows `never seen` | It has never sent a heartbeat | Check the token file and `[tiles] url` (the API's address, `https`). |
| A connector is `degraded` or `down` | Nodes, topics or queries fail, or the server is unreachable | The reason is in Settings → Edge agents. See the [edge README](../../edge/README.md). |
| Agents' posts fail with 413 | The ingress body limit is too small | Raise it to 16 MB or more. |
| Notifications aren't arriving | SMTP not set, the server refuses, or the Teams URL fails | Read the outbox in Settings → Notifications. Check `TILES_SMTP_*`, and that `tiles-notify` runs and exits 0. A Teams URL that can't be opened means a data key is missing; see the secrets runbook. |
| 503 with `Retry-After: 2` under load | All database connections are busy for `TILES_DB_WAIT_SECONDS` | Agents retry on their own. If it persists, add API pods or workers, and raise `max_connections` to match. See [Capacity](#capacity). |
| `/ready` returns 503 | The database or Redis is unreachable | Check the log line for which check failed, then the service, the Secret's URL and the network policy. |
| The API won't start: "Set TILES_DATA_KEYS in production" | No data keys | Add `tiles_data_keys` to the Secret, or let the chart generate one. |
| The copilot returns 503 | It is off | Set both `TILES_ANTHROPIC_API_KEY` and `TILES_COPILOT_MODEL`, then restart the API. |
| The copilot returns 429 | A rate limit or the daily budget is reached | Wait for `Retry-After`, or raise the limit. Check Settings → Copilot usage. |
| A job's CronJob keeps failing | One item failed | Read the Job's output: each failed item is named on stderr. |
