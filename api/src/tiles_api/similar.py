"""Similar past warnings (T10.02), pure: how alike two warnings are, from what the detector saw.

A warning is described by its signal, detector, asset, side, how far it went past its threshold
(its severity: (peak - baseline) / (threshold - baseline), 1 at the threshold) and how long the
signal was out. Two warnings' similarity is a weighted sum in [0, 1]: the same signal, detector,
asset and side count fully or not at all; severity and duration count by their ratio
(exp(-|ln a/b|): 1 when equal, 0.5 at twice or half). A past warning counts as similar from MIN_SCORE.
"""

import math
from dataclasses import dataclass
from datetime import datetime

WEIGHTS = {"signal": 0.35, "detector": 0.15, "asset": 0.15, "side": 0.1, "severity": 0.15, "duration": 0.1}
MIN_SCORE = 0.5
DURATION_FLOOR_H = 0.05  # three minutes: short warnings compare by their order of magnitude, not to 0


@dataclass(frozen=True)
class Seen:
    """A warning as the detector saw it."""

    signal: str
    detector: str
    asset: str | None
    side: str
    peak: float
    baseline: float
    threshold: float
    started_at: datetime
    until: datetime  # its end, or its last reading while still out

    @property
    def severity(self) -> float:
        """How far past its threshold: 1 at the threshold, 2 twice as far from the baseline."""
        band = self.threshold - self.baseline
        return abs((self.peak - self.baseline) / band) if band else 1.0

    @property
    def hours(self) -> float:
        return max(0.0, (self.until - self.started_at).total_seconds() / 3600)


def _ratio(a: float, b: float) -> float:
    """1 when equal, 0.5 at twice or half, towards 0 further apart."""
    if a <= 0 or b <= 0:
        return 1.0 if a == b else 0.0
    return math.exp(-abs(math.log(a / b)))


def score(a: Seen, b: Seen) -> tuple[float, list[str]]:
    """How alike two warnings are, in [0, 1], and what they share (signal, detector, asset, side)."""
    shared = [
        k
        for k, same in (
            ("signal", a.signal == b.signal),
            ("detector", a.detector == b.detector),
            ("asset", a.asset is not None and a.asset == b.asset),
            ("side", a.side == b.side),
        )
        if same
    ]
    total = sum(WEIGHTS[k] for k in shared)
    total += WEIGHTS["severity"] * _ratio(a.severity, b.severity)
    total += WEIGHTS["duration"] * _ratio(a.hours + DURATION_FLOOR_H, b.hours + DURATION_FLOOR_H)
    return round(total, 3), shared
