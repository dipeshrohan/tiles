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
| `TILES_SMTP_HOST`, `TILES_SMTP_PORT` | unset (no email), `587` | The mail server `tiles-notify` sends through |
| `TILES_SMTP_STARTTLS` | `true` | Upgrade the SMTP connection to TLS before logging in |
| `TILES_SMTP_USER`, `TILES_SMTP_PASSWORD` | unset | SMTP login, if the server needs one |
| `TILES_SMTP_FROM` | `Tiles <tiles@example.com>` | The sender of notification emails |
| `TILES_APP_URL` | `http://localhost:5173` | Where the web app is, for links in notifications |
| `TILES_ANTHROPIC_API_KEY` | unset (copilot off) | The Anthropic API key the copilot calls Claude with; keep it in a secret store, never in the repository |
| `TILES_COPILOT_MODEL` | unset (copilot off) | The Claude model ID to answer with: a current one from Anthropic's model documentation |
| `TILES_COPILOT_MAX_TOKENS`, `TILES_COPILOT_MAX_ROUNDS` | `2048`, `8` | The most the model writes per call, and the most calls (tool rounds) per question |
| `TILES_COPILOT_QUESTION_TOKENS` | `200000` | Billed tokens one question may use: the model isn't called again past it (T4.07); `0` for no limit |
| `TILES_COPILOT_ORG_DAILY_TOKENS` | `5000000` | Billed tokens an organisation's questions may use per UTC day; later questions get 429 until midnight UTC; `0` for no limit |
| `TILES_COPILOT_ORG_QUESTIONS_PER_MINUTE`, `TILES_COPILOT_USER_QUESTIONS_PER_MINUTE` | `30`, `6` | Questions an organisation, and one person, may ask a minute; `0` for no limit |

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
| `backtest.run` | the signal | | readings replayed, settings tried, events given |
| `dataset.create`, `dataset.rows`, `dataset.delete` | the dataset | `dataset.delete`: its name and rows | its name and columns; the rows added and the total |
| `copilot.conversation.create`, `copilot.ask`, `copilot.conversation.delete` | the conversation | | `copilot.ask`: the question's length (not its text: conversations are private) |
| `copilot.feedback`, `copilot.feedback.delete` | the conversation | | the answer's `seq` and the rating |
| `run.create`, `run.restore` | the run's number | | its model, version and parent; the run restored and the parent |
| `insight.create`, `insight.update`, `insight.review`, `insight.reopen`, `insight.delete` | the insight's number | `insight.update`: the fields changed; `insight.reopen`: its status; `insight.delete`: its title and status | its title and kind; the fields changed; the decision and note |
| `detector.update` | the detector | its asset | its asset |
| `notification.preferences` | the user | their choices | their choices |
| `notification.teams` | the site | the channel's host | the channel's host |
| `warning.acknowledge`, `warning.assign`, `warning.resolve`, `warning.reopen`, `warning.comment` | the warning | `warning.assign`: the assignee before; `warning.reopen`: the outcome and note it had | the note; `warning.assign`: the assignee; `warning.resolve`: the outcome |
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

The Design Studio's models (T4.10) are in the same registry, as `design` models: no input series, their parameters are the design, and they give one value. They are ported from `js/lib/design.ts`, and the browser's version 1.0 is 1.0.0 here:
- `cell-swelling` 1.0.0, 1.1.0 and 2.0.0: the swelling force in kN, from state of charge, temperature, preload, cycles and anode thickness;
- `joint-actuator` 1.0.0 and 1.1.0: the winding temperature in °C, from torque, gear ratio, torque constant, thermal resistance and ambient temperature.

