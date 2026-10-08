# Tiles API

The Tiles backend: a FastAPI service. See [ADR 001](../docs/adr/001-stack.md) for why Python, and the repository [CONTRIBUTING.md](../CONTRIBUTING.md) for the overall workflow.

## Run

The whole stack (database, Redis, API, web) runs with Docker Compose from the repository root; see the main README. To run just the API against services you already have:

```bash
cd api
uv sync                     # creates .venv with app + dev dependencies
uv run tiles-api            # http://localhost:8000  (docs at /docs)
```

## Check

```bash
uv run ruff check .         # lint
uv run ruff format --check .
uv run mypy                 # strict typing
uv run pytest -W error      # tests
```

Database tests need a PostgreSQL + TimescaleDB server whose user can create databases. Each test module creates a throwaway database, migrates it and drops it afterwards. With the Compose `db` service running:

```bash
TILES_TEST_DATABASE_URL=postgresql://tiles:tiles-dev@localhost:5432/tiles uv run pytest -W error
```

Without `TILES_TEST_DATABASE_URL` the database tests are skipped locally. In CI (`CI` set) they fail instead, so they always run there.

## Database migrations

The schema is plain SQL in Alembic migrations under `src/tiles_api/migrations/versions/` (see [ADR 002](../docs/adr/002-storage.md)). Docker Compose applies them through its `migrate` service before the API starts.

```bash
uv run tiles-migrate upgrade            # apply all pending migrations
uv run tiles-migrate current            # show the applied revision
uv run tiles-migrate downgrade -1       # undo the latest one
uv run tiles-migrate revision "add x"   # new file: versions/000N_add_x.py
```

Fill in a new migration's `UPGRADE` and `DOWNGRADE` SQL, and add tests in `tests/test_schema.py`.

Schema v1 (`0001`):

| Area | Tables |
|---|---|
| Tenancy | `orgs`, `sites`, `users` (OIDC issuer + subject; `org_admin` flag), `site_members` (role per site: viewer, engineer or admin) |
| Ontology | `ontology_nodes`, `ontology_edges` (working graph per site), `commits` (ops, inverses, stats; ordered by `seq`), `staged_ops` (per user and site) |
| Plant data | `signals` (tag, unit, sample rate, mapped node), `events` (downtime, scrap, maintenance, alarms; `source_ref` makes re-imports idempotent) |
| Design | `models` (key + version per org), `runs` (params, outputs, parent run for lineage, which must be the same model key) |
| Audit | `audit_log`: append-only, enforced by triggers; org, site and actor ids are kept even after those rows are deleted |

## Configuration

Settings come from environment variables prefixed `TILES_` (or an `.env` file in `api/`):

| Variable | Default | Meaning |
|---|---|---|
| `TILES_ENV` | `development` | `development`, `test` or `production` |
| `TILES_LOG_LEVEL` | `INFO` | Python log level |
| `TILES_HOST` | `127.0.0.1` | Bind address for `tiles-api` |
| `TILES_PORT` | `8000` | Port for `tiles-api` |
| `TILES_CORS_ORIGINS` | `["http://localhost:5173"]` | JSON list of browser origins allowed to call the API |
| `TILES_DATABASE_URL` | `postgresql://tiles:tiles-dev@localhost:5432/tiles` | PostgreSQL (TimescaleDB) connection |
| `TILES_REDIS_URL` | `redis://localhost:6379/0` | Redis connection |
| `TILES_READY_TIMEOUT` | `2.0` | Seconds each `/ready` check may take |
| `TILES_DB_POOL_MAX` | `10` | Maximum database connections |
| `TILES_OIDC_ISSUER` | unset (sign-in off) | OpenID Connect issuer; must equal the tokens' `iss` (the address browsers use) |
| `TILES_OIDC_JWKS_URL` | discovered from the issuer | Where the API fetches signing keys, if it reaches the provider by another address (Compose uses `http://keycloak:8080/…`) |
| `TILES_OIDC_AUDIENCE` | `tiles-api` | Audience tokens must carry |
| `TILES_OIDC_CLIENT_ID` | `tiles-web` | Client the browser signs in as (sent to it by `/auth/config`) |
| `TILES_OIDC_DEFAULT_ORG` | `demo` | Organisation for users whose token has no `tiles_org` claim |
| `TILES_DEV_USER_EMAIL`, `TILES_DEV_USER_NAME` | `demo@example.com`, `Demo User` | Who requests without a token act as, outside production |

