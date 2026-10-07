# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is
Tiles is a browser app for industrial R&D and shopfloor teams: a factory ontology with Git-style change history, physics-based virtual sensors, a correlation finder, a design studio and a copilot. It is currently front-end only, with seeded synthetic data. The roadmap (docs/ROADMAP.md) adds a Python backend and real plant data.

## Commands
- `npm run build`: Vite build of `js/app.ts` into `js/tiles.bundle.js` (one classic script, so `index.html` works from `file://`). **Required after editing anything in `js/`**; `npm test` fails if the bundle is stale. `npm run dev` rebuilds on save.
- `npm run lint`: ESLint and Prettier check. `npm run format` fixes formatting and rebuilds.
- `npm run typecheck`: strict TypeScript (`tsc`, includes `noUncheckedIndexedAccess`).
- `npm test`: Vitest unit tests, including the bundle freshness check.
- `npm run test:e2e`: Playwright smoke tests. In Claude Code cloud sessions Chromium is preinstalled; do not run `playwright install` there.
- `npm start`: serve on http://localhost:5173.
- `docker compose up --build --wait`: full stack (TimescaleDB, Redis, API on 8000, web on 5173); `docker compose down -v` resets it. In cloud sessions Docker Hub may rate-limit and the TLS proxy breaks in-container `pip`; see CONTRIBUTING for the workaround.
- Backend (`api/`, Python 3.12+, managed with `uv`): `uv sync`, then `uv run tiles-api` (port 8000), `uv run pytest -W error`, `uv run mypy` (strict), `uv run ruff check .` and `uv run ruff format .`. Run them from `api/`. Database tests need `TILES_TEST_DATABASE_URL` (they are skipped locally without it and fail in CI). Schema changes go in a new migration: `uv run tiles-migrate revision "…"`.

## Layout
- `js/lib/*.ts`: pure logic in strict TypeScript (ontology, physics, analysis, design models, copilot routing, stats, charts). Shared types in `js/lib/types.ts`. Import with the `.ts` extension. Unit-tested in `test/`.
- `js/views/*.ts`: one module per page; each default-exports a `View` (`{ id, title, icon, render(ctx), bind(root, ctx) }`, see `js/views/types.ts`). Per-page UI state goes through a typed `uiState(ctx)` helper with defaults.
- `js/app.ts`: state, router, persistence (localStorage via `js/lib/store.ts`).
- `vite.config.js`: builds the IIFE bundle and configures Vitest. `scripts/check-bundle.js` compares a fresh build with the committed bundle.
- DOM helpers in `js/lib/dom.ts`: `need()` (querySelector that throws if missing), `field()` (form values), `onAll()` and `onSubmit()` (typed event wiring). Prefer them over raw querySelector in views.
- `server.js`: static server; exports `createTilesServer()` for tests.
- `api/src/tiles_api/`: FastAPI service. `main.py` has `create_app(settings)` and the request-ID/JSON-logging middleware; `settings.py` reads `TILES_*` env vars; `logging.py` is the JSON formatter; `db.py` runs the Alembic migrations in `migrations/versions/` (plain SQL, no ORM); `ontology.py` ports `js/lib/ontology.ts`, `ontology_store.py` persists it and `api_ontology.py` serves it. Both ontology implementations must pass `test/fixtures/ontology-parity.json`; change them together. Tests in `api/tests/` use `TestClient(create_app(settings))`.
- `docs/`: roadmap, task list and ADRs.

## Rules
- Add or update tests with every behaviour change; never skip or disable a test.
- Keep the browser app free of runtime dependencies.
- Escape any interpolated text with `esc()` when building HTML strings.
- Task IDs (T1.01 …) map to GitHub issues; reference the issue in PRs.