`test/fixtures/design-models.json`, made by the browser's models, keeps each version giving the same numbers within 1e-12. `POST /sites/{id}/models/cell-swelling/evaluate` with `{"version", "inputs": {}, "params"}` runs one. Like every published version, they are pinned in `models/published.json`.

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `GET /models` | members | every registered model version with its inputs, outputs and parameters |
| `GET /models/{key}` | members | a model's versions, newest first |
| `POST /models/{key}/evaluate` | members | `{"version"?, "inputs": {name: [numbers]}, "params"?: {name: number}}` (up to 20 inputs of 100,000 numbers) runs it and answers the outputs; nothing is stored |

#### Design runs (T4.11)

A **run** is a design model version, its parameters and the output the API computes from them. The browser never sends an output. Each run is stored with:
- its parent: the run it was changed from;
- the run it restored, if any;
- a note, and its author (name and email, kept even when the account is deleted);
- the full set of parameters, defaults filled in.

Runs are numbered per site and never change (migration 0020; a trigger refuses updates), so a design's lineage can be followed back to its first run and exported for audit (T4.13). A run refers to the organisation's `models` row for its version.

A run's model is named by the registry's key (`cell-swelling`) or the browser's id (`swelling`, with versions like `2.0`); without a version it runs the latest. Only `design` models run. A parent must be a run of the same model, in any version.

**Restoring** run *n* runs its version and parameters again as a new run. Its parent is the model's latest run, so the history keeps what came between, and `restored_from` is *n*. Its output must equal run *n*'s, since a published version never changes; otherwise it is refused with 409 and nothing is stored.

**Comparing** two runs of a model gives:
- what changed: the version first, then each parameter;
- each output in both runs, with the difference and the percentage of the first.

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `GET /runs?model&limit&offset` | members | `{"runs", "total"}`: the site's runs, latest first, of one model if named; each with its parameters, output, units, parent, `restored_from`, note, author and `changes` from its parent |
| `POST /runs` | engineers | `{"model", "version"?, "params"?, "note"?, "parent"?}` runs the model and stores the run (201, with its `lineage`) |
| `GET /runs/{n}` | members | one run, with `lineage`: its parent, that run's parent, and so on back to the first run |
| `POST /runs/{n}/restore` | engineers | `{"note"?}` (default "Restored run n") runs run *n* again as a new run after the model's latest |
| `GET /runs/compare?a&b` | members | `{"a", "b", "changes", "outputs"}` |

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

The detector's state (the baseline window, the run of readings out, the open warning) is saved after each run, so `uv run tiles-detect` (optionally `--site <id>`), scheduled from cron, takes only new readings. Readings newer than `lateness_seconds` (default 5 minutes) wait for a later run. Readings that arrive later than that, with a time the detector has already passed, are not fed to it, so set the allowance to cover how late your data can be. The window is at most 2,000 readings, and batches shrink as it grows, so a run stays quick. A warning is written when it opens and updated while it lasts; people then work it (below).

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `GET /detectors` | members | the detectors, their settings, last run, and whether a warning is open |
| `POST /detectors` | engineers | `{"name", "signal_id", "window"?, "k"?, "persist"?, "direction"?, "cooldown"?, "flat_spread"?, "lateness_seconds"?}` starts one, from the signal's stored history |
| `POST /detectors/{id}/run` | engineers | runs it on one batch of new readings now (`caught_up` false: there is more); refused once stopped |
| `DELETE /detectors/{id}` | engineers | stops it; its warnings stay, and one still open ends |

### The warning workflow (T3.07)

People work a warning through three statuses:

1. **Raised:** the detector raised it and nobody has looked yet.
2. **Acknowledged:** someone is looking. It may be assigned to an engineer or admin of the site.
3. **Resolved:** closed with an **outcome**: `true_alarm`, `false_alarm` or `unknown`, and a note.

Assigning or resolving a warning that nobody had acknowledged acknowledges it on the way. A resolved warning can be reopened: it goes back to acknowledged, and keeps its assignee. Every step and every comment is kept in the warning's activity, with who did it and when, and is audited.

