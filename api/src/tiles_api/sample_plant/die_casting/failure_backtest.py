"""The failure-mode models' backtests (T8.02 to T8.04) on the die-casting plant's year.

Each model runs as a binding would (models/runner.py): its inputs joined on the first one's
clock, the others' latest reading at most `align_s` before, cut into hourly windows; the window
output a detector watches is replayed through the backtest (backtest.py) with each setting, on
each pilot cell, and scored against that cell's unplanned stops of the mode's code in the MES's
export (what a partner hands over, with its errors). The setting is chosen on October to March
and then judged on the whole year and, apart, on April to September, which it never saw.

The readings are the simulation's, with the historian's quirks: the same numbers as
generated/historian, without needing those files. `tiles-sample-plant backtest die-casting`
writes the reports to data/sample-plants/die-casting/backtests/; the plant's test checks they
are current and that each model beats its target (docs/failure-modes.md).
"""

import bisect
import csv
import json
import statistics
from array import array
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from tiles_api import backtest
from tiles_api.backtest import Event, Outcome
from tiles_api.detection import Config
from tiles_api.models import runner
from tiles_api.models.failure_modes import AccumulatorCharge, DieCooling, FurnaceHeater
from tiles_api.models.registry import Model, evaluate
from tiles_api.quality import duration, percent
from tiles_api.sample_plant.die_casting import calendar as cal
from tiles_api.sample_plant.die_casting import generate
from tiles_api.sample_plant.die_casting import simulate as sim
from tiles_api.sample_plant.die_casting.plant import PILOT, ZONE, Cell

WINDOW_S = 3600.0  # hourly windows: about 30 to 60 shots, or 12 grid readings
# A warning counts for a stop up to two weeks after it: a cell stopped over Christmas (two weeks)
# fails soon after it restarts, and a die channel scales over three weeks of work.
HORIZON = timedelta(days=14)
SPLIT = datetime(2026, 4, 1, tzinfo=ZONE)  # chosen on what came before, judged on what came after
# The detector's settings tried: against the window's own recent level, or (a flat baseline of 0, so
# `flat_spread` is the spread) against a model's limit.
RELATIVE = backtest.settings(window=(120, 240), k=(3.0, 4.0, 5.0), persist=(2, 3, 4), cooldown=(0, 24))
LIMIT = backtest.settings(window=(120,), k=(1.0, 2.0, 5.0), persist=(2, 3, 4), cooldown=(0, 24), flat_spread=(0.01,))


@dataclass(frozen=True)
class Target:
    recall: float  # at least
    false_per_day: float  # at most, per cell
    warning_hours: float  # the median warning time, at least


@dataclass(frozen=True)
class Plan:
    key: str
    model: Model
    code: str
    inputs: tuple[str, ...]  # tags by the cell's key, {k} (dcNN) and {n} (NN), in the model's input order
    align_s: float
    output: str  # the window output a detector watches
    target: Target
    title: str
    settings: tuple[Config, ...] = tuple(RELATIVE)


PLANS = (
    Plan(
        "accumulator-charge",
        AccumulatorCharge(),
        "DT-HYD",
        ("{k}.pressure_buildup_time", "{k}.accumulator_pressure"),
        300,
        "sag",
        Target(0.7, 0.05, 12),
        "Shot accumulator charge",
    ),
    Plan(
        "furnace-heater",
        FurnaceHeater(),
        "DT-FUR",
        ("hf{n}.heater_power", "hf{n}.bath_temp", "{k}.cycle_time"),
        300,
        "heater_excess",
        Target(0.7, 0.05, 48),
        "Holding furnace heater",
    ),
    Plan(
        "die-cooling",
        DieCooling(),
        "DT-DIE",
        ("{k}.die_temp_moving", "{k}.die_temp_fixed", "{k}.cooling_flow_moving"),
        300,
        "over_limit",
        Target(0.7, 0.05, 48),
        "Die cooling, moving half",
        tuple(LIMIT),
    ),
)

