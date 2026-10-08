# Tiles

**A workspace for industrial R&D and shopfloor teams: factory model, virtual sensors, root-cause analysis and design studies.**

Tiles is a zero-dependency web app that pairs first-principles physics with plant data. It has two halves:

| | Tiles Design (R&D) | Tiles Operations (shopfloor) |
|---|---|---|
| Who | R&D, simulation and process engineers | Production, quality and maintenance teams |
| What | Versioned physics models, parameter sweeps, sensitivity, run lineage, audit export | Factory ontology, virtual sensors, correlation finder, predictive maintenance, copilot |

![Home](docs/home.png)

## Run it

**Quickest:** open `index.html` in your browser (double-click it). No install needed.

**With a local server:**

```bash
npm start        # node server.js → http://localhost:5173
npm test         # checks the bundle is current, then runs the unit tests
```

Requires Node 22.12+ for the server and tests. See [CONTRIBUTING.md](CONTRIBUTING.md) for linting, formatting and the browser tests.

The source lives in `js/`, in strict TypeScript. Browsers block module scripts on pages opened from disk, so the page loads a single generated file, `js/tiles.bundle.js`. After editing anything in `js/`, run `npm run build` to regenerate it; `npm test` fails if you forget.

## What's inside

- **Copilot.** Ask a question in plain language. The copilot picks a skill (graph query, correlation analysis, virtual sensor, change detection or health check), runs it on the plant data, and shows each step it took. It runs fully offline.
- **Ontology builder.** A typed factory graph (Site → Workcenter → Line → Machine, plus processes, materials, PLCs, signals, documents and models). Edits are staged and then committed with a message and author, Git style. Any commit can be reverted. The health check flags orphan nodes, dangling or duplicate relationships, and missing required properties, and offers a one-click fix.
- **Process & quality.**
  - *Correlation finder:* ranks process variables by effect size (Cohen's d) between failed and healthy batches. On pooled data nothing stands out. Split by material, it shows that front stock tension runs too high for anode sheets and too low for cathode sheets.
  - *Predictive maintenance:* welding power as a second tip-wear signal next to the cycle counter.
- **Factory physics.** A plunger-friction virtual sensor for a die-caster. Friction is solved from the equation of motion `m·a = Ph·Ah − Pm·Am − F` for every shot. Warnings fire against a rolling 200-shot robust baseline. Every seizure stop in the demo data is caught about 2 h ahead.
- **Design studio.** Cell swelling-force and humanoid-actuator models, each with several versions. Includes live parameter sliders, cross-version comparison, 2-D sweep heatmaps and sensitivity bars. Saved runs record their parent run, model version and exact parameters. Click a run to restore it, or export a JSON audit record.

![Process & quality](docs/quality.png)

![Factory physics](docs/physics.png)

## Full stack with Docker

```bash
docker compose up --build --wait
```

| Service | URL | What |
|---|---|---|
| web | http://localhost:5173 | the Tiles app |
| api | http://localhost:8000/docs | FastAPI backend (`/health`, `/ready`) |
| db | localhost:5432 | PostgreSQL 17 + TimescaleDB 2.30 (user `tiles`, password `tiles-dev`) |
| redis | localhost:6379 | job queue |
| keycloak | http://localhost:8080 | sign-in for development (realm `tiles`; users `demo`/`demo`, `admin`/`admin`, `viewer`/`viewer`) |

Ports bind to localhost only. `docker compose down -v` stops everything and deletes the database volume. Set `TILES_DB_PASSWORD` (in your shell or a git-ignored root `.env`) to change the database password. Use URL-safe characters only (letters, digits, `-._~`), since it goes into a connection URL. The password is applied only when the database volume is created, so run `docker compose down -v` after changing it; that deletes the data. A one-shot `migrate` service applies the database schema and creates a demo site before the API starts. The API so far serves health and readiness checks and the ontology (stage, commit, revert, history); the ontology page uses it when the data source is set to the Tiles API. See [api/README.md](api/README.md).

To point the app at the API, open **Settings → Data source**, choose *Tiles API* and use **Test connection**, or add `?api=http://localhost:8000` to the app's URL. The API accepts browser calls from `http://localhost:5173` (`TILES_CORS_ORIGINS`), so use the served app rather than `index.html` from disk. In API mode the ontology page reads and writes the site's shared history: everyone on the site sees each commit (use **Refresh**, or reload), while staged changes stay private until committed. On an empty site, **Load demo ontology** copies the demo graph in as one commit. Other pages still use this browser's data.

With the API selected, **Settings → Account → Sign in** signs you in through Keycloak (OpenID Connect with PKCE). Your name and email then come from your sign-in, and so does your role on a site the first time you open it. Viewers see the ontology read-only; engineers can change it; admins can also change members' roles and read the site's audit log (Settings → Audit log). In development you can skip signing in and act as the demo user; a production API (`TILES_ENV=production`) refuses requests without a valid token.

## Edge agent

Plant data reaches Tiles through an edge agent that runs on the plant network and only connects out, over TLS. It opens no ports. A site admin registers each agent under **Settings → Edge agents**, which shows its token once along with a config file to copy. The same card shows whether each agent is online. The agent is a small Python program with no dependencies, so it installs with pip, as one file or as a container. It reads OPC UA servers over signed and encrypted sessions, pinning each server's certificate, MQTT brokers over TLS, including Sparkplug B, and SQL databases (PostgreSQL, SQL Server, SQLite), read only. Readings wait in a buffer on disk until Tiles has stored them in TimescaleDB, so a network cut loses nothing. Settings shows each connector's status and the buffer. See [edge/README.md](edge/README.md).

**Signals** lists every tag the site has readings for, whether it came from an edge agent or an import. You can search it by tag, description or ontology node, and filter it by source or by whether the tag is linked. Each tag shows its latest reading. Engineers add a tag's unit, sample rate, description and expected range, and link it to its Signal node in the ontology. These changes are recorded in the audit log. Each tag also carries a quality badge (good, warnings, problems) from its latest data-quality check: gaps, values stuck for over an hour, values outside the expected range, readings the source marked bad, a unit that differs from the ontology node's, or an edge agent's tag that has gone quiet. **Check quality** checks the tags listed; `tiles-check-quality` checks whole sites, for example from cron.

**Map tags to the ontology** (on the Signals page) suggests a Signal node for each tag that has none. Either it links an existing node whose name and unit match, or it creates one under the PLC the tag comes from: the PLC of sibling tags already mapped, or of the machine the tag names (`press1.temperature` → Press 1). Each suggestion has a score and its reasons. A new node is staged for you to commit on the Ontology page; the tag then links to it in one click.

**Data explorer** plots up to eight signals over any time range, one chart each on a shared time axis: the last hour, day, week or month, the day up to the latest reading, or dates you choose. Drag across a chart to zoom in; zoom out and step earlier or later with the buttons. Long ranges are averaged into buckets by the API, with each bucket's minimum and maximum shaded, so spikes still show. Click a tag on the Signals page to plot it.

To backfill history, open **Import data** (API mode, engineers and admins). Choose a CSV file or a historian export, check how its columns map to signals (one column per signal, or one row per reading with tag and value columns), the time format and time zone, and import it. The file is read in the browser and sent in batches; readings Tiles already has are skipped, so importing a file twice is safe. Past imports are listed with who ran them and what they stored.

## Data model

The ontology's node types and relationships, and how they map to ISA-95 (Enterprise › Site › Area › Line or Cell › Machine), are described in [docs/data-model.md](docs/data-model.md).

## Roadmap

The 6-month plan to take Tiles from demo to a production pilot is in [docs/ROADMAP.md](docs/ROADMAP.md), with the task-by-task breakdown in [docs/TASKS.md](docs/TASKS.md).

## Data

All plant data is synthetic and generated from fixed seeds (`js/lib/data.ts`, `js/lib/physics.ts`), so results are reproducible. Ontology commits, design runs, chat history and profile are saved in the browser's `localStorage`. Use **Settings → Reset workspace** to start over.

## Layout

```
index.html            app shell
css/styles.css        theme tokens (light + dark) and components
js/app.ts             state, router, navigation
js/tiles.bundle.js    generated by Vite (npm run build); what index.html loads
js/lib/               pure, tested logic (strict TypeScript)
  ontology.ts         graph ops, staging/commit/revert, health check, queries
  physics.ts          shot simulation, friction estimation, alerting
  analysis.ts         correlation finder, wear check
  design.ts           physics model library, sweeps, sensitivity, run lineage
  copilot.ts          skill routing and traceable answers
  data.ts             seeded demo plant
  stats.ts, rng.ts    numerics
  svg.ts, dom.ts      charts and helpers
js/views/             one module per page
test/                 Vitest unit suites
e2e/                  Playwright browser smoke tests
docs/adr/             architecture decision records
server.js             zero-dependency static server
api/                  FastAPI backend (Python, uv)
edge/                 on-site edge agent (Python, standard library only)
docker-compose.yml    local stack: db, redis, api, web
vite.config.js        Vite build (classic bundle) and Vitest config
scripts/              bundle freshness check
```
