"""Streaming detection (T3.04): a signal leaving its own recent behaviour, persistently.

Each reading is compared with a rolling robust baseline of the `window` readings
before it: the median, and the MAD (scaled to a standard deviation, at least
`min_spread`). A reading more than `k` spreads above it (or below, or either way,
by `direction`) counts as out; `persist` readings out in a row raise a warning,
which stays open while readings stay out and closes at the first one back in.
After a warning closes, `cooldown` readings must pass before another can open, so
one rough patch isn't many warnings.

The detector keeps its state (the baseline window, the run of readings out, the
open warning, the cooldown left) so the job (`tiles-detect`) can feed it new
readings run after run and get the same warnings as one pass over all of them.
With `cooldown` 0 and `direction` above, it gives the same alerts as the
browser's detectFrictionAlerts (js/lib/physics.ts); test/fixtures/friction-detection.json
keeps them matched.
"""

import statistics
from collections import deque
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Literal

Direction = Literal["above", "below", "both"]


@dataclass(frozen=True)
class Config:
    window: int = 200  # readings in the baseline
    k: float = 4.0  # robust spreads from the baseline
    persist: int = 3  # readings out in a row to raise a warning
    direction: Direction = "above"
    cooldown: int = 0  # readings after a warning closes before another can open
    min_spread: float = 1.0  # above 0: the spread never counts as less (a flat baseline isn't infinitely strict)

    def as_json(self) -> dict[str, Any]:
        return {k: getattr(self, k) for k in ("window", "k", "persist", "direction", "cooldown", "min_spread")}


@dataclass
class Alert:
    started_at: datetime  # the reading that completed the persistence run
    last_at: datetime
    peak: float  # the furthest reading from the baseline (in the warning's direction)
    baseline: float  # the median when it opened
    threshold: float  # the limit it crossed when it opened
    side: Literal["above", "below"]
    ended_at: datetime | None = None  # the first reading back in
    readings: int = 0


@dataclass
class State:
    baseline: deque[float] = field(default_factory=deque)
    run: int = 0
    open: Alert | None = None
    cooldown_left: int = 0

    def as_json(self) -> dict[str, Any]:
        w = self.open
        return {
            "baseline": list(self.baseline),
            "run": self.run,
            "cooldown_left": self.cooldown_left,
            "open": None
            if w is None
            else {
                "started_at": w.started_at.isoformat(),
                "last_at": w.last_at.isoformat(),
                "peak": w.peak,
                "baseline": w.baseline,
                "threshold": w.threshold,
                "side": w.side,
                "readings": w.readings,
            },
        }

    @classmethod
    def from_json(cls, data: dict[str, Any] | None) -> "State":
        if not data:
            return cls()
        o = data.get("open")
        open_ = (
            None
            if o is None
            else Alert(
                started_at=datetime.fromisoformat(o["started_at"]),
                last_at=datetime.fromisoformat(o["last_at"]),
                peak=o["peak"],
                baseline=o["baseline"],
                threshold=o["threshold"],
                side=o["side"],
                readings=o["readings"],
            )
        )
        return cls(deque(data.get("baseline", [])), data.get("run", 0), open_, data.get("cooldown_left", 0))


def mad(values: Iterable[float], center: float) -> float:
    return 1.4826 * statistics.median(abs(v - center) for v in values)


def step(config: Config, state: State, readings: Iterable[tuple[datetime, float]]) -> tuple[list[Alert], list[Alert]]:
    """Feeds readings (in time order) through the detector, changing `state`. Returns the warnings
    that closed and those opened (a warning can be in both); the open one, if any, is `state.open`."""
    closed: list[Alert] = []
    opened: list[Alert] = []
    for at, value in readings:
        base = state.baseline
        just_closed = False
        if len(base) >= config.window:
            center = statistics.median(base)
            spread = max(mad(base, center), config.min_spread)
            upper = center + config.k * spread
            lower = center - config.k * spread
            side: Literal["above", "below"] | None = None
            if config.direction in ("above", "both") and value > upper:
                side = "above"
            elif config.direction in ("below", "both") and value < lower:
                side = "below"
            if side is not None:
                state.run += 1
                if state.open is not None:
                    w = state.open
                    w.last_at = at
                    w.readings += 1
                    w.peak = max(w.peak, value) if w.side == "above" else min(w.peak, value)
                elif state.run >= config.persist and state.cooldown_left == 0:
                    state.open = Alert(
                        started_at=at,
                        last_at=at,
                        peak=value,
                        baseline=center,
                        threshold=upper if side == "above" else lower,
                        side=side,
                        readings=1,
                    )
                    opened.append(state.open)
            else:
                state.run = 0
                if state.open is not None:
                    state.open.ended_at = at
                    closed.append(state.open)
                    state.open = None
                    state.cooldown_left = config.cooldown
                    just_closed = True
            # The cooldown counts every reading after a warning closes, in or out.
            if state.cooldown_left and state.open is None and not just_closed:
                state.cooldown_left -= 1
        base.append(value)
        if len(base) > config.window:
            base.popleft()
    return closed, opened