## Endpoints

- `GET /health`: liveness. Always 200 while the process runs; does not touch dependencies.
- `GET /ready`: readiness. 200 when PostgreSQL and Redis answer, otherwise 503 with which check failed (no connection details in the response).
- `GET /docs`: OpenAPI docs.
- `GET /auth/config`, `GET /me`: sign-in settings and the current user (see Sign-in).
- `GET /sites`: sites in your organisation (id, slug, name, org).

### Roles

Each site member is a viewer, engineer or admin; organisation admins (`users.org_admin`) are admins on every site.

- **Viewers** can read the ontology (graph, staged changes, history, health). They can also discard their own staged changes, which matters when an engineer is demoted with work still staged.
- **Engineers** can also stage, commit and revert. Every other write endpoint checks this and answers 403 otherwise.
- **Admins** can also change other members' roles.

| Method and path (under `/sites/{site_id}`) | Does |
|---|---|
| `GET /me` | your membership and role (joins the site on first visit) |
| `GET /members` | members and their roles |
| `PUT /members/{user_id}` | set a member's role: `{"role": "engineer"}` (admins only; not your own role) |
| `GET /audit?limit=100&offset=0` | the site's audit log, newest first (admins only) |

### Audit log

Every write is recorded in `audit_log` in the same transaction as the change, so there is an entry exactly when the change happened. Each entry has the actor, the time, the action, the entity, the before and after values as JSON, and the request ID.

| Action | Entity | Before | After |
|---|---|---|---|
| `ontology.stage` | your staged ops | | the ops added |
| `ontology.discard` | your staged ops | the ops dropped | |
| `ontology.commit` | the commit | | the commit (message, ops, inverses, stats) |
| `ontology.revert` | the new commit | `{"reverted": id}` | the new commit |
| `member.role` | the member | old role | new role |
| `agent.register` | the edge agent | | `{"name": …}` (never the token) |
| `agent.revoke` | the edge agent | `{"name": …}` | |
| `import.start`, `import.finish` | the import | | its name; when finished, the counts |
| `signal.update` | the signal | its tag and the fields' old values | its tag and the fields' new values |
| `signal.quality_check` | the site | | `{"hours": …, "checked": …}` and how many got each badge |

Writes that fail, and no-ops (discarding nothing, setting the same role), leave no entry. The table refuses UPDATE, DELETE and TRUNCATE. New write endpoints should call `ctx.audit(...)`. `uv run tiles-seed` creates the demo org and site; Compose runs it for you.

### Edge agents

Edge agents (`edge/`, [ADR 003](../docs/adr/003-edge-agent.md)) run on the plant network and only call out to the API. Each authenticates with its own token (`tla_…`), not a user's sign-in. The API stores only the token's SHA-256 hash, so the token is shown once, when the agent is registered.

| Method and path | Who | Does |
|---|---|---|
| `GET /sites/{site_id}/agents` | members | the site's agents, each `online`, `offline` (three heartbeats missed) or `never seen`, with host, version and connector status |
| `POST /sites/{site_id}/agents` | admins | register an agent: `{"name": "edge-01"}` → `{"agent": …, "token": "tla_…"}`; names are unique per site |
| `DELETE /sites/{site_id}/agents/{agent_id}` | admins | revoke it: its token stops working at once, and the name is free again |
| `POST /agent/heartbeat` | the agent's token | records the heartbeat (version, host, start time, interval, connectors) and answers with the server time and any `commands` for the agent (none yet); works in production without a user token |

Commands for an agent, when there are any, travel back in the heartbeat answer: the agent pulls, and Tiles never connects in.

### Ontology

Each site has one committed graph (`head`) and a commit history. Each user stages their own changes until they commit or discard them. Every change is validated against the graph it applies to; a change that no longer fits (say someone else removed the node) gets a 409 with the same message the browser shows.

| Method and path (under `/sites/{site_id}/ontology`) | Does |
|---|---|
| `GET /graph?view=working` | head plus your staged changes (`view=head` for the committed graph) |
| `GET /staged` | your staged ops, in order |
| `POST /staged` | stage one op (`addNode`, `removeNode`, `addEdge`, `removeEdge`, `setProp`); returns all your staged ops |
| `POST /staged/batch` | stage a list of ops, all or none (one transaction) |
| `DELETE /staged` | discard your staged ops |
| `POST /commits` | commit your staged ops: `{"message": "..."}` |
| `GET /commits?limit=50&offset=0` | history, newest first |
| `POST /commits/{id}/revert` | commit the inverse of a commit |
| `GET /health?view=head` | health check: dangling and duplicate relationships, orphans, missing required properties, and a 0–100 score (`view=working` includes your staged changes) |

