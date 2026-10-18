"""A year of the sample plant, shot by shot.

Each die-casting cell is simulated from its shift calendar: shots at the die's cycle, planned stops
(weekly maintenance, plunger tip changes, die changes), random stops (electrical, robot, trim press,
operators), stops for want of metal when the melting furnace stops, and degradation episodes that
build up over working days until they stop the machine or are found first:

- plunger: the tip scores and friction rises (`plunger_pressure_1st`), until it seizes (DT-PLG);
- accumulator: the shot accumulator loses its nitrogen precharge: pressure builds up slower,
  intensification falls, porosity rises (DT-HYD);
- cooling: a moving-half cooling channel scales up: flow falls, the die runs hot, parts solder (DT-DIE);
- vacuum: the vacuum filter clogs: the cavity vacuum worsens, porosity rises (DT-VAC);
- spray: spray nozzles block: manifold pressure falls, parts stick (DT-SPR);
- furnace: a holding-furnace heater element ages, then fails (DT-FUR);
- oil: the hydraulic oil cooler fouls in summer (DT-OIL).

Every reading follows from the state of the cell at that moment, so the precursors are in the data
the way they would be at a real plant, at the strength the ground truth records. The plunger's
pressure in the slow phase obeys the same equation of motion as the plunger-friction model
(js/lib/physics.ts), with the same constants. Randomness is seeded per cell and purpose, so the
year is the same on every run.
"""

import bisect
import math
import random
from array import array
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta

from tiles_api.sample_plant.common import Episode, Maintenance, Stop, Working
from tiles_api.sample_plant.die_casting import calendar as cal
from tiles_api.sample_plant.die_casting.plant import (
    CELLS,
    END,
    PRODUCT,
    SEED,
    START,
    ZONE,
    Cell,
    Product,
)

# js/lib/physics.ts PLUNGER: the plunger and its rod, and the areas pressure acts on.
MASS, AH, AM, BAR = 42.0, 0.0079, 0.0028, 1e5
SAMPLES, DT = 80, 0.005
SLOW_METAL_BAR = sum(8 + 30 * (i / 55) ** 2 for i in range(8, 30)) / 22  # metal pressure, steady slow phase
GRID = 300  # seconds between continuous readings
# The process model behind the X-ray grades (the ground truth for T11.01's model): a shot's porosity
# in percent, from its process values against the die's set points, plus noise and, now and then, air
# entrapped (0.4 to 1.0 % more).
POROSITY = {
    "base": 0.45,
    "vacuum_above_50_mbar": 0.0020,
    "intensification_below_set_bar": 0.0030,
    "hydrogen_above_0.10": 2.5,
    "die_temp_off_set_c": 0.004,
    "speed_2nd_below_set_m_s": 0.12,
    "buildup_above_25_ms": 0.006,
    "noise_sd": 0.07,
    "entrapped_air_chance": 0.006,
}


def friction_to_pressure(f_newton: float) -> float:
    """The shot cylinder's pressure in the slow phase (bar), at constant speed (samples 8 to 29 of a
    shot): Ph·Ah = Pm·Am + F."""
    return (SLOW_METAL_BAR * BAR * AM + f_newton) / AH / BAR


@dataclass(frozen=True)
class Mode:
    name: str
    code: str
    per_year: float
    ramp_days: tuple[float, float]  # working days from onset to failure
    shape: float  # severity = (elapsed / ramp) ** shape: slow, then fast
    caught: float  # the chance planned maintenance finds it once it is half way
    stop_hours: tuple[float, float]  # the repair: median hours and spread (log)
    component: str
    summer_only: bool = False


MODES = {
    m.name: m
    for m in (
        Mode("plunger", "DT-PLG", 3.0, (2.0, 6.0), 2.2, 0.3, (6.0, 0.35), "Plunger tip and shot sleeve"),
        Mode("accumulator", "DT-HYD", 2.5, (1.0, 4.0), 1.6, 0.25, (2.5, 0.4), "Shot accumulator"),
        Mode("cooling", "DT-DIE", 3.5, (6.0, 18.0), 1.7, 0.2, (6.0, 0.3), "Die cooling, moving half"),
        Mode("vacuum", "DT-VAC", 4.5, (3.0, 9.0), 1.8, 0.5, (1.5, 0.4), "Vacuum filter and valve"),
        Mode("spray", "DT-SPR", 5.0, (0.8, 2.5), 1.4, 0.4, (1.0, 0.4), "Spray nozzles"),
        Mode("furnace", "DT-FUR", 1.0, (6.0, 25.0), 3.0, 0.1, (8.0, 0.3), "Holding furnace heater element"),
        Mode("oil", "DT-OIL", 1.5, (2.0, 7.0), 1.5, 0.3, (1.5, 0.3), "Hydraulic oil cooler", summer_only=True),
    )
}
# Random stops: the mean running hours between them on a pilot cell, and their median minutes.
RANDOM = {
    "DT-ELE": (150.0, 70.0),
    "DT-ROB": (45.0, 25.0),
    "DT-TRM": (90.0, 30.0),
    "DT-SEN": (250.0, 45.0),
    "DT-OTH": (60.0, 20.0),
    "DT-OPR": (200.0, 40.0),  # night shifts only
}
OLDER_CELLS = 1.6  # Line 1's cells stop this much more often
MIN_STOP_S = 180  # the MES logs stops of three minutes or more
WARM_IDLE_S = 1800  # idle longer than this, the die must warm up again
TIP_LIFE = 20_000  # shots between planned tip changes (SOP-DC-04)

