"""A year of the graphene plant, run by run and roll by roll.

Each machine is a `Station` (sample_plant/common.py): it runs its jobs (polishing a foil roll, a CVD
run, a transfer, an inspection, slitting) as soon as they may start and fit in the week's working
time, and stops for planned work, for what is imposed on it (the exhaust scrubber out stops the CVD
hall, aborting the runs in progress), for its degradations and for faults nothing foretells. The
flow is the plant's:

- **Foil preparation:** copper foil arrives in lots from two suppliers; each 300 m roll is
  electropolished on EP-01, which smooths it (a rectifier with ripple polishes it less well).
- **Growth:** each roll goes through one of four CVD reactors: loaded and pumped down, heated to
  1,035 °C, grown in methane and hydrogen for ten hours at 0.5 m/min, cooled.
- **Transfer:** one of two lines laminates the graphene onto PET, etches the copper away in a bath
  that gathers copper until it is changed, rinses and dries it.
- **Inspection and finishing:** IN-01 measures the film's sheet resistance, transmittance and
  defects as it passes; SP-01 slits it into two lanes of three 100 m rolls, graded and packed.

Every roll's genealogy (its run, reactor, foil roll and lot, transfer line) is kept, so what
happened upstream shows in its grade: a leaking tube lets oxygen in and raises the graphene's
defects (Raman D/G) and sheet resistance, a sagging heater and a rough foil give smaller grains, a
drifting methane controller grows bilayer patches that cost transmittance, a tired etch bath or
pump leaves copper behind, a worn laminator roll traps bubbles. The degradations show in the
signals beforehand, at the strength the ground truth records.
"""

import bisect
import math
import random
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from tiles_api.sample_plant.common import Maintenance, Mode, RandomStop, Station, Stop, Working, seasonal
from tiles_api.sample_plant.graphene import calendar as cal
from tiles_api.sample_plant.graphene.plant import (
    BATH_CHANGE,
    BATH_L,
    BATH_PLAN,
    END,
    FOIL_M,
    FOIL_UM,
    FOIL_WIDTH_M,
    GROW_H,
    GROWTH_C,
    GROWTH_SPEED,
    HEAT_H,
    INSPECT_SPEED,
    LANES,
    LENGTHS,
    LOAD_H,
    POLISH_SPEED,
    REACTORS,
    ROLL_M,
    RUN_H,
    SEED,
    START,
    TRANSFER_SPEED,
    TRANSFERS,
    ZONE,
)

GRID = Station.GRID
DAY = 86400.0
HOUR = 3600.0

# The film's quality model (the ground truth behind the inspection, for the process model).
QUALITY = {
    "d_g_ratio": "0.035 + 0.55 * leak ** 1.6 + noise(0.006): oxygen from a leaking tube makes defects",
    "domain_um": "20 * (70 / foil_ra_nm) ** 0.8 * exp(-(1035 - zone2_temp) / 30)",
    "bilayer": "0.03 + 0.32 * mfc_drift ** 1.4: too much methane grows a second layer",
    "sheet_resistance_ohm_sq": (
        "190 * (1 + 3 * d_g) * (1 + 6 / domain_um) * (1 - 0.35 * bilayer) * (1 + 0.15 * laminator_wear)"
        " * (1 - 0.3 * residual_copper), then each roll * noise(2.5 %)"
    ),
    "residual_copper": "max(0, 1 - 1.6 * (1 - bath_copper / 150) * (1 - 0.55 * etch_pump_wear ** 1.5))",
    "transmittance_pct": "97.65 - 2.3 * bilayer - 0.4 * d_g - 30 * residual_copper + noise(0.08)",
    "defects_m2": "0.5 + 9 * laminator_wear ** 1.6 + 0.6 * particles / 4000 + 4 * residual_copper",
    "grade": "A: Rs <= 350, T >= 97.0, defects <= 3; B: Rs <= 450, T >= 96.0, defects <= 8; else NG",
}

