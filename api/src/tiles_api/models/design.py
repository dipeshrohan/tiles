"""Design Studio models (T4.10), ported from js/lib/design.ts into the shared registry: the cell
swelling force (1.0.0, 1.1.0, 2.0.0) and the humanoid joint actuator's winding temperature
(1.0.0, 1.1.0). The browser's versions 1.0, 1.1 and 2.0 are 1.0.0, 1.1.0 and 2.0.0 here.

A design model has no input series: its parameters are the design, and it gives one value. Each
version is its own class and, once published (models/published.json), never changes; a new
behaviour is a new version. test/fixtures/design-models.json, made by the browser's models
(test/design-parity.test.js), keeps the two giving the same numbers: the arithmetic is written in
the same order as the browser's so the results agree to the last bit.
"""

import math
from collections.abc import Mapping, Sequence
from typing import ClassVar

from tiles_api.models.registry import ModelSpec, Param, Port, register

SWELLING_PARAMS = (
    Param("soc", "%", 80, 0, 100, "state of charge"),
    Param("temperature", "°C", 25, -10, 60, "cell temperature"),
    Param("preload", "kN", 2, 0.5, 6, "stack preload"),
    Param("cycles", "", 300, 0, 2000, "cycle count"),
    Param("thickness", "µm", 95, 60, 140, "anode thickness"),
)
SWELLING_OUT = (Port("force", "kN", "swelling force", per="window"),)

ACTUATOR_PARAMS = (
    Param("torque", "N·m", 40, 5, 120, "continuous torque"),
    Param("ratio", ":1", 30, 6, 100, "gear ratio"),
    Param("kt", "N·m/A", 0.12, 0.05, 0.4, "torque constant"),
    Param("rth", "K/W", 1.6, 0.5, 4, "thermal resistance"),
    Param("ambient", "°C", 25, 0, 45, "ambient temperature"),
)
ACTUATOR_OUT = (Port("temp", "°C", "winding temperature", per="window"),)


def _swelling(version: str, description: str) -> ModelSpec:
    return ModelSpec(
        key="cell-swelling",
        version=version,
        name="Cell swelling force",
        kind="design",
        domain="electrochemical · mechanical",
        description=description,
        outputs=SWELLING_OUT,
        params=SWELLING_PARAMS,
    )


def _actuator(version: str, description: str) -> ModelSpec:
    return ModelSpec(
        key="joint-actuator",
        version=version,
        name="Humanoid joint actuator",
        kind="design",
        domain="electromechanical · thermal",
        description=description,
        outputs=ACTUATOR_OUT,
        params=ACTUATOR_PARAMS,
    )


@register
class Swelling100:
    spec: ClassVar[ModelSpec] = _swelling("1.0.0", "Preload plus graphite expansion with state of charge.")

    def run(self, inputs: Mapping[str, Sequence[float]], p: Mapping[str, float]) -> dict[str, list[float | None]]:
        return {"force": [p["preload"] + 0.018 * p["soc"] * (p["thickness"] / 100)]}


@register
class Swelling110:
    spec: ClassVar[ModelSpec] = _swelling(
        "1.1.0", "1.0.0 with a temperature term on the expansion and a linear term in cycles."
    )

    def run(self, inputs: Mapping[str, Sequence[float]], p: Mapping[str, float]) -> dict[str, list[float | None]]:
        force = (
            p["preload"]
            + 0.018 * p["soc"] * (p["thickness"] / 100) * (1 + 0.004 * (p["temperature"] - 25))
            + 0.0011 * p["cycles"]
        )
        return {"force": [force]}


@register
class Swelling200:
    spec: ClassVar[ModelSpec] = _swelling(
        "2.0.0",
        "Graphite expansion with state of charge, SEI growth with the square root of cycles, and a stiffening "
        "preload term.",
    )

    def run(self, inputs: Mapping[str, Sequence[float]], p: Mapping[str, float]) -> dict[str, list[float | None]]:
        intercalation = 0.021 * p["soc"] * (p["thickness"] / 100) * (1 + 0.0035 * (p["temperature"] - 25))
        sei = 0.045 * math.sqrt(p["cycles"]) * (1 + 0.012 * max(0, p["temperature"] - 25))
        return {"force": [p["preload"] * (1 + 0.04 * intercalation) + intercalation + sei]}


def _current(p: Mapping[str, float]) -> float:
    return p["torque"] / (p["ratio"] * 0.85) / p["kt"]


@register
class Actuator100:
    spec: ClassVar[ModelSpec] = _actuator("1.0.0", "Copper loss in the winding through the thermal resistance.")

    def run(self, inputs: Mapping[str, Sequence[float]], p: Mapping[str, float]) -> dict[str, list[float | None]]:
        loss = 3 * _current(p) ** 2 * 0.18
        return {"temp": [p["ambient"] + loss * p["rth"]]}


@register
class Actuator110:
    spec: ClassVar[ModelSpec] = _actuator(
        "1.1.0", "1.0.0 with copper resistance rising with temperature, solved to a fixed point."
    )

    def run(self, inputs: Mapping[str, Sequence[float]], p: Mapping[str, float]) -> dict[str, list[float | None]]:
        current = _current(p)
        t = p["ambient"]
        for _ in range(20):
            t = p["ambient"] + 3 * current**2 * 0.18 * (1 + 0.00393 * (t - 20)) * p["rth"]
        return {"temp": [t]}
