# Model-author guide

This guide is for engineers and data scientists who add a model to Tiles or change one. It covers how
a model is declared, versioned, tested, matched between the browser and the API, and run on plant
data. Every name below is a real name in the repository; follow the file paths to read the code.

Read [CLAUDE.md](../../CLAUDE.md) first for the repository layout and commands.

## 1. What a model is

A model in Tiles is two things:

- a **spec** (`ModelSpec` in `api/src/tiles_api/models/registry.py`): a stable key, a version, its
  inputs, its outputs and its bounded parameters;
- a **`run` method** that turns equal-length input series and parameter values into outputs.

The spec fields are:

| Field | Meaning |
| --- | --- |
| `key` | Stable name, lower-case letters, digits and dashes, for example `plunger-friction`. |
| `version` | `MAJOR.MINOR.PATCH`, for example `1.0.0`. A published version never changes. |
| `name`, `domain`, `description` | Shown in the model list and stored with the version. |
| `kind` | `"virtual-sensor"` (runs on signals) or `"design"` (runs on parameters only). |
| `inputs` | A tuple of `Port`: one series per input, each with a `unit`. |
| `outputs` | A tuple of `Port`, each `per="sample"` (one value per input sample) or `per="window"` (one value for the whole window: a shot, a batch). At least one is required. |
| `params` | A tuple of `Param`: a number with a `unit`, a `default`, and optional `min` and `max`. |

Input, output and parameter names must be lower-case letters, digits and underscores, and unique
within their group. `ModelSpec.__post_init__` checks all of this, and also that every default lies
within its bounds. A bad spec raises `ModelError` when the module is imported.

### Where models run

| Where | What runs | Code |
| --- | --- | --- |
| Model runner | A `virtual-sensor` version bound to a site's signals, on new data windows, writing derived signals | `models/runner.py`, `api_model_bindings.py`, `tiles-run-models` |
| Evaluate endpoint | Any version on series you post, nothing stored | `POST /sites/{site_id}/models/{key}/evaluate` in `api_models.py` |
| Design runs | A `design` version on parameters, stored with its lineage | `api_runs.py` |
| Sweeps | A `design` version over a grid of one or two parameters, as a background job | `sweeps.py`, `api_sweeps.py`, `tiles-run-sweeps` |
| Browser | The Design Studio's models and the plunger physics, without the API | `js/lib/design.ts`, `js/lib/physics.ts` |
| An organisation's service | Its own model versions, registered with their spec and called over HTTP ([section 10](#10-models-served-over-http)) | `models/remote.py`, `api_org_models.py` |

All API paths go through one checked entry point, `evaluate(model, inputs, params)` in
`registry.py`. Do not call a model's `run` directly from new code.

## 2. Writing a model, step by step

The worked example below follows the real plunger model, `api/src/tiles_api/models/plunger.py`
(`plunger-friction` 1.0.0). Read that file alongside this section.

### Step 1: create the module

Put the model in its own file under `api/src/tiles_api/models/`. Start with a docstring that says
what the model computes, where the equation comes from and, if it has a browser twin, which file and
fixture keep them matched. The plunger's docstring names `js/lib/physics.ts (estimateFriction)` and
`test/fixtures/plunger-shots.json`.

### Step 2: declare the spec

Give every port and parameter a unit. Units are stored with the version and become the unit of the
derived signal the runner writes.

```python
@register
class PlungerFriction:
    spec: ClassVar[ModelSpec] = ModelSpec(
        key="plunger-friction",
        version="1.0.0",
        name="Plunger friction",
        kind="virtual-sensor",
        domain="die casting",
        description="Friction on the shot plunger from one shot's velocity and pressures, ...",
        inputs=(
            Port("t", "s", "time of each sample"),
            Port("v", "m/s", "plunger velocity"),
            Port("ph", "bar", "hydraulic pressure"),
            Port("pm", "bar", "metal pressure"),
        ),
        outputs=(
            Port("force", "N", "residual force at each sample (none at the first)"),
            Port("friction", "N", "the shot's friction: median residual", per="window"),
        ),
        params=(
            Param("mass", "kg", 42, 1, 10_000, "plunger and rod"),
            Param("hydraulic_area", "m²", 0.0079, 1e-6, 10, "hydraulic piston area"),
            Param("metal_area", "m²", 0.0028, 1e-6, 10, "plunger tip area"),
        ),
    )
```

