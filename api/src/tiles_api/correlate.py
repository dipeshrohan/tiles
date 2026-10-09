"""The correlation finder (T3.11), pure: which variables separate failed (NG) batches from good
(OK) ones, ranked by effect size, optionally per segment (`split`), where an effect that cancels
out when everything is pooled shows.

For each variable and segment: the NG and OK means, Cohen's d (pooled standard deviation) with a
95% confidence interval (the normal approximation of Hedges and Olkin), and the point-biserial
correlation r. The numbers match the browser's correlationFinder (js/lib/analysis.ts) on the same
rows: test/fixtures/correlation.json keeps them matched. A row whose outcome is missing is left
out; a row whose variable is missing is left out of that variable only.
"""

import math
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

Z95 = 1.959963984540054  # the standard normal's 97.5th percentile


def _sum(xs: Sequence[float]) -> float:
    total = 0.0
    for x in xs:  # in order, as the browser adds them, so the results match to the last bit
        total += x
    return total


def _mean(xs: Sequence[float]) -> float:
    return _sum(xs) / len(xs) if xs else math.nan


def std(xs: Sequence[float]) -> float:
    if len(xs) < 2:
        return 0.0
    m = _mean(xs)
    return math.sqrt(_sum([(x - m) ** 2 for x in xs]) / (len(xs) - 1))


def cohens_d(a: Sequence[float], b: Sequence[float]) -> float:
    """Cohen's d between two groups (pooled standard deviation); 0 when it can't be told."""
    if len(a) < 2 or len(b) < 2:
        return 0.0
    pooled = math.sqrt(((len(a) - 1) * std(a) ** 2 + (len(b) - 1) * std(b) ** 2) / (len(a) + len(b) - 2))
    return (_mean(a) - _mean(b)) / pooled if pooled else 0.0


def d_interval(d: float, n1: int, n2: int) -> tuple[float, float] | None:
    """The 95% confidence interval of d: d ± 1.96 se, se² = (n1+n2)/(n1·n2) + d²/(2(n1+n2))."""
    if n1 < 2 or n2 < 2:
        return None
    se = math.sqrt((n1 + n2) / (n1 * n2) + d * d / (2 * (n1 + n2)))
    return d - Z95 * se, d + Z95 * se


def pearson(xs: Sequence[float], ys: Sequence[float]) -> float:
    n = min(len(xs), len(ys))
    if n < 3:
        return 0.0
    mx = _mean(xs[:n])
    my = _mean(ys[:n])
    num = dx = dy = 0.0
    for i in range(n):
        a = xs[i] - mx
        b = ys[i] - my
        num += a * b
        dx += a * a
        dy += b * b
    return num / math.sqrt(dx * dy) if dx and dy else 0.0


@dataclass(frozen=True)
class Finding:
    segment: str
    variable: str
    ng_mean: float
    ok_mean: float
    ng_count: int
    ok_count: int
    effect: float  # Cohen's d, NG minus OK
    ci_low: float | None
    ci_high: float | None
    r: float  # point-biserial: the variable against NG (1) or OK (0)

    @property
    def clear(self) -> bool:
        """Whether the interval leaves out 0: the groups differ, beyond chance at 95%."""
        return self.ci_low is not None and self.ci_high is not None and (self.ci_low > 0 or self.ci_high < 0)


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int | float) and math.isfinite(value):
        return float(value)
    return None


def find(
    rows: Sequence[Mapping[str, Any]],
    variables: Sequence[str],
    is_ng: Callable[[Any], bool],
    outcome: str,
    split: str | None = None,
) -> list[Finding]:
    """Ranks the variables by |d| (each segment's, if `split`; segments in order of first
    appearance), as the browser does. `is_ng(value)` says whether an outcome value is NG; a row
    with no outcome is left out."""
    judged = [r for r in rows if r.get(outcome) is not None]
    segments = list(dict.fromkeys(str(r.get(split)) for r in judged)) if split else ["all"]
    findings: list[Finding] = []
    for segment in segments:
        subset = [r for r in judged if str(r.get(split)) == segment] if split else judged
        flags = [bool(is_ng(r[outcome])) for r in subset]
        for v in variables:
            pairs = [
                (x, ng)
                for x, ng in ((_number(r.get(v)), ng) for r, ng in zip(subset, flags, strict=True))
                if x is not None
            ]
            bad = [x for x, ng in pairs if ng]
            good = [x for x, ng in pairs if not ng]
            d = cohens_d(bad, good)
            ci = d_interval(d, len(bad), len(good))
            findings.append(
                Finding(
                    segment=segment,
                    variable=v,
                    ng_mean=_mean(bad),
                    ok_mean=_mean(good),
                    ng_count=len(bad),
                    ok_count=len(good),
                    effect=d,
                    ci_low=ci[0] if ci else None,
                    ci_high=ci[1] if ci else None,
                    r=pearson([x for x, _ in pairs], [1.0 if ng else 0.0 for _, ng in pairs]),
                )
            )
    return sorted(findings, key=lambda f: -abs(f.effect))