COMMENTS = {
    "DT-PLG": (
        "Plunger stuck in the sleeve, tip changed",
        "Tip scored, sleeve honed and tip changed",
        "Plunger seized: tip and sleeve changed",
    ),
    "DT-HYD": (
        "Accumulator pressure low: nitrogen recharged",
        "Pressure build-up alarm, accumulator recharged",
        "Intensification fault, precharge low",
    ),
    "DT-OIL": ("Oil over temperature alarm, cooler cleaned", "Hydraulic oil too hot: cooler flushed"),
    "DT-DIE": (
        "Soldering on the moving half: die cleaned, channel descaled",
        "Die too hot, cooling channel blocked: cleaned",
    ),
    "DT-VAC": ("Vacuum fault: filter changed", "Vacuum valve blocked, cleaned and filter changed"),
    "DT-SPR": ("Spray nozzles blocked: cleaned", "Spray fault, nozzles changed"),
    "DT-FUR": ("Holding furnace heater failed: element changed", "Furnace temperature low, heater element replaced"),
    "DT-ELE": ("Drive fault, reset", "Light curtain fault", "Control cabinet fan failed", "PLC communication fault"),
    "DT-ROB": ("Extraction robot gripper fault", "Robot lost part", "Robot collision alarm, reset"),
    "DT-TRM": ("Trim press: part not seated", "Trim die cleaned", "Trim press hydraulic fault"),
    "DT-SEN": ("Part present sensor faulty", "Thermocouple fault", "Ladle sensor dirty"),
    "DT-OTH": ("Waiting for crane", "Cleaning", "Unknown, restarted", "Ladle cleaned"),
    "DT-OPR": ("No operator on the cell", "Operator covering another cell"),
    "DT-MAT": ("No metal from MF-01", "Waiting for the transport ladle"),
    "DT-QH": ("Quality hold: X-ray rejects for porosity", "Quality hold: porosity, QA checked the cell"),
    "PL-PM": ("Weekly planned maintenance",),
    "PL-TIP": ("Plunger tip change at 20,000 shots",),
    "PL-DIE": ("Die change",),
    "PL-TRL": ("Trial run for a die modification",),
}


