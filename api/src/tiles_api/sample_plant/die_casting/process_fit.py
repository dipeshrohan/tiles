"""The process model for recommendations (T11.01): porosity, Line 2's main quality driver, fitted
to the X-ray table and judged on history it never saw.

A shot's porosity (per cent, the X-ray's measure) is fitted by least squares on terms that process
engineering names: the vacuum above a level, the intensification pressure below its set point,
the hydrogen in the melt, the die's temperature off its set point, the second-phase speed below its
set point and the pressure build-up time above a level. The set points are SOP-DC-01's for each
product; the two levels are chosen on the fitting half too, from a grid, by the least squared
error. The fit uses October to March; April to September judges it, against the error stated
before it ran (docs/process-model.md). `models/process.py`'s `die-porosity` 1.0.0 carries the
coefficients found; the plant's test checks they are what this fit finds.

`tiles-sample-plant fit die-casting` writes the report and the fit to
data/sample-plants/die-casting/process-model/.
"""

import json
import math
import statistics
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any

from tiles_api.sample_plant.die_casting import calendar as cal
from tiles_api.sample_plant.die_casting import generate
from tiles_api.sample_plant.die_casting import simulate as sim
from tiles_api.sample_plant.die_casting.plant import PILOT, PRODUCTS, ZONE, Cell

SPLIT = datetime(2026, 4, 1, tzinfo=ZONE)
VACUUM_LEVELS = (30.0, 40.0, 50.0, 60.0, 70.0, 80.0)  # mbar
BUILDUP_LEVELS = (20.0, 22.5, 25.0, 27.5, 30.0)  # ms
TERMS = ("base", "vacuum", "intensification", "hydrogen", "die_temp", "speed", "buildup")
SET_POINTS = {p.code: p for p in PRODUCTS}  # SOP-DC-01's die temperature, speed and intensification


@dataclass(frozen=True)
class Target:
    mae: float  # at most, porosity percentage points
    rmse: float  # at most


TARGET = Target(0.08, 0.12)


@dataclass(frozen=True)
class Shot:
    at: float
    asset: str
    product: str
    vacuum: float
    intensification: float
    hydrogen: float
    die_temp: float  # the mean of the two halves
    speed: float
    buildup: float
    porosity: float


def shots(cells: Sequence[Cell] = PILOT) -> list[Shot]:
    """Every shot of the cells' year as the X-ray table holds it, in time order."""
    shifts = cal.shifts()
    working = sim.Working(cal.working_intervals(shifts))
    site = sim.site_series(working, shifts)
    mf = sim.melting_stops(working)
    out: list[Shot] = []

    def shot(cell: Cell, r: sim.ShotRecord) -> None:
        row = generate.quality_row(cell, r)
        out.append(
            Shot(
                r.at,
                cell.asset,
                row["product"],
                row["vacuum_level"],
                row["intensification_pressure"],
                row["hydrogen"],
                (row["die_temp_fixed"] + row["die_temp_moving"]) / 2,
                row["shot_speed_2nd"],
                row["pressure_buildup_time"],
                row["porosity"],
            )
        )

    for c in cells:
        sim.CellSim(c, working, shifts, site, mf, lambda *a: None, shot, None, None).run()
    out.sort(key=lambda s: (s.at, s.asset))
    return out


def terms(s: Shot, vacuum_level: float, buildup_level: float) -> list[float]:
    """The shot's terms, in TERMS' order: what each coefficient multiplies."""
    p = SET_POINTS[s.product]
    return [
        1.0,
        max(0.0, s.vacuum - vacuum_level),
        max(0.0, p.intensification_bar - s.intensification),
        s.hydrogen,
        abs(s.die_temp - p.die_temp_c),
        max(0.0, p.speed_2nd - s.speed),
        max(0.0, s.buildup - buildup_level),
    ]


def solve(a: list[list[float]], b: list[float]) -> list[float]:
    """Solves a·x = b (a square, well conditioned) by Gaussian elimination with partial pivoting."""
    n = len(b)
    m = [[*row, b[i]] for i, row in enumerate(a)]
    for col in range(n):
        pivot = max(range(col, n), key=lambda r: abs(m[r][col]))
        if abs(m[pivot][col]) < 1e-12:
            raise ValueError("the terms are collinear: no single fit")
        m[col], m[pivot] = m[pivot], m[col]
        for r in range(col + 1, n):
            f = m[r][col] / m[col][col]
            for c in range(col, n + 1):
                m[r][c] -= f * m[col][c]
    x = [0.0] * n
    for r in range(n - 1, -1, -1):
        x[r] = (m[r][n] - sum(m[r][c] * x[c] for c in range(r + 1, n))) / m[r][r]
    return x


def least_squares(data: Sequence[Shot], vacuum_level: float, buildup_level: float) -> tuple[list[float], float]:
    """The coefficients minimising the squared error, and that error's sum."""
    k = len(TERMS)
    xtx = [[0.0] * k for _ in range(k)]
    xty = [0.0] * k
    yy = 0.0
    for s in data:
        t = terms(s, vacuum_level, buildup_level)
        yy += s.porosity * s.porosity
        for i in range(k):
            xty[i] += t[i] * s.porosity
            for j in range(i, k):
                xtx[i][j] += t[i] * t[j]
    for i in range(k):
        for j in range(i):
            xtx[i][j] = xtx[j][i]
    coef = solve(xtx, xty)
    # y'y - 2c'X'y + c'X'Xc, without a second pass over the shots
    fitted = sum(coef[i] * xtx[i][j] * coef[j] for i in range(k) for j in range(k))
    return coef, yy - 2 * predict(coef, xty) + fitted


