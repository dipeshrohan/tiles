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


def read_json(path: Path) -> dict[str, Any]:
    """A JSON file's object, or an empty one if there is no file."""
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


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
    unique = []
    for q in questions:
        if q.id not in seen:
            seen.add(q.id)
            unique.append(q)
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


@dataclass(frozen=True)
class Mode:
    """A way a machine degrades: how often, how fast, how it fails and how it is found."""

    name: str
    code: str  # the stop its failure is
    per_year: float
    ramp_days: tuple[float, float]  # working days from onset to failure
    shape: float  # severity = (elapsed / ramp) ** shape: slow, then fast
    caught: float  # the chance a planned maintenance finds it once it is 40 % of the way
    stop_hours: tuple[float, float]  # the repair: median hours and spread (log)
    component: str
    comments: tuple[str, ...]
    find: str  # what a maintenance job that finds it writes


@dataclass(frozen=True)
class RandomStop:
    """Stops nothing foretells: the mean running hours between them and their median minutes."""

    code: str
    mean_run_h: float
    median_min: float
    comments: tuple[str, ...]
    component: str = ""
    corrective: bool = True  # whether maintenance repairs it (a work order)


class Station:
    """A machine that runs jobs one at a time, each as soon as it may start (`run`): before a job
    it takes its planned stops and the stops imposed on it from outside (a dry room out of
    specification stops its assembly), then the failure of a degradation that has reached it, then
    the random stops due in its running time. A job isn't started if it would run into a planned
    stop or past the end of its working time; a planned stop that something else overtook is taken
    late, for its full length. Its continuous readings are written through `grid` every 5 minutes,
    with what it was doing then (run, idle, stop or off); `on_repair` hears of each repair and find."""

    GRID = 300

    def __init__(
        self,
        asset: str,
        working: Working,
        seed: str,
        *,
        random_stops: tuple[RandomStop, ...] = (),
        modes: tuple[Mode, ...] = (),
        planned: list[tuple[float, float, str, str]] | None = None,
        external: list[tuple[float, float, str, str]] | None = None,
        grid: Any = None,
        start: float,
        end: float,
        on_planned: Any = None,
        on_repair: Any = None,
        episodes: list[Episode] | None = None,
    ) -> None:
        self.asset = asset
        self.w = working
        self.r_ep = random.Random(f"{seed}/{asset}/episodes")
        self.r_stop = random.Random(f"{seed}/{asset}/stops")
        self.random_stops = random_stops
        self.modes = {m.name: m for m in modes}
        self.planned = sorted(planned or [])
        self.external = sorted(external or [])
        self.grid = grid
        self.on_planned = on_planned
        self.on_repair = on_repair
        self.start, self.end = start, end
        self.t = start  # when it is free
        self.run_s = 0.0
        self.next_grid = start
        self.pi = self.xi = 0
        self.random_next = {r.code: self._next(r) for r in random_stops}
        self.stops: list[Stop] = []
        self.maintenance: list[Maintenance] = []
        self.episodes: list[Episode] = episodes if episodes is not None else self._plan(modes)

    def _plan(self, modes: tuple[Mode, ...]) -> list[Episode]:
        total = self.w.cum[-1]
        out = []
        for mode in modes:
            onsets = sorted(self.r_ep.uniform(0.02, 0.97) * total for _ in range(poisson(self.r_ep, mode.per_year)))
            last_end = -1e18
            for k, w0 in enumerate(onsets):
                ramp = self.r_ep.uniform(*mode.ramp_days) * 86400
                if w0 < last_end + 3 * 86400:
                    continue
                last_end = w0 + ramp
                ep = Episode(
                    f"EP-{self.asset}-{mode.name}-{k + 1}",
                    self.asset,
                    mode.name,
                    self.w.at_seconds(w0),
                    ramp,
                    mode.shape,
                    self.r_ep.random() < mode.caught,
                )
                ep.w_onset = w0
                out.append(ep)
        return sorted(out, key=lambda e: e.onset)

    def _next(self, r: RandomStop) -> float:
        return self.r_stop.expovariate(1 / (r.mean_run_h * 3600))

    def sev(self, mode: str, t: float) -> float:
        """How far a degradation of this mode has gone at t (0 to 1)."""
        w = self.w.seconds(t)
        s = 0.0
        for ep in self.episodes:
            if ep.onset > t:
                break
            if ep.mode == mode:
                s = max(s, ep.severity(w, t))
        return min(s, 1.0)

    # ---- time passing ---------------------------------------------------------------------------

    def advance(self, to: float, mode: str) -> None:
        """The continuous readings due up to `to`; out of working time a point is `off`."""
        while self.next_grid < to:
            g = self.next_grid
            self.next_grid += self.GRID
            if self.grid is not None and g >= self.start:
                self.grid(self, g, mode if self.w.working(g) else "off")

    def _stop(self, start: float, end: float, code: str, planned: bool, text: str, episode: str | None = None) -> None:
        self.advance(start, "idle")
        if end - start >= 60:
            self.stops.append(Stop(self.asset, start, end, code, planned, text, episode))
        self.advance(end, "stop")

    def breakdown(
        self, t: float, dur: float, code: str, text: str, ep: Episode | None, component: str, corrective: bool = True
    ) -> float:
        """A stop needing `dur` working seconds of repair, continued into the next shifts; its end."""
        left, first = dur, t
        while left >= 1:
            i = self.w.index(t)
            if i >= len(self.w.intervals):
                break
            a, b = self.w.intervals[i]
            t = max(t, a)
            end = min(b, t + left)
            self._stop(t, end, code, False, text if t == first else f"{text} (continued)", ep.id if ep else None)
            left -= end - t
            t = end
        if ep:
            ep.resolved_at = t
        if corrective:
            self.maintenance.append(
                Maintenance(self.asset, first, t, "CM", component, code, text, ep.id if ep else None)
            )
            if self.on_repair:
                self.on_repair(self, self.maintenance[-1])
        return t

    def _planned_job(self, start: float, end: float, code: str, text: str) -> None:
        self._stop(start, end, code, True, text)
        found = []
        for ep in self.episodes:
            if ep.resolved_at is not None or ep.onset > start:
                continue
            s = ep.severity(self.w.seconds(start), start)
            if code == "PL-PM" and ep.catchable and s >= 0.4:
                ep.resolved_at, ep.peak, ep.outcome = start, s, "Found and fixed at planned maintenance"
                found.append(ep)
        self.maintenance.append(Maintenance(self.asset, start, end, "PM", "", code, text))
        for ep in found:
            m = self.modes[ep.mode]
            self.maintenance.append(Maintenance(self.asset, start, end, "INSP", m.component, m.code, m.find, ep.id))
            if self.on_repair:
                self.on_repair(self, self.maintenance[-1])
        if self.on_planned:
            self.on_planned(self, code, start, end)

    def run(self, ready: float, duration: float) -> tuple[float, float]:
        """Runs a job that may start at `ready`, taking `duration`; its start and end (the year's
        end, if no working time is left)."""
        while True:
            t = max(ready, self.t)
            i = self.w.index(t)
            if i >= len(self.w.intervals) or t >= self.end:
                self.t = self.end
                return self.end, self.end
            a, b = self.w.intervals[i]
            if t < a:
                t = a
            # A job that won't fit before the working time ends, or before a planned stop, waits.
            if t + duration > b and duration < b - a:
                ready = b
                continue
            if self.pi < len(self.planned) and t < self.planned[self.pi][0] < t + duration:
                ready = self.planned[self.pi][0]
                continue
            # Planned and imposed stops that began while it waited, or begin now.
            if self.pi < len(self.planned) and self.planned[self.pi][0] <= t:
                self._take_planned()
                continue
            if self.xi < len(self.external) and self.external[self.xi][0] <= t:
                start, end, code, text = self.external[self.xi]
                self.xi += 1
                begin = max(self.t, start)
                if end - begin >= 60:
                    self._stop(begin, end, code, False, text)
                    self.t = max(self.t, end)
                continue
            self.advance(t, "idle")
            # A degradation that has reached failure
            w = self.w.seconds(t)
            failed = next(
                (ep for ep in self.episodes if ep.onset <= t and ep.resolved_at is None and ep.severity(w, t) >= 1.0),
                None,
            )
            if failed:
                m = self.modes[failed.mode]
                dur = max(180.0, self.r_stop.lognormvariate(math.log(m.stop_hours[0] * 3600), m.stop_hours[1]))
                failed.failed_at, failed.peak, failed.outcome = t, 1.0, "Failed: the machine stopped"
                self.t = self.breakdown(t, dur, m.code, self.r_stop.choice(m.comments), failed, m.component)
                continue
            due = [r for r in self.random_stops if self.run_s >= self.random_next[r.code]]
            if due:
                r = min(due, key=lambda r: self.random_next[r.code])
                self.random_next[r.code] = self.run_s + self._next(r)
                dur = max(180.0, self.r_stop.lognormvariate(math.log(r.median_min * 60), 0.7))
                self.t = self.breakdown(t, dur, r.code, self.r_stop.choice(r.comments), None, r.component, r.corrective)
                continue
            end = t + duration
            self.advance(end, "run")
            self.run_s += duration
            self.t = end
            return t, end

    def finish(self) -> None:
        """Takes the planned stops left and writes the readings to the year's end."""
        while self.pi < len(self.planned):
            if self.w.working(max(self.t, self.planned[self.pi][0])):
                self._take_planned()
            else:
                self.pi += 1
        self.advance(self.end, "idle")
        self.close_episodes()

    def _take_planned(self) -> None:
        """The next planned stop, for its full length: from its start, or once the station is free."""
        start, end, code, text = self.planned[self.pi]
        self.pi += 1
        begin = max(self.t, start)
        end = min(self.end, begin + (end - start))
        if end - begin >= 60:
            self._planned_job(begin, end, code, text)
            self.t = max(self.t, end)

    def close_episodes(self) -> None:
        """The year's end: an episode still building up has the severity it reached."""
        w = self.w.seconds(self.end)
        for ep in self.episodes:
            if ep.resolved_at is None and ep.failed_at is None:
                ep.outcome = "Still building up at the end of the year"
                ep.peak = min(1.0, ep.severity(w, self.end - 1))
