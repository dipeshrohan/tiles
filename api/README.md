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
| Tenancy | `orgs`, `sites`, `users` (role: viewer, engineer or admin; OIDC issuer + subject) |
| Ontology | `ontology_nodes`, `ontology_edges` (working graph per site), `commits` (ops, inverses, stats; ordered by `seq`), `staged_ops` (per user and site) |
| Plant data | `signals` (tag, unit, sample rate, mapped node), `events` (TimescaleDB hypertable: downtime, scrap, maintenance, alarms) |
| Design | `models` (key + version per org), `runs` (params, outputs, parent run for lineage) |
| Audit | `audit_log`: append-only, enforced by a trigger |

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
| `TILES_DEV_USER_EMAIL`, `TILES_DEV_USER_NAME` | `demo@example.com`, `Demo User` | Who requests act as before sign-in exists (not in production) |

## Endpoints

- `GET /health`: liveness. Always 200 while the process runs; does not touch dependencies.
- `GET /ready`: readiness. 200 when PostgreSQL and Redis answer, otherwise 503 with which check failed (no connection details in the response).
- `GET /docs`: OpenAPI docs.
- `GET /sites`: sites you can open (id, slug, name, org). `uv run tiles-seed` creates the demo org and site; Compose runs it for you.

### Ontology

Each site has one committed graph (`head`) and a commit history. Each user stages their own changes until they commit or discard them. Every change is validated against the graph it applies to; a change that no longer fits (say someone else removed the node) gets a 409 with the same message the browser shows.

| Method and path (under `/sites/{site_id}/ontology`) | Does |
|---|---|
| `GET /graph?view=working` | head plus your staged changes (`view=head` for the committed graph) |
| `GET /staged` | your staged ops, in order |
| `POST /staged` | stage one op (`addNode`, `removeNode`, `addEdge`, `removeEdge`, `setProp`); returns all your staged ops |
| `DELETE /staged` | discard your staged ops |
| `POST /commits` | commit your staged ops: `{"message": "..."}` |
| `GET /commits?limit=50&offset=0` | history, newest first |
| `POST /commits/{id}/revert` | commit the inverse of a commit |

Ops, graphs and commits have the same JSON shape as in the browser (`js/lib/types.ts`). The logic in `tiles_api/ontology.py` is a port of `js/lib/ontology.ts`. Both run the shared fixture suite in `test/fixtures/ontology-parity.json`, and the API tests replay it over HTTP too. After changing the TypeScript behaviour, regenerate the fixtures with `UPDATE_FIXTURES=1 npx vitest run test/ontology-parity.test.js`, then make the Python port pass.

Until single sign-on lands (T1.16), requests act as `TILES_DEV_USER_EMAIL` (default `demo@example.com`), or as the email in an `X-Tiles-User` header. With `TILES_ENV=production` they are refused with 401.
