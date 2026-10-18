"""What every sample plant's generator uses: its files (text with their SHA-256, CSV), the historian
export by stream and month, the daily statistics and the month of readings its question set reads,
the working calendar, degradation episodes, stops and maintenance jobs, and the question set's rows.
"""

import bisect
import csv
import gzip
import hashlib
import io
import json
import math
import random
from array import array
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field
from datetime import UTC, datetime, tzinfo
from pathlib import Path
from typing import Any


def iso(t: float) -> str:
    """UTC with milliseconds, as a historian exports (rounded once, so 59.9996 s is 00.000 of the next minute)."""
    ms = round(t * 1000)
    return datetime.fromtimestamp(ms // 1000, UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


def local(t: float, zone: tzinfo) -> str:
    """The plant's time with its offset, as an MES exports."""
    return datetime.fromtimestamp(t, zone).isoformat(timespec="seconds")


class Text:
    """A text file written line by line, gzipped or not, with its rows and the SHA-256 of its text."""

    def __init__(self, path: Path, header: str, gz: bool) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        raw = path.open("wb")
        self.raw = raw
        self.out: Any = gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) if gz else raw
        self.sha = hashlib.sha256()
        self.rows = 0
        self.buf: list[str] = []
        self.line(header)
        self.rows = 0

    def line(self, text: str) -> None:
        self.buf.append(text + "\n")
        self.rows += 1
        if len(self.buf) >= 20_000:
            self.flush()

    def flush(self) -> None:
        if self.buf:
            data = "".join(self.buf).encode()
            self.sha.update(data)
            self.out.write(data)
            self.buf = []

    def close(self) -> dict[str, Any]:
        self.flush()
        if self.out is not self.raw:
            self.out.close()
        self.raw.close()
        return {"rows": self.rows, "sha256": self.sha.hexdigest()}


def write_csv(path: Path, header: Iterable[str], rows: Iterable[Iterable[Any]]) -> int:
    """A committed CSV file; its rows."""
    path.parent.mkdir(parents=True, exist_ok=True)
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator="\n")
    w.writerow(header)
    n = 0
    for row in rows:
        w.writerow(["" if v is None else v for v in row])
        n += 1
    path.write_text(buf.getvalue(), encoding="utf-8")
    return n


