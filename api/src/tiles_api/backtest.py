"""Backtest (T3.05): replay a signal's history through detectors with different settings, and score
their warnings against the events they should have warned of (downtime, scrap, a seizure...).

For each setting: how many events had a warning in time (recall), how many warnings an event
followed (precision), the false warnings per day, and the warning time (from the warning to its
event) as a distribution. A warning warns of an event when it started within `horizon` before it
(`at - horizon < started_at <= at`); an event's warning time comes from the earliest such warning,
as the browser's scoreAlerts does (test/fixtures/friction-detection.json keeps them matched). A
warning no event followed within `horizon` is false, unless the history ends first: then it is
pending, and left out of precision. Only the events within the replayed history (from when the
baseline filled to the last reading) count, for recall and precision alike.

Each window size's baselines (the rolling median and MAD) are computed once, from a sorted copy of
the window, and give exactly the numbers detection.step gets; each setting is then replayed with
detection.judge, so a detector with the chosen setting raises the same warnings.
"""

import bisect
import itertools
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Any

from tiles_api.detection import Alert, Config, Direction, State, judge
from tiles_api.quality import duration, percent

# What one backtest may do: readings replayed (per setting) and readings baselined (per window size).
MAX_READINGS = 200_000
MAX_SETTINGS = 48
MAX_REPLAYS = 2_000_000  # readings x settings
MAX_BASELINES = 600_000  # readings x window sizes


@dataclass(frozen=True)
class Event:
    at: datetime
    code: str = ""


@dataclass(frozen=True)
class Spread:
    """A distribution of warning times, in seconds."""

    count: int
    min: float
    p10: float
    median: float
    p90: float
    max: float


@dataclass(frozen=True)
class EventOutcome:
    event: Event
    warned_at: datetime | None  # the start of the earliest warning of it, if any

    @property
    def warning_time(self) -> timedelta | None:
        return None if self.warned_at is None else self.event.at - self.warned_at


@dataclass
class Outcome:
    config: Config
    alerts: list[Alert]
    true_warnings: int
    false_warnings: int
    pending_warnings: int  # the history ends before their horizon does
    events: list[EventOutcome]  # the events within the replayed history
    days: float  # the replayed history, from the first reading judged to the last
    warning_times: Spread | None = field(default=None)

    @property
    def caught(self) -> int:
        return sum(e.warned_at is not None for e in self.events)

    @property
    def recall(self) -> float | None:
        return self.caught / len(self.events) if self.events else None

    @property
    def precision(self) -> float | None:
        judged = self.true_warnings + self.false_warnings
        return self.true_warnings / judged if judged else None

    @property
    def false_per_day(self) -> float | None:
        return self.false_warnings / self.days if self.days > 0 else None


def settings(
    window: Sequence[int],
    k: Sequence[float],
    persist: Sequence[int],
    direction: Sequence[Direction] = ("above",),
    cooldown: Sequence[int] = (0,),
    flat_spread: Sequence[float] = (1.0,),
) -> list[Config]:
    """Every combination of the given values, each once, in order."""
    combos = itertools.product(window, k, persist, direction, cooldown, flat_spread)
    return list(dict.fromkeys(Config(*c) for c in combos))