CVD_MODES = (
    Mode(
        "leak",
        "DT-VAC",
        2.6,
        (8.0, 25.0),
        1.7,
        0.35,
        (6.0, 0.3),
        "Quartz tube seals",
        (
            "Base pressure too high to start: tube flange seals replaced",
            "Leak at the tube flange: O-rings changed",
        ),
        "Leak rate high at the monthly leak test: seals replaced",
    ),
    Mode(
        "heater",
        "DT-HTR",
        1.2,
        (20.0, 45.0),
        2.0,
        0.35,
        (10.0, 0.3),
        "Zone 2 heating element",
        ("Zone 2 could not hold 1,035 °C: heating element replaced", "Heater element open circuit: replaced"),
        "Heater element resistance high at inspection: replaced",
    ),
    Mode(
        "pump",
        "DT-PMP",
        1.6,
        (6.0, 18.0),
        1.6,
        0.3,
        (5.0, 0.35),
        "Dry vacuum pump",
        ("Vacuum pump tripped on overcurrent: exchanged", "Pump seized during pump-down: exchanged for the spare"),
        "Pump current high at the monthly check: pump exchanged",
    ),
    Mode(
        "mfc",
        "DT-MFC",
        1.0,
        (5.0, 15.0),
        1.5,
        0.5,
        (3.0, 0.3),
        "Methane mass flow controller",
        (
            "Transmittance out of tolerance: methane MFC found reading low, recalibrated",
            "Bilayer patches on the film: methane MFC replaced",
        ),
        "Methane MFC out of calibration at the monthly check: recalibrated",
    ),
)
EP_MODES = (
    Mode(
        "rectifier",
        "DT-EPL",
        3.0,
        (4.0, 12.0),
        1.6,
        0.3,
        (4.0, 0.3),
        "Rectifier",
        ("Current ripple alarm: rectifier control board replaced", "Uneven polish: rectifier repaired"),
        "Rectifier ripple high at inspection: control board replaced",
    ),
)
TL_MODES = (
    Mode(
        "laminator",
        "DT-LAM",
        3.0,
        (3.0, 10.0),
        1.6,
        0.3,
        (4.0, 0.3),
        "Laminator roll",
        ("Bubbles under the film: laminator roll replaced", "Wrinkles at lamination: roll recovered"),
        "Laminator roll worn at inspection: replaced",
    ),
    Mode(
        "etch-pump",
        "DT-ETC",
        3.0,
        (2.0, 8.0),
        1.6,
        0.25,
        (3.0, 0.3),
        "Etchant circulation pump",
        ("Etch bath circulation lost: pump replaced", "Etchant flow low: pump impeller changed"),
        "Etch pump worn at the monthly check: impeller changed",
    ),
)
SCRUBBER_MODES = (
    Mode(
        "packing",
        "DT-EXH",
        3.0,
        (10.0, 25.0),
        1.7,
        0.3,
        (6.0, 0.35),
        "Scrubber packing",
        (
            "Exhaust flow low: CVD hall stopped, scrubber packing cleaned",
            "Scrubber pressure drop trip: furnaces put in safe state, packing cleaned",
        ),
        "Scrubber packing fouled at the monthly check: cleaned",
    ),
)

CVD_STOPS = (
    RandomStop(
        "DT-FOL",
        160,
        45,
        ("Foil broke at the take-up", "Foil wrinkled in the hot zone", "Foil tracking off at the unwinder"),
        "Foil transport",
    ),
    RandomStop("DT-GAS", 400, 30, ("Hydrogen supply pressure low", "Gas cabinet alarm: cylinder change"), ""),
    RandomStop(
        "DT-ELE", 500, 60, ("Thermocouple fault", "PLC communication fault", "Interlock tripped"), "Electrics and controls"
    ),
    RandomStop("DT-OTH", 150, 15, ("Cleaning", "Waiting for a crane", "Restarted"), "", corrective=False),
)
WEB_STOPS = (
    RandomStop("DT-WEB", 90, 25, ("Web break at the splice", "PET web wandered", "Web break in the dryer"), "Web"),
    RandomStop("DT-ELE", 400, 45, ("Drive fault", "Gauge communication lost", "Safety circuit tripped"), "Electrics"),
    RandomStop("DT-OTH", 120, 12, ("Cleaning", "Waiting for a new core", "Restarted"), "", corrective=False),
)
STATION_STOPS = (
    RandomStop("DT-ELE", 400, 40, ("Drive fault", "Sensor fault", "PLC communication fault"), "Electrics and controls"),
    RandomStop("DT-OTH", 150, 12, ("Cleaning", "Restarted"), "", corrective=False),
)
INSPECTION_STOPS = (
    *STATION_STOPS,
    RandomStop(
        "DT-VIS", 120, 15, ("Camera lost focus", "Eddy current sensor drift: re-zeroed"), "Vision", corrective=False
    ),
)


@dataclass
class FoilLot:
    id: str
    supplier: str
    received: float
    ra_raw: float  # nm, as received
    rolls: int = 0
    ra_measured: float = 0.0  # the lab's AFM, on its first roll after polishing
    measured_at: float = 0.0


@dataclass
class Foil:
    id: str
    lot: FoilLot
    polished: tuple[float, float]
    ra: float  # nm after electropolishing


