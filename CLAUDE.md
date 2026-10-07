# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is
Tiles is a browser app for industrial R&D and shopfloor teams: a factory ontology with Git-style change history, physics-based virtual sensors, a correlation finder, a design studio and a copilot. It is currently front-end only, with seeded synthetic data. The roadmap (docs/ROADMAP.md) adds a Python backend and real plant data.

## Commands
- `npm run build`: regenerate `js/tiles.bundle.js`. **Required after editing anything in `js/`**; `npm test` fails if the bundle is stale.
- `npm run lint`: ESLint and Prettier check. `npm run format` fixes formatting and rebuilds.
- `npm test`: bundle check plus unit tests (node:test).
- `npm run test:e2e`: Playwright smoke tests. In Claude Code cloud sessions Chromium is preinstalled; do not run `playwright install` there.
- `npm start`: serve on http://localhost:5173.

## Layout
- `js/lib/`: pure logic (ontology, physics, analysis, design models, copilot routing, stats, charts). Unit-tested in `test/`.
- `js/views/`: one module per page; each exports `{ id, title, icon, render(ctx), bind(root, ctx) }`.
- `js/app.js`: state, router, persistence (localStorage via `js/lib/store.js`).
- `build.js`: zero-dependency bundler. It only supports single-line `import { a } from './x.js'`, `import x from './x.js'`, `export function|const` and `export default`; keep imports in those forms.
- `server.js`: static server; exports `createTilesServer()` for tests.
- `docs/`: roadmap, task list and ADRs.

## Rules
- Add or update tests with every behaviour change; never skip or disable a test.
- Keep the browser app free of runtime dependencies.
- Escape any interpolated text with `esc()` when building HTML strings.
- Task IDs (T1.01 …) map to GitHub issues; reference the issue in PRs.
