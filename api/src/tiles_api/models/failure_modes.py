"""Die casting's next failure modes (T8.02 to T8.04, chosen in docs/failure-modes.md): a physics
model for each, ported to and from js/lib/failure-models.ts, which makes the parity fixture
test/fixtures/failure-models.json that both must match.

- **Shot accumulator charge** (DT-HYD): the nitrogen precharge from the charged pressure, by the
  gas law, and the pressure build-up time the orifice law expects at that pressure; what the
  build-up takes beyond it is the accumulator sagging on the shot.
- **Holding furnace heater** (DT-FUR): the power the bath should need while the cell casts, by a
  heat balance linearised about the set point; an ageing element draws more for the same bath.
- **Die cooling, moving half** (DT-DIE): the flow lost from the channel, and how much hotter the
  moving half runs than the fixed half, which sees the same shots, alloy and water.

Each gives its estimate per sample and the window's median, which a detector watches (the
window's median of a shot-by-shot residual is steadier than the shots).
"""

import math
import statistics
from collections.abc import Mapping, Sequence
from typing import ClassVar

from tiles_api.models.registry import ModelSpec, Param, Port, register

Series = list[float | None]


def _median(values: Series) -> float | None:
    known = [v for v in values if v is not None]
    return statistics.median(known) if known else None


@register
class AccumulatorCharge:
    spec: ClassVar[ModelSpec] = ModelSpec(
        key="accumulator-charge",
        version="1.0.0",
        name="Shot accumulator charge",
        kind="virtual-sensor",
        domain="die casting",
        description=(
            "The shot accumulator's nitrogen precharge from its charged pressure, p0 = p1·(1 - fill)^n, and the "
            "pressure build-up time the orifice law expects at that pressure, t = t_rated·√((p_rated - p_load) / "
            "(p1 - p_load)); the build-up time beyond it is the accumulator sagging on the shot."
        ),
        inputs=(
            Port("buildup", "ms", "pressure build-up time of each shot"),
            Port("pressure", "bar", "accumulator pressure before the shot"),
        ),
        outputs=(
            Port("precharge", "bar", "nitrogen precharge the charged pressure implies"),
            Port("expected_buildup", "ms", "build-up time expected at the charged pressure"),
            Port("excess_buildup", "ms", "build-up time beyond the expected"),
            Port("charge_loss", "", "the precharge lost against the rated one: the window's median", per="window"),
            Port("sag", "ms", "the window's median excess build-up time", per="window"),
        ),
        params=(
            Param("rated_pressure", "bar", 160, 50, 400, "charged pressure of a healthy accumulator"),
            Param("rated_buildup", "ms", 24, 1, 500, "build-up time of a healthy accumulator"),
            Param("load_pressure", "bar", 60, 0, 300, "pressure the intensifier needs to move"),
            Param("fill", "", 0.3, 0.01, 0.9, "oil volume the pump puts in, as a share of the gas volume"),
            Param("polytropic", "", 1.4, 1, 1.67, "polytropic exponent of the nitrogen"),
        ),
    )

    def run(self, inputs: Mapping[str, Sequence[float]], params: Mapping[str, float]) -> dict[str, Series]:
        buildup, pressure = inputs["buildup"], inputs["pressure"]
        p_rated, t_rated, p_load = params["rated_pressure"], params["rated_buildup"], params["load_pressure"]
        ratio = (1 - params["fill"]) ** params["polytropic"]
        precharge: Series = []
        expected: Series = []
        excess: Series = []
        for b, p in zip(buildup, pressure, strict=True):
            precharge.append(p * ratio)
            if p <= p_load:  # too little pressure to build at all: nothing to expect
                expected.append(None)
                excess.append(None)
                continue
            e = t_rated * math.sqrt((p_rated - p_load) / (p - p_load))
            expected.append(e)
            excess.append(b - e)
        p0 = _median(precharge)
        loss = None if p0 is None else 1 - p0 / (p_rated * ratio)
        return {
            "precharge": precharge,
            "expected_buildup": expected,
            "excess_buildup": excess,
            "charge_loss": [loss],
            "sag": [_median(excess)],
        }