The status is separate from `state`, which says whether the signal is still out (`open`) or back (`ended`). A warning can be resolved while its signal is still out, and the detector keeps updating its last reading, peak and end without touching the people's side.

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `GET /warnings?state=open\|ended\|all&status=raised\|acknowledged\|resolved\|unresolved\|all&assignee=me\|none\|<user id>&outcome&signal_id&limit&offset` | members | warnings, newest first: when, how far out (peak against baseline and threshold), how many readings, when the signal came back, and their status, assignee and outcome |
| `GET /warnings/{id}` | members | one warning, with its detector's settings and its activity (oldest first, starting with raised) |
| `POST /warnings/{id}/acknowledge` | engineers | `{"note"?}`; refused if already acknowledged or resolved |
| `PUT /warnings/{id}/assignee` | engineers | `{"user_id": <id> or null, "note"?}` assigns it to an engineer or admin of the site (an organisation admin counts even before visiting it), or unassigns it; to the current assignee, it only keeps the note as a comment (even if they could no longer be given new ones) |
| `POST /warnings/{id}/resolve` | engineers | `{"outcome", "note"?}` |
| `POST /warnings/{id}/reopen` | engineers | `{"note"?}` |
| `POST /warnings/{id}/comments` | engineers | `{"note"}` adds a comment, whatever the status |

### Notifications (T3.09)

Two things are announced:

- **A new warning:** by email to the site's engineers and admins who asked for every new warning, and to the site's Microsoft Teams channel if an admin set one up. Only warnings the detector found within an hour of when it could have (its `lateness_seconds` holds readings back that long): a detector catching up on old history raises old news, not alarms. Someone demoted to viewer, or no longer on the site, gets no more, whatever they chose before.
- **A warning assigned to you by someone else:** by email to you. This is on until you turn it off.

Messages wait in an outbox, queued in the same transaction as what they announce. `uv run tiles-notify` sends the due ones, e.g. every minute from cron. Each message is sent in its own transaction, at least once (one sent just before the job dies is sent again). A failure is retried after 1, 2, 4, 8 and 16 minutes, then given up, or given up at once when retrying can't help (the channel was removed, or stopped hearing of new warnings); admins see why on the Settings page. Emails go out by SMTP (`TILES_SMTP_*` above). Teams messages are Adaptive Cards posted to the channel's webhook, from Workflows or an incoming webhook.

Only `https` URLs on Microsoft's webhook hosts (`*.webhook.office.com`, `*.logic.azure.com`, `*.api.powerplatform.com`) are accepted, and redirects are not followed, so a site admin can't point Tiles at anything else on the network. Anyone with the webhook URL can post to the channel, so the API never shows it again, and audits only its host.

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `GET /notifications/preferences` | members | your choices: `on_raised` (every new warning; off until you choose) and `on_assigned` (on), and your email |
| `PUT /notifications/preferences` | engineers | `{"on_raised", "on_assigned"}` |
| `GET /notifications/teams` | admins | whether there is a channel, its host, and whether it hears of new warnings |
| `PUT /notifications/teams` | admins | `{"webhook_url"?: <url> or null, "on_raised"?}` sets or removes it; with no `webhook_url`, keeps it and changes only `on_raised` |
| `GET /notifications?state=all\|pending\|sent\|failed&limit` | admins | the messages, newest first: what, to whom, and when sent; pending ones show why the last try failed, if it did; failed ones were given up |

### Events and warning performance (T3.10)

Downtime and scrap from the MES arrive as readings, through the edge agent's SQL connector (see the edge README), MQTT or a file import. A signal becomes an **event stream** when an engineer sets its `event_kind` (`downtime`, `scrap` or `other`) with `PATCH /signals/{id}`. Each reading on it is then an event, and its value is the code. A reading of 0 or false is not an event: it is a count of nothing.

Signals and detectors also name their **asset**: the machine, as the MES names it (`PATCH /signals/{id}` and `PATCH /detectors/{id}`, or `asset` when creating a detector). A detector's warnings are matched to its asset's events.

