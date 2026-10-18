# Process model: porosity on Line 2

Made by `tiles-sample-plant fit die-casting` (`sample_plant/die_casting/process_fit.py`) from the
X-ray table of DC-01 to DC-04: fitted on October to March, judged on April to September.

- **Target (held out):** a mean absolute error of at most 0.08 and a root mean square error of at most 0.12 porosity percentage points per shot
- **Result:** meets its target
- **Levels chosen on the fitting half:** vacuum above 50 mbar, build-up above 25 ms
- **Residual spread (fitting half):** 0.0903 percentage points

## The model

porosity (%) =

| Term | Coefficient |
|---|--:|
| constant | 0.19302 |
| vacuum above 50 mbar (per mbar) | 0.00200 |
| intensification below its set point (per bar) | 0.00426 |
| hydrogen in the melt (per ml/100 g) | 2.49836 |
| die temperature off its set point (per K) | 0.00401 |
| second-phase speed below its set point (per m/s) | 0.10856 |
| build-up time above 25 ms (per ms) | 0.00398 |

## Errors

| Shots | Count | Mean absolute error | Root mean square error | R² | Bias | Meets target |
|---|--:|--:|--:|--:|--:|---|
| October to March (fitted on) | 431,089 | 0.0605 | 0.0903 | 0.517 | -0.0000 | yes |
| April to September (held out) | 414,436 | 0.0604 | 0.0899 | 0.477 | +0.0000 | yes |
| DC-01, held out | 91,681 | 0.0605 | 0.0897 | 0.470 | -0.0000 | yes |
| DC-02, held out | 92,441 | 0.0604 | 0.0901 | 0.512 | +0.0000 | yes |
| DC-03, held out | 110,153 | 0.0603 | 0.0901 | 0.499 | +0.0001 | yes |
| DC-04, held out | 120,161 | 0.0603 | 0.0896 | 0.426 | -0.0000 | yes |
