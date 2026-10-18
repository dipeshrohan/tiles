# Process model: porosity

Month 11 of [ROADMAP-2](ROADMAP-2.md) suggests settings that avoid scrap. Its recommendations
(T11.02) sweep a process model over the line's live state, so the model comes first (T11.01,
[#349](https://github.com/dipeshrohan/tiles/issues/349)): it must predict the line's main quality
driver within its stated error on history it never saw.

The plant is the die-casting sample plant's Line 2
([data/sample-plants/die-casting](../data/sample-plants/die-casting/README.md)), standing in for the
partner's until its year of data arrives. Its main quality driver is porosity: X-ray grades 3 and 4
(POR) are its largest scrap after warm-up shots (3,953 of the 13,696 other parts scrapped in the
year, against 2,540 soldering, the next), and porosity is what the X-ray measures for every shot.

## Contents

- [The data](#the-data)
- [The model](#the-model)
- [Target and result](#target-and-result)
- [In the registry](#in-the-registry)
- [Fitting it again](#fitting-it-again)

## The data

The X-ray table (`generated/quality/`, one row per shot of DC-01 to DC-04): the shot's process values,
the hydrogen of the last lab test, the porosity in per cent and its grade; 845,525 shots in the year.
It is used as the partner hands it over, with its stuck thermocouple (dc02's fixed half in January)
and warm-up shots. The ground truth (`ground-truth/process-model.json`) is not used to fit or judge.

The set points come from SOP-DC-01 (each product's die temperature, second-phase speed and
intensification pressure).

## The model

A shot's porosity is a sum of terms process engineering names, each with a coefficient fitted by
least squares:

- the vacuum above a level (a filter clogging);
- the intensification pressure below its set point (the accumulator sagging);
- the hydrogen in the melt (gas porosity);
- the die's temperature off its set point, either side;
- the second-phase speed below its set point;
- the pressure build-up time above a level.

The two levels are chosen with the coefficients: each pair from a grid (vacuum 30 to 80 mbar,
build-up 20 to 30 ms), the one with the least squared error on the fitting half. The fit uses
October 2025 to March 2026 (431,089 shots); April to September 2026 (414,436 shots) judges it.

| Term | Coefficient |
| --- | --: |
| constant | 0.19302 |
| vacuum above 50 mbar (per mbar) | 0.00200 |
| intensification below its set point (per bar) | 0.00426 |
| hydrogen in the melt (per ml/100 g) | 2.49836 |
| die temperature off its set point (per K) | 0.00401 |
| second-phase speed below its set point (per m/s) | 0.10856 |
| build-up time above 25 ms (per ms) | 0.00398 |

## Target and result

The target was set before the fit ran: on the held-out half, a mean absolute error of at most 0.08
and a root mean square error of at most 0.12 porosity percentage points per shot. That is less than
a third of a grade's width (0.25 points), so the model can tell a shot heading for grade 3 from one
that isn't.

| Shots | Mean absolute error | Root mean square error | R² |
| --- | --: | --: | --: |
| October to March (fitted on) | 0.0605 | 0.0903 | 0.517 |
| April to September (held out) | 0.0604 | 0.0899 | 0.477 |

It meets its target, on every cell too; the full report, with each cell's errors, is
[process-model/report.md](../data/sample-plants/die-casting/process-model/report.md). Half the
spread is shot-to-shot noise no process value explains (and the odd shot with air entrapped), which
is why R² stays near 0.5 while the error is small: the model is for the expected porosity of a
setting, not for one shot's.

## In the registry

`die-porosity` 1.0.0 (`api/src/tiles_api/models/process.py`, pinned in `models/published.json`) is
a design model: its parameters are a shot's state (vacuum, intensification and its set point,
hydrogen, die temperature and its set point, speed and its set point, build-up time), within bounds,
and it gives the porosity expected, the grade that is (SOP-QA-05) and the chance the part is scrap
(porosity of 1.1 % or more), from the fit's residual spread (0.09032). It runs through the registry
like the Design Studio's models (`POST /sites/{id}/models/die-porosity/evaluate`), and sweeps over it
are what T11.02's recommendations will be. Its coefficients are this version's for good: a new fit
is a new version.

## Fitting it again

```sh
cd api
uv run tiles-sample-plant fit die-casting
```

This simulates Line 2's year again (about a minute; it needs none of the large files under
`generated/`), fits and judges the model (`sample_plant/die_casting/process_fit.py`) and writes
[process-model/](../data/sample-plants/die-casting/process-model/) (the report and `fit.json`). It
exits with 1 if the model misses its target. The plant's test (`tests/test_sample_die_casting.py`,
CI's Sample plants job) checks the files are current and the target met, and
`tests/test_process_model.py` that the registry's model carries `fit.json`'s numbers and that the fit
recovers a known model.