@dataclass
class Run:
    id: str
    reactor: str
    foil: Foil
    job: tuple[float, float]  # the reactor's job: load to unload
    growth: tuple[float, float] = (0.0, 0.0)
    base_pressure: float = 0.0
    oxygen: float = 0.0
    zone2: float = 0.0  # the growth temperature, as it was
    ch4_actual: float = 0.0
    domain: float = 0.0
    bilayer: float = 0.0
    d_g: float = 0.0
    two_d_g: float = 0.0
    rs_growth: float = 0.0
    scrap: str = ""
    scrap_at: float = 0.0
    line: str = ""
    transfer: tuple[float, float] = (0.0, 0.0)
    bath_copper: float = 0.0
    etch_flow: float = 0.0
    laminator: float = 0.0  # the laminator's wear then (0 to 1)
    lam_spread: float = 0.0
    residual: float = 0.0
    particles: float = 0.0
    rs_film: float = 0.0
    rs_4pp: float = 0.0  # the lab's four-point probe
    lab_at: float = 0.0
    transmittance: float = 0.0
    defects: float = 0.0
    inspected: tuple[float, float] = (0.0, 0.0)
    packed: float = 0.0


@dataclass
class FilmRoll:
    id: str
    run: Run
    lane: int
    segment: int
    rs: float
    uniformity: float
    transmittance: float
    defects: float
    grade: str = ""
    scrap: str = ""


@dataclass
class Year:
    shifts: list[cal.Shift]
    working: Working
    stations: dict[str, Station]
    lots: list[FoilLot] = field(default_factory=list)
    foils: list[Foil] = field(default_factory=list)
    runs: list[Run] = field(default_factory=list)
    rolls: list[FilmRoll] = field(default_factory=list)
    lab: list[tuple[float, str, float]] = field(default_factory=list)  # time, tag, value
    bath_changes: list[tuple[str, float, float]] = field(default_factory=list)  # line, time, copper before
    t0: float = 0.0


Write = Callable[[str, str, float, float], None]  # stream, tag, time, value


def monthly_pm(
    shifts: list[cal.Shift], day: int, hours: float, text: str = "Monthly planned maintenance"
) -> list[tuple[float, float, str, str]]:
    """A planned maintenance at 07:00 on the first early shift on or after the month's `day`."""
    out = []
    seen: set[str] = set()
    for s in shifts:
        key = f"{s.start:%Y-%m}"
        if s.name == "E" and s.start.day >= day and key not in seen:
            seen.add(key)
            a = s.start + timedelta(hours=1)
            out.append((a.timestamp(), (a + timedelta(hours=hours)).timestamp(), "PL-PM", text))
    return out


def weekly(
    shifts: list[cal.Shift], weekday: int, hour: int, hours: float, code: str, text: str
) -> list[tuple[float, float, str, str]]:
    out = []
    for s in shifts:
        if s.name == "E" and s.start.weekday() == weekday:
            a = s.start.replace(hour=hour)
            out.append((a.timestamp(), (a + timedelta(hours=hours)).timestamp(), code, text))
    return out


# CVD-02's zone 2 thermocouple read 8 °C high from 12 January to 6 February 2026, until it was
# recalibrated: the controller held the furnace 8 °C cooler than it showed (a known gap, and a cause).
TC_DRIFT = ("CVD-02", 8.0, datetime(2026, 1, 12, 6, tzinfo=ZONE), datetime(2026, 2, 6, 10, tzinfo=ZONE))