Points to copy:

- Give every parameter physical bounds (`min`, `max`). `evaluate` refuses values outside them, so the
  bounds are your first line of input validation.
- Convert units inside `run`, not in the caller. The plunger takes pressures in bar, as the plant
  logs them, and multiplies by `BAR = 1e5` to get pascals.
- Use `per="window"` for a summary of the whole window, such as the shot's friction.

### Step 3: write `run`

`run` receives the inputs as plain lists of finite floats (already checked) and the parameters with
defaults filled in. It returns a dict with exactly one list per output.

```python
def run(self, inputs: Mapping[str, Sequence[float]], params: Mapping[str, float]) -> dict[str, list[float | None]]:
    t, v, ph, pm = inputs["t"], inputs["v"], inputs["ph"], inputs["pm"]
    mass, ah, am = params["mass"], params["hydraulic_area"], params["metal_area"]
    force: list[float | None] = [None] if t else []  # no acceleration at the first sample
    for i in range(1, len(t)):
        dt = t[i] - t[i - 1]
        if dt <= 0:  # repeated or out-of-order timestamps: no acceleration to speak of
            force.append(None)
            continue
        acc = (v[i] - v[i - 1]) / dt
        force.append(ph[i] * BAR * ah - pm[i] * BAR * am - mass * acc)
    known = [f for f in force if f is not None]
    return {"force": force, "friction": [statistics.median(known) if known else None]}
```

Rules for `run`:

1. Return `None` (or NaN) where a value can't be computed. `evaluate` turns NaN and infinities into
   `None`, and the runner does not write `None` values.
2. Handle bad samples per sample where you can, as the plunger does with `dt <= 0`.
3. Raise `ValueError` or an `ArithmeticError` when the whole window can't be run (for example, a
   series too short). `evaluate` turns these into a `ModelError` that names the model and version.
4. Keep `run` pure: no database, no clock, no randomness. The same inputs must give the same outputs,
   every time, for as long as the version exists.

### Step 4: register it

The `@register` class decorator adds one instance to the default `registry`. Registering the same key
and version twice with different specs raises `ModelError`.

Then import your module in `api/src/tiles_api/models/__init__.py`, as the built-in models are:

```python
from tiles_api.models import design as design  # registers the Design Studio models (T4.10)
from tiles_api.models import plunger as plunger  # registers the model
```

Importing the package registers every built-in model; a module that is not imported there is never
registered.

### Step 5: know what `evaluate` checks for you

`evaluate` refuses, with a `ModelError` listing every problem at once:

- an input the spec doesn't know (`unknown input(s): ...`) or one that is missing (`missing input ...`);
- an input series longer than `MAX_POINTS` (1,000,000 values);
- values that aren't finite numbers, including `None`, `True` and infinities;
- input series of different lengths;
- unknown parameters, non-numeric parameters, and parameters outside `[min, max]`.

After `run`, it checks that the model returned exactly its declared outputs, with as many values as
the inputs for `per="sample"` outputs and one value for `per="window"` outputs. A model without
inputs (a design model) returns one value per output.

`check_params(spec, params)` runs the parameter checks alone. Bindings and sweeps use it to refuse bad
parameters before anything is stored.

Over HTTP, a `ModelError` from `evaluate` is a 422 with the message as `detail`, so write any
`ValueError` message you raise for a person to read.

### Step 6: try it

Start the API (`uv run tiles-api` from `api/`) and post to the evaluate endpoint. It accepts at most
100,000 values per input series and stores nothing.