`GET /performance` scores the real warnings the way the backtest scores a replay:

- an event counts as warned of when a warning started at most `horizon_hours` before it;
- a warning counts as followed when such an event came after it, and as pending while its horizon runs past now;
- an asset with several detectors counts an event once, if any of them warned.

Each detector is scored over the part of the period it has judged: from its signal's first reading to where its runs got to. Events outside that couldn't have been warned of, so they aren't counted as missed. A warning that started up to a horizon before the period can still warn of an event in it, but only warnings that started in the period are counted.

Alongside these, it shows what people resolved the warnings as (T3.07). Events of assets no detector watches are counted apart.

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `GET /performance?days&horizon_hours&codes` | members | the last `days` (default 30): totals, each detector's scores, unwatched assets, and the latest 200 events with the warning that came first, if any. `codes` (repeatable) counts only those events. At most 20,000 events per period |
| `PATCH /detectors/{id}` | engineers | `{"asset": <name> or null}` |

### Batch tables and the correlation finder (T3.11)

A **dataset** is a batch table from the MES or a quality system: one row per batch, with its settings and measurements, and a column saying whether it failed. Engineers upload it from a CSV on the Correlation finder page. The page declares the columns (number, text or true/false, inferred from the cells) and sends the rows in batches.

The finder asks which variables separate the failed (NG) batches from the good ones. You choose:
- the outcome column, and the values that mean failed (true, by default, for a true/false column);
- the variables (by default every number column);
- an optional `split` column (material, line, shift), whose segments are compared separately. An effect that cancels out when everything is pooled shows up this way.

For each variable and segment it reports:
- the failed and good means;
- Cohen's d, with its 95% confidence interval (the normal approximation of Hedges and Olkin);
- the point-biserial r.

Results are ranked by |d|. The numbers match the browser's finder: `test/fixtures/correlation.json`, made from the demo cutter batches, keeps the two in step. A row with no outcome is left out, and a missing value only from its own variable. Each segment's strongest effect is explained in words when it is large (|d| ≥ 0.8) and its interval leaves out 0.

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `GET /datasets` | members | the batch tables: name, columns, rows, who uploaded them |
| `POST /datasets` | engineers | `{"name", "columns": [{"name", "kind"}], "description"?}` starts one (at most 200 columns) |
| `POST /datasets/{id}/rows` | engineers | `{"rows": [{column: value}]}` appends up to 5,000 rows (at most 200,000 per dataset); a value of the wrong kind is refused, with its row |
| `GET /datasets/{id}` | members | the dataset, with its first 20 rows |
| `DELETE /datasets/{id}` | engineers | removes it |
| `POST /datasets/{id}/correlate?min_effect` | members | `{"outcome", "ng_values"?, "variables"?, "split"?}`: the findings, largest effect first, and the explanations; at most 2 million rows × variables, and 50 segments |

### Copilot (T4.01)

The copilot answers questions about the site with Claude (the Anthropic API) and tools that read the site's own data, as the user who asked. It is off until `TILES_ANTHROPIC_API_KEY` and `TILES_COPILOT_MODEL` are set.

An answer streams back as server-sent events:
- `text`: a piece of the answer as the model writes it;
- `tool_use`: a tool the model called, with its input and the number `n` its result is cited by;
- `tool_result`: whether the tool answered;
- `retract`: the answer so far is withdrawn (it stated what no tool returned), with why; a new one follows;
- `grounding`: the final answer's grounding report;
- `done`, with the tokens used and whether the answer is grounded, or `error`.

**Grounding (T4.03).** An answer may only state what the tools returned. Each tool result reaches the model numbered, with its tool and input (`[3] wear_check {"tag": …}`), and the model cites the results a fact rests on as `[3]`. `grounding.py` then holds the answer to them:
- it cites at least one result, unless it declines (starts with "I can't answer that from the site's data") or is only a short question back (one sentence, no numbers or names);
- every result it cites exists;
- every number in it, with or without a unit after it, is in a cited result or in the question. It may appear as given, rounded half up to the digits shown, rounded to its trailing zeros when that is within 5% ("about 1,800"), as a percentage of a fraction, or as the count of a list. A minus sign must be in the result too;
- every `code` span (a tag, node or dataset name) is a value or key in a cited result, a whole word of one, or in the question.

