# Monthly metrics

Each month's review of the figures that [the roadmap](../ROADMAP.md#metrics-to-track-monthly) tracks
(T0.01, [#104](https://github.com/dipeshrohan/tiles/issues/104)): one file a month, named
`YYYY-MM.md`, beside the month's risk review (T0.02).

| Month | Report |
| --- | --- |
| November 2026 | [2026-11.md](2026-11.md) |

## What a report holds

- **Warnings:** recall, precision and median warning time.
- **Copilot:** evaluation accuracy, unsupported claims and tool choice, against the gate.
- **Data freshness:** the time from a reading to the dashboard.
- **Adoption:** weekly active users on the pilot line.
- **Ontology:** the health score.
- **Onboarding:** the time to bring a new machine online.

Every number comes from running the code in this repository or from a report file it commits, and
each table names the command or file it came from. A figure that needs something the repository
doesn't have is a placeholder that says what it needs:

- `‹partner data›`: the design partner's plant (the pilot hasn't started; see the
  [risks](../ROADMAP.md#risks-and-mitigations)).
- `‹needs the copilot's key›`: a score from Claude, which needs `TILES_ANTHROPIC_API_KEY` and
  `TILES_COPILOT_MODEL`.

Until the pilot starts, the warning, copilot and ontology figures are the
[sample plants'](../../data/sample-plants/README.md). They are simulated, with their precursors built
in, so they show the tooling works; they aren't the figures the pilot will be judged on.

## Making it again

From `api/`, after `uv sync`:

```sh
# The failure-mode backtests: rewrites data/sample-plants/die-casting/backtests/ (no change when current)
uv run tiles-sample-plant backtest die-casting

# The process model's fit: rewrites data/sample-plants/die-casting/process-model/ (no change when current)
uv run tiles-sample-plant fit die-casting

# The copilot's evaluation with the oracle model, and each sample plant's question set (needs a database)
TILES_TEST_DATABASE_URL=postgresql://… uv run pytest -W error tests/test_evaluation.py tests/test_sample_*.py

# The copilot's evaluation on Claude (needs the copilot's key and model, and a migrated database)
TILES_DATABASE_URL=postgresql://… uv run tiles-evaluate --report evaluation.md
```

The backtest reports give recall, warnings and false warnings a day, but not precision. Precision is
the backtest's own (`backtest.Outcome.precision`: true warnings over judged ones), pooled over the
cells; from `api/`, `uv run python precision.py` with this as `precision.py`:

```python
from tiles_api.sample_plant import DATA
from tiles_api.sample_plant.die_casting import failure_backtest as fb

for r in fb.all_results(DATA / "die-casting"):
    for name, p in (("tuning", r.tuning), ("held_out", r.held_out), ("year", r.year)):
        true = sum(o.true_warnings for o in p.outcomes)
        false = sum(o.false_warnings for o in p.outcomes)
        print(r.plan.key, name, p.warnings, true, false, true / (true + false) if true + false else None)
```

The ontology health scores are `ontology.health_check` on each plant's committed model:

```python
from tiles_api import ontology, ontology_io
from tiles_api.sample_plant import DATA

for plant in ("die-casting", "battery", "graphene", "biologics"):
    graph = ontology_io.from_json((DATA / plant / "plant" / "ontology.json").read_text())
    report = ontology.health_check(graph)
    print(plant, report["score"], report["counts"], [(i["level"], i["ref"]) for i in report["issues"]])
```
