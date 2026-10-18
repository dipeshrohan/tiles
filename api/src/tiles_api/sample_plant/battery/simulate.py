"""A year of the battery plant, coil by coil and cell by cell.

Each machine is a `Station` (sample_plant/common.py): it runs its jobs (a slurry batch, a coil, a
roll, a cell, a formation) as soon as they may start, and stops for planned work, for what is
imposed on it (the dry room out of specification stops assembly), for its degradations and for
faults nothing foretells. The flow is the plant's:

- **Electrodes:** each line mixes slurry in batches, coats a coil from it, calenders it, slits it
  into four daughter rolls and vacuum-dries them; assembly takes the oldest dried rolls.
- **Assembly**, in the dry room: each cell is stacked from a cathode and an anode roll on one of
  two stackers, its tabs welded, and it is filled with electrolyte.
- **Formation and aging:** after a day's wetting each cell is formed on a channel of one of four
  racks, aged ten days, and tested at the end of the line.

Every cell's genealogy (its coils, rolls, stacker, rack) is kept, so what happened upstream shows in
its test: a chipped slitter blade's burrs become high self-discharge (a K-value fail) two weeks
later, a humid dry room raises moisture, resistance and self-discharge, a worn welding horn raises
resistance, a worn dosing pump under-fills cells and costs capacity. The degradations show in the
signals beforehand, at the strength the ground truth records.
"""

import bisect
import heapq
import math
import random
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta

from tiles_api.sample_plant.battery import calendar as cal
from tiles_api.sample_plant.battery.plant import (
    ANODE_LOADING,
    CATHODE_LOADING,
    COIL_M,
    END,
    FILL_G,
    LANES,
    METRES_A_CELL,
    NOMINAL_AH,
    SEED,
    START,
    ZONE,
)
from tiles_api.sample_plant.common import Mode, RandomStop, Station, Working, seasonal

GRID = Station.GRID
DAY = 86400.0
HOUR = 3600.0

# The cell's quality model (the ground truth behind the end-of-line test, for the process model).
QUALITY = {
    "capacity_ah": (
        "60.9 * cathode_loading / 22.0 - 0.012 * max(0, moisture_ppm - 200) - 0.35 * max(0, 245 - fill_g) - noise(0.22)"
    ),
    "dcir_mohm": "0.78 + 0.25 * weld_weakness + 0.0006 * max(0, moisture_ppm - 200) + noise(0.025)",
    "k_value_mv_day": (
        "0.07 + 0.0004 * max(0, moisture_ppm - 200) + noise(0.015), plus 0.4 to 3.0 when a micro-short forms"
    ),
    "micro_short_chance": "0.002 + 0.25 / (1 + exp(-(burr_um - 13) / 1.2)) + 0.03 * max(0, overhang_mm - 0.5)",
    "grade": "A: capacity >= 60.0, DCIR <= 0.90, K <= 0.20; B: capacity >= 58.8, DCIR <= 0.95, K <= 0.25; else NG",
}

COATER_MODES = (
    Mode(
        "die-lip",
        "DT-DIE",
        6.0,
        (1.5, 6.0),
        1.8,
        0.0,
        (3.0, 0.3),
        "Slot die",
        ("Coating streaks: slot die lips cleaned", "Coating weight out of tolerance across the web: die cleaned"),
        "Dried slurry on the die lips: cleaned",
    ),
    Mode(
        "dryer",
        "DT-DRY",
        1.5,
        (6.0, 20.0),
        1.6,
        0.3,
        (6.0, 0.35),
        "Dryer zone 3 fan",
        ("Dryer fan tripped: bearings replaced", "Dryer zone 3 too cold: fan motor changed"),
        "Dryer fan bearings worn: replaced",
    ),
)
CALENDER_MODES = (
    Mode(
        "bearing",
        "DT-CAL",
        1.2,
        (15.0, 40.0),
        2.0,
        0.35,
        (8.0, 0.3),
        "Work roll bearing",
        ("Calender vibration alarm: roll bearing replaced", "Thickness out of tolerance: bearing changed"),
        "Work roll bearing noisy at the vibration check: replaced",
    ),
)
SLITTER_MODES = (
    Mode(
        "blade-chip",
        "DT-BLD",
        4.0,
        (1.0, 4.0),
        1.5,
        0.0,
        (1.5, 0.3),
        "Slitter blades",
        ("Burrs over the limit: blades changed", "Blade chipped: knives changed"),
        "Blade chipped at inspection: changed",
    ),
)
DRYROOM_MODES = (
    Mode(
        "desiccant",
        "DT-DRM",
        3.0,
        (8.0, 25.0),
        1.7,
        0.3,
        (5.0, 0.35),
        "Desiccant wheel",
        (
            "Dew point above -30 °C: assembly stopped, wheel regenerated",
            "Dry room out of spec: desiccant wheel serviced",
        ),
        "Desiccant wheel loaded at the monthly check: regenerated",
    ),
)
STACKER_MODES = (
    Mode(
        "tension",
        "DT-STK",
        3.0,
        (1.0, 5.0),
        1.6,
        0.3,
        (2.0, 0.4),
        "Separator dancer",
        ("Overhang rejects: separator dancer adjusted", "Separator tension drift: servo replaced"),
        "Separator dancer worn: replaced",
    ),
)
WELDER_MODES = (
    Mode(
        "horn",
        "DT-WLD",
        2.0,
        (2.0, 6.0),
        1.8,
        0.25,
        (2.5, 0.3),
        "Ultrasonic horn",
        ("Weld rejects: horn cracked, changed", "Low weld energy margin: horn and anvil changed"),
        "Horn worn at inspection: changed",
    ),
)
FILLER_MODES = (
    Mode(
        "pump",
        "DT-FIL",
        3.0,
        (3.0, 12.0),
        1.6,
        0.3,
        (4.0, 0.3),
        "Dosing pump",
        ("Fill weight out of tolerance: dosing pump rebuilt", "Under-filled cells: pump valves replaced"),
        "Dosing pump valves worn: replaced",
    ),
)
RACK_MODES = (
    Mode(
        "contacts",
        "DT-FRM",
        1.5,
        (10.0, 40.0),
        1.8,
        0.4,
        (6.0, 0.3),
        "Channel contacts",
        ("Formation faults: channel contacts replaced", "Rack contact resistance high: probes changed"),
        "Contact resistance high at the monthly check: probes changed",
    ),
)


