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

### Edge agent (`edge/`)

From `edge/`: `uv sync --all-extras` once, then `uv run pytest -W error`, `uv run mypy`, `uv run ruff check .` and `uv run ruff format .`. The agent's core uses only the standard library; keep it that way, so it also ships as one zipapp file. A connector that needs a protocol library (like OPC UA's `asyncua`) is an optional extra, imported only when configured. See [edge/README.md](edge/README.md).

### Full stack

`docker compose up --build --wait` starts PostgreSQL + TimescaleDB, Redis, Keycloak (sign-in; users `demo`/`demo`, `admin`/`admin`, `viewer`/`viewer`), the API and the web server, applies database migrations, and waits until all are healthy. `docker compose down -v` stops them and deletes the data volume.

Behind a TLS-intercepting proxy (some corporate networks and sandboxes), the image build can fail at `pip install` with a certificate error. Build the API image from a copy of `api/` with your proxy's CA added (`COPY ca.crt …` plus `SSL_CERT_FILE`/`PIP_CERT`), tag it `tiles-api:dev`, then run `docker compose up --no-build --wait`. Don't commit proxy certificates. If quay.io is blocked, pull Keycloak through a mirror and retag it: `docker pull mirror.gcr.io/keycloak/keycloak:26.4 && docker tag mirror.gcr.io/keycloak/keycloak:26.4 quay.io/keycloak/keycloak:26.4`.

Add a line to the top section of `CHANGELOG.md` (the next version, marked Unreleased) for any change people will notice, and keep migrations reversible; see [releasing](docs/releasing.md).

CI runs lint and typecheck, unit tests on Node 22 and 24, the browser tests, the API and edge agent checks (ruff, strict mypy, pytest; the API's against a TimescaleDB service), a point-in-time restore drill (`deploy/backup/pitr-drill.sh`), a full `docker compose up` smoke test, which also registers an edge agent and runs its container against the API, and the Helm chart (lint, kubeconform, then an install, a job run and an upgrade on a kind cluster; see `deploy/helm/tiles/README.md`), on every pull request. All must pass before merging.

### Security scanning (T5.08)

The CI's **Dependency and container scanning** job fails a pull request in three cases:
- `npm audit` finds a high or critical advisory in the npm dependencies;
- `pip-audit` finds any known vulnerability in the API's or the edge agent's locked dependencies;
- Trivy finds a high or critical vulnerability that has a fix in the API or edge agent image.

The job also writes software bills of materials in CycloneDX: the source tree and both images, as the `sbom` artifact of each run. Dependabot opens weekly update pull requests for npm, both `uv` projects, the images' base and the GitHub Actions (`.github/dependabot.yml`).

To run the same checks locally (as CI runs them):

```
npm audit --audit-level=high
for p in api edge; do (cd $p && uv export --locked --all-extras --no-dev --no-hashes --no-emit-project --format requirements-txt > /tmp/$p.txt) && uvx pip-audit==2.10.1 --strict --no-deps --disable-pip -r /tmp/$p.txt; done
docker build --pull --no-cache -t tiles-api:scan api && docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy:0.56.2 image --db-repository mirror.gcr.io/aquasec/trivy-db:2 --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed tiles-api:scan
```

Only what ships is audited: the development tools (pytest, mypy, ruff) aren't in the images. The images install the base's security updates, which needs the Debian mirrors as well as PyPI and Docker Hub. A cached build keeps old packages, so rebuild with `--pull --no-cache` now and then. Dependabot doesn't bump the pinned scanners (`aquasec/trivy`, `pip-audit`) or uv; bump them by hand when updating CI.

A finding without a fix yet doesn't fail the build. For one that can't be fixed in time, an exception goes in a `.trivyignore` with the reason and an expiry date, reviewed like any change.

## Conventions

- **Logic in `js/lib`, rendering in `js/views`, all strict TypeScript.** Library modules are pure and unit-tested; views turn state into HTML and wire up events with the helpers in `js/lib/dom.ts`. Domain types live in `js/lib/types.ts`, app and view types in `js/views/types.ts`.
- **Every bug fix ships with a regression test.** Never skip or disable a test to get green.
- **No runtime dependencies** in the browser app. Dev dependencies are fine.
- **Synthetic data is seeded**, so results are reproducible; keep it that way.
- **Start from the style guide** (`#/styleguide`, linked from Settings → About): it shows each token and component with the code for it.
- **Build pages from the components** in `js/lib/ui.ts` (`button`, `badge`, `card`, `field`, `select`, `table`, `tabs`, `pageHead`, `errorState`…): they escape what they show and keep pages alike.
- **No inline styles.** Use a component class, or the utilities at the end of `css/styles.css` (`.gap-2`, `.mt-3`, `.grow`, `.wrap`, `.justify-between`, `.text-bad`…; the number is the `--space-*` step). `npm run lint` refuses a `style` attribute unless its value is computed, like a chart's width.
- **Escape user-visible strings** with `esc()` from `js/lib/dom.js` when building HTML.
- **Accessible to keyboard and screen-reader users (WCAG 2.1 AA).** `e2e/a11y.test.js` runs axe on every page, in light and dark, and fails on any violation. So:
  - make controls `<button>`s and `<a>`s, not clickable `div`s;
  - give every form field a label, and every table column a header (an `sr-only` one for a column of buttons);
  - draw charts with `js/lib/svg.ts`, which names each one and summarises its numbers for screen readers (pass a `title`);
  - colour text with the tokens that meet 4.5:1, such as `--muted`, `--soft` and `--warn-ink` (`--warn` is for lines and borders);
  - never let colour alone carry meaning: links inside text are underlined, and states have words.
- **Commit messages:** a short imperative summary line, then why the change was made.

## Planning

The plan is in [docs/ROADMAP.md](docs/ROADMAP.md), the task breakdown in [docs/TASKS.md](docs/TASKS.md), and the live tracker is GitHub Issues, one parent issue per month. Architecture decisions are recorded in [docs/adr](docs/adr/README.md).

Reference an issue in your PR (for example `Closes #15`) so it closes on merge.