```http
POST /sites/{site_id}/models/plunger-friction/evaluate
{"inputs": {"t": [0, 0.005, 0.01], "v": [0, 1, 2], "ph": [50, 50, 50], "pm": [10, 10, 10]},
 "params": {"mass": 42}}
```

Leave out `version` to get the latest one. `GET /sites/{site_id}/models` lists every registered
version; `GET /sites/{site_id}/models/{key}` lists one model's versions, newest first.

## 3. Versioning

### A published version is frozen

Runs, derived signals and audit records name the model version that made them. The binding's derived
signals carry the source `model:<key>@<version>`; design runs and sweeps store the key and version.
If a version's behaviour changed, those records would no longer say what made them. So a change in
behaviour is always a new version.

Three things guard this:

1. **`models/published.json`** pins each published version's `ModelSpec.fingerprint()`, a SHA-256 of
   everything the spec says (key, version, name, kind, domain, description, inputs, outputs, params).
2. **`test_every_registered_version_is_published_and_unchanged`** in `api/tests/test_models.py`
   fails if a registered version is missing from the file or its fingerprint differs. The failure
   message gives you the line to add:
   `add <key> <version>: <fingerprint> to models/published.json`.
3. **The `models` table.** `store.model_id(conn, org_id, model)` writes an organisation's row for a
   version the first time it is used (a binding, a design run or a sweep), with
   `ON CONFLICT (org_id, key, version) DO NOTHING`, and never rewrites it. If the stored spec differs
   from the registry's, it raises `ModelChanged` ("Give the change a new version"). Binding then fails
   with 500; design runs and sweeps fail with 409.

The fingerprint covers the spec only, not the code in `run`. A change to the formula that leaves the
spec alone passes the published test. It is caught instead by the parity tests (section 4), and by
`restore`, which refuses with 409 when a run's stored output differs from what its version gives now
("model ... changed"). Treat the `run` code of a published version as frozen too.

### Publishing a new version

1. Add a new class with the new `version`. Do not edit the old class. `models/design.py` keeps one
   class per version (`Swelling100`, `Swelling110`, `Swelling200`) and does not share formula code
   between versions, "so nothing a version computes is shared with another". Shared, unchanging
   declarations, such as `SWELLING_PARAMS`, are fine.
2. Decorate it with `@register`.
3. Run `uv run pytest -W error tests/test_models.py` from `api/`. Copy the fingerprint from the
   failure message into `published.json` under the model's key.
4. Add tests for the new behaviour, and update the parity fixture if the model has a browser twin.

`registry.get(key)` with no version returns the latest by numeric order (`1.10.0` after `1.9.0`), so
new bindings, runs and sweeps that leave out `version` pick up your new version. Existing bindings
stay pinned to the version they were created with.

### Major, minor or patch

The registry only enforces the `MAJOR.MINOR.PATCH` format. The repository's practice, from the
existing versions, is:

- **Minor** (`1.0.0` to `1.1.0`): the same inputs, outputs and parameters, with a refined formula.
  For example, `cell-swelling` 1.1.0 is "1.0.0 with a temperature term on the expansion and a linear
  term in cycles", and `joint-actuator` 1.1.0 adds copper resistance rising with temperature.
