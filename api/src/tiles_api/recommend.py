"""Setpoint recommendations (T11.02), pure: a sweep of a design model over the line's state, within
an engineer's limits, and the guard rails (T11.04) that keep every recommendation inside them.

The settable parameters (one or two) take `steps` values each, evenly from their limit's min to its
max, and their current value when it is inside the limits; every other parameter stays as the line
has it. The best point lowers the model's `objective` output the most; of points as good, the one
nearest the current setting (each change measured against its limit's width) wins, so nothing moves
that needn't. A recommendation is only made when the best point is better than now.

`breaches` is the guard rail: what lies outside its limit. A sweep's proposal is inside by
construction, and is checked again before it is kept and again before it is approved, against the
limits as they are then.
"""

import itertools
import math
from collections.abc import Mapping
from dataclasses import dataclass

from tiles_api.models.registry import Model, ModelError, evaluate

MAX_SETTABLE = 2
MAX_POINTS = 441  # model evaluations in one sweep (21 values of two parameters)


@dataclass(frozen=True)
class Limit:
    min: float
    max: float

    def holds(self, value: float) -> bool:
        return self.min <= value <= self.max


@dataclass(frozen=True)
class Sweep:
    proposal: dict[str, float]  # the settable parameters' best values
    now: dict[str, float | None]  # the model's outputs at the current state
    proposed: dict[str, float | None]  # and at the proposal
    points: int  # evaluations made


class NoBetter(Exception):
    """The current setting is already as good as any inside the limits."""

    def __init__(self, now: float) -> None:
        super().__init__(f"No setting inside the limits lowers it from {now:g}")
        self.now = now


def breaches(values: Mapping[str, float], limits: Mapping[str, Limit]) -> list[str]:
    """The parameters of `values` outside their limit, or with none: what a guard rail refuses."""
    return [p for p, v in values.items() if p not in limits or not limits[p].holds(v)]


def grid(limit: Limit, steps: int, current: float) -> list[float]:
    """`steps` values from the limit's min to its max, and the current value when it is inside."""
    if limit.min == limit.max:
        values = [limit.min]
    else:
        values = [limit.min + (limit.max - limit.min) * i / (steps - 1) for i in range(steps)]
    if limit.holds(current) and current not in values:
        values.append(current)
    return sorted(values)


def _outputs(model: Model, params: Mapping[str, float]) -> dict[str, float | None]:
    out = evaluate(model, {}, params)
    return {name: values[0] if values else None for name, values in out.items()}


def sweep(
    model: Model,
    state: Mapping[str, float],
    limits: Mapping[str, Limit],
    objective: str,
    steps: int = 11,
) -> Sweep:
    """The best setting of the parameters `limits` names, the rest at `state`. ModelError for a
    sweep the model can't take; NoBetter when nothing inside the limits beats now."""
    spec = model.spec
    if spec.kind != "design" or spec.inputs:
        raise ModelError(f"{spec.key} takes input series: only a design model is swept")
    if objective not in {p.name for p in spec.outputs}:
        raise ModelError(f"{spec.key} has no output {objective}")
    if not 1 <= len(limits) <= MAX_SETTABLE:
        raise ModelError(f"sweep one or two parameters, not {len(limits)}")
    unknown = [p for p in limits if p not in state]
    if unknown:
        raise ModelError(f"not parameters of {spec.key}: {', '.join(unknown)}")
    if steps < 2:
        raise ModelError("at least two steps")
    axes = {p: grid(limit, steps, state[p]) for p, limit in limits.items()}
    if math.prod(len(v) for v in axes.values()) > MAX_POINTS:
        raise ModelError(f"more than {MAX_POINTS} points: fewer steps")
    now = _outputs(model, state)
    current = now[objective]
    if current is None:
        raise ModelError(f"{spec.key} gives no {objective} at the current state")
    best: tuple[float, float, dict[str, float]] | None = None
    points = 0
    for combo in itertools.product(*axes.values()):
        candidate = dict(zip(axes, combo, strict=True))
        value = _outputs(model, {**state, **candidate})[objective]
        points += 1
        if value is None or math.isnan(value):
            continue
        moved = sum(abs(v - state[p]) / (limits[p].max - limits[p].min or 1.0) for p, v in candidate.items())
        if best is None or (value, moved) < (best[0], best[1]):
            best = (value, moved, candidate)
    if best is None or best[0] >= current:
        raise NoBetter(current)
    proposal = best[2]
    if breaches(proposal, limits):  # by construction never; the guard rail all the same
        raise ModelError("a proposal outside its limits")
    return Sweep(proposal, now, _outputs(model, {**state, **proposal}), points)