def max_readings(configs: Sequence[Config]) -> int:
    """The most readings one backtest may replay with `configs`."""
    windows = len({c.window for c in configs})
    return min(MAX_READINGS, MAX_REPLAYS // max(1, len(configs)), MAX_BASELINES // max(1, windows))


def check_size(readings: int, configs: Sequence[Config]) -> None:
    """Raises ValueError if replaying `readings` with `configs` is more than one backtest may do."""
    windows = len({c.window for c in configs})
    if not configs:
        raise ValueError("No settings to try")
    if len(configs) > MAX_SETTINGS:
        raise ValueError(f"{len(configs)} settings: at most {MAX_SETTINGS} at once")
    if readings > MAX_READINGS:
        raise ValueError(f"{readings} readings: at most {MAX_READINGS}; choose a shorter period")
    if readings > max_readings(configs):
        raise ValueError(
            f"{readings} readings with {len(configs)} settings ({windows} window sizes) is too much at once;"
            " try fewer settings or a shorter period"
        )


def _kth(k: int, center: float, s: Sequence[float], split: int) -> float:
    """The k-th smallest (from 0) distance from `center` of the sorted values `s`, where
    `s[:split]` are at most `center` and the rest above it. Distances below the center grow
    leftwards and those above it rightwards: two sorted runs, searched without merging."""
    a, b = split, len(s) - split

    def below(i: int) -> float:  # the i-th smallest distance below the center
        return center - s[split - 1 - i]

    def above(j: int) -> float:
        return s[split + j] - center

    # Take i from below and k + 1 - i from above: find the i where the two runs meet.
    lo, hi = max(0, k + 1 - b), min(k + 1, a)
    while lo < hi:
        i = (lo + hi) // 2
        if below(i) < above(k - i):  # j = k + 1 - i is at least 1 here, since i <= k
            lo = i + 1
        else:
            hi = i
    i, j = lo, k + 1 - lo
    return max(below(i - 1) if i > 0 else float("-inf"), above(j - 1) if j > 0 else float("-inf"))


def _median_mad(s: Sequence[float]) -> tuple[float, float]:
    """The median and scaled MAD of the sorted values `s`, as statistics.median and detection.mad
    compute them (the same operations on the same numbers, so the same results)."""
    n = len(s)
    mid = n // 2
    center = s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2
    split = bisect.bisect_right(s, center)
    deviation = (
        _kth(mid, center, s, split) if n % 2 else (_kth(mid - 1, center, s, split) + _kth(mid, center, s, split)) / 2
    )
    return center, 1.4826 * deviation


def baselines(values: Sequence[float], window: int) -> list[tuple[float, float] | None]:
    """For each reading, the median and scaled MAD of the `window` readings before it (None while
    there are fewer), kept in a sorted copy of the window as it slides."""
    out: list[tuple[float, float] | None] = [None] * min(window, len(values))
    s = sorted(values[:window])
    for i in range(window, len(values)):
        out.append(_median_mad(s))
        del s[bisect.bisect_left(s, values[i - window])]
        bisect.insort(s, values[i])
    return out


def _spread(seconds: list[float]) -> Spread | None:
    if not seconds:
        return None
    s = sorted(seconds)

    def q(p: float) -> float:  # linear between the closest ranks
        x = p * (len(s) - 1)
        i = int(x)
        return s[i] if i + 1 >= len(s) else s[i] + (s[i + 1] - s[i]) * (x - i)

    return Spread(len(s), s[0], q(0.1), q(0.5), q(0.9), s[-1])


def score(
    config: Config, alerts: list[Alert], events: Sequence[Event], horizon: timedelta, start: datetime, end: datetime
) -> Outcome:
    """Scores warnings (in the order they started) against events (in time order), for history
    judged from `start` to `end`. Only the events within it count, for recall and precision alike."""
    starts = [a.started_at for a in alerts]
    inside = [e for e in events if start <= e.at <= end]
    times = [e.at for e in inside]
    outcomes: list[EventOutcome] = []
    for e in inside:
        i = bisect.bisect_right(starts, e.at - horizon)  # the first warning started after at - horizon
        outcomes.append(EventOutcome(e, starts[i] if i < len(starts) and starts[i] <= e.at else None))
    true = false = pending = 0
    for s in starts:
        i = bisect.bisect_left(times, s)  # the first event at or after the warning
        if i < len(times) and times[i] < s + horizon:
            true += 1
        elif s + horizon > end:  # an event after the history could still make it true
            pending += 1
        else:
            false += 1
    caught = [o.warning_time.total_seconds() for o in outcomes if o.warning_time is not None]
    days = (end - start).total_seconds() / 86400
    return Outcome(config, alerts, true, false, pending, outcomes, days, _spread(caught))


def replay(
    times: Sequence[datetime],
    values: Sequence[float],
    events: Sequence[Event],
    configs: Sequence[Config],
    horizon: timedelta,
) -> list[Outcome]:
    """Replays readings (in time order) through a detector with each setting and scores each."""
    bands = {w: baselines(values, w) for w in dict.fromkeys(c.window for c in configs)}
    events = sorted(events, key=lambda e: e.at)
    outcomes = []
    for config in configs:
        state, closed, opened = State(), list[Alert](), list[Alert]()
        for i, b in enumerate(bands[config.window]):
            if b is not None:
                judge(config, state, times[i], values[i], b[0], b[1], closed, opened)
        if len(values) > config.window:
            outcomes.append(score(config, opened, events, horizon, times[config.window], times[-1]))
        else:  # the baseline never filled: nothing judged
            outcomes.append(Outcome(config, [], 0, 0, 0, [], 0.0))
    return outcomes


def ranked(outcomes: Sequence[Outcome]) -> list[Outcome]:
    """Best first: most events warned of, then fewest false warnings per day, then the longest
    median warning time; a setting that judged nothing (its baseline never filled) last."""

    def key(o: Outcome) -> tuple[bool, float, float, float]:
        median = o.warning_times.median if o.warning_times else 0.0
        return (o.days == 0, -(o.recall or 0.0), o.false_per_day or 0.0, -median)

    return sorted(outcomes, key=key)


def _percent(x: float | None) -> str:
    return "-" if x is None else percent(x)


def _cell(text: str) -> str:
    """Text in a Markdown table cell: on one line, its bars escaped."""
    return " ".join(text.split()).replace("\\", "\\\\").replace("|", "\\|")


def setting(c: Config) -> str:
    """A setting in one line, its defaults left out."""
    parts = [f"window {c.window}", f"k {c.k:g}", f"persist {c.persist}"]
    if c.direction != "above":
        parts.append(c.direction)
    if c.cooldown:
        parts.append(f"cooldown {c.cooldown}")
    if c.flat_spread != 1.0:
        parts.append(f"flat spread {c.flat_spread:g}")
    return ", ".join(parts)


def report(title: str, about: dict[str, Any], outcomes: Sequence[Outcome], horizon: timedelta) -> str:
    """The backtest as a Markdown report: the settings ranked, then the best one's events."""
    best = ranked(outcomes)
    lines = [f"# {_cell(title)}", ""]
    lines += [f"- **{k}:** {_cell(str(v))}" for k, v in about.items()]
    lines += [f"- **Warning horizon:** {duration(horizon.total_seconds())} before an event", ""]
    lines += [
        "## Settings, best first",
        "",
        "| Setting | Warnings | False per day | Recall | Precision | Warning time (median, p10 to p90) |",
        "|---|--:|--:|--:|--:|---|",
    ]
    for o in best:
        fpd = "-" if o.false_per_day is None else f"{o.false_per_day:.2f}"
        w = o.warning_times
        time = "-" if w is None else f"{duration(w.median)} ({duration(w.p10)} to {duration(w.p90)})"
        caught = f"{_percent(o.recall)} ({o.caught}/{len(o.events)})"
        lines.append(f"| {setting(o.config)} | {len(o.alerts)} | {fpd} | {caught} | {_percent(o.precision)} | {time} |")
    if best:
        top = best[0]
        lines += ["", f"## Events with the best setting ({setting(top.config)})", ""]
        lines += ["| Event | Code | Warned | Warning time |", "|---|---|---|--:|"]
        for e in top.events:
            wt = e.warning_time
            warned = "yes" if wt is not None else "**no**"
            lines.append(
                f"| {e.event.at.isoformat()} | {_cell(e.event.code) or '-'} | {warned} |"
                f" {'-' if wt is None else duration(wt.total_seconds())} |"
            )
        if top.pending_warnings:
            lines += ["", f"{top.pending_warnings} warning(s) near the end of the history are not scored yet."]
    return "\n".join(lines) + "\n"
