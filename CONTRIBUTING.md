# Contributing to Tiles

## Setup

Requires Node 22.12 or newer.

```bash
npm ci                              # dev tools: ESLint, Prettier, Playwright
npx playwright install chromium     # once, for the browser tests
npm start                           # http://localhost:5173
```

You can also open `index.html` straight from disk.

## Everyday commands

| Command | What it does |
|---|---|
| `npm run build` | Vite build of `js/` into `js/tiles.bundle.js`. Run after any change in `js/`. |
| `npm run dev` | Rebuilds the bundle on every save; reload `index.html` to see changes. |
| `npm run format` | Formats with Prettier, then rebuilds the bundle. |
| `npm run lint` | ESLint (JavaScript and TypeScript) plus a Prettier check. |
| `npm run typecheck` | Strict TypeScript check of everything in `js/`. |
| `npm test` | Vitest unit tests in `test/`, including a check that the bundle is current. |
| `npm run test:e2e` | Browser smoke tests in `e2e/`: every page in light, dark and phone layouts, over http and `file://`. |

### Backend (`api/`)

Requires [uv](https://docs.astral.sh/uv/). From `api/`: `uv sync` once, then `uv run tiles-api`, `uv run pytest -W error`, `uv run mypy`, `uv run ruff check .` and `uv run ruff format .`. Database tests need `TILES_TEST_DATABASE_URL` (for example the Compose `db` service); schema changes go in a new migration (`uv run tiles-migrate revision "…"`). Configuration is via `TILES_*` environment variables; see [api/README.md](api/README.md).

### Full stack

`docker compose up --build --wait` starts PostgreSQL + TimescaleDB, Redis, Keycloak (sign-in; users `demo`/`demo`, `admin`/`admin`, `viewer`/`viewer`), the API and the web server, applies database migrations, and waits until all are healthy. `docker compose down -v` stops them and deletes the data volume.

Behind a TLS-intercepting proxy (some corporate networks and sandboxes), the image build can fail at `pip install` with a certificate error. Build the API image from a copy of `api/` with your proxy's CA added (`COPY ca.crt …` plus `SSL_CERT_FILE`/`PIP_CERT`), tag it `tiles-api:dev`, then run `docker compose up --no-build --wait`. Don't commit proxy certificates. If quay.io is blocked, pull Keycloak through a mirror and retag it: `docker pull mirror.gcr.io/keycloak/keycloak:26.4 && docker tag mirror.gcr.io/keycloak/keycloak:26.4 quay.io/keycloak/keycloak:26.4`.

CI runs lint and typecheck, unit tests on Node 22 and 24, the browser tests, the API checks (ruff, strict mypy, pytest against a TimescaleDB service) and a full `docker compose up` smoke test on every pull request. All must pass before merging.

## Conventions

- **Logic in `js/lib`, rendering in `js/views`, all strict TypeScript.** Library modules are pure and unit-tested; views turn state into HTML and wire up events with the helpers in `js/lib/dom.ts`. Domain types live in `js/lib/types.ts`, app and view types in `js/views/types.ts`.
- **Every bug fix ships with a regression test.** Never skip or disable a test to get green.
- **No runtime dependencies** in the browser app. Dev dependencies are fine.
- **Synthetic data is seeded**, so results are reproducible; keep it that way.
- **Escape user-visible strings** with `esc()` from `js/lib/dom.js` when building HTML.
- **Commit messages:** a short imperative summary line, then why the change was made.

## Planning

The plan is in [docs/ROADMAP.md](docs/ROADMAP.md), the task breakdown in [docs/TASKS.md](docs/TASKS.md), and the live tracker is GitHub Issues, one parent issue per month. Architecture decisions are recorded in [docs/adr](docs/adr/README.md).

Reference an issue in your PR (for example `Closes #15`) so it closes on merge.