Readings = dict[str, tuple[array[float], array[float]]]


def tags_for(plan: Plan, cell: Cell) -> list[str]:
    return [t.format(k=cell.key, n=f"{cell.number:02d}") for t in plan.inputs]


def readings(wanted: set[str], cells: Sequence[Cell] = PILOT) -> Readings:
    """The cells' readings of `wanted` tags for the year, as the historian holds them."""
    shifts = cal.shifts()
    working = sim.Working(cal.working_intervals(shifts))
    site = sim.site_series(working, shifts)
    mf = sim.melting_stops(working)
    out: Readings = {t: (array("d"), array("d")) for t in wanted}

    def reading(tag: str, t: float, value: float | str) -> None:
        if tag not in wanted or not isinstance(value, float | int):
            return
        v = generate.quirk(tag, t, float(value))
        if v is not None:
            out[tag][0].append(t)
            out[tag][1].append(v)

    for c in cells:
        sim.CellSim(c, working, shifts, site, mf, reading, lambda *a: None, None, None).run()
    return out


def join(series: Sequence[tuple[array[float], array[float]]], align_s: float) -> tuple[list[float], list[list[float]]]:
    """The inputs joined as the runner joins them: on the first series' clock, each other series'
    latest reading at most `align_s` seconds before (a time without one for every input is left out)."""
    times: list[float] = []
    columns: list[list[float]] = [[] for _ in series]
    first_t, first_v = series[0]
    for t, v in zip(first_t, first_v, strict=True):
        row = [v]
        for other_t, other_v in series[1:]:
            i = bisect.bisect_right(other_t, t) - 1
            if i < 0 or other_t[i] < t - align_s:
                break
            row.append(other_v[i])
        else:
            times.append(t)
            for col, x in zip(columns, row, strict=True):
                col.append(x)
    return times, columns


def windows(plan: Plan, times: list[float], columns: list[list[float]]) -> tuple[list[datetime], list[float]]:
    """The model's window output, at each window's last reading, as the runner writes it."""
    stamps = [datetime.fromtimestamp(t, UTC) for t in times]
    names = [p.name for p in plan.model.spec.inputs]
    at: list[datetime] = []
    values: list[float] = []
    for a, b in runner.cut(stamps, "fixed", WINDOW_S):
        out = evaluate(plan.model, {n: col[a:b] for n, col in zip(names, columns, strict=True)})
        v = out[plan.output][0]
        if v is not None:
            at.append(stamps[b - 1])
            values.append(v)
    return at, values


# The MES's older names for a code (README: Known gaps): hydraulic faults were HYD until December.
OLD_CODES = {"DT-HYD": ("HYD",)}


def mes_events(data: Path, asset: str, code: str) -> list[Event]:
    with (data / "mes" / "stops.csv").open(newline="") as f:
        rows = list(csv.DictReader(f))
    codes = (code, *OLD_CODES.get(code, ()))
    return [
        Event(datetime.fromisoformat(r["start"]), code)
        for r in rows
        if r["asset"] == asset and r["code"] in codes and r["planned"] == "no"
    ]


@dataclass
class Pooled:
    """Outcomes of one setting over the cells, as one detector each."""

    config: Config
    outcomes: list[Outcome]

    @property
    def events(self) -> int:
        return sum(len(o.events) for o in self.outcomes)

    @property
    def caught(self) -> int:
        return sum(o.caught for o in self.outcomes)

    @property
    def recall(self) -> float | None:
        return self.caught / self.events if self.events else None

    @property
    def warnings(self) -> int:
        return sum(len(o.alerts) for o in self.outcomes)

    @property
    def false(self) -> int:
        return sum(o.false_warnings for o in self.outcomes)

    @property
    def false_per_day(self) -> float:
        days = sum(o.days for o in self.outcomes)
        return self.false / days if days else 0.0

    @property
    def warning_hours(self) -> list[float]:
        return [
            e.warning_time.total_seconds() / 3600 for o in self.outcomes for e in o.events if e.warning_time is not None
        ]

    @property
    def median_hours(self) -> float:
        h = self.warning_hours
        return statistics.median(h) if h else 0.0

    def meets(self, t: Target) -> bool:
        return (
            (self.recall or 0) >= t.recall
            and self.false_per_day <= t.false_per_day
            and self.median_hours >= t.warning_hours
        )