class Plant:
    def __init__(self, write: Write) -> None:
        self.write = write
        self.shifts = cal.shifts()
        self.shift_starts = [s.start.timestamp() for s in self.shifts]
        self.w = Working(cal.working_intervals(self.shifts))
        self.t0, self.t1 = START.timestamp(), END.timestamp()
        self.rng = random.Random(f"{SEED}/plant")
        self.stations: dict[str, Station] = {}
        self.year = Year(self.shifts, self.w, self.stations, t0=self.t0)
        self.state: dict[str, float] = {}  # smoothed values per station and tag
        self.bath = {a: 8.0 if a == "TL-01" else 30.0 for a in TRANSFERS}  # copper in each etch bath, g/L
        self.pending: set[str] = set()  # a bath change planned and not yet done
        self.particles: list[float] = []  # the cleanroom's, on the grid
        self.ambient: list[float] = []
        self.exhaust: list[tuple[float, float, str, str]] = []  # the scrubber's stops of the CVD hall

    def station(self, asset: str, **kw: object) -> Station:
        st = Station(asset, self.w, SEED, start=self.t0, end=self.t1, **kw)  # type: ignore[arg-type]
        self.stations[asset] = st
        return st

    def smooth(self, key: str, target: float, tau_s: float) -> float:
        v = self.state.get(key, target)
        v += (target - v) * (1 - math.exp(-GRID / tau_s))
        self.state[key] = v
        return v

    def at_grid(self, values: list[float], t: float) -> float:
        return values[min(len(values) - 1, max(0, int((t - self.t0) // GRID)))]

    def mean_grid(self, values: list[float], a: float, b: float) -> float:
        i, j = int((a - self.t0) // GRID), max(int((a - self.t0) // GRID) + 1, int((b - self.t0) // GRID))
        part = values[max(0, i) : min(len(values), j)]
        return sum(part) / len(part) if part else values[-1]

    def _next_shift(self, t: float) -> float:
        """Half an hour into the next shift after t."""
        i = bisect.bisect_right(self.shift_starts, t)
        return self.shift_starts[i] + HOUR / 2 if i < len(self.shift_starts) else self.t1

    # ---- the site ------------------------------------------------------------------------------

    def utilities(self) -> None:
        """The chiller, DI water, gases and the transfer cleanroom, every 5 minutes all year."""
        r = random.Random(f"{SEED}/utilities")
        t = self.t0
        noise = burst = 0.0
        burst_until = 0.0
        while t < self.t1:
            on = self.w.working(t)
            noise = 0.98 * noise + r.gauss(0, 0.05)
            amb = 11 + 6 * seasonal(t, ZONE) + noise
            self.ambient.append(amb)
            # People bring particles in; a door left open or a filter change lets a burst in.
            if t >= burst_until and on and r.random() < 1 / (30 * 24 * 12):
                burst, burst_until = r.uniform(3.0, 6.0), t + r.uniform(2, 6) * HOUR
            if t >= burst_until:
                burst = 0.0
            base = (3800.0 if on else 900.0) * (1 + 0.2 * seasonal(t, ZONE)) * (1 + burst)
            particles = base * math.exp(r.gauss(0, 0.18))
            self.particles.append(particles)
            self.write("site", "ch01.supply_temp", t, round(14.0 + 0.35 * max(0.0, amb - 10) + r.gauss(0, 0.1), 2))
            self.write("site", "di01.conductivity", t, round(0.08 + abs(r.gauss(0, 0.015)), 3))
            self.write("site", "cr01.particles", t, round(particles, -1))
            self.write("site", "cr01.temperature", t, round(21.0 + 0.15 * seasonal(t, ZONE) + r.gauss(0, 0.12), 2))
            self.write("site", "gs01.h2_pressure", t, round(8.0 + r.gauss(0, 0.05) - (0.2 if on else 0.0), 2))
            t += GRID

    def scrubber(self) -> None:
        """The exhaust scrubber's year: its packing loads up with the CVD hall's exhaust and, when it
        trips, the hall stops: every furnace goes to its safe state."""
        r = random.Random(f"{SEED}/SC-01/grid")
        sc = self.station(
            "SC-01",
            modes=SCRUBBER_MODES,
            planned=monthly_pm(self.shifts, 2, 4, "Monthly scrubber check: packing, nozzles, pumps"),
        )
        m = SCRUBBER_MODES[0]
        t = self.t0
        down_until = 0.0
        while t < self.t1:
            w = self.w.seconds(t)
            ep = next(
                (
                    e
                    for e in sc.episodes
                    if e.failed_at is None and e.resolved_at is None and e.onset <= t and e.severity(w, t) >= 1.0
                ),
                None,
            )
            if ep:
                dur = max(1800.0, sc.r_stop.lognormvariate(math.log(m.stop_hours[0] * HOUR), m.stop_hours[1]))
                ep.failed_at, ep.peak, ep.outcome = t, 1.0, "Failed: the scrubber tripped and stopped the CVD hall"
                ep.resolved_at = down_until = t + dur
                text = sc.r_stop.choice(m.comments)
                sc.stops.append(Stop("SC-01", t, t + dur, m.code, False, text, ep.id))
                sc.maintenance.append(Maintenance("SC-01", t, t + dur, "CM", m.component, m.code, text, ep.id))
                self._impose(t, t + dur, m.code, "Exhaust scrubber out: CVD hall stopped")
            while sc.pi < len(sc.planned) and sc.planned[sc.pi][0] <= t:
                a, b, code, text = sc.planned[sc.pi]
                sc.pi += 1
                sc._planned_job(a, b, code, text)
            s = sc.sev("packing", t)
            hot = self.w.working(t)
            down = t < down_until
            dp = (6.0 + 9.0 * s**1.4 if not down else 2.0) + r.gauss(0, 0.15)
            flow = (2200 - 650 * s**1.5 if hot and not down else 400.0) + r.gauss(0, 15)
            self.write("sc01", "sc01.differential_pressure", t, round(dp, 2))
            self.write("sc01", "sc01.exhaust_flow", t, round(flow, 0))
            self.write("sc01", "sc01.scrub_ph", t, round(9.2 - 0.6 * s + r.gauss(0, 0.04), 2))
            t += GRID
        for ep in sc.episodes:
            if ep.resolved_at is None and ep.failed_at is None:
                ep.outcome = "Still building up at the end of the year"

    def _impose(self, a: float, b: float, code: str, text: str) -> None:
        """A stop of the CVD hall, in its working time."""
        for ia, ib in self.w.intervals:
            lo, hi = max(a, ia), min(b, ib)
            if hi - lo >= 60:
                self.exhaust.append((lo, hi, code, text))

    def in_exhaust_stop(self, t: float) -> bool:
        i = bisect.bisect_right(self.exhaust, (t, math.inf)) - 1
        return i >= 0 and t < self.exhaust[i][1]

    # ---- foil preparation ------------------------------------------------------------------------

    def _ep_grid(self, st: Station, g: float, mode: str) -> None:
        # The bath is kept warm and the rectifier idles between rolls: their readings run all week.
        r = self.rng
        rect = st.sev("rectifier", g)
        self.write("ep01", "ep01.bath_temp", g, round(35.0 + r.gauss(0, 0.2), 1))
        # The bath's conductivity falls as it is used; the monthly bath maintenance renews it.
        days = (g - self.state.get("ep01.renewed", self.t0)) / DAY
        self.write("ep01", "ep01.bath_conductivity", g, round(385 - 1.6 * days + r.gauss(0, 1.2), 1))
        ripple = 1.4 + 6.2 * rect**1.4 + abs(r.gauss(0, 0.08))
        self.write("ep01", "ep01.current_ripple", g, round(ripple, 2))

    def _ep_planned(self, st: Station, code: str, start: float, end: float) -> None:
        if code == "PL-PM":
            self.state["ep01.renewed"] = end

    def foil_line(self) -> tuple[Station, Callable[[float], Foil | None]]:
        ep = self.station(
            "EP-01",
            random_stops=STATION_STOPS,
            modes=EP_MODES,
            planned=monthly_pm(self.shifts, 1, 6, "Monthly maintenance and polishing bath renewal"),
            grid=self._ep_grid,
            on_planned=self._ep_planned,
        )
        r = random.Random(f"{SEED}/foil")
        lots = self.year.lots
        n = 0

        def polish(ready: float) -> Foil | None:
            nonlocal n
            if not lots or lots[-1].rolls >= 36:  # a lot is 36 rolls
                supplier = "Supplier B" if r.random() < 0.35 else "Supplier A"
                ra = r.gauss(150, 12) if supplier == "Supplier A" else r.gauss(185, 18)
                if r.random() < 0.07:  # a rough lot
                    ra *= r.uniform(1.4, 1.7)
                lots.append(FoilLot(f"CU-{len(lots) + 1:04d}", supplier, max(self.t0, ready - 3 * DAY), ra))
            lot = lots[-1]
            start, end = ep.run(ready, FOIL_M / POLISH_SPEED * 60, fit=True)
            if end >= self.t1:
                return None
            n += 1
            lot.rolls += 1
            rect = ep.sev("rectifier", start)
            ra = lot.ra_raw * 0.42 * (1 + 0.9 * rect**1.4) * (1 + r.gauss(0, 0.04))
            foil = Foil(f"F-{n:05d}", lot, (start, end), ra)
            self._polish_minutes(foil, r)
            if lot.rolls == 1:
                lot.ra_measured, lot.measured_at = round(ra, 1), end + HOUR
                self.year.lab.append((lot.measured_at, "lab.foil_roughness", lot.ra_measured))
            self.year.foils.append(foil)
            return foil

        return ep, polish

    def _polish_minutes(self, foil: Foil, r: random.Random) -> None:
        start, end = foil.polished
        t = math.ceil(start / 60) * 60
        while t < end:
            self.write("ep01-run", "ep01.current_density", t, round(18.0 + r.gauss(0, 0.15), 2))
            self.write("ep01-run", "ep01.line_speed", t, round(POLISH_SPEED + r.gauss(0, 0.01), 2))
            t += 60

    # ---- growth ----------------------------------------------------------------------------------

    def _cvd_grid(self, st: Station, g: float, mode: str) -> None:
        r = self.rng
        key = st.asset.lower().replace("-", "")
        if mode == "run" and self.in_exhaust_stop(g):
            mode = "stop"
        # Running, waiting and baking out the furnace is hot; stopped for a repair or off, it cools.
        hot = mode in ("run", "idle") or (mode == "stop" and bool(st.stops) and st.stops[-1].code == "PL-BAK")
        heater = st.sev("heater", g)
        leak = st.sev("leak", g)
        pump = st.sev("pump", g)
        sag = 24.0 * max(0.0, (heater - 0.45) / 0.55) ** 1.4
        drift = TC_DRIFT[1] if st.asset == TC_DRIFT[0] and TC_DRIFT[2].timestamp() <= g < TC_DRIFT[3].timestamp() else 0
        for zone, target in (("zone1", 1000.0), ("zone2", GROWTH_C - sag - drift), ("zone3", 1010.0)):
            v = self.smooth(f"{key}.{zone}", target if hot else 25.0, 2 * HOUR if hot else 3 * HOUR)
            self.write(key, f"{key}.{zone}_temp", g, round(v + r.gauss(0, 0.4), 1))
        power = (18.0 + 9.0 * heater**1.4 if hot else 0.2) + r.gauss(0, 0.12)
        self.write(key, f"{key}.heater_power", g, round(max(0.0, power), 2))
        self.write(key, f"{key}.oxygen", g, round(0.8 + 24.0 * leak**1.5 + abs(r.gauss(0, 0.06)), 2))
        self.write(key, f"{key}.pump_current", g, round(9.0 + 4.5 * pump**1.5 + r.gauss(0, 0.08), 2))

    def reactors(self) -> list[Station]:
        out = []
        for i, a in enumerate(REACTORS):
            out.append(
                self.station(
                    a,
                    random_stops=CVD_STOPS,
                    modes=CVD_MODES,
                    planned=monthly_pm(self.shifts, 4 + 3 * i, 8, "Monthly maintenance: leak test, MFC calibration")
                    + weekly(self.shifts, 0, 6, 3, "PL-BAK", "Weekly tube bake-out, as the week starts"),
                    external=list(self.exhaust),
                    grid=self._cvd_grid,
                )
            )
        return out

    def grow(self, cvd: Station, foil: Foil, r: random.Random, n: int) -> Run | None:
        start, end = cvd.run(foil.polished[1] + HOUR, RUN_H * HOUR, fit=True)
        if end >= self.t1:
            return None
        run = Run(f"R-{n:05d}", cvd.asset, foil, (start, end))
        g0 = start + (LOAD_H + HEAT_H) * HOUR
        g1 = g0 + GROW_H * HOUR
        run.growth = (g0, g1)
        leak, pump = cvd.sev("leak", start), cvd.sev("pump", start)
        heater, mfc = cvd.sev("heater", g0), cvd.sev("mfc", g0)
        run.base_pressure = 0.002 * (1 + 4.0 * leak**2) + 0.001 * pump**2 + abs(r.gauss(0, 0.0002))
        run.oxygen = 0.8 + 24.0 * leak**1.5
        drift = TC_DRIFT[1] if cvd.asset == TC_DRIFT[0] and TC_DRIFT[2].timestamp() <= g0 < TC_DRIFT[3].timestamp() else 0
        run.zone2 = GROWTH_C - 24.0 * max(0.0, (heater - 0.45) / 0.55) ** 1.4 - drift + r.gauss(0, 0.5)
        run.ch4_actual = 30.0 * (1 + 0.45 * mfc**1.3)
        run.bilayer = 0.03 + 0.32 * mfc**1.4 + abs(r.gauss(0, 0.005))
        run.d_g = max(0.01, 0.035 + 0.55 * leak**1.6 + r.gauss(0, 0.006))
        run.domain = 20.0 * (70.0 / foil.ra) ** 0.8 * math.exp(-(GROWTH_C - run.zone2) / 30.0)
        run.two_d_g = 2.6 - 1.4 * run.bilayer - 0.5 * run.d_g + r.gauss(0, 0.05)
        run.rs_growth = 190.0 * (1 + 3.0 * run.d_g) * (1 + 6.0 / run.domain) * (1 - 0.35 * run.bilayer)
        k = cvd.asset.lower().replace("-", "")
        self.write(f"{k}-unit", f"{k}.base_pressure", start + LOAD_H * HOUR, round(run.base_pressure, 4))
        # The scrubber tripping during the run aborts it: the furnace goes to its safe state.
        cut = g1
        if cvd.xi < len(cvd.external) and start < cvd.external[cvd.xi][0] < end:
            a, b, code, text = cvd.external[cvd.xi]
            cvd.xi += 1
            cvd.stops.append(Stop(cvd.asset, a, b, code, False, f"{text}: run {run.id} aborted"))
            run.scrap, run.scrap_at, cut = "CVD-ABT", a, min(g1, a)
        elif r.random() < 0.012:
            run.scrap, run.scrap_at = "CVD-WRK", g1
        self._growth_minutes(k, run, cut, r)
        return run

    def _growth_minutes(self, key: str, run: Run, cut: float, r: random.Random) -> None:
        g0, _ = run.growth
        t = math.ceil(g0 / 60) * 60
        tension = 32.0 + r.gauss(0, 0.6)
        while t < cut:
            self.write(f"{key}-run", f"{key}.foil_speed", t, round(GROWTH_SPEED + r.gauss(0, 0.004), 3))
            self.write(f"{key}-run", f"{key}.foil_tension", t, round(tension + r.gauss(0, 0.4), 1))
            self.write(f"{key}-run", f"{key}.ch4_flow", t, round(30.0 + r.gauss(0, 0.08), 2))  # what the MFC says
            self.write(f"{key}-run", f"{key}.h2_flow", t, round(600.0 + r.gauss(0, 1.5), 1))
            pressure = 0.50 + 0.004 * (run.ch4_actual - 30) + 0.02 * (run.oxygen - 0.8) / 24 + r.gauss(0, 0.003)
            self.write(f"{key}-run", f"{key}.chamber_pressure", t, round(pressure, 3))
            t += 60

    # ---- transfer, inspection, finishing ---------------------------------------------------------

    def _tl_grid(self, st: Station, g: float, mode: str) -> None:
        # The laminator roll is kept at temperature and the bath heated and circulating around the
        # clock (thermal cycles crack the roll's surface): their readings run all week.
        r = self.rng
        key = st.asset.lower().replace("-", "")
        lam, pump = st.sev("laminator", g), st.sev("etch-pump", g)
        self.write(key, f"{key}.laminator_temp", g, round(120.0 + r.gauss(0, 0.3), 1))
        spread = 1.5 + 6.0 * lam**1.4 + abs(r.gauss(0, 0.1))
        self.write(key, f"{key}.roll_temp_spread", g, round(spread, 2))
        self.write(key, f"{key}.etch_temp", g, round(40.0 + r.gauss(0, 0.15), 1))
        self.write(key, f"{key}.etch_flow", g, round(180.0 * (1 - 0.5 * pump**1.5) + r.gauss(0, 1.2), 1))
        self.write(key, f"{key}.bath_copper", g, round(self.bath[st.asset] + r.gauss(0, 0.15), 1))

    def _tl_planned(self, st: Station, code: str, start: float, end: float) -> None:
        if code == "PL-BTH":
            self.year.bath_changes.append((st.asset, start, self.bath[st.asset]))
            self.bath[st.asset] = 1.5
            self.pending.discard(st.asset)

    def transfer_lines(self) -> list[Station]:
        out = []
        for i, a in enumerate(TRANSFERS):
            out.append(
                self.station(
                    a,
                    random_stops=WEB_STOPS,
                    modes=TL_MODES,
                    planned=monthly_pm(self.shifts, 18 + 2 * i, 6),
                    grid=self._tl_grid,
                    on_planned=self._tl_planned,
                )
            )
        return out

    def transfer(self, tl: Station, run: Run, r: random.Random) -> bool:
        """Laminates and etches a run's film; False if the year ended first."""
        start, end = tl.run(run.job[1] + 2 * HOUR, FOIL_M / TRANSFER_SPEED * 60, fit=True)
        if end >= self.t1:
            return False
        run.line, run.transfer = tl.asset, (start, end)
        lam, pump = tl.sev("laminator", start), tl.sev("etch-pump", start)
        copper = self.bath[tl.asset]
        capacity = 1.6 * (1 - copper / 150.0) * (1 - 0.55 * pump**1.5)
        run.bath_copper, run.laminator = copper, lam
        run.etch_flow = 180.0 * (1 - 0.5 * pump**1.5)
        run.lam_spread = 1.5 + 6.0 * lam**1.4
        run.residual = max(0.0, 1.0 - capacity)
        run.particles = self.mean_grid(self.particles, start, end)
        run.rs_film = run.rs_growth * (1 + 0.15 * lam) * (1 - 0.3 * run.residual)
        run.transmittance = 97.65 - 2.3 * run.bilayer - 0.4 * run.d_g - 30.0 * run.residual
        run.defects = 0.5 + 9.0 * lam**1.6 + 0.6 * run.particles / 4000 + 4.0 * run.residual
        etched = FOIL_WIDTH_M * FOIL_M * FOIL_UM * 1e-6 * 8.96e6 * (1 - run.residual)  # grams of copper
        self.bath[tl.asset] = copper + etched / BATH_L
        if self.bath[tl.asset] >= BATH_PLAN and tl.asset not in self.pending:
            nxt = self._next_shift(end)
            bisect.insort(tl.planned, (nxt, nxt + 2.5 * HOUR, "PL-BTH", f"Etch bath change at {BATH_CHANGE:.0f} g/L"))
            self.pending.add(tl.asset)
        self._transfer_minutes(tl.asset.lower().replace("-", ""), run, capacity, r)
        if r.random() < 0.004 + 0.25 * lam**2.5:
            run.scrap, run.scrap_at = "TL-TEAR", end
        else:
            run.lab_at = end + 2 * HOUR
            run.rs_4pp = round(run.rs_film * (1 + r.gauss(0, 0.03)), 0)
            self.year.lab.append((run.lab_at, "lab.d_g_ratio", round(run.d_g, 3)))
            self.year.lab.append((run.lab_at + 60, "lab.2d_g_ratio", round(run.two_d_g, 2)))
            self.year.lab.append((run.lab_at + 1800, "lab.sheet_resistance_4pp", run.rs_4pp))
        return True

    def _transfer_minutes(self, key: str, run: Run, capacity: float, r: random.Random) -> None:
        start, end = run.transfer
        t = math.ceil(start / 60) * 60
        rate = 2.4 * capacity / 1.6
        while t < end:
            self.write(f"{key}-run", f"{key}.line_speed", t, round(TRANSFER_SPEED + r.gauss(0, 0.005), 3))
            self.write(f"{key}-run", f"{key}.nip_pressure", t, round(4.0 + r.gauss(0, 0.03 + 0.2 * run.laminator), 2))
            self.write(f"{key}-run", f"{key}.etch_rate", t, round(rate + r.gauss(0, 0.02), 3))
            self.write(f"{key}-run", f"{key}.rinse_conductivity", t, round(12 + 40 * run.residual + abs(r.gauss(0, 1)), 1))
            t += 60

    def inspect(self, ins: Station, sp: Station, run: Run, r: random.Random) -> list[FilmRoll] | None:
        start, end = ins.run(run.transfer[1] + HOUR, FOIL_M / INSPECT_SPEED * 60, fit=True)
        if end >= self.t1:
            return None
        run.inspected = (start, end)
        rolls = []
        for lane in range(1, LANES + 1):
            bias = 1 + (0.02 if lane == 1 else -0.015)
            for seg in range(1, LENGTHS + 1):
                rs = run.rs_film * bias * (1 + r.gauss(0, 0.025))
                uniformity = 4.0 + 6.0 * run.laminator + abs(r.gauss(0, 0.6))
                tr = run.transmittance + r.gauss(0, 0.08)
                defects = max(0.0, run.defects + r.gauss(0, 0.3 * math.sqrt(run.defects)))
                roll = FilmRoll(f"{run.id}-{lane}{seg}", run, lane, seg, rs, uniformity, tr, defects)
                if rs <= 350 and tr >= 97.0 and defects <= 3.0:
                    roll.grade = "A"
                elif rs <= 450 and tr >= 96.0 and defects <= 8.0:
                    roll.grade = "B"
                else:
                    roll.grade = "NG"
                    roll.scrap = "QC-RS" if rs > 450 else "QC-T" if tr < 96.0 else "QC-DEF"
                rolls.append(roll)
        # Inline, a minute at a time: both lanes, three metres a minute.
        t = math.ceil(start / 60) * 60
        while t < end:
            seg = min(LENGTHS, int((t - start) / 60 * INSPECT_SPEED // ROLL_M) + 1)
            here = [x for x in rolls if x.segment == seg]
            rs = sum(x.rs for x in here) / len(here) * (1 + r.gauss(0, 0.012))
            tr = sum(x.transmittance for x in here) / len(here) + r.gauss(0, 0.04)
            defects = max(0.0, sum(x.defects for x in here) / len(here) + r.gauss(0, 0.4))
            self.write("in01-run", "in01.sheet_resistance", t, round(rs, 0))
            self.write("in01-run", "in01.transmittance", t, round(tr, 2))
            self.write("in01-run", "in01.defects", t, round(defects, 1))
            t += 60
        _, packed = sp.run(end + HOUR, FOIL_M / 20 * 60, fit=True)
        if packed >= self.t1:
            return None
        run.packed = packed
        return rolls

    def run(self) -> Year:
        self.utilities()
        self.scrubber()
        self.exhaust.sort()
        ep, polish = self.foil_line()
        cvds = self.reactors()
        tls = self.transfer_lines()
        ins = self.station("IN-01", random_stops=INSPECTION_STOPS, planned=monthly_pm(self.shifts, 22, 4))
        sp = self.station("SP-01", random_stops=STATION_STOPS, planned=monthly_pm(self.shifts, 23, 4))
        r = random.Random(f"{SEED}/runs")
        n = 0
        while True:
            cvd = min(cvds, key=lambda s: s.t)
            if cvd.t >= self.t1:
                break
            foil = polish(cvd.t - 3 * HOUR)
            if foil is None:
                break
            n += 1
            run = self.grow(cvd, foil, r, n)
            if run is None:
                break
            self.year.runs.append(run)
            if run.scrap:
                continue
            tl = min(tls, key=lambda s: s.t)
            if not self.transfer(tl, run, r):
                break
            if run.scrap:
                continue
            rolls = self.inspect(ins, sp, run, r)
            if rolls is None:
                break
            self.year.rolls += rolls
        for st in (ep, *cvds, *tls, ins, sp):
            st.finish()
        for t, tag, v in sorted(self.year.lab):
            if t < self.t1:
                self.write("lab", tag, t, v)
        return self.year


__all__ = ["QUALITY", "FilmRoll", "Foil", "FoilLot", "Plant", "Run", "Year"]