Ops, graphs and commits have the same JSON shape as in the browser (`js/lib/types.ts`). The logic in `tiles_api/ontology.py` is a port of `js/lib/ontology.ts`. Both run the shared fixture suite in `test/fixtures/ontology-parity.json`, and the API tests replay it over HTTP too. After changing the TypeScript behaviour, regenerate the fixtures with `UPDATE_FIXTURES=1 npx vitest run test/ontology-parity.test.js`, then make the Python port pass.

### Signals and data quality

| Method and path (under `/sites/{site_id}/signals`) | Who | Does |
|---|---|---|
| `GET ?q&source&linked&quality&limit&offset` | members | the catalogue in tag order, each signal with its latest reading and its latest quality report; `quality` is `good`, `warn`, `bad`, `unknown` (no readings) or `unchecked` |
| `GET /{id}` | members | one signal |
| `PATCH /{id}` | engineers | set `unit`, `sample_rate_hz`, `description`, `node_id`, the expected range (`range_min`, `range_max`) or `stuck_after_s`; a change that affects the quality check checks the signal again |
| `GET /suggestions?limit` | members | for each tag no node is linked to (the first `limit`, default 100): the Signal node to link, or the one to create with the ontology ops to stage, a score and the reasons (agentic ingestion, `suggest.py`) |
| `GET /{id}/series?from&to&points` | members | readings from `from` (included) to `to` (excluded, at most five years later): as they are when there are at most `points` (10–5000, default 1000), otherwise in time buckets from `from`, each with its average, minimum, maximum, count and last text; true/false count as 1/0 |
| `POST /quality` | engineers | check `{"signal_ids": [...]}` (or all the site's signals) over `hours` (default 24) up to each one's latest reading |

A check (`tiles_api/quality.py`) looks for gaps (steps longer than three expected periods: 1 / the sample rate, or the median step), numeric values stuck for longer than `stuck_after_s` (an hour by default) and at least 10 readings, readings outside the expected range, readings the source marked bad or uncertain, a unit that differs from the linked ontology node's `unit`, and edge agent signals that have gone quiet. Each finding is a warning or a problem (less than 90% of the time covered, more than 5% of readings out of range or marked bad, a unit mismatch, a silent tag); the badge is the worst. A day of 1 Hz readings takes about a quarter of a second to check, so check whole sites on a schedule rather than from the page:

```bash
uv run tiles-check-quality              # every site; --site <id> for one, --hours 72 for a longer window
```

### Sign-in

The API accepts OpenID Connect access tokens (`Authorization: Bearer …`) from `TILES_OIDC_ISSUER`. It checks the signature against the issuer's keys, and also the issuer, audience and expiry; a token that fails any check gets 401.

- **First sign-in** creates the user. It also creates their organisation if needed, taken from a `tiles_org` claim or `TILES_OIDC_DEFAULT_ORG`.
- **Roles:** the first visit to a site makes the user a member, with the highest role their token grants (`tiles-admin`, `tiles-engineer`, otherwise viewer). After that the stored membership counts.
- **Organisations:** users see only their organisation's sites; another organisation's site is a 403.

`GET /auth/config` (public) tells the browser where and as which client to sign in, and `GET /me` says who you are.

Requests without a token are refused in production. Elsewhere they act as `TILES_DEV_USER_EMAIL` (default `demo@example.com`) or as the email in an `X-Tiles-User` header, so tests and curl need no sign-in.

In Docker Compose, Keycloak runs at http://localhost:8080 with the `tiles` realm from `keycloak/tiles-realm.json`. It has three users: `demo`/`demo` (engineer), `admin`/`admin` (admin) and `viewer`/`viewer` (viewer). For scripts, the dev-only `tiles-dev-cli` client allows the password grant:

```bash
curl -s -X POST http://localhost:8080/realms/tiles/protocol/openid-connect/token \
  -d grant_type=password -d client_id=tiles-dev-cli -d username=demo -d password=demo | jq -r .access_token
```