@dataclass
class SiteSeries:
    """What the whole site shares, on the 5-minute grid: the hall's air, the cooling water, the
    melt from MF-01 and its hydrogen, sampled by the lab."""

    t0: float
    ambient: list[float]
    water: list[float]
    melt: list[float]
    gas: list[float]
    air: list[float]
    lab_times: list[float]
    lab_h2: list[float]
    degas_episodes: list[Episode]

    def at(self, series: list[float], t: float) -> float:
        i = min(len(series) - 1, max(0, int((t - self.t0) // GRID)))
        return series[i]

    def hydrogen(self, t: float) -> float:
        i = bisect.bisect_right(self.lab_times, t) - 1
        return self.lab_h2[max(0, i)]


def seasonal(t: float) -> float:
    """-1 in late January, +1 in late July."""
    doy = datetime.fromtimestamp(t, ZONE).timetuple().tm_yday
    return math.sin(2 * math.pi * (doy - 116) / 365.25)


def site_series(working: Working, shifts: list[cal.Shift]) -> SiteSeries:
    rng = random.Random(f"{SEED}/site")
    t0, t1 = START.timestamp(), END.timestamp()
    n = int((t1 - t0) // GRID)
    ambient, water, melt, gas, air = [], [], [], [], []
    a_noise = w_noise = 0.0
    for i in range(n):
        t = t0 + i * GRID
        local = datetime.fromtimestamp(t, ZONE)
        hour = local.hour + local.minute / 60
        working_now = working.index(t) < len(working.intervals) and working.intervals[working.index(t)][0] <= t
        a_noise = 0.97 * a_noise + rng.gauss(0, 0.12)
        w_noise = 0.98 * w_noise + rng.gauss(0, 0.05)
        s = seasonal(t)
        ambient.append(
            19 + 8.5 * s + 2.5 * math.sin(2 * math.pi * (hour - 9) / 24) + (5.0 if working_now else 0.0) + a_noise
        )
        water.append(22 + 6.0 * s + 1.2 * math.sin(2 * math.pi * (hour - 15) / 24) + w_noise)
        melt.append((742 if working_now else 715) + rng.gauss(0, 3.0))
        gas.append((205 if working_now else 48) + rng.gauss(0, 9.0))
        air.append(7.1 - (0.25 if working_now else 0.0) + rng.gauss(0, 0.04))
    # The degassing rotor wears two or three times a year and hydrogen creeps up; the melting team
    # re-degasses when the lab finds more than 0.19 ml/100g.
    degas = []
    for k in range(3):
        onset = working.at_seconds(rng.uniform(0.05, 0.95) * working.cum[-1])
        ep = Episode(f"EP-DG01-{k + 1}", "DG-01", "degassing", onset, rng.uniform(3, 10) * 86400, 1.5, False)
        ep.w_onset = working.seconds(onset)
        degas.append(ep)
    degas.sort(key=lambda e: e.onset)
    lab_times, lab_h2 = [], []
    for sh in shifts:
        for frac in (0.15, 0.6):  # two density-index tests a shift
            t = sh.start.timestamp() + frac * (sh.end.timestamp() - sh.start.timestamp()) + rng.uniform(-600, 600)
            w = working.seconds(t)
            extra = sum(0.12 * e.severity(w, t) for e in degas)
            h2 = max(0.04, 0.10 + 0.025 * seasonal(t) + extra + rng.gauss(0, 0.012))
            lab_times.append(t)
            lab_h2.append(round(h2, 3))
            for e in degas:
                if e.resolved_at is None and e.onset <= t and h2 > 0.19:
                    e.resolved_at = t + 2 * 3600
                    e.outcome = "Re-degassed and rotor changed after a high hydrogen test"
                    e.peak = e.severity(w, t)
    for e in degas:
        if e.resolved_at is None:
            e.resolved_at = e.onset + e.ramp_s * 1.4
            e.outcome = "Rotor changed at the planned melting maintenance"
    return SiteSeries(t0, ambient, water, melt, gas, air, lab_times, lab_h2, degas)


def melting_stops(working: Working) -> list[Stop]:
    """MF-01's stops: Line 2's cells run out of metal when one lasts more than 20 minutes."""
    rng = random.Random(f"{SEED}/MF-01")
    out = []
    w = rng.expovariate(1 / (140 * 3600))
    while w < working.cum[-1]:
        start = working.at_seconds(w)
        dur = max(MIN_STOP_S, rng.lognormvariate(math.log(35 * 60), 0.7))
        code = rng.choice(("DT-ELE", "DT-OTH", "DT-SEN", "DT-FUR"))
        text = {
            "DT-ELE": "Burner control fault",
            "DT-OTH": "Charging machine blocked",
            "DT-SEN": "Level sensor fault",
            "DT-FUR": "Burner flame failure",
        }[code]
        out.append(Stop("MF-01", start, start + dur, code, False, text))
        w += dur + rng.expovariate(1 / (140 * 3600))
    return out


def other_stops(asset: str, working: Working, mean_h: float, median_min: float, codes: tuple[str, ...]) -> list[Stop]:
    """Stops of a machine outside the die-casting cells, from the MES (no sensor data)."""
    rng = random.Random(f"{SEED}/{asset}")
    out = []
    w = rng.expovariate(1 / (mean_h * 3600))
    while w < working.cum[-1]:
        start = working.at_seconds(w)
        dur = max(MIN_STOP_S, rng.lognormvariate(math.log(median_min * 60), 0.8))
        code = rng.choice(codes)
        out.append(Stop(asset, start, start + dur, code, False, rng.choice(COMMENTS.get(code, ("",)))))
        w += dur + rng.expovariate(1 / (mean_h * 3600))
    return out


Sink = Callable[[str, float, float | str], None]


@dataclass
class ShotRecord:
    """One shot as the cell and X-ray saw it: the quality table's row."""

    shot_id: str
    at: float
    product: str
    values: dict[str, float]
    hydrogen: float
    porosity: float
    grade: int
    parts: int
    scrapped: int
    defect: str


@dataclass
class CellResult:
    cell: Cell
    stops: list[Stop] = field(default_factory=list)
    maintenance: list[Maintenance] = field(default_factory=list)
    episodes: list[Episode] = field(default_factory=list)
    scrap: list[tuple[float, str, str, str]] = field(default_factory=list)  # time, product, code, part id
    shots: int = 0
    parts: int = 0
    die_changes: list[tuple[float, str]] = field(default_factory=list)  # time, the product now cast
    shot_times: array[float] = field(default_factory=lambda: array("d"))  # when each shot began


class CellSim:
    def __init__(
        self,
        cell: Cell,
        working: Working,
        shifts: list[cal.Shift],
        site: SiteSeries,
        line_stops: list[Stop],
        reading: Sink,
        shot: Callable[[Cell, ShotRecord], None],
        trace: Callable[[float, float], None] | None,
        trace_window: tuple[float, float] | None,
    ) -> None:
        self.c = cell
        self.w = working
        self.shifts = shifts
        self.shift_starts = [s.start.timestamp() for s in shifts]
        self.site = site
        self.line_stops = sorted(line_stops, key=lambda s: s.start)
        self.reading = reading
        self.on_shot = shot
        self.trace = trace
        self.trace_window = trace_window
        self.full = cell.historian == "full"
        tag = cell.asset
        self.r_ep = random.Random(f"{SEED}/{tag}/episodes")
        self.r_stop = random.Random(f"{SEED}/{tag}/stops")
        self.r_shot = random.Random(f"{SEED}/{tag}/shots")
        self.r_grid = random.Random(f"{SEED}/{tag}/grid")
        self.res = CellResult(cell)
        self.scale = OLDER_CELLS if not self.full else 1.0
        # State
        self.die_index = 0
        self.product: Product = PRODUCT[cell.dies[0]]
        self.die_shots = 30_000 + self.r_shot.randint(0, 20_000)
        self.tip_shots = self.r_shot.randint(0, TIP_LIFE - 2000)
        self.tip_life = TIP_LIFE + self.r_shot.randint(-1500, 1500)
        self.counter = 1_200_000 + 250_000 * cell.number + self.r_shot.randint(0, 99_999)
        self.t_fixed = self.t_moving = 25.0
        self.last_shot = START.timestamp() - 86400
        self.warm_left = 0
        self.oil = 32.0
        self.recent_por: list[int] = []
        self.next_grid = START.timestamp()
        self.bucket: dict[str, list[float]] = {}  # an older cell's 5-minute averages
        self.pm_count = 0
        self.tip_due: float | None = None
        self.hold_until = 0.0  # a quality hold's end

    # ---- planning -------------------------------------------------------------------------------

    def plan_episodes(self) -> None:
        total = self.w.cum[-1]
        for mode in MODES.values():
            count = self._poisson(mode.per_year * self.scale)
            onsets = sorted(self.r_ep.uniform(0.02, 0.97) * total for _ in range(count))
            last_end = -1e18
            for k, w0 in enumerate(onsets):
                onset = self.w.at_seconds(w0)
                if mode.summer_only:
                    month = datetime.fromtimestamp(onset, ZONE).month
                    if month not in (6, 7, 8, 9):
                        continue
                ramp = self.r_ep.uniform(*mode.ramp_days) * 86400  # working seconds
                if w0 < last_end + 3 * 86400:
                    continue
                last_end = w0 + ramp
                ep = Episode(
                    f"EP-{self.c.asset}-{mode.name}-{k + 1}",
                    self.c.asset,
                    mode.name,
                    onset,
                    ramp,
                    mode.shape,
                    self.r_ep.random() < mode.caught,
                )
                ep.w_onset = w0
                self.res.episodes.append(ep)
        self.res.episodes.sort(key=lambda e: e.onset)

    def _poisson(self, lam: float) -> int:
        n, p, limit = 0, 1.0, math.exp(-lam)
        while True:
            p *= self.r_ep.random()
            if p <= limit:
                return n
            n += 1

    def _planned(self) -> list[tuple[float, float, str, str]]:
        """Weekly PM, die changes and trials: (start, end, code, comment)."""
        out = []
        weekday = (self.c.number * 2) % 5  # Monday 0
        for sh in self.shifts:
            local = sh.start
            if sh.name == "E" and local.weekday() == weekday:
                start = sh.start + timedelta(minutes=30)
                out.append(
                    (start.timestamp(), (start + timedelta(hours=3)).timestamp(), "PL-PM", "Weekly planned maintenance")
                )
        # Die changes: two products alternate every two to three weeks; one product's die goes for
        # maintenance every eight to ten weeks (the spare die comes in).
        weeks = (2, 3) if len(self.c.dies) > 1 else (8, 10)
        t = START.timestamp() + self.r_ep.uniform(5, 15) * 86400
        while t < END.timestamp():
            i = bisect.bisect_left(self.shift_starts, t)
            if i >= len(self.shifts):
                break
            sh = self.shifts[i]
            begin = sh.start.timestamp() + 3600
            hours = self.r_ep.uniform(3.5, 6.0)
            out.append((begin, begin + hours * 3600, "PL-DIE", "Die change"))
            t = begin + self.r_ep.uniform(*weeks) * 7 * 86400
        for _ in range(2):
            i = self.r_ep.randrange(len(self.shifts))
            sh = self.shifts[i]
            begin = sh.start.timestamp() + 2 * 3600
            out.append((begin, begin + 2 * 3600, "PL-TRL", "Trial run for a die modification"))
        out.sort()
        return out

    # ---- the loop -------------------------------------------------------------------------------

    def run(self) -> CellResult:
        self.plan_episodes()
        planned = self._planned()
        random_next = {code: self._next_random(code) for code in RANDOM}
        run_s = 0.0
        line = [s for s in self.line_stops]  # MF-01's long stops: no metal
        li = 0
        pi = 0
        intervals = self.w.intervals
        t = intervals[0][0]
        while True:
            # The working stretch at or after t: a breakdown may have carried t into a later one.
            i = self.w.index(t)
            if i >= len(intervals):
                break
            a, b = intervals[i]
            if t < a:
                self._advance(a, "off")
                t = a
            # Planned stops due (in this shift); one a breakdown overtook didn't happen.
            if pi < len(planned) and planned[pi][0] <= t:
                start, end, code, text = planned[pi]
                pi += 1
                begin, end = max(t, start), min(end, b)
                if start < a or end - begin < 60:
                    continue
                self._stop(begin, end, code, True, text)
                self._after_planned(code, begin, end)
                t = end
                continue
            if self.tip_due is not None and t >= self.tip_due:
                end = min(b, t + self.r_stop.uniform(35, 55) * 60)
                self._stop(t, end, "PL-TIP", True, COMMENTS["PL-TIP"][0])
                self._tip_changed(t, end, "PM")
                self.tip_due = None
                t = end
                continue
            # No metal
            while li < len(line) and line[li].end - 20 * 60 < t:
                li += 1
            if li < len(line) and line[li].start + 15 * 60 <= t and self.c.line == "Line 2":
                ms = line[li]
                li += 1
                if ms.end - ms.start > 20 * 60:
                    end = min(b, ms.end + 5 * 60)
                    if end - t >= MIN_STOP_S:
                        self._stop(t, end, "DT-MAT", False, COMMENTS["DT-MAT"][0])
                        t = end
                        continue
            # Failures
            w = self.w.seconds(t)
            failed = None
            for ep in self.res.episodes:
                if ep.onset > t:
                    break
                if ep.resolved_at is None and ep.severity(w, t) >= 1.0:
                    failed = ep
                    break
            if failed:
                mode = MODES[failed.mode]
                dur = max(
                    MIN_STOP_S, self.r_stop.lognormvariate(math.log(mode.stop_hours[0] * 3600), mode.stop_hours[1])
                )
                failed.failed_at = t
                failed.peak = 1.0
                failed.outcome = "Failed: the machine stopped"
                t = self._breakdown(t, dur, mode.code, self.r_stop.choice(COMMENTS[mode.code]), failed, mode.component)
                continue
            # Random stops
            code = min(random_next, key=lambda c: random_next[c])
            if run_s >= random_next[code]:
                random_next[code] = run_s + self._next_random(code)
                if code == "DT-OPR" and self._shift(t).name != "N":
                    continue
                median = RANDOM[code][1]
                dur = max(MIN_STOP_S, self.r_stop.lognormvariate(math.log(median * 60), 0.7))
                t = self._breakdown(t, dur, code, self.r_stop.choice(COMMENTS[code]), None, "")
                continue
            # A shot
            cycle = self._shot(t)
            run_s += cycle
            self._advance(t + cycle, "run")
            t += cycle
            if self.hold_until > t:  # a quality hold: the cell waits for QA
                t = self.hold_until
        self._advance(END.timestamp(), "off")
        for ep in self.res.episodes:
            if ep.resolved_at is None and ep.failed_at is None:
                ep.outcome = "Still building up at the end of the year"
        return self.res

    def _next_random(self, code: str) -> float:
        mean_h = RANDOM[code][0] / self.scale
        return self.r_stop.expovariate(1 / (mean_h * 3600))

    def _shift(self, t: float) -> cal.Shift:
        i = max(0, bisect.bisect_right(self.shift_starts, t) - 1)
        return self.shifts[i]

    def _stop(self, start: float, end: float, code: str, planned: bool, text: str, episode: str | None = None) -> None:
        if end - start < MIN_STOP_S and not planned:
            return
        if end - start >= 60:  # a planned stop the shift's end cut to nothing isn't logged (its work still counts)
            self.res.stops.append(Stop(self.c.asset, start, end, code, planned, text, episode))
        self._advance(end, "stop")

    def _breakdown(self, t: float, dur: float, code: str, text: str, ep: Episode | None, component: str) -> float:
        """A stop that needs `dur` working seconds of repair: it continues into the next shift."""
        left = dur
        start = t
        while left >= 1:  # a second or more of repair to go (less is lost in rounding)
            i = self.w.index(t)
            if i >= len(self.w.intervals):
                break
            a, b = self.w.intervals[i]
            t = max(t, a)
            end = min(b, t + left)
            self._stop(t, end, code, False, text if t == start else f"{text} (continued)", ep.id if ep else None)
            left -= end - t
            t = end
            if left >= 1 and i + 1 < len(self.w.intervals):
                self._advance(self.w.intervals[i + 1][0], "off")
        if code in (
            "DT-PLG",
            "DT-HYD",
            "DT-OIL",
            "DT-DIE",
            "DT-VAC",
            "DT-SPR",
            "DT-FUR",
            "DT-ELE",
            "DT-ROB",
            "DT-TRM",
            "DT-SEN",
        ):
            self.res.maintenance.append(
                Maintenance(
                    self.c.asset, start, t, "CM", component or self._component(code), code, text, ep.id if ep else None
                )
            )
        if ep:
            ep.resolved_at = t
            if ep.mode == "plunger":
                self._tip_changed(start, t, "")
            if ep.mode == "cooling":
                self.die_shots = max(0, self.die_shots - 20_000)
        return t

    def _component(self, code: str) -> str:
        return {
            "DT-ELE": "Electrics and controls",
            "DT-ROB": "Extraction robot",
            "DT-TRM": "Trim press",
            "DT-SEN": "Sensors",
        }.get(code, "")

    def _tip_changed(self, start: float, end: float, kind: str) -> None:
        self.tip_shots = 0
        self.tip_life = TIP_LIFE + self.r_stop.randint(-1500, 1500)
        if self.r_stop.random() < 0.12:  # a busy week: the change waits
            self.tip_life += self.r_stop.randint(3000, 6000)
        if kind:
            self.res.maintenance.append(
                Maintenance(
                    self.c.asset, start, end, "PM", "Plunger tip", "PL-TIP", "Plunger tip changed at the shot count"
                )
            )

    def _after_planned(self, code: str, start: float, end: float) -> None:
        w = self.w.seconds(start)
        if code == "PL-PM":
            self.pm_count += 1
            found = []
            for ep in self.res.episodes:
                if ep.resolved_at is not None or ep.onset > start:
                    continue
                s = ep.severity(w, start)
                monthly_filter = ep.mode == "vacuum" and self.pm_count % 4 == 0 and s > 0.1
                if (ep.catchable and s >= 0.4) or monthly_filter:
                    ep.resolved_at = start
                    ep.peak = s
                    ep.outcome = "Found and fixed at planned maintenance"
                    found.append(ep)
            text = "Weekly PM: lubrication, vacuum and spray check, accumulator precharge check"
            if self.pm_count % 4 == 0:
                text += ", vacuum filter changed"
            self.res.maintenance.append(Maintenance(self.c.asset, start, end, "PM", "Die-casting cell", code, text))
            for ep in found:
                mode = MODES[ep.mode]
                self.res.maintenance.append(
                    Maintenance(self.c.asset, start, end, "INSP", mode.component, mode.code, FINDS[ep.mode], ep.id)
                )
                if ep.mode == "plunger":
                    self._tip_changed(start, end, "")
        elif code == "PL-DIE":
            if len(self.c.dies) > 1:
                self.die_index = (self.die_index + 1) % len(self.c.dies)
                self.product = PRODUCT[self.c.dies[self.die_index]]
            self.die_shots = 0
            self.res.die_changes.append((start, self.product.code))
            for ep in self.res.episodes:
                if ep.mode == "cooling" and ep.resolved_at is None and ep.onset <= start:
                    ep.resolved_at = start
                    ep.peak = ep.severity(w, start)
                    ep.outcome = "Cleared by a die change (the die went for maintenance)"
            self.res.maintenance.append(
                Maintenance(self.c.asset, start, end, "PM", "Die", code, f"Die change: {self.product.code} die in")
            )
        self.warm_left = max(self.warm_left, 4)

    # ---- one shot -------------------------------------------------------------------------------

    def _sev(self, mode: str, w: float, t: float) -> float:
        s = 0.0
        for ep in self.res.episodes:
            if ep.onset > t:
                break
            if ep.mode == mode:
                v = ep.severity(w, t)
                if v > s:
                    s = v
        return min(s, 1.0)

    def _shot(self, t: float) -> float:
        r = self.r_shot
        p = self.product
        w = self.w.seconds(t)
        plunger, acc, cool, vac = (self._sev(m, w, t) for m in ("plunger", "accumulator", "cooling", "vacuum"))
        spray, furnace = self._sev("spray", w, t), self._sev("furnace", w, t)
        idle = t - self.last_shot
        if idle > WARM_IDLE_S:
            self.warm_left = max(self.warm_left, 3 + min(9, int(idle / 3600 * 2)))
        ambient = self.site.at(self.site.ambient, t)
        water = self.site.at(self.site.water, t)
        # The die cools while idle, then heats shot by shot towards its working temperature.
        k_cool = math.exp(-idle / 2700)
        self.t_fixed = ambient + (self.t_fixed - ambient) * k_cool
        self.t_moving = ambient + (self.t_moving - ambient) * k_cool
        scale = min(0.18, self.die_shots / 90_000 * 0.15)
        ss_fixed = p.die_temp_c + 0.55 * (water - 24)
        ss_moving = p.die_temp_c + 4 + 0.55 * (water - 24) + 42 * cool + 30 * scale + 9 * spray
        cycle = p.cycle_s * (1 + r.gauss(0, 0.012)) + (r.uniform(5, 25) if r.random() < 0.02 else 0) + 3.5 * spray
        k_heat = 1 - math.exp(-cycle / 520)
        self.t_fixed += (ss_fixed - self.t_fixed) * k_heat
        self.t_moving += (ss_moving - self.t_moving) * k_heat
        die_f = self.t_fixed + r.gauss(0, 1.6 + 3 * spray)
        die_m = self.t_moving + r.gauss(0, 1.8 + 3 * spray)
        # The shot
        wear = (self.tip_shots / TIP_LIFE) ** 2
        friction = 9000 + 5000 * wear + 22000 * plunger**2 + r.gauss(0, 260)
        p1 = friction_to_pressure(friction) * (1 + r.gauss(0, 0.01))
        speed1 = 0.30 + r.gauss(0, 0.004) - 0.02 * plunger
        speed2 = p.speed_2nd * (1 + r.gauss(0, 0.008)) - 0.25 * acc
        fill = 55.0 * p.speed_2nd / max(1.0, speed2) + r.gauss(0, 0.8)
        intens = p.intensification_bar - 70 * acc + r.gauss(0, 7)
        buildup = 24 + 30 * acc + r.gauss(0, 1.4)
        biscuit = 28 + r.gauss(0, 1.3 * (1 + 2 * furnace))
        vacuum = 48 + r.gauss(0, 3.5) + 320 * vac**1.6
        spray_p = 5.2 - 1.8 * spray + r.gauss(0, 0.07)
        bath = 690 - 26 * max(0.0, furnace - 0.85) / 0.15 + r.gauss(0, 1.8 * (1 + 2 * furnace))
        h2 = self.site.hydrogen(t)
        # Quality: porosity (X-ray grade), then the other defects, warm-up shots first.
        die_avg = (die_f + die_m) / 2
        coef = POROSITY
        porosity = (
            coef["base"]
            + coef["vacuum_above_50_mbar"] * max(0.0, vacuum - 50)
            + coef["intensification_below_set_bar"] * (p.intensification_bar - intens)
            + coef["hydrogen_above_0.10"] * (h2 - 0.10)
            + coef["die_temp_off_set_c"] * abs(die_avg - p.die_temp_c)
            + coef["speed_2nd_below_set_m_s"] * max(0.0, p.speed_2nd - speed2)
            + coef["buildup_above_25_ms"] * max(0.0, buildup - 25)
            + r.gauss(0, coef["noise_sd"])
            + (r.uniform(0.4, 1.0) if r.random() < coef["entrapped_air_chance"] else 0.0)  # entrapped air
        )
        porosity = max(0.05, porosity)
        grade = grade_of(porosity)
        parts = p.cavities
        defect = ""
        scrapped = 0
        if self.warm_left > 0:
            self.warm_left -= 1
            defect, scrapped = "WU", parts
        else:
            for _ in range(parts):
                d = self._defect(r, grade, bath, die_m, spray_p, intens, die_avg)
                if d:
                    scrapped += 1
                    defect = defect or d
        self.recent_por.append(1 if defect == "POR" else 0)
        if len(self.recent_por) > 30:
            self.recent_por.pop(0)
        self.counter += 1
        self.tip_shots += 1
        self.die_shots += 1
        if self.tip_shots >= self.tip_life and self.tip_due is None:
            nxt = bisect.bisect_right(self.shift_starts, t)
            self.tip_due = self.shift_starts[nxt] if nxt < len(self.shift_starts) else END.timestamp()
        shot_id = f"{self.c.asset.replace('-', '')}-{self.counter:07d}"
        values = {
            "cycle_time": round(cycle, 1),
            "shot_speed_1st": round(speed1, 3),
            "shot_speed_2nd": round(speed2, 2),
            "fill_time": round(fill, 1),
            "intensification_pressure": round(intens, 0),
            "pressure_buildup_time": round(buildup, 1),
            "biscuit_length": round(biscuit, 1),
            "vacuum_level": round(vacuum, 0),
            "die_temp_fixed": round(die_f, 1),
            "die_temp_moving": round(die_m, 1),
            "plunger_pressure_1st": round(p1, 2),
            "spray_pressure": round(spray_p, 2),
        }
        at = t + cycle  # readings carry the time the shot finished
        self.res.shots += 1
        self.res.shot_times.append(t)
        self.res.parts += parts
        for k in range(scrapped):  # the X-ray books each part a second after the one before
            self.res.scrap.append((at + k, p.code, defect, f"{shot_id}-{k + 1}"))
        self._advance(at, "run")  # the 5-minute readings up to the shot's end first: a stream is in time order
        if self.full:
            for name, v in values.items():
                self.reading(f"{self.c.key}.{name}", at, v)
        else:
            for name in ("cycle_time", "die_temp_fixed"):
                self.bucket.setdefault(name, []).append(values[name])
        record = ShotRecord(
            shot_id,
            at,
            p.code,
            {**values, "bath_temp": round(bath, 1)},
            h2,
            round(porosity, 3),
            grade,
            parts,
            scrapped,
            defect,
        )
        self.on_shot(self.c, record)
        if self.trace and self.trace_window and self.trace_window[0] <= t < self.trace_window[1]:
            self.trace(t, friction)
        self.last_shot = at
        # Five porosity rejects in thirty shots: QA holds the cell and checks it.
        if sum(self.recent_por) >= 5:
            self.recent_por.clear()
            hold = self.r_stop.uniform(60, 120) * 60
            self._quality_hold(at, hold)
        return cycle

    def _defect(
        self, r: random.Random, grade: int, bath: float, die_m: float, spray_p: float, intens: float, die_avg: float
    ) -> str:
        if grade >= 3:
            return "POR"
        chances = (
            ("CS", 0.0008 + 0.3 / (1 + math.exp((bath - 655) / 4)) + 0.2 / (1 + math.exp((die_avg - 185) / 6))),
            ("SOLD", 0.0005 + 0.25 / (1 + math.exp(-(die_m - 268) / 4))),
            ("STK", 0.0008 + 0.15 / (1 + math.exp(-(3.9 - spray_p) / 0.15))),
            ("FL", 0.0006 + 0.05 / (1 + math.exp(-(intens - 1010) / 15)) + (0.004 if self.die_shots > 70_000 else 0.0)),
            ("DIM", 0.0015),
            ("DAM", 0.002),
        )
        for code, chance in chances:
            if r.random() < chance:
                return code
        return ""

    def _quality_hold(self, t: float, hold: float) -> None:
        i = self.w.index(t)
        if i < len(self.w.intervals):  # the hold ends with the shift at the latest
            hold = min(hold, max(0.0, self.w.intervals[i][1] - t))
        self.hold_until = t + hold
        self.res.stops.append(Stop(self.c.asset, t, t + hold, "DT-QH", False, self.r_stop.choice(COMMENTS["DT-QH"])))
        self._advance(t + hold, "stop")
        w = self.w.seconds(t)
        for ep in self.res.episodes:
            if (
                ep.mode == "vacuum"
                and ep.resolved_at is None
                and ep.onset <= t
                and ep.severity(w, t) > 0.3
                and self.r_stop.random() < 0.7
            ):
                ep.resolved_at = t + hold
                ep.peak = ep.severity(w, t)
                ep.outcome = "Found in a quality hold: vacuum filter changed"
                self.res.maintenance.append(
                    Maintenance(
                        self.c.asset,
                        t,
                        t + hold,
                        "INSP",
                        MODES["vacuum"].component,
                        "DT-VAC",
                        "Quality hold for porosity: vacuum filter found clogged and changed",
                        ep.id,
                    )
                )
        self.last_shot = t  # the cell waits warm
        self.warm_left = max(self.warm_left, 2)

    # ---- the 5-minute readings ------------------------------------------------------------------

    def _advance(self, to: float, mode: str) -> None:
        """Writes the continuous readings due up to `to`: the cell was running, stopped in a shift
        or off (no shift) meanwhile."""
        r = self.r_grid
        n = self.c.number
        while self.next_grid < to:
            g = self.next_grid
            self.next_grid += GRID
            if g < START.timestamp():
                continue
            w = self.w.seconds(g)
            ambient = self.site.at(self.site.ambient, g)
            water = self.site.at(self.site.water, g)
            running = mode == "run"
            in_shift = mode != "off"
            if not self.full:
                for name, vals in self.bucket.items():
                    if vals:
                        self.reading(f"{self.c.key}.{name}", g, round(sum(vals) / len(vals), 1))
                self.bucket = {}
                continue
            acc = self._sev("accumulator", w, g)
            cool = self._sev("cooling", w, g)
            oil_foul = self._sev("oil", w, g)
            furnace = self._sev("furnace", w, g)
            target = (
                33
                + (13 if running else 4 if in_shift else 0)
                + 0.35 * (ambient - 20)
                + 0.4 * (water - 22)
                + 24 * oil_foul
            )
            self.oil += (target - self.oil) * (1 - math.exp(-GRID / 2400))
            if self.oil > 58 and running:
                for ep in self.res.episodes:
                    if ep.mode == "oil" and ep.resolved_at is None and ep.onset <= g:
                        ep.ramp_s = min(ep.ramp_s, max(1.0, w - ep.w_onset))  # trips now
            k = self.c.key
            self.reading(f"{k}.hydraulic_oil_temp", g, round(self.oil + r.gauss(0, 0.25), 1))
            if in_shift:
                self.reading(f"{k}.accumulator_pressure", g, round(160 - 22 * acc + r.gauss(0, 0.6), 1))
            else:
                self.reading(f"{k}.accumulator_pressure", g, round(max(0.0, 2 + r.gauss(0, 0.3)), 1))
            scale = min(0.18, self.die_shots / 90_000 * 0.15)
            flowing = in_shift
            self.reading(f"{k}.cooling_flow_fixed", g, round(46 + r.gauss(0, 0.8), 1) if flowing else 0.0)
            self.reading(
                f"{k}.cooling_flow_moving",
                g,
                round(42 * (1 - 0.55 * cool - 0.6 * scale) + r.gauss(0, 0.8), 1) if flowing else 0.0,
            )
            tcu = 200 + r.gauss(0, 0.8) if in_shift else ambient + 40 + r.gauss(0, 1.0)
            self.reading(f"{k}.tcu_oil_temp", g, round(tcu, 1))
            hold = 690.0 if in_shift else 655.0
            bath = hold - 26 * max(0.0, furnace - 0.85) / 0.15 + r.gauss(0, 1.5 * (1 + 2 * furnace))
            self.reading(f"hf{n:02d}.bath_temp", g, round(bath, 1))
            power = (34 if in_shift else 22) + (14 if running else 0) + 28 * min(furnace, 0.85) / 0.85 + r.gauss(0, 1.2)
            self.reading(f"hf{n:02d}.heater_power", g, round(power, 1))


FINDS = {
    "plunger": "Tip scored and friction high at inspection: tip changed before it seized",
    "accumulator": "Accumulator precharge low at the weekly check: nitrogen recharged",
    "cooling": "Moving-half cooling flow low: channel descaled",
    "vacuum": "Vacuum filter clogged: changed",
    "spray": "Spray nozzles partly blocked: cleaned",
    "furnace": "Heater element resistance high: element changed",
    "oil": "Oil cooler fouled: flushed",
}


def grade_of(porosity: float) -> int:
    """X-ray grade by porosity (SOP-QA-05): 0 below 0.6 %, then 0.85, 1.1 and 1.4."""
    for g, limit in enumerate((0.6, 0.85, 1.1, 1.4)):
        if porosity < limit:
            return g
    return 4


def trace_shot(rng: random.Random, friction: float) -> tuple[list[float], list[float], list[float]]:
    """One shot's curves, as the shot monitoring records them: js/lib/physics.ts simulateShot."""

    def velocity(i: int) -> float:
        if i < 30:
            return 0.35 * min(1.0, i / 8)
        if i < 55:
            return 0.35 + (4.2 - 0.35) * min(1.0, (i - 30) / 6)
        return max(0.05, 4.2 * math.exp(-(i - 55) / 3))

    v, ph, pm = [], [], []
    for i in range(SAMPLES):
        vel, prev = velocity(i), velocity(i - 1) if i else 0.0
        acc = (vel - prev) / DT
        metal = (8 + 30 * (i / 55) ** 2 if i < 55 else 38 + 260 * (1 - math.exp(-(i - 55) / 6))) * BAR
        fr = friction * (1 + 0.04 * rng.gauss(0, 1))
        hyd = (MASS * acc + metal * AM + fr) / AH
        v.append(vel * (1 + 0.01 * rng.gauss(0, 1)))
        ph.append(hyd / BAR * (1 + 0.002 * rng.gauss(0, 1)))
        pm.append(metal / BAR * (1 + 0.002 * rng.gauss(0, 1)))
    return v, ph, pm


def utc(t: float) -> datetime:
    return datetime.fromtimestamp(t, UTC)


__all__ = [
    "CELLS",
    "MODES",
    "CellSim",
    "Episode",
    "Maintenance",
    "ShotRecord",
    "SiteSeries",
    "Stop",
    "Working",
    "grade_of",
    "melting_stops",
    "other_stops",
    "site_series",
    "trace_shot",
    "utc",
]