def web_stops(scale: float = 1.0) -> tuple[RandomStop, ...]:
    return (
        RandomStop(
            "DT-WEB",
            140 / scale,
            30,
            ("Web break at the splice", "Web break in the dryer", "Web wandered off the rollers"),
            "Web handling",
        ),
        RandomStop(
            "DT-ELE",
            300 / scale,
            60,
            ("Drive fault", "Gauge communication lost", "Safety circuit tripped"),
            "Electrics and controls",
        ),
        RandomStop(
            "DT-OTH", 100 / scale, 15, ("Cleaning", "Waiting for a new core", "Restarted"), "", corrective=False
        ),
    )


ASSEMBLY_STOPS = (
    RandomStop(
        "DT-ROB", 40, 15, ("Gripper lost a sheet", "Robot collision alarm", "Pick position lost"), "Handling robot"
    ),
    RandomStop(
        "DT-VIS", 60, 10, ("Camera lost calibration", "Vision false rejects: restarted"), "Vision", corrective=False
    ),
    RandomStop(
        "DT-ELE", 300, 50, ("Servo fault", "PLC communication fault", "Light curtain fault"), "Electrics and controls"
    ),
)
STATION_STOPS = (
    RandomStop("DT-ELE", 400, 40, ("Drive fault", "Sensor fault", "PLC communication fault"), "Electrics and controls"),
    RandomStop("DT-OTH", 150, 12, ("Cleaning", "Restarted"), "", corrective=False),
)
RACK_STOPS = (
    RandomStop("DT-ELE", 600, 45, ("Rack power supply fault", "Channel board fault"), "Electrics and controls"),
)


@dataclass
class Coil:
    id: str
    side: str  # C or A
    batch: str
    coated: tuple[float, float]
    calendered: tuple[float, float] = (0.0, 0.0)
    slit: tuple[float, float] = (0.0, 0.0)
    dried: tuple[float, float] = (0.0, 0.0)
    loading: float = 0.0  # mean coating weight, mg/cm²
    loading_cv: float = 0.0
    streaks: int = 0
    residual: float = 0.0  # ppm after the dryer
    peel: float = 0.0  # N/m
    thickness: float = 0.0
    thickness_sd: float = 0.0
    scrapped: str = ""  # its scrap code


@dataclass
class Roll:
    id: str
    coil: Coil
    lane: int
    burr: float
    moisture: float = 0.0
    ready: float = 0.0  # dried and in the dry room
    cells_left: int = 0
    scrapped: str = ""


@dataclass
class CellRecord:
    id: str
    stacker: str
    cathode: Roll
    anode: Roll
    stacked: float
    overhang: float = 0.0
    tension: float = 0.0
    cycle: float = 0.0
    dew_point: float = 0.0
    welded: float = 0.0
    weld_energy: float = 0.0
    weld_weak: float = 0.0
    filled: float = 0.0
    fill_g: float = 0.0
    fill_vacuum: float = 0.0
    rack: str = ""
    formed: tuple[float, float] = (0.0, 0.0)
    formation_ah: float = 0.0
    tested: float = 0.0
    capacity: float = 0.0
    dcir: float = 0.0
    k_value: float = 0.0
    short: bool = False
    grade: str = ""
    scrap: str = ""  # where and why it was scrapped
    scrap_at: float = 0.0


@dataclass
class Year:
    shifts: list[cal.Shift]
    working: Working
    stations: dict[str, Station]
    coils: list[Coil] = field(default_factory=list)
    rolls: list[Roll] = field(default_factory=list)
    cells: list[CellRecord] = field(default_factory=list)
    batches: list[tuple[str, str, float, float, float, float]] = field(
        default_factory=list
    )  # id, side, start, end, viscosity, solids
    lab: list[tuple[float, str, float]] = field(default_factory=list)  # time, tag, value
    dew: list[float] = field(default_factory=list)  # dew point on the grid
    t0: float = 0.0


Write = Callable[[str, str, float, float], None]  # stream, tag, time, value