- **Major** (`1.x` to `2.0.0`): a different formulation, as `cell-swelling` 2.0.0 is ("SEI growth with
  the square root of cycles, and a stiffening preload term"). Also bump major if you add, remove or
  rename an input, output or parameter, or change a unit: bindings map inputs and outputs by name, and
  derived signals are named after outputs.
- **Patch**: a change that gives the same numbers, such as a clearer description. It is still a new
  fingerprint, so it is still a new version.

### Retiring a version

Keep old versions registered. A binding whose version is no longer registered stops with the error
"the model version is no longer registered". A design run of an unregistered version still shows,
but cannot be restored (409).

## 4. Parity between the browser and the API

Some models exist twice: in TypeScript for the browser, which runs without the API, and in Python for
the API. Parity fixtures keep them giving the same numbers.

| Fixture | Browser code | Made by | Checked by |
| --- | --- | --- | --- |
| `test/fixtures/plunger-shots.json` | `estimateFriction`, `simulateShot` in `js/lib/physics.ts` | `test/plunger-parity.test.js` | `api/tests/test_models.py` (`rel_tol=1e-9`) |
| `test/fixtures/design-models.json` | `MODELS`, `evaluate` in `js/lib/design.ts` | `test/design-parity.test.js` | `api/tests/test_design_models.py` (within `1e-12`, relative) |
| `test/fixtures/friction-detection.json` | `detectFrictionAlerts`, `scoreAlerts` in `js/lib/physics.ts` | `test/detection-parity.test.js` | `api/tests/test_detection.py`, `api/tests/test_backtest.py` |

The browser is the source of each fixture. Each `*-parity.test.js` test computes the cases fresh from
the TypeScript, compares them with the saved file, and fails if they differ. It rewrites the file only
when you ask:

```sh
UPDATE_FIXTURES=1 npx vitest run test/design-parity.test.js
npm run format
```

`test_every_versions_spec_is_the_browsers_word_for_word` also checks a design model's name, domain,
parameter labels, units and bounds against the fixture. Keep these word for word.

### Changing a model that exists in both

1. Change the TypeScript and the Python together, in the same pull request.
2. Write the arithmetic in the same order in both. `models/design.py` does this "so the results agree
   to the last bit"; the design fixture uses only `+ - * /` and `Math.sqrt`, which IEEE 754 makes
   exact on every engine.
3. Regenerate the fixture with `UPDATE_FIXTURES=1`, then run `npm run format`.
4. Run `npm test` and `uv run pytest -W error` (from `api/`). Both sides must pass the same fixture.
5. If the change alters a published version's numbers, stop: make a new version on both sides instead.
   The browser names versions without a patch number (`"2.0"`); `from_browser` in `models/design.py`
   and `browserVersion` in `js/lib/design-runs.ts` map between `2.0` and `2.0.0`, and
   `BROWSER_KEYS` / `API_MODEL` map `swelling` to `cell-swelling` and `actuator` to `joint-actuator`.
6. Run `npm run build` after editing anything in `js/`; `npm test` fails if the bundle is stale.

## 5. Testing

### What to test

Every behaviour change needs a test. For a model, cover at least:

- the numbers: known cases, or the parity fixture if there is a browser twin;
- the edges `run` handles itself, as `test_plunger_friction_skips_samples_without_time_passing` does
  for a repeated timestamp;
- that a parameter moves the output the right way (the same test checks that a heavier plunger gives
  a lower friction);
- that the version is registered and pinned in `published.json` (the existing test covers this for
  every model once you add the line).

`api/tests/test_models.py` shows how to test the registry with a small throwaway model, `Doubler`,
and a separate `Registry()`, so tests don't touch the default registry.

### Running the suites

From the repository root:

```sh
npm test            # Vitest, including the parity tests and the bundle check
npm run typecheck   # strict TypeScript
npm run lint
```

From `api/`:

```sh
uv run pytest -W error
uv run mypy
uv run ruff check .
uv run ruff format .
```

Database tests, such as `test_model_runner.py`, `test_runs.py` and `test_sweeps.py`, need
`TILES_TEST_DATABASE_URL`. They are skipped locally without it and fail in CI.

### Backtesting a detector's settings

Use the backtest to choose detection settings before you create a detector. See section 7.

## 6. Running a model on plant data

### Bindings

A binding feeds a `virtual-sensor` version from a site's signals. Engineers create one with
`POST /sites/{site_id}/model-bindings`. This is the body the runner tests use:

```json
{
  "name": "dc1-plunger",
  "model": "plunger-friction",
  "inputs": {"t": "@time", "v": "<signal id>", "ph": "<signal id>", "pm": "<signal id>"},
  "window": {"kind": "gap", "seconds": 2}
}
```

| Field | Meaning |
| --- | --- |
| `name` | Lower-case, digits, `.`, `_`, `-`. The derived signals are `<name>.<output>`. |
| `model`, `version` | The version is the latest when left out, and pinned from then on. |
| `inputs` | Exactly the model's inputs. Each is a signal id of this site, or `"@time"` for seconds since the window began. At least one must be a signal. |
| `params` | Checked with `check_params`; defaults filled in. |
| `window.kind` | `gap`: a window ends where readings pause longer than `seconds` (a shot). `fixed`: every `seconds`. |
| `lateness_seconds` | How late readings may arrive (default 300). A window runs once this much older than complete. |
| `align_seconds` | 0 (default): inputs join at equal timestamps. Above 0: each other input takes its latest reading at most this many seconds before. |

A design model can't be bound: the API answers 422, "it takes no signals, so it is run with evaluate,
not bound". Binding writes the version's `models` row (section 3) and is audited as `model.bind`.

### Derived signals

For each output, binding creates a signal `<name>.<output>` with source `model:<key>@<version>` and the
output port's unit and description. Per-sample outputs are written at each sample's time; per-window
outputs at the window's last reading. Writes go through `tiles_store_samples` and skip readings
already stored, so running again is harmless.

### Windows and `done_until`

The runner (`models/runner.py`) joins the input signals' readings on the first signal's clock, cuts
them into windows with `cut()`, and runs only complete windows (`complete()`): those followed by more
data, or old enough that no reading can still join them, allowing for `lateness_s`. A shot still being
recorded waits for the next run. After each window, `done_until` moves to its last reading, so each run
takes only new data. The first run starts from the history already stored.

Limits: `MAX_ROWS` (100,000 joined readings per batch) and `MAX_BATCHES` (50 per run). A single window
larger than a batch stops the run: "a window has more than 100000 readings: use shorter windows".

### Running it

- **Scheduled:** `uv run tiles-run-models` (optionally `--site <id>`) runs every enabled binding, from
  cron. Each binding runs in its own transaction, so one failing keeps the others' work.
- **Now:** `POST /sites/{site_id}/model-bindings/{binding_id}/run` (engineers) runs one batch.
  `caught_up` is false when more is left.
- **Stop:** `DELETE /sites/{site_id}/model-bindings/{binding_id}`. Derived signals keep their readings.

To move a binding to a new model version, stop it and bind the new version under a new name. There
is no endpoint that changes a binding's version, and signal tags are unique per site.

### How failures are reported

- A window the model refuses (a `ModelError` from `evaluate`) is skipped and counted. The binding
  keeps `last_windows`, `last_failed` and `last_error`, the first problem of the last run, such as
  `window ending <time>: <reason>`. `GET /sites/{site_id}/model-bindings` shows them.
- Inputs that never share a timestamp give "the input signals have no readings at the same instants",
  with a hint to set or widen `align_seconds`.
- `tiles-run-models` prints one line per binding, for example
  `3 window(s), 1 refused, 240 reading(s) written; <error>`, and exits with code 1 if any binding
  reported an error or raised.

This is why your `ValueError` messages matter: they end up in `last_error`.

## 7. Detectors

A detector watches one signal, often a derived one such as `dc1-plunger.friction`, and raises a
warning when it leaves its own recent behaviour. The logic is `detection.py`; the job is
`detector_job.py` (`tiles-detect`); the endpoints are in `api_detectors.py`.

### Settings

The settings are `detection.Config`. The API bounds are from `DetectorIn`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `window` | 200 | Readings in the rolling baseline (10 to 2,000). Nothing is judged until it is full. |
| `k` | 4.0 | How many robust spreads from the baseline median a reading must be to count as out. |
| `persist` | 3 | Readings out in a row, on one side, to raise a warning. |
| `direction` | `above` | `above`, `below` or `both`. With `both`, a swing across ends one warning and starts a run on the other side. |
| `cooldown` | 0 | Readings after a warning closes before another can open. |
| `flat_spread` | 1.0 | The spread used when the baseline is flat (MAD 0), which would otherwise flag any change. |

The baseline is the median of the last `window` readings, and the spread is the MAD scaled by 1.4826.
A warning stays open while readings stay out on its side and closes at the first one that isn't. The
detector saves its state between runs, so feeding readings in pieces gives the same warnings as one
pass. With `cooldown` 0 and `direction` `above`, it raises the same alerts as the browser's
`detectFrictionAlerts`, as `test/fixtures/friction-detection.json` checks.

A detector also has `lateness_seconds` (default 300): readings newer than that wait for the next run.

### Tuning with the backtest

The backtest (`backtest.py`) replays a signal's stored history with every combination of the settings
you give and scores the warnings against events you list (downtime, scrap, a seizure). For each
setting you get recall, precision, false warnings per day and the warning time distribution. A
warning counts for an event when it started within `horizon` before it.

Over HTTP (engineers, at most two at a time):

```json
POST /sites/{site_id}/backtest
{"signal_id": "<id>", "events": [{"at": "2026-03-02T10:15:00+00:00", "code": "DT-SEIZURE"}],
 "horizon_seconds": 28800, "k": [3, 4, 5], "persist": [1, 3], "cooldown": [0, 50]}
```

From the command line, as a Markdown report (events in a CSV with columns `at`, with its offset, and
optionally `code`):

```sh
uv run tiles-backtest --site <id> --signal dc1-plunger.friction --events events.csv \
  --horizon-hours 8 --k 3,4,5 --persist 1,3 --cooldown 0,50 --out report.md
```

Each setting takes 1 to 8 values. Limits: `MAX_SETTINGS` (48 combinations), `MAX_READINGS`
(200,000), `MAX_REPLAYS` (2,000,000 readings times settings) and `MAX_BASELINES` (600,000 readings
times window sizes). Settings are ranked by events warned of, then fewest false warnings per day, then
the longest median warning time. The replay uses `detection.judge`, so a detector created with the
chosen setting raises the same warnings.

## 8. Design Studio models and sweeps

A `design` model has no inputs: its parameters are the design, and each output is `per="window"`,
one value. `models/design.py` holds `cell-swelling` (1.0.0, 1.1.0, 2.0.0) and `joint-actuator`
(1.0.0, 1.1.0), ported from `js/lib/design.ts`.

### Design runs and their lineage

`api_runs.py` stores Design Studio runs. The API computes every output with `evaluate`; it never
stores an output the browser sends. Runs refuse non-design models with 422.

- `POST /sites/{site_id}/runs` (engineers) takes `model` (registry key or browser id), `version`
  (latest when left out), `params`, `note`, `parent` (the run it was changed from) and `project`.
- `POST /sites/{site_id}/runs/{n}/restore` runs run n's version and parameters again as a new run,
  after the latest run of that model in its project. It refuses (409) if the version is no longer
  registered or now gives another output.
- `GET /sites/{site_id}/runs/compare?a=&b=` gives the version change, parameter changes and output
  differences.

Each run is numbered per site and keeps its parent, the run it restored, its note and its author.
Runs belong to a shared design project (`/sites/{site_id}/design-projects`) or to none. With the API,
the Design Studio (`js/views/design.ts`, mapping in `js/lib/design-runs.ts`) saves and lists runs per
project; without it, runs stay in the browser.

### Audit export

`GET /sites/{site_id}/runs/{n}/audit` returns a JSON record (`"format": "tiles-design-audit/1"`) with
run n, its lineage back to the first run, the runs any of them restored, the stored spec of every
model version they ran, and a SHA-256 digest of the record. `.../audit.pdf` is the same as a report.
Exports are themselves audited (`run.audit_export`). A record holds at most `MAX_AUDIT_RUNS` (5,000)
runs; `complete` is false when it is cut.

Because the record includes each version's stored spec, a frozen version is what makes the audit
trustworthy.

### Sweeps

A sweep runs a design version over a grid of one parameter (`x`) or two (`x` and `y`), holding the
others. Engineers start one with `POST /sites/{site_id}/sweeps`; it runs in the background.

```json
{"model": "cell-swelling", "params": {"soc": 80},
 "x": {"param": "temperature", "from": -10, "to": 60, "steps": 50},
 "y": {"param": "cycles", "from": 0, "to": 2000, "steps": 40}}
```

- Limits: `MAX_STEPS` 200 per axis, `MAX_POINTS` 40,000 per sweep, and the two axes must differ.
- Both ends of each axis are checked with `check_params` before the sweep starts.
- The grid is evaluated in chunks of `CHUNK` (500) points; after each, progress and a heartbeat are
  saved and a cancel request is honoured (`POST .../sweeps/{id}/cancel`). A cancelled sweep keeps no
  result.
- A point the model refuses or can't run is null in the grid.
- The API runs at most `API_WORKERS` (2) sweeps at once. `uv run tiles-run-sweeps` (from cron) picks
  up queued sweeps and running ones whose heartbeat is older than `STALE_SECONDS` (120).
- An identical sweep (same version, held parameters and axes, by `sweeps.cache_key`) is answered from
  the result kept, with 200 and `cached: true`. This is another reason a version's numbers must never
  change.

## 9. App Studio templates

An App Studio template (T6.10) is a use case written once, which people then configure as apps on
their signals, without code: the wear check and SPC limits are the first two. A template lives in
`api/src/tiles_api/app_templates.py`:

- **Its settings** (`Param`): each has a kind (`signal`, `number`, `integer`, `choice` or `choices`),
  a label, a default, and bounds or choices. The browser builds the form from them
  (`GET /app-templates`), and `check_config` checks an app's settings against them, filling in the
  defaults. Checks across settings go in the template's `check`, which raises `ConfigError` with
  what to fix.
- **Its `run(ctx, config)`:** it reads the site's data through `ctx` (the site's own rows only) and
  returns `result(...)`:
  - a status (`ok`, `alert` or `no_data`), a headline and a sentence;
  - the chart: points, reference levels and shaded stretches;
  - facts, each a number or a share.

  Keep the arithmetic in a pure module, as the wear check's is in `wear.py` and SPC's in `spc.py`,
  and test it there.