The reasons for any withdrawn drafts are kept with the answer too (`meta.withdrawn`). An answer that fails is withdrawn and the model is told why and asked once more. The second try doesn't count against `TILES_COPILOT_MAX_ROUNDS`. If the second answer fails too, it is kept with its report, which names the numbers and names nothing supports, so the page can warn. The report is stored with the answer (`meta.grounding`, migration 0017). The check can't tell whether a sentence with no number or name says what its result says. It catches values, counts, times, tags and every uncited answer, and T4.06 measures the rest on the evaluation set.

Every message of the exchange (the question, the answer, the tool calls and their results) is stored as it completes, so the next question carries the whole conversation. Whatever broke off while it was stored is repaired before it goes to the model, wherever it broke: a tool call without its results, a result without its call, an empty message. A turn cut short in the middle of a tool call keeps only its text, and an empty answer isn't stored.

Limits on each question:
- at most `TILES_COPILOT_MAX_ROUNDS` model calls;
- a tool result is cut at 20,000 characters;
- one answer at a time per conversation (one that has stored nothing for 10 minutes counts as lost), and it can't be deleted meanwhile;
- a conversation takes a question only while it has room for every round of the answer (200 messages in all), and while what it sends the model stays under about 400,000 characters;
- tokens are counted for every model call, including those of an answer that broke off;
- the cost limits below.

### Cost and latency (T4.07)

The prompt is cached. Each model call marks three cache breakpoints: after the tools, after the system prompt, and after the last message. Every call of a question, and the next question in the conversation, starts with what the last call sent, so it reads that from the cache and writes only what is new.

Tokens are weighted by price, in input tokens (`assistant.billed`): an output token counts five, a cache write one and a quarter, and a cache read a tenth. Budgets and the dashboard both use this count, so a budget follows the cost and caching isn't held against anyone.

Each question is a row in `copilot_usage` (migration 0019) from the moment it is taken. The row records:
- the tokens of each model call (input, output, cache writes and cache reads);
- the time to the first text and to the end;
- how it ended (answered, failed, or over its budget), and whether the answer was grounded.

The row is updated with every message the question stores, so questions still being answered count against the limits. A deleted user's rows stay, without the user: the tokens were spent. The limits are:
- **Rate:** an organisation may ask `TILES_COPILOT_ORG_QUESTIONS_PER_MINUTE` questions a minute, and each person `TILES_COPILOT_USER_QUESTIONS_PER_MINUTE`.
- **Daily budget:** an organisation's questions may use `TILES_COPILOT_ORG_DAILY_TOKENS` billed tokens per UTC day.

A question over either limit is refused with 429 and `Retry-After`, before anything is stored. Questions from one organisation are admitted one at a time (an advisory lock), so two at once can't both take the last place.

A question stops calling the model when it reaches `TILES_COPILOT_QUESTION_TOKENS`, or when the organisation's daily budget runs out while it is answered. It ends with an `error` event that carries `"over_budget": true`. Both are checked before each model call, so the last call may go past them: one call is bounded by the conversation's length limit and `TILES_COPILOT_MAX_TOKENS`.

Admins read the site's usage on the Settings page (`GET /copilot/usage`). For each UTC day it shows:
- questions and how they ended, and answers the grounding check flagged;
- tokens, and the share of input read from the cache;
- the median and 95th percentile of the time to the first text and to the whole answer.

It also shows usage by person, the limits, and how much of today's organisation budget is used.

Conversations are private to their user. Anyone on the site may use the copilot, because its tools only read.