def write_json(path: Path, body: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


@dataclass
class Capture:
    """A month of readings (as the historian holds them) and of batch-table rows: what a question
    set reads, and what its test loads into Tiles."""

    start: float
    end: float
    readings: dict[str, tuple[array[float], array[float]]] = field(default_factory=dict)
    quality: dict[str, list[dict[str, Any]]] = field(default_factory=lambda: defaultdict(list))

    def add(self, tag: str, t: float, v: float) -> None:
        if self.start <= t < self.end:
            got = self.readings.get(tag)
            if got is None:
                got = self.readings[tag] = (array("d"), array("d"))
            got[0].append(t)
            got[1].append(v)


@dataclass
class Stats:
    """Per tag and plant day: min, max, sum, count (for a question set and its baseline)."""

    zone: tzinfo
    days: dict[tuple[str, str], list[float]] = field(default_factory=dict)

    def add(self, tag: str, t: float, v: float) -> None:
        day = datetime.fromtimestamp(t, self.zone).date().isoformat()
        s = self.days.get((tag, day))
        if s is None:
            self.days[(tag, day)] = [v, v, v, 1]
        else:
            if v < s[0]:
                s[0] = v
            if v > s[1]:
                s[1] = v
            s[2] += v
            s[3] += 1


class Historian:
    """The historian export: a gzipped CSV per stream (a cell, a line, the site) and month (UTC),
    or nothing written (`root` None) but the statistics and the capture."""

    def __init__(self, root: Path | None, stats: Stats, capture: Capture) -> None:
        self.root = root
        self.stats = stats
        self.capture = capture
        self.open: dict[str, tuple[str, Text]] = {}
        self.files: dict[str, dict[str, Any]] = {}
        self.month_cache: tuple[int, str] = (-1, "")
        self.closed: set[tuple[str, str]] = set()  # (stream, month) files already written

    def _month(self, t: float) -> str:
        hour = int(t // 3600)
        if self.month_cache[0] != hour:
            self.month_cache = (hour, datetime.fromtimestamp(t, UTC).strftime("%Y-%m"))
        return self.month_cache[1]

    def write(self, stream: str, tag: str, t: float, value: float | str) -> None:
        if isinstance(value, float | int):
            self.stats.add(tag, t, float(value))
            self.capture.add(tag, t, float(value))
        if self.root is None:
            return
        month = self._month(t)
        current = self.open.get(stream)
        if current is None or current[0] != month:
            if current:
                self.files[f"historian/{current[0]}/{stream}.csv.gz"] = current[1].close()
                self.closed.add((stream, current[0]))
            if (stream, month) in self.closed:  # it would be overwritten: a stream is written in time order
                raise ValueError(f"{stream}: a reading of {month} after a later month's ({tag} at {iso(t)})")
            text = Text(self.root / "historian" / month / f"{stream}.csv.gz", "timestamp,tag,value,quality", True)
            current = (month, text)
            self.open[stream] = current
        current[1].line(f"{iso(t)},{tag},{value},Good")

    def close(self) -> None:
        for _stream, (month, text) in self.open.items():
            self.files[f"historian/{month}/{_stream}.csv.gz"] = text.close()
        self.open = {}


class Working:
    """The working calendar: is a time in a shift, and how many working seconds lie before it."""

    def __init__(self, intervals: list[tuple[float, float]]) -> None:
        self.intervals = intervals
        self.starts = [a for a, _ in intervals]
        self.cum = [0.0]
        for a, b in intervals:
            self.cum.append(self.cum[-1] + b - a)

    def index(self, t: float) -> int:
        """The interval at or after t."""
        i = bisect.bisect_right(self.starts, t) - 1
        if i >= 0 and t < self.intervals[i][1]:
            return i
        return i + 1

    def seconds(self, t: float) -> float:
        i = bisect.bisect_right(self.starts, t) - 1
        if i < 0:
            return 0.0
        a, b = self.intervals[i]
        return self.cum[i] + min(t, b) - a

    def at_seconds(self, w: float) -> float:
        """The time when `w` working seconds have passed."""
        i = max(0, bisect.bisect_right(self.cum, w) - 1)
        if i >= len(self.intervals):
            return self.intervals[-1][1]
        return self.intervals[i][0] + (w - self.cum[i])

    def working(self, t: float) -> bool:
        i = self.index(t)
        return i < len(self.intervals) and self.intervals[i][0] <= t


@dataclass
class Episode:
    """A degradation: from its onset it grows in working time to failure at severity 1, unless it is
    found first (resolved)."""

    id: str
    asset: str
    mode: str
    onset: float  # epoch seconds
    ramp_s: float  # working seconds from onset to failure
    shape: float
    catchable: bool
    resolved_at: float | None = None
    outcome: str = ""  # failed, found at maintenance, in a quality hold…
    failed_at: float | None = None
    peak: float = 0.0  # the severity reached
    w_onset: float = 0.0  # working seconds at onset

    def severity(self, w: float, t: float) -> float:
        if t < self.onset or (self.resolved_at is not None and t >= self.resolved_at):
            return 0.0
        return float(max(0.0, (w - self.w_onset) / self.ramp_s) ** self.shape)


@dataclass
class Stop:
    asset: str
    start: float
    end: float
    code: str
    planned: bool
    comment: str
    episode: str | None = None


@dataclass
class Maintenance:
    """A job maintenance did: planned (PM), a repair after a stop (CM), or a find (INSP)."""

    asset: str
    start: float
    end: float
    kind: str  # PM, CM or INSP
    component: str
    code: str
    text: str
    episode: str | None = None


def poisson(rng: random.Random, lam: float) -> int:
    n, p, limit = 0, 1.0, math.exp(-lam)
    while True:
        p *= rng.random()
        if p <= limit:
            return n
        n += 1


def seasonal(t: float, zone: tzinfo) -> float:
    """-1 in late January, +1 in late July."""
    doy = datetime.fromtimestamp(t, zone).timetuple().tm_yday
    return math.sin(2 * math.pi * (doy - 116) / 365.25)


@dataclass
class Question:
    """A question of a plant's copilot set: its facts (alternatives joined by " | "), the tool calls
    that answer it (`plan`) and the readings they read (`data`: tag, from, to)."""

    id: str
    question: str
    tools: list[str] = field(default_factory=list)
    facts: list[str] = field(default_factory=list)
    absent: list[str] = field(default_factory=list)
    decline: bool = False
    notes: str = ""
    plan: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    data: list[tuple[str, str, str]] = field(default_factory=list)


def number(v: float, places: int) -> str:
    """As the grounding check reads it: rounded half up, without a trailing .0."""
    text = f"{math.floor(v * 10.0**places + 0.5) / 10.0**places:.{places}f}"
    return text[:-2] if text.endswith(".0") else text


def borderline(v: float, places: int) -> bool:
    """Too near a rounding boundary to be stated safely (the API sums in another order)."""
    x = v * 10.0**places
    return abs(x - math.floor(x) - 0.5) < 0.01


def write_questions(path: Path, questions: list[Question]) -> int:
    """The set as `tiles-evaluate --cases` reads it, with `plan` and `data` for the test; ids unique."""
    seen: set[str] = set()
    unique = [q for q in questions if not (q.id in seen or seen.add(q.id))]  # type: ignore[func-returns-value]
    return write_csv(
        path,
        ("id", "question", "tools", "facts", "absent", "decline", "notes", "plan", "data"),
        (
            (
                q.id,
                q.question,
                "; ".join(q.tools),
                "; ".join(q.facts),
                "; ".join(q.absent),
                "yes" if q.decline else "",
                q.notes,
                json.dumps(q.plan, ensure_ascii=False) if q.plan else "",
                "; ".join(f"{t}@{a}/{b}" for t, a, b in q.data),
            )
            for q in unique
        ),
    )
