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
- **Engineers** can also stage, commit and revert, and request, comment on, approve and reject change reviews. Every other write endpoint checks this and answers 403 otherwise.
- **Admins** can also change other members' roles and require a review for every ontology change.

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
| `ontology.review.request` | the change request (its number) | | message, ops, reviewer and the commit it reverts |
| `ontology.review.comment` | the change request | | `{"body": …}` |
| `ontology.review.approve` | the change request | | `{"commit": …}`, the commit it made |
| `ontology.review.reject` | the change request | | `{"comment": …}`, the reason |
| `ontology.review.rework` | the change request | | the ops staged again |
| `ontology.review_policy` | the site | `{"required": …}` | `{"required": …}` |
| `model.bind`, `model.run`, `model.stop` | the model binding | `model.stop`: its name | `model.bind`: its model, inputs, params and outputs; `model.run`: windows run, readings written, `done_until`, error |
| `detector.create`, `detector.run`, `detector.stop` | the detector | `detector.stop`: its name | `detector.create`: its signal and settings; `detector.run`: readings, warnings raised and ended |
| `ontology.import` | your staged ops | | the file's name, format, mode and the counts staged |
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
| `GET /export?format=json` | the committed ontology as a file: JSON (`format`, `version`, `site`, `commit`, `nodes`, `edges`) or `format=csv` (one table: `kind`, `id`, `type`, `label`, `from`, `rel`, `to` and a `prop:<key>` column per property) |
| `POST /import` | engineers: `{"format": "json"\|"csv", "content": "…", "mode": "merge"\|"replace", "name"?, "dry_run"?, "expect_commit"?}` plans the ops that bring the committed ontology to the file's and stages them (with no staged changes of your own); answers the counts, the first 500 ops the relationships skipped as already there (in the ontology or earlier in the file) under another id, and the latest `commit` it was planned on; pass that as `expect_commit` to stage only if nobody has committed since (409 otherwise) (`ontology_io.py`) |
| `GET /health?view=head` | health check: dangling and duplicate relationships, orphans, missing required properties, and a 0–100 score (`view=working` includes your staged changes) |

#### Change reviews (T2.12)

An engineer can send their staged changes to another engineer instead of committing them, optionally naming who should review. The staged ops move into a numbered change request. Another engineer reads the diff, comments, and approves it, which commits the ops with the requester as `author` and the approver as `reviewer`, or rejects it with a reason. The author can take an open request back into their staged changes ("rework"; it is withdrawn) or a rejected one, to change it and send it again. A request whose ops no longer fit the committed graph shows the reason as `conflict` and cannot be approved. A site admin can require a review for every change: `POST /commits` and `POST /commits/{id}/revert` then answer 409, and a revert is requested with `reverts`.

| Method and path (under `/sites/{site_id}/ontology`) | Who | Does |
|---|---|---|
| `GET /review-policy`, `PUT /review-policy` | members; admins to change | `{"required": true}`: every change needs a review |
| `GET /reviews?state=open&limit&offset` | members | change requests, newest first; `state` is `open`, `closed` or `all` |
| `GET /reviews/{n}` | members | one request with its ops, comment thread and `conflict` |
| `POST /reviews` | engineers | `{"message", "reviewer_id"?}` sends your staged ops; `{"reverts": commit_id}` asks to revert a commit (with no staged ops) |
| `POST /reviews/{n}/comments` | engineers | `{"body": …}` |
| `POST /reviews/{n}/approve` | engineers, not the author; if a reviewer is named, them or an admin | `{"comment"?}`: commits the ops |
| `POST /reviews/{n}/reject` | as approve | `{"comment": …}`, required |
| `POST /reviews/{n}/rework` | the author | puts the ops back into your (empty) staged changes; an open request is withdrawn |