def pooled(
    configs: Sequence[Config],
    series: dict[str, tuple[list[datetime], list[float]]],
    events: dict[str, list[Event]],
    start: datetime | None,
    end: datetime | None,
) -> list[Pooled]:
    """Each setting replayed on each cell's windows between `start` and `end`."""
    per: dict[Config, list[Outcome]] = {c: [] for c in configs}
    for asset, (at, values) in series.items():
        lo = 0 if start is None else bisect.bisect_left(at, start)
        hi = len(at) if end is None else bisect.bisect_left(at, end)
        for o in backtest.replay(at[lo:hi], values[lo:hi], events[asset], configs, HORIZON):
            per[o.config].append(o)
    return [Pooled(c, os) for c, os in per.items()]


def best(results: list[Pooled]) -> Pooled:
    """Most stops warned of, then fewest false warnings per day, then the longest warning time."""
    return min(results, key=lambda p: (-(p.recall or 0), p.false_per_day, -p.median_hours))


@dataclass
class Result:
    plan: Plan
    chosen: Config
    tuning: Pooled
    year: Pooled
    held_out: Pooled
    windows: int

    @property
    def passed(self) -> bool:
        return self.year.meets(self.plan.target) and self.held_out.meets(self.plan.target)


def run(plan: Plan, source: Readings, data: Path) -> Result:
    series: dict[str, tuple[list[datetime], list[float]]] = {}
    events: dict[str, list[Event]] = {}
    for c in PILOT:
        times, columns = join([source[t] for t in tags_for(plan, c)], plan.align_s)
        series[c.asset] = windows(plan, times, columns)
        events[c.asset] = mes_events(data, c.asset, plan.code)
    tuning = best(pooled(plan.settings, series, events, None, SPLIT))
    chosen = tuning.config
    year = pooled([chosen], series, events, None, None)[0]
    # The held-out half is scored on the year's replay: its baseline carries on from March.
    held = Pooled(
        chosen,
        [
            backtest.score(chosen, o.alerts, events[c.asset], HORIZON, SPLIT, series[c.asset][0][-1])
            for o, c in zip(year.outcomes, PILOT, strict=True)
        ],
    )
    return Result(plan, chosen, tuning, year, held, sum(len(v[0]) for v in series.values()))


def _row(name: str, p: Pooled, t: Target) -> str:
    h = p.warning_hours
    spread = (
        "-"
        if not h
        else f"{duration(statistics.median(h) * 3600)} ({duration(min(h) * 3600)} to {duration(max(h) * 3600)})"
    )
    recall = "-" if p.recall is None else f"{percent(p.recall)} ({p.caught}/{p.events})"
    ok = "yes" if p.meets(t) else "**no**"
    return f"| {name} | {recall} | {p.warnings} | {p.false_per_day:.3f} | {spread} | {ok} |"