The tools (T4.02) are the browser copilot's skills on the site's real data:

| Tool | Gives |
|---|---|
| `site_overview` | the site's name, ontology nodes by type, signals, open warnings and those still out |
| `find_signals` | the signal catalogue's search: unit, description, node, asset, event kind, latest reading, quality |
| `graph_query` | one node (by id or label) with every node linked to it and how, and the signal tags mapped to it; or nodes by words and type |
| `ontology_health` | the health check: score, counts and issues (dangling or duplicate relationships, orphans, missing properties) |
| `time_series` | a signal over a range (default the day up to its latest reading, or the day from `from`): min, max, mean, first, last and up to 200 points |
| `wear_check` | the wear check (T3.13) on a signal |
| `virtual_sensors` | model bindings: model and version, input and output signals with their latest values, how the last run went |
| `events` | warnings (detector, peak, baseline, threshold, workflow and outcome) or events (downtime, scrap… codes), newest first; by default the 30 days up to `until` (now), plus every warning still open however long ago it started |
| `correlate` | the correlation finder on an uploaded batch table; without an outcome it lists the columns, with an unknown name the datasets |

A tool that can't answer says why in words the model can act on: the close signal tags or node labels, the datasets or columns there are, what was wrong with an input (the API's own checks become these messages). Each runs in its own read-only transaction.

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `GET /copilot` | members | `{"configured"}`: whether the copilot is on |
| `GET /copilot/conversations` | members | your conversations, latest first, with their message and token counts |
| `POST /copilot/conversations` | members | `{"title"?}` starts one (titled by its first question otherwise) |
| `GET /copilot/conversations/{id}` | its user | with `history`: every stored message, as Messages API content blocks, and its `meta` (an answer's grounding report) |
| `DELETE /copilot/conversations/{id}` | its user | removes it |
| `PUT /copilot/conversations/{id}/messages/{seq}/feedback` | its user | `{"rating": "up" \| "down", "comment"?}` on one of your answers (T4.04) |
| `DELETE /copilot/conversations/{id}/messages/{seq}/feedback` | its user | takes it back |
| `GET /copilot/usage?days` | admins | the site's usage over the last `days` (1–90, default 30) UTC days: `days` (latest first: questions, answered, failed, over budget, ungrounded, model calls, tokens by kind and billed, time to first text and to the end at the median and 95th percentile), `users` (questions and billed tokens), `today` (billed tokens of the organisation and of the site) and `limits` (T4.07) |
| `GET /copilot/feedback?rating&limit` | admins | the site's rated answers, newest first, each with its question, answer, whether it was grounded, the rating and comment, and who gave it: to improve the copilot and grow its evaluation set (T4.05) |
| `POST /copilot/conversations/{id}/messages` | its user | `{"text"}` asks; the answer streams back (`text/event-stream`); 503 while the copilot is off, 409 while it is still answering |

### Wear check (T3.13)

The demo copilot's welder check, for any signal. A wearing tool moves a signal's level: a welder tip's power climbs before its swap, a spindle's current or a cutter's force drifts.

The readings are cut into equal buckets, each kept as its median. The **baseline** is the median of the buckets in `baseline_hours` before the recent window. The **recent level** is the median of the last `last` buckets (4 by default) of the last `recent_hours`, so one odd bucket doesn't decide. The check also gives:
- the **change**: (recent − baseline) / |baseline|, so a fall is negative whatever the sign. It is **wearing** when the change reaches `threshold` (5% by default) in `direction` (`up`, `down` or `either`), and **stable** otherwise. It says **not enough data** below 6 baseline buckets, below `last` recent ones, or when the baseline is 0;
- the **slope** in the recent window, as the median of the slopes between every two buckets (Theil–Sen), so one spike can't tilt it;
- given a `limit`, about how long until the level reaches it at that pace.

On hourly buckets this is the browser's `wearCheck`; `test/fixtures/wear-check.json` (the demo welder) keeps the two matched.

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `POST /signals/{id}/wear-check` | members | `{"end"?, "recent_hours"? (24), "baseline_hours"? (72), "bucket_minutes"? (60), "direction"?, "threshold"?, "limit"?, "last"?}`: the verdict, baseline, recent level, change, slope per day, hours to the limit, a sentence, and the bucket medians. `end` defaults to just after the latest reading. Both windows are whole buckets; at most 120 days, 5,000 buckets, and 500 in the recent window |

The Data explorer runs it on each chart over the range shown. The recent window is the last day, or a quarter of a shorter range, and the buckets are the shortest that keep the range to 400.

### Saved insights (T3.12)

An **insight** is a finding worth keeping: a title, a summary, the actions it proposes, the query that found it and the evidence the query gave. Engineers save one from the Correlation finder (a correlation of a dataset) or the Data explorer (up to 8 signals over a time range). The API computes the evidence from the query itself, so it can't be made up. It is kept as it was when saved, so the insight still shows what was seen after the data changes or the dataset is deleted. A correlation keeps its 60 largest effects and every effect its explanations name; a signal keeps at most 1,000 points.

Each insight has a number per site, never reused, so `#/insights/<number>` keeps linking to the same one. It waits for review until another engineer accepts or rejects it; rejecting needs a note. Its author (or an admin) can edit the title, summary and actions while it waits, reopen it after a review, or delete it. The query and evidence never change: a different finding is a new insight.

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `GET /insights?status&limit&offset` | members | newest first, without the evidence; `status` is `proposed`, `accepted` or `rejected` |
| `GET /insights/{number}` | members | one, with its `query` and `evidence` |
| `POST /insights` | engineers | `{"title", "summary"?, "actions"?, "source"}`, where `source` is `{"kind": "correlation", "dataset_id", "outcome", "ng_values"?, "variables"?, "split"?, "min_effect"?}` or `{"kind": "series", "signals", "start", "end", "points"?}` |
| `PATCH /insights/{number}` | its author, admins | `{"title"?, "summary"?, "actions"?}` while it waits for review |
| `POST /insights/{number}/review` | other engineers | `{"decision": "accepted" \| "rejected", "note"}` |
| `POST /insights/{number}/reopen` | its author, admins | back to waiting for review |
| `DELETE /insights/{number}` | its author, admins | removes it |

### Backtest (T3.05)

Before a detector goes live, replay the signal's history with the settings you are considering, and score the warnings against the events they should have warned of (downtime or scrap, with their times). For each combination of the values given: **recall** (the share of events with a warning in time), **precision** (the share of warnings an event followed), **false warnings per day**, and the **warning time** from warning to event (its median, 10th and 90th percentile). A warning counts for an event when it started within `horizon_seconds` before it. The event's warning time comes from the earliest such warning, as in the browser. A warning that no event followed within the horizon is false, unless the history ends first: then it is *pending* and left out of precision. Only the events within the replayed history (from when the baseline fills to the last reading) count, for recall and precision alike. The settings come back best first: the most events warned of, then the fewest false warnings per day, then the longest median warning time.

The replay raises exactly the warnings a detector with that setting would raise (it shares the detector's judgement, and computes the same baselines faster). It changes nothing, but it runs in the request and takes seconds, so engineers run it, at most two at a time (a third gets 429). One backtest replays at most 200,000 readings, with at most 48 settings, 2 million readings × settings, and 600,000 readings × window sizes. Choose a shorter period or fewer settings when it says so.

| Method and path (under `/sites/{site_id}`) | Who | Does |
|---|---|---|
| `POST /backtest` | engineers | `{"signal_id", "events": [{"at", "code"?}], "horizon_seconds", "start"?, "end"?, "window"?: [...], "k"?: [...], "persist"?: [...], "direction"?: [...], "cooldown"?: [...], "flat_spread"?: [...]}`: each setting's scores and events, best first, and the Markdown `report` |

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