def predict(coef: Sequence[float], t: Sequence[float]) -> float:
    return sum(c * x for c, x in zip(coef, t, strict=True))


@dataclass(frozen=True)
class Errors:
    shots: int
    mae: float
    rmse: float
    r2: float
    bias: float  # mean of measured less predicted

    def meets(self, t: Target) -> bool:
        return self.mae <= t.mae and self.rmse <= t.rmse


def errors(coef: Sequence[float], vacuum_level: float, buildup_level: float, data: Sequence[Shot]) -> Errors:
    residuals = [s.porosity - predict(coef, terms(s, vacuum_level, buildup_level)) for s in data]
    mean = statistics.fmean(s.porosity for s in data)
    total = sum((s.porosity - mean) ** 2 for s in data)
    sse = sum(r * r for r in residuals)
    return Errors(
        len(data),
        statistics.fmean(abs(r) for r in residuals),
        math.sqrt(sse / len(data)),
        1 - sse / total,
        statistics.fmean(residuals),
    )


@dataclass(frozen=True)
class Fit:
    vacuum_level: float
    buildup_level: float
    coefficients: dict[str, float]  # by term, rounded as the model carries them
    residual_sd: float  # on the fitting half
    fitting: Errors
    held_out: Errors
    by_cell: dict[str, Errors]  # held out

    @property
    def passed(self) -> bool:
        return self.held_out.meets(TARGET)


def fit(data: Sequence[Shot]) -> Fit:
    """Chooses the levels and the coefficients on the shots before SPLIT; judges them after."""
    split = SPLIT.timestamp()
    train = [s for s in data if s.at < split]
    test = [s for s in data if s.at >= split]
    best: tuple[float, float, float, list[float]] | None = None
    for v in VACUUM_LEVELS:
        for b in BUILDUP_LEVELS:
            coef, sse = least_squares(train, v, b)
            if best is None or sse < best[0]:
                best = (sse, v, b, coef)
    if best is None:
        raise ValueError("no levels to try")
    _, v, b, coef = best
    rounded = [round(c, 5) for c in coef]
    on_train = errors(rounded, v, b, train)
    by_cell = {c.asset: errors(rounded, v, b, [s for s in test if s.asset == c.asset]) for c in PILOT}
    return Fit(
        v,
        b,
        dict(zip(TERMS, rounded, strict=True)),
        round(on_train.rmse, 5),
        on_train,
        errors(rounded, v, b, test),
        by_cell,
    )


def _row(name: str, e: Errors) -> str:
    ok = "yes" if e.meets(TARGET) else "**no**"
    return f"| {name} | {e.shots:,} | {e.mae:.4f} | {e.rmse:.4f} | {e.r2:.3f} | {e.bias:+.4f} | {ok} |"


def report(f: Fit) -> str:
    c = f.coefficients
    lines = [
        "# Process model: porosity on Line 2",
        "",
        "Made by `tiles-sample-plant fit die-casting` (`sample_plant/die_casting/process_fit.py`) from the",
        "X-ray table of DC-01 to DC-04: fitted on October to March, judged on April to September.",
        "",
        f"- **Target (held out):** a mean absolute error of at most {TARGET.mae} and a root mean square error"
        f" of at most {TARGET.rmse} porosity percentage points per shot",
        f"- **Result:** {'meets its target' if f.passed else 'misses its target'}",
        f"- **Levels chosen on the fitting half:** vacuum above {f.vacuum_level:g} mbar, build-up above"
        f" {f.buildup_level:g} ms",
        f"- **Residual spread (fitting half):** {f.residual_sd:.4f} percentage points",
        "",
        "## The model",
        "",
        "porosity (%) =",
        "",
        "| Term | Coefficient |",
        "|---|--:|",
        f"| constant | {c['base']:.5f} |",
        f"| vacuum above {f.vacuum_level:g} mbar (per mbar) | {c['vacuum']:.5f} |",
        f"| intensification below its set point (per bar) | {c['intensification']:.5f} |",
        f"| hydrogen in the melt (per ml/100 g) | {c['hydrogen']:.5f} |",
        f"| die temperature off its set point (per K) | {c['die_temp']:.5f} |",
        f"| second-phase speed below its set point (per m/s) | {c['speed']:.5f} |",
        f"| build-up time above {f.buildup_level:g} ms (per ms) | {c['buildup']:.5f} |",
        "",
        "## Errors",
        "",
        "| Shots | Count | Mean absolute error | Root mean square error | R² | Bias | Meets target |",
        "|---|--:|--:|--:|--:|--:|---|",
        _row("October to March (fitted on)", f.fitting),
        _row("April to September (held out)", f.held_out),
        *(_row(f"{asset}, held out", e) for asset, e in f.by_cell.items()),
        "",
    ]
    return "\n".join(lines)


def as_json(f: Fit) -> dict[str, Any]:
    def e(x: Errors) -> dict[str, Any]:
        return {"shots": x.shots, "mae": round(x.mae, 5), "rmse": round(x.rmse, 5), "r2": round(x.r2, 4)}

    return {
        "vacuum_level": f.vacuum_level,
        "buildup_level": f.buildup_level,
        "coefficients": f.coefficients,
        "residual_sd": f.residual_sd,
        "target": {"mae": TARGET.mae, "rmse": TARGET.rmse},
        "fitting": e(f.fitting),
        "held_out": e(f.held_out),
        "passed": f.passed,
    }


def files(f: Fit) -> dict[str, str]:
    return {"report.md": report(f), "fit.json": json.dumps(as_json(f), indent=2) + "\n"}


def write(data: Path, f: Fit) -> None:
    out = data / "process-model"
    out.mkdir(exist_ok=True)
    for name, text in files(f).items():
        (out / name).write_text(text)
