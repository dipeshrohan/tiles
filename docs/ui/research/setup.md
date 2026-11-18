# Setting up a session

How to get Tiles into the same state before every session of [the study](README.md), so each participant, in both rounds, sees the same site, machines, warnings and signals. It takes about five minutes the first time and under a minute between sessions. The steps were tried on 18 Nov 2026 against `main`, with the database in its own container on another port (as in [When something goes wrong](#when-something-goes-wrong)) because 5432 was taken.

## Contents

- [Which Tiles to use](#which-tiles-to-use)
- [Once, on the study laptop](#once-on-the-study-laptop)
- [Before each session](#before-each-session)
- [The participant's browser](#the-participants-browser)
- [During the session](#during-the-session)
- [After the session](#after-the-session)
- [When something goes wrong](#when-something-goes-wrong)

## Which Tiles to use

| Setup | What it has | Use it for |
| --- | --- | --- |
| Tiles API with the evaluation plant (below) | Plant 1 with Line 2's die-casting cells DC-01 and DC-02, five signals over three days, two open warnings, one downtime event list and SOP 14 (`load` in `api/src/tiles_api/evaluation/plant.py`) | Every session. The [task cards](cards.md) are written for it |
| This browser only (`npm start`, no API) | The demo plant in the browser | A dry run of the welcome only. Warnings, Signals, Data explorer, Correlation finder, Change reviews, Insights and 5 more pages show only that they need the Tiles API, so 4 of the 6 key tasks can't be done |
| The fake API (`e2e/fake-api.js`) | An in-memory API for the browser tests, empty until a test fills it, on a random port | Nothing here: it is not meant for people |
| A sample plant (`uv run tiles-sample-plant load die-casting …`) | A year of Aldermoor Castings | Not this study: its machines and tags differ from the cards. Use it only if both rounds change their cards together |

## Once, on the study laptop

You need Docker, Node.js 22, and [uv](https://docs.astral.sh/uv/) for the API. From the repository's root:

```sh
npm ci
(cd api && uv sync)
```

The copilot task needs the copilot service: an Anthropic API key and the model your deployment's copilot uses, set as `TILES_ANTHROPIC_API_KEY` and `TILES_COPILOT_MODEL` in the shell that starts the API (see the [admin guide](../../guides/admin.md)). Without them, Tiles' built-in skills answer instead, and they can't answer the task's question: leave the `copilot` task out of the round and say so in the report.

Write the batch table for the correlation task to the desktop. It is the 720 cutter batches the browser tests use (`generateCutterBatches` in `js/lib/data.ts`), rounded to one decimal:

```sh
node --input-type=module -e "
import { generateCutterBatches } from './js/lib/data.ts';
const cols = ['id', 'material', 'tension', 'speed', 'humidity', 'bladeAge', 'rollDiameter', 'ng'];
const cell = (r, k) => (k === 'ng' ? (r.ng ? 'yes' : 'no') : typeof r[k] === 'number' ? r[k].toFixed(1) : r[k]);
console.log([cols.join(','), ...generateCutterBatches().map((r) => cols.map((k) => cell(r, k)).join(','))].join('\n'));
" > ~/Desktop/batches.csv
```

## Before each session

Start from an empty database, so nothing a previous participant did is left. Use three terminals, each at the repository's root.

**Terminal 1, the database and the site:**

```sh
docker compose down -v
docker compose up -d --wait db
cd api
export TILES_DATABASE_URL=postgresql://tiles:tiles-dev@localhost:5432/tiles
uv run tiles-migrate upgrade
uv run tiles-seed
```

`tiles-seed` prints `Demo site: <id>`. Keep the id: `SITE=<id>`.

**Terminal 2, the API** (stop it with Ctrl C and start it again after every reset; it keeps connections to the old database):

```sh
cd api
export TILES_DATABASE_URL=postgresql://tiles:tiles-dev@localhost:5432/tiles
export TILES_ANTHROPIC_API_KEY=… TILES_COPILOT_MODEL=…   # only for the copilot task
uv run tiles-api
```

**Terminal 3, the web app** (leave it running between sessions):

```sh
TILES_API_URL=http://localhost:8000 npm start
```

**Back in terminal 1, load the plant and the people.** The plant's readings end an hour before it is loaded, so load it just before the session:

```sh
uv run python -c "
import datetime, httpx2
from tiles_api.evaluation import plant
with httpx2.Client(base_url='http://localhost:8000', timeout=60) as api:
    plant.load(api, '$SITE', {'X-Tiles-User': 'moderator@example.com'}, datetime.datetime.now(datetime.UTC))
print('Plant loaded')
"
# Someone to hand a warning to in the triage task
curl -s localhost:8000/sites/$SITE/me -H 'X-Tiles-User: maintenance@example.com' > /dev/null
# The moderator approves the participant's change request, and turns the copilot on
docker compose exec db psql -U tiles -d tiles -c "UPDATE users SET org_admin = true WHERE email = 'moderator@example.com'"
curl -s -X PUT localhost:8000/sites/$SITE/copilot/policy -H 'X-Tiles-User: moderator@example.com' \
  -H 'Content-Type: application/json' -d '{"enabled": true}'
```

Check: `curl -s localhost:8000/sites/$SITE/warnings` lists two warnings on `dc01.plunger_friction`.

The API runs with its development sign-in: a request without a token acts as `demo@example.com`, or as the email the browser's Settings page names. All emails here are `example.com` and participants are known only by their code.

## The participant's browser

Chrome or Edge at 1440 × 900, in a new guest or private window so nothing is kept from the last participant. Set its language to English (UK): date and time fields follow the browser's language, and with English (US) they show mm/dd/yyyy and AM/PM while the pages write 18 Nov 2026 and 24-hour times.

1. Open http://localhost:5173/#/settings. If the welcome opens, choose **Just look around**: it is for the development user, not the participant.
2. Under **Profile**, set **Email** to the participant's code, `p01@example.com` for P01, and **Save**. The top bar's account shows the new email; Tiles makes them an engineer on Plant 1.
3. Reload. The welcome opens for the new person: hand the laptop over on it for the [first-page task](cards.md#first-page). If it doesn't open, open it from **Help**, **Show the welcome**: it is the same dialog, but note it in the participant's row.

## During the session

- **Commit task:** when the participant says the change is sent for review, approve it as the second engineer, the moderator:

  ```sh
  curl -s -X POST localhost:8000/sites/$SITE/ontology/reviews/1/approve -H 'X-Tiles-User: moderator@example.com' \
    -H 'Content-Type: application/json' -d '{"comment": "Approved for the study"}'
  ```

  The number is 1 in a fresh database; `curl -s localhost:8000/sites/$SITE/ontology/reviews` lists them.

- **Site task:** it needs an organisation admin. Just before it, make the participant one, and reload their page:

  ```sh
  docker compose exec db psql -U tiles -d tiles -c "UPDATE users SET org_admin = true WHERE email = 'p01@example.com'"
  ```

  Their Home shows an admin's cards from then on, which is why the site task comes last.

- The Import data page lists the plant's five files as "not finished". That is how the loader leaves them, not something the participant did.

## After the session

- Fill in the participant's rows in the round's `tasks.csv`, `sus.csv` and `participants.csv` ([recording](README.md#recording)) the same day.
- Keep the screen recording where the [consent form](consent.md) says, never in this repository.
- Reset with [Before each session](#before-each-session) for the next participant.

## When something goes wrong

- **`docker compose up` fails with 429 Too Many Requests:** Docker Hub's rate limit. Pull the database image through Google's mirror and tag it: `docker pull mirror.gcr.io/timescale/timescaledb:2.30.2-pg17 && docker tag mirror.gcr.io/timescale/timescaledb:2.30.2-pg17 timescale/timescaledb:2.30.2-pg17`.
- **Port 5432 is taken** by another PostgreSQL: stop it, or run the image on another port (`docker run -d --name study-db -e POSTGRES_USER=tiles -e POSTGRES_PASSWORD=tiles-dev -e POSTGRES_DB=tiles -p 127.0.0.1:55432:5432 timescale/timescaledb:2.30.2-pg17`) and use that port in `TILES_DATABASE_URL`. To reset it, drop and create the database (`docker exec study-db psql -U tiles -d postgres -c "DROP DATABASE tiles WITH (FORCE)" -c "CREATE DATABASE tiles"`) and run the steps from `tiles-migrate` on.
- **Loading the plant fails with a 500** after a reset: the API still holds the old database's connections. Restart it (terminal 2) and load again.
- **Loading fails with `the ontology: 409 … Node line-2 already exists`:** the plant is already in this database. Reset and load once.
- **The copilot says it is off:** the API was started without the two copilot settings, or the site's policy wasn't turned on. Set them, restart the API, and run the policy `curl` again.