- **Its version:** an app keeps the template and version it was made with. Change what a published
  version does only by adding a new version, and keep serving the old one for the apps made with it
  (an app whose version is gone gets 409).
- **Registered with `register(Template(...))`** at import. Test it in `api/tests/test_apps.py`: its
  settings, a result on loaded readings, and too little data.

## 10. Models served over HTTP

An organisation can also run a model it computes itself, on its own service, without adding code to
Tiles (T4.15). Tiles keeps the version's spec and calls the endpoint for every evaluation; the model
then works everywhere a built-in one does: the model list, evaluate, bindings, design runs and
sweeps. The code is `models/remote.py` (the call), `models/store.py` (`find`, which gives a built-in
or an HTTP model) and `api_org_models.py` (registering).

### Registering a version

An organisation admin posts the spec and the endpoint to `POST /org/models`:

```json
{
  "key": "beam-deflection",
  "version": "1.0.0",
  "name": "Beam deflection",
  "kind": "design",
  "domain": "structures",
  "outputs": [{ "name": "deflection", "unit": "mm", "per": "window" }],
  "params": [{ "name": "load", "unit": "kN", "default": 2, "min": 0, "max": 10 }],
  "endpoint_url": "https://models.example.com/beam",
  "token": "…"
}
```

The spec follows the same rules as a built-in model's ([section 1](#1-what-a-model-is)), and:

- a `design` model takes parameters only, no inputs; a `virtual-sensor` takes at least one input;
- the key can't be a built-in model's;
- the endpoint is https on a host the deployment allows (`TILES_MODEL_HOSTS`); outside production,
  `http://localhost` works too, for trying a model on your machine;
- the version is frozen once registered (409 if you register it again). A change in what the model
  computes is a new version, exactly as in [section 3](#3-versioning). The newest version that isn't
  archived is the one used when none is named.

`PATCH /org/models/{key}/{version}` moves the endpoint, replaces or clears the token, or archives
the version (`{"archived": true}`). Moving to another host needs the new host's token, or
`clear_token`: a token is never sent to a host it wasn't given for. An archived version gets no new
uses (evaluate, new runs, bindings, sweeps); bindings and queued sweeps already using it keep
running, and runs made with it still show.

### What the endpoint receives and answers

Tiles checks the inputs and parameters against the spec first (bounds, defaults filled in), then
posts JSON, with `Authorization: Bearer <token>` if the version has one:

```json
{ "model": "beam-deflection", "version": "1.0.0", "inputs": {}, "params": { "load": 3.0 } }
```

For a virtual sensor, `inputs` holds one list of numbers per input, all one length: one window of
readings. Answer with one list per output, numbers or `null` where a value can't be computed:

```json
{ "outputs": { "deflection": [13.5] } }
```

A `per: "sample"` output has one value per input sample; a `per: "window"` output (and every output
of a design model) has one. The reply is checked like a built-in model's return value: the wrong
outputs or lengths are refused (422), and so are values that aren't numbers or `null`.

### When the endpoint fails

Tiles tells two kinds of failure apart (`RemoteError.retry` in `remote.py`):

- **The endpoint failed:** it can't be reached, the call took longer than `TILES_MODEL_TIMEOUT`
  (10 s, for the whole call), it redirected, it answered 5xx, 408 or 429, or its token doesn't open.
  A binding's run stops at that window, saying so in `last_error` ("stopped at the window ending
  …"), and runs it again next time: no window is skipped while your service is down. A sweep fails,
  with the reason.
- **It refused these inputs:** another 4xx, or a reply that isn't the JSON above. That window is
  skipped and counted, like one a built-in model refuses, and that sweep point is null.

Either way, evaluate and design runs answer 502 and nothing is stored. A binding of an HTTP model
runs at most 500 windows per scheduled run (20 for **Run now**), one call each; the rest wait for
the next run.

Keep the endpoint deterministic: a restored run is checked against the stored output, and an
identical sweep is answered from the result kept.

## 11. Checklist for a model pull request

Before you open the pull request:

1. [ ] The model is in its own module under `api/src/tiles_api/models/`, decorated with `@register`,
   and imported in `models/__init__.py`.
2. [ ] Every input, output and parameter has a unit; every parameter has a sensible default and
   physical `min` and `max`.
3. [ ] `run` is pure, returns `None` where it can't compute a value, and raises `ValueError` with a
   readable message when it can't run the window.
4. [ ] No published version's spec or `run` code changed. A change in behaviour is a new version, in a
   new class, with the bump explained in the description.
5. [ ] The new version's fingerprint is in `models/published.json`.
6. [ ] Tests cover the numbers, the edge cases `run` handles, and the effect of key parameters.
7. [ ] If the model exists in the browser: TypeScript and Python changed together, the fixture
   regenerated with `UPDATE_FIXTURES=1`, `npm run format` and `npm run build` run.
8. [ ] For a detector change: the backtest report for the chosen settings is attached.
9. [ ] `npm test`, `npm run typecheck`, `npm run lint` pass; from `api/`, `uv run pytest -W error`,
   `uv run mypy` and `uv run ruff check .` pass.
10. [ ] Docs updated if the model adds a concept (for example `docs/data-model.md` for a node type).
11. [ ] The pull request references its task's GitHub issue.