Import (T2.13) matches nodes and relationships by id. **Merge** adds the file's nodes and relationships and sets their properties; **replace** also removes the nodes, relationships and properties the file doesn't have. The ops can't rename a node or change its type, so a file that does is refused with each one named. A CSV cell that reads as a number or as true/false is that, unless it starts with an apostrophe, which marks text (`'1.3` is the text 1.3, as in spreadsheets); an empty cell is no property. Export puts the apostrophe in front of text that would otherwise read as a number, true/false or no property, and of any cell a spreadsheet would run as a formula (`=`, `+`, `-`, `@`), so a round trip changes nothing and opening the file runs nothing. The staged changes are then committed, or sent for review, like any other.

Ops, graphs and commits have the same JSON shape as in the browser (`js/lib/types.ts`). The logic in `tiles_api/ontology.py` is a port of `js/lib/ontology.ts`. Both run the shared fixture suite in `test/fixtures/ontology-parity.json`, and the API tests replay it over HTTP too. After changing the TypeScript behaviour, regenerate the fixtures with `UPDATE_FIXTURES=1 npx vitest run test/ontology-parity.test.js`, then make the Python port pass.

### Models (T3.01)

Models are registered in code (`tiles_api/models/`): each declares its key, version (`MAJOR.MINOR.PATCH`), kind (`virtual-sensor` or `design`), input series, outputs (per sample, or one per window such as a shot) and parameters with their unit, default and bounds, and implements `run`. `registry.evaluate` checks inputs and parameters against the spec, fills in defaults and checks what the model returns. A published version never changes: `models/published.json` pins each version's spec fingerprint and a unit test fails if a published spec changes (give the change a new version) or a new version isn't pinned yet (the failure prints the line to add). An organisation's `models` row for a version is written when it is first used (by the model runner, T3.03), never rewritten. Listing and evaluating write nothing. The first model is `plunger-friction` (T3.02), ported from `js/lib/physics.ts`; `test/fixtures/plunger-shots.json`, made by the browser's model, keeps both giving the same numbers.

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `GET /models` | members | every registered model version with its inputs, outputs and parameters |
| `GET /models/{key}` | members | a model's versions, newest first |
| `POST /models/{key}/evaluate` | members | `{"version"?, "inputs": {name: [numbers]}, "params"?: {name: number}}` (up to 20 inputs of 100,000 numbers) runs it and answers the outputs; nothing is stored |

#### Model runner (T3.03)

A **binding** runs a registered model version on a site's signals. Each model input is fed by a signal, or by `@time`, the seconds since the window began. The input signals' readings are joined on their timestamps and cut into **windows**: where the readings pause for longer than the window's seconds (`gap`: a shot, a batch), or every that many seconds (`fixed`). A window runs once it is complete: more data follows it, or it is older than its seconds plus `lateness_seconds` (default 5 minutes, for readings that arrive late, such as an edge agent's backlog). A shot still being recorded therefore waits. By default the inputs join at equal timestamps. Set `align_seconds` for signals recorded a little apart: each other input then takes its latest reading at most that long before the first input's. When nothing joins, the binding says so. Each output becomes a signal of the site, `<binding>.<output>`, with source `model:<key>@<version>` and the output's unit. Per-sample outputs are written at each sample's time and per-window outputs at the window's last reading. A binding starts with the history already stored, and `done_until` moves past each window run, so later runs take only new data. Writes skip readings already stored, so running again is harmless. A window the model refuses is skipped and counted (`last_failed`), and the first reason is kept as `last_error`. A window with more readings than a batch (100,000) stops the binding with that error rather than running in pieces. Only the runner writes a derived signal: readings sent under its tag by an agent or an import are left out. Schedule `uv run tiles-run-models` (optionally `--site <id>`) from cron, for example every minute: each binding runs in its own transaction, and the exit code is 1 if one failed.

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `GET /model-bindings` | members | the bindings with their inputs, outputs and last run (windows, error, `done_until`) |
| `POST /model-bindings` | engineers | `{"name", "model", "version"?, "inputs": {input: signal id or "@time"}, "params"?, "window": {"kind": "gap"\|"fixed", "seconds"}, "lateness_seconds"?, "align_seconds"?}` binds the model (the latest version unless named; pinned from then on) and creates its output signals |
| `POST /model-bindings/{id}/run` | engineers | runs it on one batch of its new data now (`caught_up` false: there is more); refused for a stopped binding |
| `DELETE /model-bindings/{id}` | engineers | stops it; its derived signals and their readings stay |

### Detection and warnings (T3.04)

A **detector** watches one signal (often a model's derived signal, such as `dc1-plunger.friction`). It compares each reading with a rolling robust baseline of the `window` readings before it: their median, and their MAD scaled to a standard deviation (`flat_spread` when the baseline is flat, i.e. its MAD is 0, as in the browser). A reading more than `k` spreads above it (or below, or either way, set by `direction`) is out. `persist` readings out in a row on one side raise a **warning**. It stays open while readings stay out on that side, and ends at the first one that isn't. With `direction` both, a swing to the other side ends it and starts a run there. After a warning ends, `cooldown` readings must pass before another can open. The defaults (`window` 200, `k` 4, `persist` 3, `cooldown` 0, `direction` above) are the browser's friction detector, and `test/fixtures/friction-detection.json` keeps the two raising the same warnings.

The detector's state (the baseline window, the run of readings out, the open warning) is saved after each run, so `uv run tiles-detect` (optionally `--site <id>`), scheduled from cron, takes only new readings. Readings newer than `lateness_seconds` (default 5 minutes) wait for a later run. Readings that arrive later than that, with a time the detector has already passed, are not fed to it, so set the allowance to cover how late your data can be. The window is at most 2,000 readings, and batches shrink as it grows, so a run stays quick. A warning is written when it opens and updated while it lasts. T3.07 adds acknowledging, assigning and resolving warnings, with an outcome.

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `GET /detectors` | members | the detectors, their settings, last run, and whether a warning is open |
| `POST /detectors` | engineers | `{"name", "signal_id", "window"?, "k"?, "persist"?, "direction"?, "cooldown"?, "flat_spread"?, "lateness_seconds"?}` starts one, from the signal's stored history |
| `POST /detectors/{id}/run` | engineers | runs it on one batch of new readings now (`caught_up` false: there is more); refused once stopped |
| `DELETE /detectors/{id}` | engineers | stops it; its warnings stay, and one still open ends |
| `GET /warnings?state=open\|ended\|all&signal_id&limit&offset` | members | warnings, newest first: when, how far out (peak against baseline and threshold), how many readings, and when it ended |

### Backtest (T3.05)

Before a detector goes live, replay the signal's history with the settings you are considering, and score the warnings against the events they should have warned of (downtime or scrap, with their times). For each combination of the values given: **recall** (the share of events with a warning in time), **precision** (the share of warnings an event followed), **false warnings per day**, and the **warning time** from warning to event (its median, 10th and 90th percentile). A warning counts for an event when it started within `horizon_seconds` before it. The event's warning time comes from the earliest such warning, as in the browser. A warning that no event followed within the horizon is false, unless the history ends first: then it is *pending* and left out of precision. Events before the baseline fills, or after the last reading, are left out of recall. The settings come back best first: the most events warned of, then the fewest false warnings per day, then the longest median warning time.

The replay raises exactly the warnings a detector with that setting would raise (it shares the detector's judgement, and computes the same baselines faster). It runs in the request and changes nothing, so members may run it. One backtest replays at most 200,000 readings, with at most 48 settings, 2 million readings × settings, and 600,000 readings × window sizes. Choose a shorter period or fewer settings when it says so.

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `POST /backtest` | members | `{"signal_id", "events": [{"at", "code"?}], "horizon_seconds", "start"?, "end"?, "window"?: [...], "k"?: [...], "persist"?: [...], "direction"?: [...], "cooldown"?: [...], "flat_spread"?: [...]}`: each setting's scores and events, best first, and the Markdown `report` |

For the report on a machine, put its events in a CSV file (columns `at`, an ISO 8601 time with its offset, and optionally `code`), then:

```sh
uv run tiles-backtest --site <id> --signal dc1-plunger.friction --events downtime.csv \
  --horizon-hours 8 --window 100,200 --k 3,4,5 --persist 1,3 --out report.md
```

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
