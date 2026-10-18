# Failure modes: the next three

Month 8 of [ROADMAP-2](ROADMAP-2.md) adds physics models for the line's next most costly failure
modes after the plunger (T3.02). This page records the three that were chosen (T8.01,
[#337](https://github.com/dipeshrohan/tiles/issues/337)), what each costs, the history each has, the
model for each (T8.02 to T8.04, [#338](https://github.com/dipeshrohan/tiles/issues/338) to
[#340](https://github.com/dipeshrohan/tiles/issues/340)) and its backtest against the target it was
set before it ran.

The plant is the die-casting sample plant ([data/sample-plants/die-casting](../data/sample-plants/die-casting/README.md),
Aldermoor Castings), standing in for the design partner's line until its year of data arrives. Its
figures come from its MES export (`mes/stops.csv`, with its errors) and controlling's costs
(`plant/costs.csv`). The ground truth (`ground-truth/episodes.csv`) is not used to choose, tune or
score anything.

## Contents

- [How they were chosen](#how-they-were-chosen)
- [The three](#the-three)
- [The models](#the-models)
- [Targets and results](#targets-and-results)
- [Running the backtests again](#running-the-backtests-again)
- [If a model misses its target](#if-a-model-misses-its-target)

## How they were chosen

Most unplanned hours on the cells are random faults: the extraction robot (DT-ROB, 513 h a year),
electrical faults (DT-ELE, 388 h), trim press faults and "other". None of them builds up in a signal
before it happens, so no model warns of them; they are counted, not predicted. The failure modes that
develop over hours or days, and show in the signals first, are these (the six cells, the year from
October 2025, unplanned stops only, each stop's hours at its cell's cost of an hour):

| Code | Failure mode | Stops | Hours | Cost (EUR) | Line 2 stops | Line 2 hours | Line 2 cost (EUR) |
| --- | --- | --: | --: | --: | --: | --: | --: |
| DT-PLG | Plunger tip and shot sleeve | 10 | 52 | 109,500 | 6 | 32 | 90,992 |
| DT-HYD | Shot accumulator (with `HYD`, its name until December) | 23 | 60 | 107,736 | 11 | 29 | 80,191 |
| DT-FUR | Holding furnace heater element | 7 | 50 | 96,839 | 4 | 26 | 75,230 |
| DT-DIE | Die cooling, moving half | 7 | 37 | 93,983 | 6 | 30 | 87,736 |
| DT-SPR | Spray nozzles | 29 | 30 | 60,747 | 18 | 18 | 50,166 |
| DT-VAC | Vacuum filter and valve | 2 | 2 | 6,902 | 2 | 2 | 6,902 |
| DT-OIL | Hydraulic oil cooler | 3 | 4 | 4,476 | 1 | 1 | 1,946 |

The plunger already has its model (T3.02). The next three by cost are the accumulator, the holding
furnace and the die cooling; together 147 unplanned hours and 298,558 EUR a year on the six cells,
and 85 hours and 243,157 EUR on Line 2. Spray nozzles come next: frequent, but each stop is about an hour
of cleaning at the cell.

## The three

**Shot accumulator (DT-HYD).** The nitrogen precharge of the shot accumulator leaks away; the
accumulator holds less pressure and sags on the shot, the intensification builds up late and weakly
(porosity), and at last the machine stops on a hydraulic fault. Recharging nitrogen costs 160 EUR and
an hour at the weekly check; a stop costs 2.6 hours on average.

- **History:** Line 2 (DC-01 to DC-04) has the pressure build-up time of every shot and the
  accumulator pressure every 5 minutes, for the year; 11 stops in the MES. Line 1 (DC-05, DC-06)
  records only two 5-minute averages, too little to model.
- **How fast:** one to four working days from the first sign to the stop.

**Holding furnace heater (DT-FUR).** The holding furnace's heater element ages: its resistance
rises, it draws more for the same bath, and at the end it can't keep the bath at its set point, the
metal goes in cold (cold shuts) and the cell stops. A new element costs 1,900 EUR; a stop costs about
seven hours with the bath lost.

- **History:** each Line 2 cell's furnace (hf01 to hf04) records its heater power and bath
  temperature every 5 minutes; 4 stops in the MES. The melting furnace's DT-FUR stops (MF-01) are
  another furnace, not counted.
- **How fast:** six to twenty-five working days.

**Die cooling, moving half (DT-DIE).** Scale and debris block the moving half's cooling channel; its
flow falls, the moving half runs hot (soldering, sticking) and the die comes out for cleaning. A
blockage found at planned maintenance is descaled in the PM's time; a stop costs five hours.

- **History:** the moving half's cooling flow every 5 minutes and both halves' temperatures every
  shot on Line 2; 6 stops in the MES (one of them booked again in the next shift).
- **How fast:** six to eighteen working days; the channel also scales slowly over the die's life,
  and a die change clears it.

## The models

Each is a virtual sensor in the registry (`api/src/tiles_api/models/failure_modes.py`, pinned in
`models/published.json`), with its twin in the browser (`js/lib/failure-models.ts`). The browser's
twin makes the parity fixture `test/fixtures/failure-models.json` (`test/failure-models-parity.test.js`),
which the API's models must match (`api/tests/test_failure_modes.py`). Each gives its estimate for
every reading and the median of a window, which the detector watches; the binding (T8.05) runs them on
hourly windows.

| Model | Inputs (joined within 5 minutes) | Physics | Watched |
| --- | --- | --- | --- |
| `accumulator-charge` 1.0.0 | build-up time (ms), accumulator pressure (bar) | The precharge the charged pressure implies by the gas law, p0 = p1·(1 − fill)^n; the build-up time the orifice law expects at that pressure, t = t_rated·√((p_rated − p_load) / (p1 − p_load)); the rest is the sag | `sag`: the window's median build-up time beyond the expected |
| `furnace-heater` 1.0.0 | heater power (kW), bath temperature (°C), the cell's cycle time (s) | The power the bath needs while the cell casts, by a heat balance linearised about the set point, P = P_hold + P_cast + k·(T − T_set); readings while the cell waits are left out | `heater_excess`: the window's median power beyond the demand |
| `die-cooling` 1.0.0 | moving half's temperature (°C), fixed half's (°C), the moving half's flow (l/min) | The flow lost, 1 − Q / Q_rated; the heat transfer left, (Q / Q_rated)^0.8 (Dittus-Boelter); the moving half against the fixed half, which sees the same shots, alloy and water | `over_limit`: the window's flow lost beyond 20% |

The die cooling's blockage creeps up over weeks, so a detector comparing it with its own recent
level follows it up and never warns. Its window output beyond a limit is 0 while the channel is
clean enough: the detector sees a flat baseline (its spread `flat_spread`, 0.01) and warns once the
limit is passed. That is the physics-only threshold the roadmap's risk table names as the fallback,
here as the model's own limit rather than a separate rule.

## Targets and results

The targets were set before the backtests ran, from what the plant needs: most stops warned of
(recall at least 70%), few enough false warnings that people keep reading them (at most one in 20
days per cell, 0.05 a day), and time to act. A sagging accumulator is recharged in an hour at the
next shift change, so 12 hours is enough; an element or a die channel needs the part and a planned
stop, so two days.

A warning counts for a stop up to 14 days after it: a cell stopped over Christmas fails soon after
it restarts, and a die channel scales over three weeks of work. Each model's detector setting was
chosen on October to March, from a grid of settings, and then judged on the whole year and, apart,
on April to September, which it never saw. The reports are in
[data/sample-plants/die-casting/backtests](../data/sample-plants/die-casting/backtests/).

| Model | Target: recall, false a day, warning time | The year | April to September (held out) | Report |
| --- | --- | --- | --- | --- |
| Shot accumulator charge | 70%, 0.05, 12 h | 91% (10/11), 0.001, 2.1 days | 100% (7/7), 0.000, 2.2 days | [accumulator-charge.md](../data/sample-plants/die-casting/backtests/accumulator-charge.md) |
| Holding furnace heater | 70%, 0.05, 2 days | 100% (4/4), 0.000, 7.5 days | 100% (1/1), 0.000, 5.9 days | [furnace-heater.md](../data/sample-plants/die-casting/backtests/furnace-heater.md) |
| Die cooling, moving half | 70%, 0.05, 2 days | 100% (6/6), 0.001, 5.9 days | 100% (2/2), 0.001, 7.6 days | [die-cooling.md](../data/sample-plants/die-casting/backtests/die-cooling.md) |

All three beat their targets. The one stop missed, DC-04's on 5 January, was warned of on
22 December, just before the Christmas shutdown, a little over 14 days before it: in time, but past the
horizon. The furnace's 4 stops and the held-out halves are few; the partner's year will judge them
again. The chosen settings, which T8.05 binds, are in
[summary.json](../data/sample-plants/die-casting/backtests/summary.json).

## Running the backtests again

```sh
cd api
uv run tiles-sample-plant backtest die-casting
```

This simulates Line 2's year again (about a minute; it needs none of the large files under
`generated/`), runs each model as a binding would (`sample_plant/die_casting/failure_backtest.py`:
the runner's join and hourly windows, then the backtest's replay and scoring) and writes the reports.
It exits with 1 if a model misses its target. The plant's test (`tests/test_sample_die_casting.py`, CI's
Sample plants job) checks the reports are current and that every model beats its target.

## If a model misses its target

The roadmap's risk table applies: a model that misses its target on the partner's data falls back to
its physics-only threshold (the limit on its window output, as the die cooling uses) with a longer
review before its warnings go to the line. A model's new behaviour is a new version, never a change to
1.0.0.
