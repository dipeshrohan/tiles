"""Plunger friction (T3.02): a virtual sensor for the die-casting shot sleeve, ported from
js/lib/physics.ts (estimateFriction).

The plunger obeys m·a = Ph·Ah - Pm·Am - F. Every shot records velocity and the
hydraulic and metal pressures over time, so F, the friction nobody can measure,
is what is left over: one residual per sample, and their median for the shot.
Friction creeps up for hours before a seizure, which is what makes it worth
watching (T3.04). test/fixtures/plunger-shots.json, made by the browser's model,
keeps the two implementations giving the same numbers.
"""

import statistics
from collections.abc import Mapping, Sequence
from typing import ClassVar

from tiles_api.models.registry import ModelSpec, Param, Port, register

BAR = 1e5  # Pa per bar


@register
class PlungerFriction:
    spec: ClassVar[ModelSpec] = ModelSpec(
        key="plunger-friction",
        version="1.0.0",
        name="Plunger friction",
        kind="virtual-sensor",
        domain="die casting",
        description=(
            "Friction on the shot plunger from one shot's velocity and pressures, by the equation of motion "
            "m·a = Ph·Ah - Pm·Am - F; the shot's estimate is the median residual."
        ),
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

    def run(self, inputs: Mapping[str, Sequence[float]], params: Mapping[str, float]) -> dict[str, list[float | None]]:
        t, v, ph, pm = inputs["t"], inputs["v"], inputs["ph"], inputs["pm"]
        mass, ah, am = params["mass"], params["hydraulic_area"], params["metal_area"]
        force: list[float | None] = [None]
        for i in range(1, len(t)):
            dt = t[i] - t[i - 1]
            if dt <= 0:  # repeated or out-of-order timestamps: no acceleration to speak of
                force.append(None)
                continue
            acc = (v[i] - v[i - 1]) / dt
            force.append(ph[i] * BAR * ah - pm[i] * BAR * am - mass * acc)
        known = [f for f in force if f is not None]
        return {"force": force[: len(t)], "friction": [statistics.median(known) if known else None]}