def report(r: Result) -> str:
    p, t = r.plan, r.plan.target
    spec = p.model.spec
    lines = [
        f"# Backtest: {p.title}",
        "",
        f"- **Model:** `{spec.key}` {spec.version}, window output `{p.output}`, hourly windows",
        f"- **Inputs:** {', '.join(f'`{i}`' for i in p.inputs)} (joined within {duration(p.align_s)})",
        f"- **Events:** the MES's unplanned `{p.code}` stops"
        + "".join(f" (and `{old}`, its older name)" for old in OLD_CODES.get(p.code, ()))
        + f" on {', '.join(c.asset for c in PILOT)}",
        f"- **Warning horizon:** {duration(HORIZON.total_seconds())} before a stop",
        f"- **Setting:** {backtest.setting(r.chosen)}, chosen on October to March from {len(p.settings)}",
        f"- **Target:** recall at least {percent(t.recall)}, at most {t.false_per_day} false warnings a day"
        f" per cell, a median warning time of at least {duration(t.warning_hours * 3600)}",
        f"- **Windows:** {r.windows:,}",
        f"- **Result:** {'beats its target' if r.passed else 'misses its target'}",
        "",
        "| Period | Recall | Warnings | False per day | Warning time (median, min to max) | Meets target |",
        "|---|--:|--:|--:|---|---|",
        _row("October to March (chosen on)", r.tuning, t),
        _row("April to September (held out)", r.held_out, t),
        _row("The year", r.year, t),
        "",
        "## Stops in the year",
        "",
        "| Cell | Stop | Warned | Warning time |",
        "|---|---|---|--:|",
    ]
    for o, c in zip(r.year.outcomes, PILOT, strict=True):
        for e in o.events:
            wt = e.warning_time
            when = e.event.at.astimezone(ZONE).isoformat(timespec="minutes")
            warned = "yes" if wt is not None else "**no**"
            lines.append(f"| {c.asset} | {when} | {warned} | {'-' if wt is None else duration(wt.total_seconds())} |")
    return "\n".join(lines) + "\n"


def summary(results: Sequence[Result]) -> dict[str, Any]:
    """Each model's chosen setting and its year: backtests/summary.json."""
    out: dict[str, Any] = {}
    for r in results:
        out[r.plan.key] = {
            "version": r.plan.model.spec.version,
            "output": r.plan.output,
            "code": r.plan.code,
            "setting": r.chosen.as_json(),
            "recall": r.year.recall,
            "false_per_day": round(r.year.false_per_day, 4),
            "median_warning_hours": round(r.year.median_hours, 2),
            "held_out_recall": r.held_out.recall,
            "passed": r.passed,
        }
    return out


def bindings(results: Sequence[Result]) -> list[dict[str, Any]]:
    """What goes live (T8.05): each model bound on each pilot cell as its backtest ran it, and a
    detector on the window output it watched, with the setting chosen. backtests/bindings.json,
    which the loader binds on a site (`Loader.failure_models`)."""
    out = []
    for r in results:
        spec = r.plan.model.spec
        for c in PILOT:
            name = f"{c.key}-{r.plan.key}"
            out.append(
                {
                    "name": name,
                    "model": spec.key,
                    "version": spec.version,
                    "inputs": dict(zip((p.name for p in spec.inputs), tags_for(r.plan, c), strict=True)),
                    "window": {"kind": "fixed", "seconds": WINDOW_S},
                    "align_seconds": r.plan.align_s,
                    "detector": {"signal": f"{name}.{r.plan.output}", "asset": c.asset, **r.chosen.as_json()},
                }
            )
    return out


def files(results: Sequence[Result]) -> dict[str, str]:
    """The backtests' files by name: a report per model, the summary and the bindings."""
    made = {f"{r.plan.key}.md": report(r) for r in results}
    made["summary.json"] = json.dumps(summary(results), indent=2) + "\n"
    made["bindings.json"] = json.dumps(bindings(results), indent=2) + "\n"
    return made


def write(data: Path, results: Sequence[Result]) -> None:
    out = data / "backtests"
    out.mkdir(exist_ok=True)
    for name, text in files(results).items():
        (out / name).write_text(text)


def all_results(data: Path) -> list[Result]:
    wanted = {t for p in PLANS for c in PILOT for t in tags_for(p, c)}
    source = readings(wanted)
    return [run(p, source, data) for p in PLANS]
