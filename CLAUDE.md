# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is
Tiles is a browser app for industrial R&D and shopfloor teams: a factory ontology with Git-style change history, physics-based virtual sensors, a correlation finder, a design studio and a copilot. It is currently front-end only, with seeded synthetic data. The roadmap (docs/ROADMAP.md) adds a Python backend and real plant data.

## Commands
- `npm run build`: Vite build of `js/app.js` into `js/tiles.bundle.js` (one classic script, so `index.html` works from `file://`). **Required after editing anything in `js/`**; `npm test` fails if the bundle is stale. `npm run dev` rebuilds on save.
- `npm run lint`: ESLint and Prettier check. `npm run format` fixes formatting and rebuilds.
- `npm run typecheck`: strict TypeScript (`tsc`, includes `noUncheckedIndexedAccess`).
- `npm test`: Vitest unit tests, including the bundle freshness check.
- `npm run test:e2e`: Playwright smoke tests. In Claude Code cloud sessions Chromium is preinstalled; do not run `playwright install` there.
- `npm start`: serve on http://localhost:5173.

## Layout
- `js/lib/*.ts`: pure logic in strict TypeScript (ontology, physics, analysis, design models, copilot routing, stats, charts). Shared types in `js/lib/types.ts`. Import with the `.ts` extension. Unit-tested in `test/`.
- `js/views/`: one module per page; each exports `{ id, title, icon, render(ctx), bind(root, ctx) }`.
- `js/app.js`: state, router, persistence (localStorage via `js/lib/store.js`).
- `vite.config.js`: builds the IIFE bundle and configures Vitest. `scripts/check-bundle.js` compares a fresh build with the committed bundle.
- `js/views/*.js` and `js/app.js` are still JavaScript (task T1.08 ports them).
- `server.js`: static server; exports `createTilesServer()` for tests.
- `docs/`: roadmap, task list and ADRs.

## Rules
- Add or update tests with every behaviour change; never skip or disable a test.
- Keep the browser app free of runtime dependencies.
- Escape any interpolated text with `esc()` when building HTML strings.
- Task IDs (T1.01 …) map to GitHub issues; reference the issue in PRs.