@register
class FurnaceHeater:
    spec: ClassVar[ModelSpec] = ModelSpec(
        key="furnace-heater",
        version="1.0.0",
        name="Holding furnace heater",
        kind="virtual-sensor",
        domain="die casting",
        description=(
            "The power a holding furnace's bath needs while its cell casts, by a heat balance linearised about the "
            "set point, P = P_hold + P_cast + k·(T - T_set); an ageing heater element draws more than that for the "
            "same bath, and the excess is what it has lost. Samples with a cycle longer than max_cycle (the cell "
            "waiting) are left out."
        ),
        inputs=(
            Port("power", "kW", "heater power"),
            Port("bath", "°C", "bath temperature"),
            Port("cycle", "s", "the cell's cycle time at the reading"),
        ),
        outputs=(
            Port("demand", "kW", "power the bath needs"),
            Port("excess", "kW", "power drawn beyond the demand"),
            Port("heater_excess", "kW", "the window's median excess", per="window"),
            Port("bath_deficit", "°C", "the window's median bath temperature below the set point", per="window"),
        ),
        params=(
            Param("set_point", "°C", 690, 550, 800, "bath set point while the cell works"),
            Param("holding_power", "kW", 34, 0, 500, "power to hold the bath at its set point, the cell idle"),
            Param("casting_power", "kW", 14, 0, 500, "power the casting adds: the door, the ladle, the refill"),
            Param("loss_slope", "kW/K", 0.34, 0, 20, "holding power per kelvin of bath temperature"),
            Param("max_cycle", "s", 300, 1, 3600, "a longer cycle is the cell waiting, not casting"),
        ),
    )

    def run(self, inputs: Mapping[str, Sequence[float]], params: Mapping[str, float]) -> dict[str, Series]:
        power, bath, cycle = inputs["power"], inputs["bath"], inputs["cycle"]
        base = params["holding_power"] + params["casting_power"]
        set_point, slope, max_cycle = params["set_point"], params["loss_slope"], params["max_cycle"]
        demand: Series = []
        excess: Series = []
        deficit: Series = []
        for p, t, c in zip(power, bath, cycle, strict=True):
            if c > max_cycle or c <= 0:
                demand.append(None)
                excess.append(None)
                deficit.append(None)
                continue
            d = base + slope * (t - set_point)
            demand.append(d)
            excess.append(p - d)
            deficit.append(set_point - t)
        return {
            "demand": demand,
            "excess": excess,
            "heater_excess": [_median(excess)],
            "bath_deficit": [_median(deficit)],
        }


@register
class DieCooling:
    spec: ClassVar[ModelSpec] = ModelSpec(
        key="die-cooling",
        version="1.0.0",
        name="Die cooling, moving half",
        kind="virtual-sensor",
        domain="die casting",
        description=(
            "The cooling flow the moving half's channel has lost, 1 - Q / Q_rated, and the heat transfer left "
            "(h ∝ Q^0.8, Dittus-Boelter), with how much hotter the moving half runs than the fixed half, which "
            "sees the same shots, alloy and water: a blocked channel loses flow and runs hot. A channel scales "
            "slowly, so the window's blockage is also given beyond a limit, 0 below it: a physics threshold that "
            "a detector sees as a flat baseline until the limit is passed."
        ),
        inputs=(
            Port("die_temp", "°C", "moving half's temperature at each shot"),
            Port("fixed_temp", "°C", "fixed half's temperature at the same shot"),
            Port("flow", "l/min", "moving half's cooling flow"),
        ),
        outputs=(
            Port("flow_loss", "", "the flow lost against the rated flow"),
            Port("heat_transfer", "", "the heat transfer left, against a clean channel's"),
            Port("half_gap", "°C", "the moving half above the fixed half, beyond the design difference"),
            Port("blockage", "", "the window's median flow lost", per="window"),
            Port("hot_half", "°C", "the window's median half gap", per="window"),
            Port("over_limit", "", "the window's blockage beyond the limit, 0 below it", per="window"),
        ),
        params=(
            Param("rated_flow", "l/min", 42, 0.1, 1000, "a clean channel's flow"),
            Param("exponent", "", 0.8, 0.1, 2, "heat transfer per flow, as a power law"),
            Param("design_gap", "°C", 4, -50, 50, "how much hotter the moving half runs by design"),
            Param("limit", "", 0.2, 0, 1, "the flow lost at which the moving half runs too hot to cast sound parts"),
        ),
    )

    def run(self, inputs: Mapping[str, Sequence[float]], params: Mapping[str, float]) -> dict[str, Series]:
        moving, fixed, flow = inputs["die_temp"], inputs["fixed_temp"], inputs["flow"]
        rated, exponent, design = params["rated_flow"], params["exponent"], params["design_gap"]
        limit = params["limit"]
        loss: Series = []
        transfer: Series = []
        gap: Series = []
        for m, f, q in zip(moving, fixed, flow, strict=True):
            share = max(0.0, q) / rated
            loss.append(1 - share)
            transfer.append(share**exponent)
            gap.append(m - f - design)
        blockage = _median(loss)
        return {
            "flow_loss": loss,
            "heat_transfer": transfer,
            "half_gap": gap,
            "blockage": [blockage],
            "hot_half": [_median(gap)],
            "over_limit": [None if blockage is None else max(0.0, blockage - limit)],
        }
