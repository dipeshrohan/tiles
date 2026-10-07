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

CI runs lint and typecheck, unit tests on Node 22 and 24, and the browser tests on every pull request. All must pass before merging.

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