def monthly_pm(
    shifts: list[cal.Shift], day: int, hours: float, text: str = "Monthly planned maintenance"
) -> list[tuple[float, float, str, str]]:
    """A planned maintenance on the first day shift on or after the month's `day`."""
    out = []
    seen: set[str] = set()
    for s in shifts:
        key = f"{s.start:%Y-%m}"
        if s.name == "D" and s.start.day >= day and key not in seen:
            seen.add(key)
            a = s.start + timedelta(hours=1)
            out.append((a.timestamp(), (a + timedelta(hours=hours)).timestamp(), "PL-PM", text))
    return out


def weekly(
    shifts: list[cal.Shift], weekday: int, hour: int, hours: float, code: str, text: str
) -> list[tuple[float, float, str, str]]:
    out = []
    for s in shifts:
        if s.name == "D" and s.start.weekday() == weekday:
            a = s.start.replace(hour=hour)
            out.append((a.timestamp(), (a + timedelta(hours=hours)).timestamp(), code, text))
    return out


class Plant:
    def __init__(self, write: Write) -> None:
        self.write = write
        self.shifts = cal.shifts()
        self.w = Working(cal.working_intervals(self.shifts))
        self.t0, self.t1 = START.timestamp(), END.timestamp()
        self.rng = random.Random(f"{SEED}/plant")
        self.ambient = self._ambient()
        self.stations: dict[str, Station] = {}
        self.year = Year(self.shifts, self.w, self.stations, t0=self.t0)
        self.blade_km: dict[str, float] = {"SL-C1": 40.0, "SL-A1": 95.0}
        self.welds = 120_000
        self.pending: set[str] = set()  # a counted change planned and not yet done
        self.r_racks = random.Random(f"{SEED}/racks")
        self.state: dict[str, float] = {}  # smoothed values per station and tag

    # ---- the site ---------------------------------------------------------------------------

    def _ambient(self) -> list[float]:
        r = random.Random(f"{SEED}/site")
        n = int((self.t1 - self.t0) // GRID)
        out, noise = [], 0.0
        for i in range(n):
            t = self.t0 + i * GRID
            noise = 0.98 * noise + r.gauss(0, 0.05)
            out.append(9 + 4 * seasonal(t, ZONE) + noise)
        return out

    def chilled(self, t: float) -> float:
        return self.ambient[min(len(self.ambient) - 1, int((t - self.t0) // GRID))]

    def station(self, asset: str, **kw: object) -> Station:
        st = Station(asset, self.w, SEED, start=self.t0, end=self.t1, **kw)  # type: ignore[arg-type]
        self.stations[asset] = st
        return st

    def smooth(self, key: str, target: float, tau_s: float) -> float:
        v = self.state.get(key, target)
        v += (target - v) * (1 - math.exp(-GRID / tau_s))
        self.state[key] = v
        return v

    # ---- the dry room --------------------------------------------------------------------------

    def dry_room(self) -> list[tuple[float, float, str, str]]:
        """The dehumidifier's year: the dew point it holds, and the assembly stops when it can't."""
        r = random.Random(f"{SEED}/DR-01/grid")
        dh = self.station(
            "DH-01",
            modes=DRYROOM_MODES,
            planned=monthly_pm(self.shifts, 3, 6, "Monthly dehumidifier check: wheel, filters, regeneration heater"),
        )
        stops: list[tuple[float, float, str, str]] = []
        t = self.t0
        dew_list = self.year.dew
        noise = 0.0
        while t < self.t1:
            w = self.w.seconds(t)
            ep = next(
                (
                    e
                    for e in dh.episodes
                    if e.failed_at is None and e.resolved_at is None and e.onset <= t and e.severity(w, t) >= 1.0
                ),
                None,
            )
            if ep:  # the dew point is out of specification until the wheel is regenerated
                m = DRYROOM_MODES[0]
                dur = max(1800.0, dh.r_stop.lognormvariate(math.log(m.stop_hours[0] * HOUR), m.stop_hours[1]))
                ep.failed_at, ep.peak, ep.outcome = t, 1.0, "Failed: the dry room went out of specification"
                ep.resolved_at = t + dur
                stops.append((t, t + dur, "DT-DRM", dh.r_stop.choice(m.comments)))
                from tiles_api.sample_plant.common import Maintenance

                dh.maintenance.append(Maintenance("DH-01", t, t + dur, "CM", m.component, m.code, stops[-1][3], ep.id))
            # Monthly checks find a loaded wheel.
            while dh.pi < len(dh.planned) and dh.planned[dh.pi][0] <= t:
                a, b, code, text = dh.planned[dh.pi]
                dh.pi += 1
                dh._planned_job(a, b, code, text)
            noise = 0.97 * noise + r.gauss(0, 0.35)
            s = dh.sev("desiccant", t)
            dew = -45.5 + 17.5 * s**1.2 + 1.5 * seasonal(t, ZONE) + noise
            dew_list.append(dew)
            self.write("dr01", "dr01.dew_point", t, round(dew, 1))
            self.write("dr01", "dr01.temperature", t, round(21 + 0.3 * r.gauss(0, 1) + 0.6 * seasonal(t, ZONE), 1))
            self.write("dr01", "dh01.regen_temp", t, round(140 + r.gauss(0, 1.5) - 4 * s, 1))
            self.write("dr01", "dh01.wheel_dp", t, round(220 + 190 * s**1.3 + r.gauss(0, 4), 0))
            t += GRID
        for ep in dh.episodes:
            if ep.resolved_at is None and ep.failed_at is None:
                ep.outcome = "Still building up at the end of the year"
        return stops

    def dew_at(self, t: float) -> float:
        i = min(len(self.year.dew) - 1, max(0, int((t - self.t0) // GRID)))
        return self.year.dew[i]

    # ---- electrodes ---------------------------------------------------------------------------

    def electrodes(self, side: str) -> list[Roll]:
        """A line's year: coils at the assembly's pace, each coated, calendered, slit and dried."""
        s_ = side.lower()
        target = CATHODE_LOADING if side == "C" else ANODE_LOADING
        mx = self.station(
            f"MX-{side}1", random_stops=STATION_STOPS, planned=monthly_pm(self.shifts, 5 if side == "C" else 6, 6)
        )

        def coater_grid(st: Station, g: float, mode: str) -> None:
            r = self.rng
            running = mode == "run"
            dry = st.sev("dryer", g)
            key = st.asset.lower().replace("-", "")
            z = 120.0 if side == "C" else 95.0
            for zone, base in (("z1", z - 25), ("z3", z), ("z5", z - 10)):
                drop = 14 * dry if zone == "z3" else 3 * dry
                target_t = (base - drop) if mode in ("run", "idle", "stop") else 25.0
                v = self.smooth(f"{key}.{zone}", target_t, 1800)
                self.write(key, f"{key}.dryer_temp_{zone}", g, round(v + r.gauss(0, 0.6), 1))
            current = (14.0 + 6.5 * dry**1.3 if mode != "off" else 0.0) + r.gauss(0, 0.15)
            self.write(key, f"{key}.dryer_fan_current", g, round(max(0.0, current), 2))
            residual = (180 + 900 * dry**1.5 if running else 60.0) + r.gauss(0, 12)
            self.write(key, f"{key}.residual_solvent", g, round(max(0.0, residual), 0))

        ct = self.station(
            f"CT-{side}1",
            random_stops=web_stops(),
            modes=COATER_MODES,
            planned=monthly_pm(self.shifts, 8 if side == "C" else 9, 8)
            + weekly(self.shifts, 2 if side == "C" else 3, 8, 1.5, "PL-CLN", "Weekly slot die cleaning"),
            grid=coater_grid,
            on_planned=self._coater_planned,
        )

        def calender_grid(st: Station, g: float, mode: str) -> None:
            r = self.rng
            key = st.asset.lower().replace("-", "")
            b = st.sev("bearing", g)
            temp = self.smooth(f"{key}.roll", 85.0 if mode in ("run", "idle", "stop") else 30.0, 2400)
            self.write(key, f"{key}.roll_temp", g, round(temp + r.gauss(0, 0.4), 1))
            vib = (1.8 + 7.5 * b**1.6) * (1.0 if mode == "run" else 0.35) + abs(r.gauss(0, 0.12))
            self.write(key, f"{key}.bearing_vibration", g, round(vib, 2))

        cl = self.station(
            f"CL-{side}1",
            random_stops=web_stops(0.8),
            modes=CALENDER_MODES,
            planned=monthly_pm(self.shifts, 12 if side == "C" else 13, 8),
            grid=calender_grid,
        )

        def slitter_grid(st: Station, g: float, mode: str) -> None:
            key = st.asset.lower().replace("-", "")
            self.write(key, f"{key}.blade_km", g, round(self.blade_km[st.asset], 1))

        sl = self.station(
            f"SL-{side}1",
            random_stops=web_stops(0.7),
            modes=SLITTER_MODES,
            planned=monthly_pm(self.shifts, 15 if side == "C" else 16, 6),
            grid=slitter_grid,
            on_planned=self._slitter_planned,
        )

        def oven_grid(st: Station, g: float, mode: str) -> None:
            r = self.rng
            key = st.asset.lower().replace("-", "")
            hot = mode in ("run", "idle")
            self.write(
                key,
                f"{key}.oven_temp",
                g,
                round(self.smooth(f"{key}.t", 120.0 if hot else 25.0, 3600) + r.gauss(0, 0.5), 1),
            )
            self.write(key, f"{key}.vacuum", g, round((2.0 if mode == "run" else 1013.0) + abs(r.gauss(0, 0.3)), 1))

        vd = self.station(
            f"VD-{side}1",
            random_stops=STATION_STOPS,
            planned=monthly_pm(self.shifts, 18 if side == "C" else 19, 4),
            grid=oven_grid,
        )

        r = random.Random(f"{SEED}/{side}/coils")
        rolls: list[Roll] = []
        takt = (COIL_M * LANES / METRES_A_CELL) / 2050 * DAY  # a coil every so often, for 2,050 cells a day
        batch_ready = 0.0
        batch_id = ""
        n = 0
        ready = self.t0 + 6 * HOUR
        while True:
            n += 1
            # A slurry batch serves two coils.
            if n % 2 == 1:
                bs, be = mx.run(ready - 4 * HOUR, 2.5 * HOUR)
                if be >= self.t1:
                    break
                visc = r.gauss(6200 if side == "C" else 3800, 260)
                solids = r.gauss(70.0 if side == "C" else 50.0, 0.4)
                batch_id = f"B{s_.upper()}-{n // 2 + 1:05d}"
                self.year.batches.append((batch_id, side, bs, be, visc, solids))
                self.write(f"mx{s_}1", f"mx{s_}1.viscosity", be, round(visc, 0))
                self.write(f"mx{s_}1", f"mx{s_}1.solid_content", be, round(solids, 2))
                batch_ready = be
            speed = 15.0 * (1 + r.gauss(0, 0.004))
            start, end = ct.run(max(ready, batch_ready), COIL_M / speed * 60)
            if end >= self.t1:
                break
            coil = Coil(f"{'CC' if side == 'C' else 'AC'}-{n:05d}", side, batch_id, (start, end))
            lip = ct.sev("die-lip", start)
            dry = ct.sev("dryer", start)
            coil.loading_cv = 0.85 + 2.8 * lip**1.4 + abs(r.gauss(0, 0.05))
            coil.loading = target * (1 + r.gauss(0, 0.006))
            coil.streaks = int(max(0.0, r.gauss(0.3 + 12 * lip**2, 0.5 + 2 * lip)))
            coil.residual = 180 + 900 * dry**1.5 + r.gauss(0, 15)
            coil.peel = (16.0 if side == "C" else 12.0) - 9.0 * dry**1.5 + r.gauss(0, 0.8)
            self._coating_minutes(ct.asset.lower().replace("-", ""), coil, speed, lip, r)
            ck = ct.asset.lower().replace("-", "")
            self.write(f"{ck}-unit", f"{ck}.streaks", end, coil.streaks)
            if side == "C":
                self.year.lab.append((end + 2 * HOUR, "lab.peel_cathode", round(coil.peel, 1)))
            if coil.streaks > 12 or coil.loading_cv > 3.2:
                coil.scrapped = "COIL-STREAK"
            elif coil.peel < 8.0:
                coil.scrapped = "COIL-ADH"
            # Calendering, an hour or more after coating.
            cs, ce = cl.run(end + HOUR, COIL_M / 21.0 * 60)
            coil.calendered = (cs, ce)
            b = cl.sev("bearing", cs)
            coil.thickness = (118.0 if side == "C" else 136.0) + r.gauss(0, 0.6)
            coil.thickness_sd = 0.8 + 1.8 * b**1.6 + abs(r.gauss(0, 0.05))
            self._calender_minutes(cl.asset.lower().replace("-", ""), coil, r)
            # Slitting into four daughter rolls
            ss, se = sl.run(ce + 0.5 * HOUR, COIL_M / 30.0 * 60)
            coil.slit = (ss, se)
            chip = sl.sev("blade-chip", ss)
            km = self.blade_km[sl.asset]
            self.blade_km[sl.asset] = km + COIL_M * LANES / 1000
            if self.blade_km[sl.asset] >= 150 and sl.asset not in self.pending:
                nxt = self._next_day_shift(se)
                bisect.insort(sl.planned, (nxt, nxt + 1.5 * HOUR, "PL-BLD", "Planned blade change at 150 km"))
                self.pending.add(sl.asset)  # until the change is done
            base_burr = 3.0 + 5.0 * (km / 150) ** 2
            # Vacuum drying the four rolls together
            vs, ve = vd.run(se + HOUR, 2.5 * HOUR)
            coil.dried = (vs, ve)
            dew = self.dew_at(ve)
            for lane in range(LANES):
                burr = base_burr + 11.0 * chip**1.3 + abs(r.gauss(0, 0.7))
                roll = Roll(f"{coil.id}-{lane + 1}", coil, lane + 1, burr)
                roll.moisture = 140 + 14 * max(0.0, dew + 45) + r.gauss(0, 12)
                roll.ready = ve + 2 * HOUR
                roll.cells_left = int(COIL_M / METRES_A_CELL)
                sk = sl.asset.lower().replace("-", "")
                self.write(f"{sk}-unit", f"{sk}.burr_height", se + lane, round(burr, 1))
                self.year.lab.append((ve + HOUR + lane * 60, "lab.moisture_electrode", round(roll.moisture, 0)))
                if burr >= 15.0:
                    roll.scrapped = "COIL-BURR"
                if coil.scrapped:
                    roll.scrapped = coil.scrapped
                rolls.append(roll)
            # A chipped blade is changed once its burrs go over the limit (or at its failure).
            if chip >= 0.85:
                ep = next(
                    (e for e in sl.episodes if e.mode == "blade-chip" and e.resolved_at is None and e.onset <= ss), None
                )
                if ep:
                    m = SLITTER_MODES[0]
                    done = sl.breakdown(
                        se, 1.5 * HOUR, m.code, "Burrs over the limit: chipped blades changed", ep, m.component
                    )
                    sl.t = max(sl.t, done)
                    ep.peak, ep.outcome = chip, "Found by the burr measurement: blades changed"
                    self.blade_km[sl.asset] = 0.0
                    self.pending.discard(sl.asset)
            self.year.coils.append(coil)
            ready += takt
            if ready < end - 6 * HOUR:  # far behind: the line catches up as fast as it can
                ready = end - 6 * HOUR
        for st in (mx, ct, cl, sl, vd):
            st.finish()
        return rolls

    def _coater_planned(self, st: Station, code: str, start: float, end: float) -> None:
        if code in ("PL-CLN", "PL-PM"):  # die cleaning clears dried slurry on the lips
            for ep in st.episodes:
                if ep.mode == "die-lip" and ep.resolved_at is None and ep.onset <= start:
                    ep.resolved_at, ep.peak = start, ep.severity(self.w.seconds(start), start)
                    ep.outcome = "Cleared by the planned die cleaning"

    def _slitter_planned(self, st: Station, code: str, start: float, end: float) -> None:
        if code == "PL-BLD":
            self.blade_km[st.asset] = 0.0
            self.pending.discard(st.asset)
            for ep in st.episodes:
                if ep.mode == "blade-chip" and ep.resolved_at is None and ep.onset <= start:
                    ep.resolved_at, ep.peak, ep.outcome = (
                        start,
                        ep.severity(self.w.seconds(start), start),
                        "Cleared by the planned blade change",
                    )

    def _next_day_shift(self, t: float) -> float:
        for s in self.shifts:
            if s.start.timestamp() > t and s.name == "D":
                return s.start.timestamp() + HOUR
        return self.t1

    def _coating_minutes(self, key: str, coil: Coil, speed: float, lip: float, r: random.Random) -> None:
        start, end = coil.coated
        t = math.ceil(start / 60) * 60
        while t < end:
            self.write(f"{key}-run", f"{key}.web_speed", t, round(speed + r.gauss(0, 0.03), 2))
            self.write(f"{key}-run", f"{key}.coating_weight", t, round(coil.loading * (1 + r.gauss(0, 0.002)), 2))
            self.write(f"{key}-run", f"{key}.coating_weight_cv", t, round(coil.loading_cv + r.gauss(0, 0.04), 2))
            self.write(f"{key}-run", f"{key}.slot_die_pressure", t, round(2.4 + 0.9 * lip + r.gauss(0, 0.03), 2))
            t += 60

    def _calender_minutes(self, key: str, coil: Coil, r: random.Random) -> None:
        start, end = coil.calendered
        t = math.ceil(start / 60) * 60
        while t < end:
            self.write(
                f"{key}-run", f"{key}.roll_force", t, round((1450 if coil.side == "C" else 980) + r.gauss(0, 8), 0)
            )
            self.write(
                f"{key}-run", f"{key}.thickness", t, round(coil.thickness + r.gauss(0, coil.thickness_sd * 0.3), 1)
            )
            self.write(f"{key}-run", f"{key}.thickness_sd", t, round(coil.thickness_sd + r.gauss(0, 0.05), 2))
            t += 60

    # ---- assembly ----------------------------------------------------------------------------

    def assembly(
        self, cathodes: list[Roll], anodes: list[Roll], dry_stops: list[tuple[float, float, str, str]]
    ) -> list[CellRecord]:
        r = random.Random(f"{SEED}/assembly")
        ext = list(dry_stops)
        nt_c = self.station(
            "NT-C1",
            random_stops=STATION_STOPS,
            planned=monthly_pm(self.shifts, 20, 6),
            grid=self._notcher_grid,
            external=ext,
        )
        nt_a = self.station(
            "NT-A1",
            random_stops=STATION_STOPS,
            planned=monthly_pm(self.shifts, 21, 6),
            grid=self._notcher_grid,
            external=ext,
        )
        st1 = self.station(
            "ST-01",
            random_stops=ASSEMBLY_STOPS,
            modes=STACKER_MODES,
            planned=monthly_pm(self.shifts, 22, 8),
            external=ext,
        )
        st2 = self.station(
            "ST-02",
            random_stops=ASSEMBLY_STOPS,
            modes=STACKER_MODES,
            planned=monthly_pm(self.shifts, 23, 8),
            external=ext,
        )
        uw = self.station(
            "UW-01",
            random_stops=STATION_STOPS,
            modes=WELDER_MODES,
            planned=monthly_pm(self.shifts, 24, 6),
            external=ext,
            on_planned=self._welder_planned,
        )
        ef = self.station(
            "EF-01",
            random_stops=STATION_STOPS,
            modes=FILLER_MODES,
            planned=monthly_pm(self.shifts, 25, 6),
            external=ext,
        )
        c_rolls = [x for x in cathodes if not x.scrapped]
        a_rolls = [x for x in anodes if not x.scrapped]
        ci = ai = 0
        cells: list[CellRecord] = []
        stackers = [st1, st2]
        n = 0
        while True:
            # The oldest dried rolls with cells left in them.
            while ci < len(c_rolls) and c_rolls[ci].cells_left <= 0:
                ci += 1
            while ai < len(a_rolls) and a_rolls[ai].cells_left <= 0:
                ai += 1
            if ci >= len(c_rolls) or ai >= len(a_rolls):
                break
            cr, ar = c_rolls[ci], a_rolls[ai]
            st = min(stackers, key=lambda s: s.t)
            material = max(cr.ready, ar.ready)
            # Notching runs just ahead of stacking; its long stops hold the stackers.
            notch = max(nt_c.run(material, 20)[1], nt_a.run(material, 20)[1])
            # Welding and filling buffer half an hour of cells.
            ready = max(material, notch, uw.t - 1800, ef.t - 1800)
            tension = st.sev("tension", max(ready, st.t))
            cycle = 80 * (1 + r.gauss(0, 0.02)) + (r.uniform(10, 40) if r.random() < 0.02 else 0)
            start, end = st.run(ready, cycle)
            if end >= self.t1:
                break
            n += 1
            cell = CellRecord(f"KX60-{n:07d}", st.asset, cr, ar, end)
            cr.cells_left -= 1
            ar.cells_left -= 1
            cell.cycle = cycle
            cell.tension = 8.0 - 2.2 * tension + r.gauss(0, 0.12)
            cell.overhang = abs(r.gauss(0.12, 0.06 + 0.28 * tension**1.3))
            cell.dew_point = self.dew_at(start)
            k = st.asset.lower().replace("-", "")
            self.write(k, f"{k}.cycle_time", end, round(cycle, 1))
            self.write(k, f"{k}.overhang_dev", end, round(cell.overhang, 3))
            self.write(k, f"{k}.separator_tension", end, round(cell.tension, 2))
            cells.append(cell)
            if cell.overhang > 0.8:
                cell.scrap, cell.scrap_at = "STK-OVH", end
                continue
            # Tab welding
            horn = uw.sev("horn", end)
            _, we = uw.run(end + 60, 30)
            if we >= self.t1:
                break
            self.welds += 1
            if self.welds >= 200_000 and "UW-01" not in self.pending:
                nxt = self._next_day_shift(we)
                bisect.insort(uw.planned, (nxt, nxt + 1.5 * HOUR, "PL-HRN", "Planned horn change at 200,000 welds"))
                self.pending.add("UW-01")
            wear = (self.welds / 200_000) ** 2
            cell.welded = we
            cell.weld_energy = 620 + 90 * wear + 230 * horn**1.4 + r.gauss(0, 9)
            cell.weld_weak = 0.15 * wear + horn**1.6
            self.write("uw01", "uw01.weld_energy", we, round(cell.weld_energy, 0))
            self.write("uw01", "uw01.weld_time", we, round(180 + 40 * horn + r.gauss(0, 4), 0))
            if self.welds > 0 and self.welds % 500 == 0:
                self.year.lab.append(
                    (we + HOUR, "lab.weld_peel", round(140 - 25 * wear - 70 * horn**1.4 + r.gauss(0, 6), 1))
                )
            if r.random() < 0.0005 + 0.2 / (1 + math.exp(-(horn - 0.8) / 0.08)):
                cell.scrap, cell.scrap_at = "WLD-FAIL", we
                continue
            # Electrolyte filling
            pump = ef.sev("pump", we)
            _, fe = ef.run(we + 60, 35)
            if fe >= self.t1:
                break
            cell.filled = fe
            cell.fill_g = FILL_G - 4.0 * pump**1.5 + r.gauss(0, 0.8 + 2.2 * pump**1.3)
            cell.fill_vacuum = 1.5 + abs(r.gauss(0, 0.3)) + 2 * pump
            self.write("ef01", "ef01.fill_weight", fe, round(cell.fill_g, 1))
            self.write("ef01", "ef01.fill_vacuum", fe, round(cell.fill_vacuum, 2))
            if cell.fill_g < 240.0:
                cell.scrap, cell.scrap_at = "FIL-LOW", fe
        for s in (nt_c, nt_a, st1, st2, uw, ef):
            s.finish()
        return cells

    def _notcher_grid(self, st: Station, g: float, mode: str) -> None:
        key = st.asset.lower().replace("-", "")
        power = (1200 if mode in ("run", "idle") else 0) + self.rng.gauss(0, 6)
        self.write(key, f"{key}.laser_power", g, round(max(0.0, power), 0))

    def _welder_planned(self, st: Station, code: str, start: float, end: float) -> None:
        if code == "PL-HRN":
            self.welds = 0
            self.pending.discard("UW-01")
            for ep in st.episodes:
                if ep.mode == "horn" and ep.resolved_at is None and ep.onset <= start:
                    ep.resolved_at, ep.peak, ep.outcome = (
                        start,
                        ep.severity(self.w.seconds(start), start),
                        "Cleared by the planned horn change",
                    )

    # ---- formation, aging, test -------------------------------------------------------------------

    def formation(self, cells: list[CellRecord]) -> None:
        r = random.Random(f"{SEED}/formation")
        racks = []
        for i in range(1, 5):
            asset = f"FM-{i:02d}"
            racks.append(
                self.station(
                    asset,
                    random_stops=RACK_STOPS,
                    modes=RACK_MODES,
                    planned=monthly_pm(self.shifts, 26 + i // 3, 6),
                    grid=self._rack_grid,
                )
            )
        channels = [[0.0] * 512 for _ in racks]
        for ch in channels:
            heapq.heapify(ch)
        self.load: dict[str, list[float]] = {rk.asset: [] for rk in racks}  # formation ends, for the racks' temperature
        good = sorted((c for c in cells if not c.scrap and c.filled), key=lambda c: c.filled)
        for n, cell in enumerate(good):
            i = n % 4
            rack = racks[i]
            ready = max(cell.filled + 24 * HOUR, channels[i][0])
            # A rack that is down holds the cells for its channels.
            start, _ = rack.run(ready, 0.0)
            if start >= self.t1 - 18 * HOUR:
                break
            heapq.heapreplace(channels[i], start + 18 * HOUR)
            contact = rack.sev("contacts", start)
            cell.rack = rack.asset
            cell.formed = (start, start + 18 * HOUR)
            bisect.insort(self.load[rack.asset], start + 18 * HOUR)
            cell.formation_ah = 66.0 * cell.cathode.coil.loading / CATHODE_LOADING + r.gauss(0, 0.3)
            if r.random() < 0.001 + 0.05 * contact**2:
                cell.scrap, cell.scrap_at = "FRM-FAIL", start + 18 * HOUR
        for rk in racks:
            rk.finish()
        self._test(good, r)

    def _rack_grid(self, st: Station, g: float, mode: str) -> None:
        key = st.asset.lower().replace("-", "")
        ends = self.load.get(st.asset, [])
        busy = bisect.bisect_right(ends, g + 18 * HOUR) - bisect.bisect_right(ends, g)  # cells on its channels
        contact = st.sev("contacts", g)
        util = min(1.0, busy / 512)
        r = self.r_racks
        self.write(key, f"{key}.rack_temp", g, round(25 + 9 * util + 5 * contact * util + r.gauss(0, 0.3), 1))
        self.write(key, f"{key}.contact_resistance", g, round(2.5 + 5.5 * contact**1.4 + abs(r.gauss(0, 0.1)), 2))

    def _test(self, cells: list[CellRecord], r: random.Random) -> None:
        eol = self.station("EOL-01", random_stops=STATION_STOPS, planned=monthly_pm(self.shifts, 28, 4))
        aging_done = sorted((c for c in cells if c.rack and not c.scrap), key=lambda c: c.formed[1])
        for cell in aging_done:
            _, end = eol.run(cell.formed[1] + 10 * DAY, 20)
            if end >= self.t1:
                break
            cell.tested = end
            moisture = 0.5 * (cell.cathode.moisture + cell.anode.moisture) + 9 * max(0.0, cell.dew_point + 45)
            short_p = (
                0.002
                + 0.25 / (1 + math.exp(-(max(cell.cathode.burr, cell.anode.burr) - 13) / 1.2))
                + 0.03 * max(0.0, cell.overhang - 0.5)
            )
            cell.short = r.random() < short_p
            cell.capacity = (
                60.9 * cell.cathode.coil.loading / CATHODE_LOADING
                - 0.012 * max(0.0, moisture - 200)
                - 0.35 * max(0.0, FILL_G - cell.fill_g)
                + r.gauss(0, 0.22)
            )
            cell.dcir = 0.78 + 0.25 * cell.weld_weak + 0.0006 * max(0.0, moisture - 200) + r.gauss(0, 0.025)
            cell.k_value = (
                0.07
                + 0.0004 * max(0.0, moisture - 200)
                + r.gauss(0, 0.015)
                + (r.uniform(0.4, 3.0) if cell.short else 0.0)
            )
            cell.k_value = max(0.01, cell.k_value)
            if cell.capacity >= 60.0 and cell.dcir <= 0.90 and cell.k_value <= 0.20:
                cell.grade = "A"
            elif cell.capacity >= 58.8 and cell.dcir <= 0.95 and cell.k_value <= 0.25:
                cell.grade = "B"
            else:
                cell.grade = "NG"
                cell.scrap = "EOL-K" if cell.k_value > 0.25 else "EOL-DCIR" if cell.dcir > 0.95 else "EOL-CAP"
                cell.scrap_at = end
            self.write("eol01", "eol01.capacity", end, round(cell.capacity, 2))
            self.write("eol01", "eol01.dcir", end, round(cell.dcir, 3))
            self.write("eol01", "eol01.k_value", end, round(cell.k_value, 3))
        eol.finish()

    # ---- utilities ---------------------------------------------------------------------------------

    def utilities(self) -> None:
        r = random.Random(f"{SEED}/utilities")
        t = self.t0
        i = 0
        while t < self.t1:
            on = self.w.working(t)
            self.write(
                "site", "ch01.supply_temp", t, round(7.0 + 0.4 * max(0.0, self.ambient[i] - 9) + r.gauss(0, 0.1), 2)
            )
            self.write("site", "cp01.header_pressure", t, round((7.0 if on else 7.3) + r.gauss(0, 0.04), 2))
            self.write("site", "nr01.outlet_nmp", t, round((18 if on else 4) + abs(r.gauss(0, 2.5)), 1))
            self.write("site", "ag01.room_temp", t, round(25.0 + r.gauss(0, 0.15), 2))
            t += GRID
            i += 1

    def run(self) -> Year:
        self.utilities()
        dry_stops = self.dry_room()
        cathodes = self.electrodes("C")
        anodes = self.electrodes("A")
        self.year.rolls = cathodes + anodes
        cells = self.assembly(cathodes, anodes, dry_stops)
        self.formation(cells)
        self.year.cells = cells
        # The dry room's stops are DR-01's in the MES.
        from tiles_api.sample_plant.common import Stop

        dr = self.station("DR-01")
        dr.stops = [Stop("DR-01", a, b, code, False, text) for a, b, code, text in dry_stops]
        dr.episodes = []
        for t, tag, v in sorted(self.year.lab):
            self.write("lab", tag, t, v)
        return self.year


def nominal() -> float:
    return NOMINAL_AH


__all__ = ["QUALITY", "CellRecord", "Coil", "Plant", "Roll", "Year", "datetime"]
