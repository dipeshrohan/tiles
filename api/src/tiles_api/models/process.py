"""The process model for recommendations (T11.01): a die-casting shot's porosity, Line 2's main
quality driver, from its process state, fitted to the sample plant's X-ray table
(`sample_plant/die_casting/process_fit.py`, docs/process-model.md) and judged on history the fit
never saw.

A design model: its parameters are a shot's state (what the line measures and the set points it
casts to), and it gives the porosity expected, the X-ray grade that is and the chance the part is
scrap (grade 3 or more: porosity of 1.1 % or more), from the fit's residual spread. Sweeping its
settable parameters over the line's live state is what a recommendation is (T11.02). The
coefficients are this version's, never changed: a new fit is a new version.
"""

import math
from collections.abc import Mapping, Sequence
from typing import ClassVar

from tiles_api.models.registry import ModelSpec, Param, Port, register

# Fitted on October 2025 to March 2026 (process-model/fit.json); the plant's test checks them.
VACUUM_LEVEL = 50.0  # mbar
BUILDUP_LEVEL = 25.0  # ms
COEFFICIENTS = {
    "base": 0.19302,
    "vacuum": 0.002,
    "intensification": 0.00426,
    "hydrogen": 2.49836,
    "die_temp": 0.00401,
    "speed": 0.10856,
    "buildup": 0.00398,
}
RESIDUAL_SD = 0.09032  # porosity percentage points
GRADES = (0.6, 0.85, 1.1, 1.4)  # SOP-QA-05: the porosity each grade starts above
SCRAP_FROM = 1.1  # grade 3


def grade(porosity: float) -> int:
    return sum(porosity >= limit for limit in GRADES)


@register
class DiePorosity:
    spec: ClassVar[ModelSpec] = ModelSpec(
        key="die-porosity",
        version="1.0.0",
        name="Die-cast porosity",
        kind="design",
        domain="die casting",
        description=(
            "A shot's porosity (%) from its state, fitted by least squares to Line 2's X-ray table: "
            "0.19302 + 0.002 per mbar of vacuum above 50 mbar + 0.00426 per bar of intensification below its "
            "set point + 2.49836 per ml/100 g of hydrogen + 0.00401 per K of die temperature off its set point "
            "+ 0.10856 per m/s of second-phase speed below its set point + 0.00398 per ms of build-up above "
            "25 ms; with the X-ray grade it makes and the chance of scrap (1.1 % or more) from the fit's "
            "residual spread, 0.09032."
        ),
        outputs=(
            Port("porosity", "%", "Porosity expected", per="window"),
            Port("grade", "", "X-ray grade of the porosity expected (SOP-QA-05)", per="window"),
            Port("scrap_chance", "", "Chance the part is scrap (porosity of 1.1 % or more)", per="window"),
        ),
        params=(
            Param("vacuum", "mbar", 48, 0, 500, "Vacuum level"),
            Param("intensification", "bar", 900, 0, 1500, "Intensification pressure"),
            Param("intensification_set", "bar", 900, 500, 1500, "Intensification set point"),
            Param("hydrogen", "ml/100 g", 0.1, 0, 0.5, "Hydrogen in the melt"),
            Param("die_temp", "°C", 232, 100, 350, "Die temperature (mean of the halves)"),
            Param("die_temp_set", "°C", 232, 150, 300, "Die temperature set point"),
            Param("speed", "m/s", 4.8, 0.5, 8, "Second-phase speed"),
            Param("speed_set", "m/s", 4.8, 0.5, 8, "Second-phase speed set point"),
            Param("buildup", "ms", 24, 1, 200, "Pressure build-up time"),
        ),
    )

    def run(self, inputs: Mapping[str, Sequence[float]], params: Mapping[str, float]) -> dict[str, list[float | None]]:
        c = COEFFICIENTS
        porosity = (
            c["base"]
            + c["vacuum"] * max(0.0, params["vacuum"] - VACUUM_LEVEL)
            + c["intensification"] * max(0.0, params["intensification_set"] - params["intensification"])
            + c["hydrogen"] * params["hydrogen"]
            + c["die_temp"] * abs(params["die_temp"] - params["die_temp_set"])
            + c["speed"] * max(0.0, params["speed_set"] - params["speed"])
            + c["buildup"] * max(0.0, params["buildup"] - BUILDUP_LEVEL)
        )
        scrap = 0.5 * math.erfc((SCRAP_FROM - porosity) / (RESIDUAL_SD * math.sqrt(2)))
        return {"porosity": [porosity], "grade": [float(grade(porosity))], "scrap_chance": [scrap]}
