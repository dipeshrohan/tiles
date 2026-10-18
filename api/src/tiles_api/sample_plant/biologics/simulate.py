"""A year of the biologics site, batch by batch and vial by vial.

Each piece of equipment is a `Station` (sample_plant/common.py): it runs its jobs (a CIP, a
harvest, a chromatography run, a lyophilisation cycle) as soon as they may start, and stops for
planned work, for what is imposed on it (WFI out of specification stops media and buffer
preparation and the CIP skids; the filling room losing its pressure stops filling), for its
degradations and for faults nothing foretells. The flow is the site's:

- **Upstream:** a vial of the working cell bank is thawed into shake flasks, expanded in a rocking
  bioreactor and an N-1 bioreactor, and inoculated into one of four 2,000 L production
  bioreactors, cleaned, sterilised and filled with medium for it; the fed-batch culture runs 14
  days. A culture can't be paused: a seal that fails or a contamination loses the batch.
- **Downstream:** the harvest is centrifuged and depth-filtered, captured on Protein A in cycles,
  held at low pH to inactivate viruses, polished by cation and anion exchange, virus-filtered,
  concentrated and diafiltered, and filled into bags and frozen: a drug substance lot, released by
  QC on its aggregates, host cell protein and endotoxin.
- **Fill-finish:** each released lot is thawed, filled into vials, lyophilised, capped and
  inspected: a drug product lot.

Every lot's genealogy (vial, bioreactor, harvest, chromatography cycles, bulk lot, fill lot) is
kept, so what happened upstream shows downstream: a worn Protein A resin yields less, a compressed
CEX bed clears fewer aggregates, a leaking lyophiliser raises the chamber pressure, and with it the
product temperature, collapsed cakes and moisture; a worn dosing pump under-fills one needle's vials;
a wearing agitator seal makes contamination likelier. The degradations show in the signals
beforehand, at the strength the ground truth records.
"""

import bisect
import heapq
import math
import random
from array import array
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from functools import partial

from tiles_api.sample_plant.biologics import calendar as cal
from tiles_api.sample_plant.biologics.plant import (
    END,
    FILL_G,
    FILL_HIGH,
    FILL_LOW,
    HEADS,
    RESIN_L,
    RESIN_LIFE,
    RESIN_LOAD,
    SEED,
    START,
    ZONE,
)
from tiles_api.sample_plant.common import Episode, Maintenance, Mode, RandomStop, Station, Stop, Working, seasonal

GRID = Station.GRID
DAY = 86400.0
HOUR = 3600.0
NO_END = float("inf")

# The process model: the ground truth behind the QC results and the vials' fate.
PROCESS = {
    "protein_a_step_yield_pct": "95.5 - 11 * (resin_cycle / 150) ** 2 + noise(0.6)",
    "protein_a_column_dp_bar": "1.05 + 0.55 * (resin_cycle / 150) ** 1.5 + noise(0.02)",
    "harvest_hmw_pct": "2.2 + 0.07 * (100 - harvest_viability) + noise(0.15)",
    "cex_clearance": "0.70 - 0.45 * bed ** 1.5 + noise(0.02), bed: the CEX column's compression (0 to 1)",
    "bulk_hmw_pct": "harvest_hmw * (1 - cex_clearance)",
    "bulk_hcp_ppm": "9 + 0.9 * (100 - harvest_viability) + 0.12 * harvest_hold_hours + noise(2)",
    "chamber_pressure_ubar": "100 + 2.5 * (leak_rate - 4), leak_rate = 4 + 16 * leak ** 1.5 (µbar·L/s)",
    "product_temp_max_c": "-35.2 + 0.035 * (chamber_pressure - 100) + 1.6 * edge_vial + shelf_bias + noise(0.6)",
    "cake": "collapsed when product_temp_max > -32.0 (the formulation's collapse temperature)",
    "dp_moisture_pct": "0.85 + 0.02 * (chamber_pressure - 100) + noise(0.07)",
    "fill_weight_g": "10.30 - 0.25 * pump ** 1.5 on the worn needle + noise(0.035 + 0.05 * pump)",
    "contamination_per_hour": "0.8e-5 + 3.5e-4 * seal ** 2, seal: the agitator seal's wear (0 to 1)",
    "specifications": "bulk HMW <= 2.0 %, HCP <= 50 ppm, endotoxin <= 0.10 EU/mg; product moisture <= 2.0 %",
}
SHELF_BIAS = (0.35, 0.1, 0.0, -0.05, -0.05, 0.0, 0.1, 0.3)  # 8 shelves: the top and bottom run warmer


def _mode(
    name: str,
    code: str,
    per_year: float,
    ramp: tuple[float, float],
    shape: float,
    caught: float,
    stop: tuple[float, float],
    component: str,
    comments: tuple[str, ...],
    find: str,
) -> Mode:
    return Mode(name, code, per_year, ramp, shape, caught, stop, component, comments, find)


SEAL = _mode(
    "seal",
    "DT-SEAL",
    1.6,
    (10.0, 35.0),
    1.6,
    0.6,
    (30.0, 0.25),
    "Agitator mechanical seal",
    ("Seal barrier fluid alarm: mechanical seal replaced", "Seal leaking into the vessel: agitator seal changed"),
    "Seal faces worn at the six-monthly maintenance: replaced",
)
WFI = _mode(
    "wfi",
    "DT-WFI",
    3.5,
    (6.0, 20.0),
    1.6,
    0.35,
    (12.0, 0.3),
    "WFI still",
    (
        "Conductivity above 1.3 µS/cm: loop drained, still serviced and loop sanitised",
        "WFI out of specification: still's heat exchanger cleaned, loop sanitised",
    ),
    "Conductivity creeping up at the monthly still service: heat exchanger cleaned",
)
FILTER = _mode(
    "filter",
    "DT-HVAC",
    4.0,
    (8.0, 25.0),
    1.5,
    0.4,
    (7.0, 0.3),
    "AHU final filters",
    (
        "Room pressure below 10 Pa: filling stopped, AHU filters changed",
        "FR-01 pressure cascade lost: final filters replaced",
    ),
    "Final filters loaded at the monthly check: changed",
)
BEARING = _mode(
    "bearing",
    "DT-CEN",
    3.0,
    (15.0, 40.0),
    2.0,
    0.4,
    (16.0, 0.3),
    "Spindle bearings",
    ("Vibration trip at start-up: spindle bearings replaced", "Centrifuge vibration high: bearing set changed"),
    "Spindle bearings noisy at the monthly vibration check: replaced",
)
BED = _mode(
    "bed",
    "DT-COL",
    5.0,
    (8.0, 25.0),
    1.5,
    0.0,
    (20.0, 0.2),
    "CEX column",
    ("Pre-use test failed: CEX column repacked", "Column pressure high and peaks tailing: bed repacked"),
    "",
)
MEMBRANE = _mode(
    "membrane",
    "DT-UF",
    4.0,
    (8.0, 25.0),
    1.5,
    0.0,
    (8.0, 0.25),
    "UF/DF cassettes",
    ("Water flux below the limit after cleaning: cassettes replaced", "TMP limit reached: cassettes changed"),
    "",
)
LEAK = _mode(
    "leak",
    "DT-LYO",
    4.0,
    (10.0, 30.0),
    1.6,
    0.3,
    (16.0, 0.3),
    "Door seal and isolation valve",
    ("Leak test failed: door seal replaced", "Leak rate over 20 µbar·L/s: isolation valve rebuilt"),
    "Door seal worn at the monthly maintenance: replaced",
)
PUMP = _mode(
    "pump",
    "DT-FIL",
    5.0,
    (3.0, 12.0),
    1.6,
    0.3,
    (4.0, 0.3),
    "Dosing pump",
    ("Fill weights low on one needle: dosing pump replaced", "Checkweigher rejects: pump piston worn, changed"),
    "Pump piston worn at the monthly maintenance: changed",
)
MODES = {m.name: m for m in (SEAL, WFI, FILTER, BEARING, BED, MEMBRANE, LEAK, PUMP)}


def _stops(*items: tuple[str, float, float, tuple[str, ...], str, bool]) -> tuple[RandomStop, ...]:
    return tuple(RandomStop(code, h, m, comments, comp, corr) for code, h, m, comments, comp, corr in items)


SEED_STOPS = _stops(
    ("DT-CTL", 900, 50, ("Rocker drive fault", "Controller lost communication"), "Controls", True),
)
BR_STOPS = _stops(
    (
        "DT-CTL",
        160,
        45,
        ("DeltaV controller fault", "Valve position feedback fault", "Load cell fault"),
        "Controls",
        True,
    ),
    ("DT-MAT", 300, 120, ("Media lot not yet released", "Clean steam not available"), "", False),
    ("DT-OTH", 120, 20, ("Waiting for QA walk-down", "Paperwork"), "", False),
)
DSP_STOPS = _stops(
    ("DT-CTL", 250, 40, ("Skid controller fault", "Pump fault", "Valve fault"), "Controls", True),
    ("DT-MAT", 400, 90, ("Buffer lot not released", "Waiting for QA release of the pool"), "", False),
    ("DT-OTH", 150, 15, ("Line clearance", "Restarted"), "", False),
)
STATION_STOPS = _stops(
    ("DT-CTL", 400, 40, ("Controller fault", "Sensor fault"), "Controls", True),
    ("DT-OTH", 150, 12, ("Line clearance", "Restarted"), "", False),
)
FILL_STOPS = _stops(
    (
        "DT-JAM",
        8,
        12,
        ("Vial jam at the infeed star wheel", "Broken vial at the needles: line cleared"),
        "Vial handling",
        True,
    ),
    ("DT-CTL", 200, 40, ("PLC fault", "Servo fault"), "Controls", True),
    ("DT-OTH", 40, 12, ("Line clearance", "Glove port check"), "", False),
)
LYO_STOPS = _stops(
    ("DT-CTL", 1500, 60, ("Refrigeration compressor tripped", "Vacuum pump fault"), "Refrigeration and vacuum", True),
)
CAP_STOPS = _stops(("DT-JAM", 15, 10, ("Cap feed jammed", "Vial fallen at the crimping head"), "Cap feed", True))
AVI_STOPS = _stops(
    ("DT-VIS", 30, 15, ("Camera calibration lost", "False rejects: camera cleaned"), "Cameras", False),
    ("DT-JAM", 20, 8, ("Vial jam at the infeed", "Vial fallen in the carousel"), "Vial handling", True),
)


@dataclass
class Cycle:
    """A Protein A cycle of a batch."""

    id: str
    batch: str
    resin_cycle: int  # the resin's cycle number
    start: float
    load_g_l: float
    step_yield: float  # %
    column_dp: float


@dataclass
class Batch:
    id: str
    reactor: str
    vial: str
    seed_start: float
    planned_inoculation: float
    wb: str = ""
    sb: str = ""
    wb_span: tuple[float, float] = (0.0, 0.0)
    sb_span: tuple[float, float] = (0.0, 0.0)
    transfer_vcd: float = 0.0
    transfer_viability: float = 0.0
    seed_hold_h: float = 0.0
    inoculated: float = 0.0
    ended: float = NO_END  # the culture's end: harvest started, or the batch was lost
    status: str = "in culture"
    lost: str = ""  # its scrap code
    lost_at: float = 0.0
    contaminated_at: float | None = None
    detected_at: float | None = None
    seal_wear: float = 0.0  # the seal's wear when the culture ended
    # The culture, hour by hour from inoculation.
    vcd: array[float] = field(default_factory=lambda: array("d"))
    viability: array[float] = field(default_factory=lambda: array("d"))
    titre_h: array[float] = field(default_factory=lambda: array("d"))
    params: dict[str, float] = field(default_factory=dict)
    # Harvest and purification.
    harvest: tuple[float, float] = (0.0, 0.0)
    harvest_vcd: float = 0.0
    harvest_viability: float = 0.0
    harvest_titre: float = 0.0
    harvest_volume_l: float = 0.0
    harvest_mass_g: float = 0.0
    harvest_delay_h: float = 0.0
    centrate_ntu: float = 0.0
    df_dp: float = 0.0
    hold_h: float = 0.0  # harvest hold before capture
    cycles: list[Cycle] = field(default_factory=list)
    steps: list[tuple[str, str, float, float, str]] = field(default_factory=list)  # step, equipment, start, end, result
    pa_yield: float = 0.0
    vi_ph: float = 0.0
    vi_minutes: float = 0.0
    cex_asymmetry: float = 0.0
    cex_dp: float = 0.0
    bed: float = 0.0
    membrane: float = 0.0
    nwp: float = 0.0
    harvest_hmw: float = 0.0
    # The drug substance lot.
    bulk_id: str = ""
    bulk_end: float = 0.0
    bulk_g: float = 0.0
    bulk_hmw: float = 0.0
    bulk_hcp: float = 0.0
    bulk_endotoxin: float = 0.0
    bulk_conc: float = 0.0
    bulk_tested: float = 0.0
    bulk_status: str = ""  # released or rejected


@dataclass
class FillLot:
    id: str
    batch: Batch
    vials: int
    fill: tuple[float, float]
    lyo: tuple[float, float]
    capped: tuple[float, float]
    inspected: tuple[float, float]
    leak_rate: float
    chamber_pressure: float
    pump: float  # the dosing pump's wear while filling
    worn_head: int
    room: float  # the AHU filters' loading while filling (0 to 1)
    weights: array[float] = field(default_factory=lambda: array("d"))
    product_temp: array[float] = field(default_factory=lambda: array("d"))
    rejects: dict[int, tuple[str, float]] = field(default_factory=dict)  # vial index: code, time
    moisture: float = 0.0
    em_cfu: int = 0
    tested: float = 0.0
    status: str = ""


@dataclass
class Deviation:
    opened: float
    area: str
    asset: str
    lot: str
    category: str
    classification: str  # minor, major or critical
    title: str
    description: str
    root_cause: str
    capa: bool = False
    episode: str = ""
    closed: float = 0.0
    id: str = ""


@dataclass
class Year:
    shifts: list[cal.Shift]
    working: Working
    stations: dict[str, Station]
    batches: list[Batch] = field(default_factory=list)
    lots: list[FillLot] = field(default_factory=list)
    deviations: list[Deviation] = field(default_factory=list)
    lab: list[tuple[float, str, float]] = field(default_factory=list)  # time, tag, value
    media: list[tuple[str, float, float, float, float]] = field(default_factory=list)  # lot, start, end, osmo, pH
    buffers: list[tuple[str, float, float, float]] = field(default_factory=list)  # lot, start, end, conductivity
    resin_changes: list[float] = field(default_factory=list)
    t0: float = 0.0


Write = Callable[[str, str, float, float], None]  # stream, tag, time, value
Planned = list[tuple[float, float, str, str]]


def monthly_pm(shifts: list[cal.Shift], day: int, hours: float, text: str = "Monthly planned maintenance") -> Planned:
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


def every_months(
    shifts: list[cal.Shift], months: tuple[int, ...], day: int, hours: float, code: str, text: str
) -> Planned:
    return [
        (*p[:2], code, text)
        for p in monthly_pm(shifts, day, hours)
        if datetime.fromtimestamp(p[0], ZONE).month in months
    ]


class Plant:
    def __init__(self, write: Write) -> None:
        self.write = write
        self.shifts = cal.shifts()
        self.w = Working(cal.working_intervals(self.shifts))
        self.t0, self.t1 = START.timestamp(), END.timestamp()
        self.rng = random.Random(f"{SEED}/plant")
        self.stations: dict[str, Station] = {}
        self.year = Year(self.shifts, self.w, self.stations, t0=self.t0)
        self.phase: dict[str, str] = {}
        self.current: dict[str, Batch | None] = {}
        self.resin_cycles = 38  # the resin in the column on 1 October
        self.pending: set[str] = set()
        self.room: list[float] = []  # the AHU filters' loading on the grid
        self.fills: list[tuple[float, float]] = []  # filling, for the room's particles
        self.holds: list[tuple[float, float]] = []  # harvest holds in HT-01
        self.freezer: list[float] = []  # freezer door openings
        self.seal_change: set[str] = set()  # a seal change planned at a turnaround

    def station(self, asset: str, **kw: object) -> Station:
        st = Station(asset, self.w, SEED, start=self.t0, end=self.t1, **kw)  # type: ignore[arg-type]
        self.stations[asset] = st
        return st

    def earliest(self, st: Station, ready: float) -> float:
        """When a job that may start at `ready` could start, if nothing stopped it."""
        t = max(ready, st.t)
        i = self.w.index(t)
        return max(t, self.w.intervals[i][0]) if i < len(self.w.intervals) else self.t1

    def deviate(
        self,
        t: float,
        area: str,
        asset: str,
        lot: str,
        category: str,
        cls: str,
        title: str,
        text: str,
        cause: str,
        capa: bool = False,
        episode: str = "",
    ) -> None:
        r = random.Random(f"{SEED}/dev/{t:.0f}/{asset}")
        days = {"minor": (5, 20), "major": (15, 40), "critical": (30, 60)}[cls]
        self.year.deviations.append(
            Deviation(t, area, asset, lot, category, cls, title, text, cause, capa, episode, t + r.uniform(*days) * DAY)
        )

    # ---- utilities: WFI, clean steam, HVAC, cold room ---------------------------------------------

    def utilities(self) -> tuple[Planned, Planned]:
        """The WFI system's and the fill-finish HVAC's year, and the stops they impose: WFI out of
        specification stops media and buffer preparation and the CIP skids; the filling room
        losing its pressure stops filling and capping."""
        r = random.Random(f"{SEED}/utilities")
        wfi = self.station(
            "WFI-01",
            modes=(WFI,),
            planned=monthly_pm(self.shifts, 4, 6, "Monthly WFI still service: heat exchanger, vent filter, sensors"),
        )
        ahu = self.station(
            "AHU-01",
            modes=(FILTER,),
            planned=monthly_pm(self.shifts, 11, 2, "Monthly AHU check: filter pressure drops, belts, dampers")
            + every_months(self.shifts, (3, 9), 12, 8, "PL-FLT", "Six-monthly final filter change"),
            on_planned=self._ahu_planned,
        )
        fr = self.station("FR-01")
        wfi_stops: Planned = []
        hvac_stops: Planned = []
        noise = {"wfi": 0.0, "toc": 0.0, "dp": 0.0, "cr": 0.0}
        t = self.t0
        while t < self.t1:
            for st, stops in ((wfi, wfi_stops), (ahu, hvac_stops)):
                w = self.w.seconds(t)
                ep = next(
                    (
                        e
                        for e in st.episodes
                        if e.failed_at is None and e.resolved_at is None and e.onset <= t and e.severity(w, t) >= 1.0
                    ),
                    None,
                )
                if ep:
                    m = MODES[ep.mode]
                    dur = max(2 * HOUR, st.r_stop.lognormvariate(math.log(m.stop_hours[0] * HOUR), m.stop_hours[1]))
                    ep.failed_at, ep.peak = t, 1.0
                    ep.outcome = (
                        "Failed: WFI out of specification"
                        if st is wfi
                        else "Failed: the filling room lost its pressure"
                    )
                    ep.resolved_at = t + dur
                    text = st.r_stop.choice(m.comments)
                    stops.append((t, t + dur, m.code, text))
                    st.maintenance.append(Maintenance(st.asset, t, t + dur, "CM", m.component, m.code, text, ep.id))
                    if st is wfi:
                        wfi.stops.append(Stop("WFI-01", t, t + dur, m.code, False, text, ep.id))
                        self.deviate(
                            t,
                            "Utilities",
                            "WFI-01",
                            "",
                            "Utilities",
                            "major",
                            "WFI conductivity out of specification",
                            f"WFI loop conductivity went over 1.3 µS/cm. {text}.",
                            "Fouling of the still's heat exchanger raised the distillate's conductivity",
                            capa=True,
                            episode=ep.id,
                        )
                    else:
                        fr.stops.append(Stop("FR-01", t, t + dur, m.code, False, text, ep.id))
                        self.deviate(
                            t,
                            "Fill-finish",
                            "FR-01",
                            "",
                            "Environment",
                            "major",
                            "Filling room pressure cascade lost",
                            f"FR-01's pressure to the corridor fell below 10 Pa. {text}.",
                            "The AHU's final filters loaded up faster than the six-monthly change allows",
                            capa=True,
                            episode=ep.id,
                        )
                while st.pi < len(st.planned) and st.planned[st.pi][0] <= t:
                    a, b, code, text = st.planned[st.pi]
                    st.pi += 1
                    st._planned_job(a, b, code, text)
            s_w = wfi.sev("wfi", t)
            s_a = ahu.sev("filter", t)
            self.room.append(s_a)
            noise["wfi"] = 0.9 * noise["wfi"] + r.gauss(0, 0.006)
            noise["toc"] = 0.9 * noise["toc"] + r.gauss(0, 1.5)
            noise["dp"] = 0.95 * noise["dp"] + r.gauss(0, 0.4)
            self.write("site", "wfi01.conductivity", t, round(0.42 + 1.05 * s_w**1.6 + noise["wfi"], 3))
            self.write("site", "wfi01.toc", t, round(55 + 380 * s_w**2 + noise["toc"], 0))
            self.write("site", "wfi01.loop_temp", t, round(81.5 + r.gauss(0, 0.25), 1))
            self.write("site", "wfi01.return_velocity", t, round(1.4 + r.gauss(0, 0.02), 2))
            self.write("site", "csg01.pressure", t, round(3.1 + r.gauss(0, 0.04), 2))
            self.write("site", "csg01.condensate_conductivity", t, round(0.9 + r.gauss(0, 0.04), 2))
            self.write("site", "ahu01.filter_dp", t, round(175 + 300 * s_a**1.5 + noise["dp"], 0))
            self.write("site", "ahu01.supply_temp", t, round(19.0 + r.gauss(0, 0.15), 1))
            self.write("site", "ahu01.supply_rh", t, round(45 + 6 * seasonal(t, ZONE) + r.gauss(0, 1.0), 1))
            out = any(a <= t < b for a, b, _, _ in hvac_stops[-1:])
            room_dp = 3.0 + r.gauss(0, 0.5) if out else 15.0 - 3.0 * s_a**3 + r.gauss(0, 0.3)
            self.write("site", "fr01.room_dp", t, round(room_dp, 1))
            self.write("site", "fr01.temperature", t, round(20.0 + r.gauss(0, 0.15), 1))
            door = self.w.working(t) and r.random() < 0.04
            noise["cr"] = 0.8 * noise["cr"] + (1.8 if door else 0.0)
            self.write("site", "cr01.temperature", t, round(5.0 + noise["cr"] + r.gauss(0, 0.15), 1))
            t += GRID
        for st in (wfi, ahu):
            for ep in st.episodes:
                if ep.resolved_at is None and ep.failed_at is None:
                    ep.outcome = "Still building up at the end of the year"
        return wfi_stops, hvac_stops

    def _ahu_planned(self, st: Station, code: str, start: float, end: float) -> None:
        if code == "PL-FLT":
            for ep in st.episodes:
                if ep.resolved_at is None and ep.onset <= start:
                    ep.resolved_at, ep.peak = start, ep.severity(self.w.seconds(start), start)
                    ep.outcome = "Cleared by the planned filter change"

    def room_at(self, t: float) -> float:
        return self.room[min(len(self.room) - 1, max(0, int((t - self.t0) // GRID)))]

    # ---- upstream ----------------------------------------------------------------------------------

    def _br_grid(self, st: Station, g: float, mode: str) -> None:
        r = self.rng
        k = st.asset.lower().replace("-", "")
        seal = st.sev("seal", g)
        self.write(k, f"{k}.seal_loss", g, round(max(0.0, 0.6 + 9.0 * seal**1.6 + r.gauss(0, 0.06)), 2))
        b = self.current.get(st.asset)
        if b is not None and b.inoculated <= g < b.ended:
            tau = (g - b.inoculated) / DAY
            h = min(len(b.vcd) - 1, int(tau * 24))
            x, v = b.vcd[h], b.viability[h]
            temp = 36.8 if tau < b.params["shift_day"] else 33.5
            do, ph, o2 = 40.0 + r.gauss(0, 0.8), 7.05 - 0.08 * min(1.0, tau / 8) + r.gauss(0, 0.012), 0.65 * x
            if b.contaminated_at is not None and g >= b.contaminated_at:
                since = (g - b.contaminated_at) / HOUR
                do = max(0.0, 40.0 * math.exp(-since / 3.0) + r.gauss(0, 0.5))
                ph -= min(0.4, 0.04 * since)
                o2 = min(30.0, o2 + 2.5 * since)
            weight = 1500.0 * (1 + 0.022 * max(0.0, min(tau, 14.0) - 3))
            self.write(k, f"{k}.temperature", g, round(temp + r.gauss(0, 0.04), 2))
            self.write(k, f"{k}.ph", g, round(ph, 3))
            self.write(k, f"{k}.do", g, round(do, 1))
            self.write(k, f"{k}.agitation", g, 85.0 if tau < 3 else 110.0)
            self.write(k, f"{k}.air_flow", g, round(15.0 + r.gauss(0, 0.1), 1))
            self.write(k, f"{k}.o2_flow", g, round(max(0.0, o2 + r.gauss(0, 0.15)), 2))
            self.write(k, f"{k}.co2_flow", g, round(0.8 if tau < 2 else 0.1, 2))
            self.write(k, f"{k}.pressure", g, round(50 + r.gauss(0, 1.0), 0))
            self.write(k, f"{k}.weight", g, round(weight + r.gauss(0, 1.5), 0))
            self.write(k, f"{k}.jacket_temp", g, round(temp - 1.2 - 0.06 * x * v / 100 + r.gauss(0, 0.1), 1))
            return
        phase = self.phase.get(st.asset, "") if mode == "run" else ""
        temp, weight, agit, pres = {
            "cip": (75.0, 300.0, 30.0, 0.0),
            "sip": (121.5, 0.0, 0.0, 1100.0),
            "media": (36.8, 1400.0, 85.0, 50.0),
            "harvest": (12.0, 700.0, 40.0, 80.0),
        }.get(phase, (21.0, 0.0, 0.0, 0.0))
        self.write(k, f"{k}.temperature", g, round(temp + r.gauss(0, 0.1), 2))
        self.write(k, f"{k}.agitation", g, agit)
        self.write(k, f"{k}.air_flow", g, 15.0 if phase == "media" else 0.0)
        self.write(k, f"{k}.pressure", g, round(pres + r.gauss(0, 1.0), 0))
        self.write(k, f"{k}.weight", g, round(max(0.0, weight + r.gauss(0, 1.5)), 0))
        self.write(k, f"{k}.jacket_temp", g, round((temp + 2.0 if phase else 18.0) + r.gauss(0, 0.2), 1))
        if phase == "media":  # conditioning: the probes read the medium
            self.write(k, f"{k}.ph", g, round(7.10 + r.gauss(0, 0.01), 3))
            self.write(k, f"{k}.do", g, round(100.0 + r.gauss(0, 0.8), 1))

    def _br_planned(self, st: Station, code: str, start: float, end: float) -> None:
        if code == "PL-PM" and st.asset in self.seal_change:
            self.seal_change.discard(st.asset)
            for ep in st.episodes:
                if ep.mode == "seal" and ep.resolved_at is None and ep.onset <= start:
                    ep.resolved_at, ep.peak = start, ep.severity(self.w.seconds(start), start)
                    ep.outcome = "Found by the turnaround seal check: seal replaced"
                    st.maintenance.append(
                        Maintenance(
                            st.asset,
                            start,
                            end,
                            "INSP",
                            SEAL.component,
                            SEAL.code,
                            "Seal replaced: barrier fluid loss over 3 mL/h at the turnaround check",
                            ep.id,
                        )
                    )

    def _seed_grid(self, st: Station, g: float, mode: str) -> None:
        r = self.rng
        k = st.asset.lower().replace("-", "")
        on = mode == "run"
        self.write(k, f"{k}.temperature", g, round((36.8 if on else 21.0) + r.gauss(0, 0.05), 2))
        if st.asset.startswith("WB"):
            self.write(k, f"{k}.rocking", g, 22.0 if on else 0.0)
        elif on:
            self.write(k, f"{k}.ph", g, round(7.05 + r.gauss(0, 0.015), 3))
            self.write(k, f"{k}.do", g, round(40.0 + r.gauss(0, 1.0), 1))

    def _culture(self, b: Batch, r: random.Random) -> None:
        """The batch's culture, hour by hour for up to 20 days from inoculation."""
        xmax, mu = r.gauss(23.5, 1.4), r.gauss(0.92, 0.04)
        x0 = max(0.3, b.transfer_vcd * 200 / 1500)
        kv, qp1, qp2 = r.gauss(0.55, 0.05), r.gauss(16.0, 1.0), r.gauss(22.0, 1.3)
        b.params = {"xmax": xmax, "mu": mu, "x0": x0, "kv": kv, "qp1": qp1, "qp2": qp2, "shift_day": 5.0}
        titre = 0.0
        x9 = 0.0
        for h in range(20 * 24 + 1):
            tau = h / 24
            if tau <= 9:
                x = xmax / (1 + (xmax / x0 - 1) * math.exp(-mu * tau))
                x9 = x
            else:
                x = x9 * math.exp(-(0.05 + 0.02 * max(0.0, tau - 14)) * (tau - 9))
            v = min(99.0, 98.5 - kv * max(0.0, tau - 7) ** 1.6 - 0.25 * b.seed_hold_h / 24)
            titre += x * (qp1 if tau < 5 else qp2) * 1e-3 / 24 * v / 100
            b.vcd.append(x)
            b.viability.append(v)
            b.titre_h.append(titre)

    def _sample(self, b: Batch, t: float, r: random.Random) -> None:
        """The day's sample: cell count, metabolites and titre, as the analysers give them."""
        k = b.reactor.lower().replace("-", "")
        tau = (t - b.inoculated) / DAY
        h = min(len(b.vcd) - 1, int(tau * 24))
        x, v, titre = b.vcd[h], b.viability[h], b.titre_h[h]
        glucose = 6.0 - 0.4 * tau if tau < 3 else 6.2 - 0.18 * x + 0.6 * math.sin(tau)
        lactate = 2.4 * (tau / 4) * math.exp(1 - tau / 4) + 0.6 * min(1.0, tau / 10)
        if b.contaminated_at is not None and t >= b.contaminated_at:
            since = (t - b.contaminated_at) / HOUR
            x *= max(0.2, 1 - 0.03 * since)
            v = max(5.0, v - 2.5 * since)
            glucose = max(0.0, glucose - 0.25 * since)
            lactate += 0.12 * since
        self.write(f"{k}-unit", f"{k}.vcd", t, round(x * (1 + r.gauss(0, 0.03)), 2))
        self.write(f"{k}-unit", f"{k}.viability", t, round(min(100.0, v + r.gauss(0, 0.6)), 1))
        self.write(f"{k}-unit", f"{k}.glucose", t, round(max(0.1, glucose + r.gauss(0, 0.1)), 2))
        self.write(f"{k}-unit", f"{k}.lactate", t, round(max(0.05, lactate + r.gauss(0, 0.06)), 2))
        if tau >= 3:
            self.write(f"{k}-unit", f"{k}.titre", t, round(titre * (1 + r.gauss(0, 0.03)), 2))
        self.write(f"{k}-unit", f"{k}.pco2", t, round(min(140.0, 38 + 2.0 * x + r.gauss(0, 2)), 0))
        self.write(f"{k}-unit", f"{k}.osmolality", t, round(300 + 6 * min(tau, 14) + r.gauss(0, 3), 0))

    def upstream(self, wfi_stops: Planned) -> None:
        """The year's batches, in time order: each reactor's turnaround, seed train and culture, and
        each harvest with its purification as the culture ends (`downstream`)."""
        r = random.Random(f"{SEED}/upstream")
        ext = list(wfi_stops)
        for a in ("WB-01", "WB-02", "SB-01", "SB-02"):
            self.station(a, random_stops=SEED_STOPS, planned=monthly_pm(self.shifts, 2, 4), grid=self._seed_grid)
        for i in range(1, 5):
            a = f"BR-0{i}"
            self.station(a, random_stops=BR_STOPS, modes=(SEAL,), grid=self._br_grid, on_planned=self._br_planned)
            self.current[a] = None
        self.station("MP-01", random_stops=STATION_STOPS, planned=monthly_pm(self.shifts, 3, 4), external=ext)
        self.station("CIP-01", random_stops=STATION_STOPS, planned=monthly_pm(self.shifts, 5, 4), external=ext)
        self.downstream_stations(ext)
        shut_a, shut_b = cal.SHUTDOWN[0].timestamp(), cal.SHUTDOWN[1].timestamp()
        events: list[tuple[float, int, str, str]] = []  # time, order, kind, reactor
        n_batches = {f"BR-0{i}": 0 for i in range(1, 5)}
        plan_end = {f"BR-0{i}": 0.0 for i in range(1, 5)}
        batches: dict[str, Batch] = {}
        seq = 0
        for i in range(1, 5):  # the first batches' seed trains ran in September
            heapq.heappush(events, (self.t0 + (0.4 + 3.6 * (i - 1)) * DAY, seq, "free", f"BR-0{i}"))
            seq += 1
        while events:
            t, _, kind, reactor = heapq.heappop(events)
            if kind == "free":
                first = n_batches[reactor] == 0
                n_batches[reactor] += 1
                if first:
                    seed_start, inoc = t - 15.5 * DAY, t
                else:
                    seed_start = plan_end[reactor] - 14.5 * DAY
                    inoc = max(t + 1.2 * DAY, seed_start + 15.5 * DAY)
                if inoc + 14.5 * DAY > shut_a and inoc < shut_b:  # no culture over the shutdown
                    idx = int(reactor[-1]) - 1
                    seed_start = shut_b + (1.0 + 3.6 * idx) * DAY
                    inoc = seed_start + 15.5 * DAY
                if inoc >= self.t1 - 2 * DAY:
                    continue
                n = len(self.year.batches) + 1
                yy = datetime.fromtimestamp(inoc, ZONE).strftime("%y")
                b = Batch(f"B{yy}{n:03d}", reactor, f"WCB-17-{(n * 7) % 400 + 1:03d}", seed_start, inoc)
                self.year.batches.append(b)
                batches[b.id] = b
                if not self._start_batch(b, t, first, r):
                    self.year.batches.remove(b)
                    continue
                plan_end[reactor] = b.inoculated + 14.0 * DAY + 0.25 * DAY
                end = self._grow(b, b.inoculated + 14.0 * DAY, r)
                if b.lost:
                    heapq.heappush(events, (end, seq, "free", reactor))
                elif end < self.t1:
                    heapq.heappush(events, (end, seq, f"harvest:{b.id}", reactor))
                seq += 1
            else:
                b = batches[kind.split(":", 1)[1]]
                free = self.harvest(b, t, r)
                if free < self.t1:
                    heapq.heappush(events, (free, seq, "free", reactor))
                    seq += 1
        for a in ("WB-01", "WB-02", "SB-01", "SB-02", "MP-01", "CIP-01"):
            self.stations[a].finish()
        for i in range(1, 5):
            self.stations[f"BR-0{i}"].finish()

    def _start_batch(self, b: Batch, free: float, first: bool, r: random.Random) -> bool:
        """The seed train and the reactor's turnaround; False if the year ends first."""
        br = self.stations[b.reactor]
        if first:
            b.wb, b.sb = ("WB-01", "SB-01") if int(b.reactor[-1]) % 2 else ("WB-02", "SB-02")
            b.wb_span = (b.seed_start + 9 * DAY, b.seed_start + 12 * DAY)
            b.sb_span = (b.seed_start + 12 * DAY, b.inoculated if b.inoculated else b.planned_inoculation)
            b.transfer_vcd, b.transfer_viability = r.gauss(5.2, 0.3), r.gauss(97.0, 0.6)
        else:
            wb = min((self.stations["WB-01"], self.stations["WB-02"]), key=lambda s: s.t)
            ws, we = wb.run(b.seed_start + 9 * DAY, 3 * DAY)
            sb = min((self.stations["SB-01"], self.stations["SB-02"]), key=lambda s: s.t)
            ss, se = sb.run(we, 3.5 * DAY)
            if se >= self.t1:
                b.status = "seed train at the end of the year"
                return False
            b.wb, b.sb, b.wb_span = wb.asset, sb.asset, (ws, we)
            b.transfer_vcd, b.transfer_viability = r.gauss(5.2, 0.3), r.gauss(97.0, 0.6)
            # The reactor: pending maintenance, CIP, SIP and media, ready just before the seed is.
            if len([x for x in self.year.batches if x.reactor == b.reactor]) % 6 == 0:
                at = max(free, br.t)
                bisect.insort(
                    br.planned,
                    (at, at + 36 * HOUR, "PL-PM", "Six-monthly bioreactor maintenance: seal, valves, probes"),
                )
            ready = max(free, se - 1.4 * DAY)
            # The turnaround's seal check (SOP-USP-03): a seal losing over 3 mL/h is changed now, mostly.
            at = self.earliest(br, ready)
            loss = 0.6 + 9.0 * br.sev("seal", at) ** 1.6
            if loss > 3.0 and r.random() < 0.6:
                text = f"Agitator seal replaced at turnaround: barrier fluid loss {loss:.1f} mL/h"
                bisect.insort(br.planned, (at, at + 24 * HOUR, "PL-PM", text))
                self.seal_change.add(b.reactor)
            br_ready, _ = br.run(ready, 0.0)
            mp = self.stations["MP-01"]
            ms, me = mp.run(br_ready - 4 * HOUR, 8 * HOUR)
            osmo, ph = r.gauss(305, 3), r.gauss(7.10, 0.02)
            lot = f"M{b.id[1:]}"
            self.year.media.append((lot, ms, me, osmo, ph))
            self.write("mp01-unit", "mp01.osmolality", me, round(osmo, 0))
            self.write("mp01-unit", "mp01.ph", me, round(ph, 2))
            cs, ce = self.stations["CIP-01"].run(br_ready, 3 * HOUR)
            self.write("cip01-unit", "cip01.final_rinse_conductivity", ce, round(abs(r.gauss(0.9, 0.08)), 2))
            self.phase[b.reactor] = "cip"
            _, e1 = br.run(cs, 3 * HOUR)
            self.phase[b.reactor] = "sip"
            _, e2 = br.run(e1, 2.5 * HOUR)
            self.phase[b.reactor] = "media"
            _, e3 = br.run(max(e2, me), 10 * HOUR)
            if e3 >= self.t1:
                return False
            inoc = max(e3, se)
            b.seed_hold_h = max(0.0, inoc - se) / HOUR
            if inoc > se:  # the N-1 culture is held until the reactor is ready
                sb.advance(inoc, "run")
                sb.run_s += inoc - se
                sb.t = inoc
            br.advance(inoc, "run")
            br.t = inoc
            b.sb_span = (ss, inoc)
            b.inoculated = inoc
            k = sb.asset.lower().replace("-", "")
            self.write(f"{k}-unit", f"{k}.final_vcd", inoc, round(b.transfer_vcd + 0.3 * b.seed_hold_h / 24, 2))
            self.write(f"{k}-unit", f"{k}.final_viability", inoc, round(b.transfer_viability, 1))
        if first:
            b.inoculated = b.planned_inoculation
            br.advance(b.inoculated, "idle")
            br.t = b.inoculated
        self._culture(b, r)
        self.current[b.reactor] = b
        self.phase[b.reactor] = "culture"
        return True

    def _grow(self, b: Batch, until: float, r: random.Random) -> float:
        """The culture up to `until` (or the year's end), hour by hour: the daily sample, the seal's
        wear, a contamination. Returns when it ended, or when the reactor is free again if the batch
        was lost."""
        br = self.stations[b.reactor]
        t = br.t
        end = min(until, self.t1)
        day = datetime.fromtimestamp(t, ZONE).replace(hour=8, minute=0, second=0, microsecond=0)
        samples = [(day + timedelta(days=d)).timestamp() for d in range(25)]
        samples = [s for s in samples if s > b.inoculated + HOUR]
        si = bisect.bisect_right(samples, t)
        while t < end:
            nxt = min(t + HOUR, end)
            w = self.w.seconds(t)
            seal_ep = next(
                (
                    e
                    for e in br.episodes
                    if e.mode == "seal" and e.onset <= t and e.resolved_at is None and e.severity(w, t) >= 1.0
                ),
                None,
            )
            if seal_ep:
                return self._lose(b, t, "BATCH-SEAL", seal_ep, r)
            if b.contaminated_at is None:
                seal = br.sev("seal", t)
                if r.random() < (0.8e-5 + 3.5e-4 * seal**2) * (nxt - t) / HOUR:
                    b.contaminated_at = t + r.random() * (nxt - t)
                    b.detected_at = b.contaminated_at + r.uniform(8, 20) * HOUR
            if b.detected_at is not None and t >= b.detected_at:
                return self._lose(b, t, "BATCH-CONT", None, r)
            while si < len(samples) and samples[si] < nxt:
                br.advance(samples[si], "run")
                self._sample(b, samples[si], r)
                si += 1
            br.advance(nxt, "run")
            t = nxt
        br.t = t
        b.seal_wear = br.sev("seal", t)
        if t >= self.t1:
            b.status = "in culture at the end of the year"
        return t

    def _lose(self, b: Batch, t: float, code: str, ep: Episode | None, r: random.Random) -> float:
        br = self.stations[b.reactor]
        b.ended, b.lost, b.lost_at, b.status = t, code, t, "lost"
        b.seal_wear = br.sev("seal", t)
        self.current[b.reactor] = None
        br.advance(t, "run")
        br.t = t
        if ep is not None:
            m = SEAL
            dur = max(12 * HOUR, br.r_stop.lognormvariate(math.log(m.stop_hours[0] * HOUR), m.stop_hours[1]))
            ep.failed_at, ep.peak = t, 1.0
            ep.outcome = f"Failed during batch {b.id}: the seal leaked and the batch was lost"
            text = br.r_stop.choice(m.comments)
            end = br.breakdown(t, dur, m.code, text, ep, m.component)
            self.deviate(
                t,
                "Upstream",
                b.reactor,
                b.id,
                "Equipment",
                "critical",
                f"Batch {b.id} lost: agitator seal failed",
                f"{b.reactor}'s agitator seal leaked on culture day {(t - b.inoculated) / DAY:.0f}; the"
                " sterile boundary was breached and the batch was terminated.",
                "Wear of the mechanical seal faces; the barrier fluid loss had been rising for days",
                capa=True,
                episode=ep.id,
            )
        else:
            text = "Contamination: culture inactivated, vessel decontaminated and resterilised"
            end = br.breakdown(t, r.uniform(28, 40) * HOUR, "DT-CONT", text, None, "Vessel", corrective=False)
            seal = b.seal_wear
            cause = (
                "A worn agitator seal is the likeliest route: its barrier fluid loss was high"
                if seal > 0.4
                else "No equipment cause found; aseptic technique at sampling under review"
            )
            self.deviate(
                t,
                "Upstream",
                b.reactor,
                b.id,
                "Process",
                "critical",
                f"Batch {b.id} lost: contamination",
                f"Dissolved oxygen fell and the culture's viability crashed on day"
                f" {(t - b.inoculated) / DAY:.0f}; a bacterial contamination was confirmed.",
                cause,
                capa=True,
            )
        br.t = end
        return end

    # ---- harvest and purification --------------------------------------------------------------------

    def downstream_stations(self, ext: Planned) -> None:
        self.station(
            "CF-01",
            random_stops=DSP_STOPS,
            modes=(BEARING,),
            planned=monthly_pm(self.shifts, 6, 6, "Monthly centrifuge maintenance and vibration check"),
        )
        self.station("DF-01", random_stops=STATION_STOPS, planned=monthly_pm(self.shifts, 6, 3))
        self.station("BP-01", random_stops=STATION_STOPS, planned=monthly_pm(self.shifts, 7, 4), external=ext)
        self.station(
            "CS-01",
            random_stops=DSP_STOPS,
            planned=monthly_pm(self.shifts, 8, 6),
            grid=self._cs01_grid,
            on_planned=self._cs01_planned,
        )
        self.station("VT-01", random_stops=STATION_STOPS, planned=monthly_pm(self.shifts, 8, 3))
        self.station(
            "CS-02",
            random_stops=DSP_STOPS,
            modes=(BED,),
            planned=monthly_pm(self.shifts, 9, 6),
            on_planned=self._found_planned,
        )
        self.station("VF-01", random_stops=STATION_STOPS, planned=monthly_pm(self.shifts, 10, 3))
        self.station(
            "UF-01",
            random_stops=DSP_STOPS,
            modes=(MEMBRANE,),
            planned=monthly_pm(self.shifts, 10, 4),
            on_planned=self._found_planned,
        )
        self.station("BF-01", random_stops=STATION_STOPS, planned=monthly_pm(self.shifts, 12, 3))
        self.station("CIP-02", random_stops=STATION_STOPS, planned=monthly_pm(self.shifts, 12, 4), external=ext)

    def _cs01_grid(self, st: Station, g: float, mode: str) -> None:
        self.write("cs01", "cs01.resin_cycles", g, float(self.resin_cycles))

    def _cs01_planned(self, st: Station, code: str, start: float, end: float) -> None:
        if code == "PL-RSN":
            self.resin_cycles = 0
            self.pending.discard("CS-01")
            self.year.resin_changes.append(start)

    def _found_planned(self, st: Station, code: str, start: float, end: float) -> None:
        if code in ("PL-COL", "PL-UF"):
            self.pending.discard(st.asset)
            for ep in st.episodes:
                if ep.resolved_at is None and ep.onset <= start:
                    ep.resolved_at, ep.peak = start, ep.severity(self.w.seconds(start), start)
                    ep.outcome = "Found by the pre-use test: " + (
                        "column repacked" if code == "PL-COL" else "cassettes replaced"
                    )

    def _minutes(
        self, stream: str, start: float, end: float, values: Callable[[float, float], dict[str, float]]
    ) -> None:
        t = math.ceil(start / 60) * 60
        while t < end:
            for tag, v in values(t, (t - start) / 60).items():
                self.write(stream, tag, t, v)
            t += 60

    def harvest(self, b: Batch, at: float, r: random.Random) -> float:
        """The batch's harvest at the end of its culture (when the centrifuge can take it), and its
        purification to a drug substance lot. Returns when its reactor is free."""
        br, cf, df = self.stations[b.reactor], self.stations["CF-01"], self.stations["DF-01"]
        t0 = self.earliest(cf, at)
        bearing = cf.sev("bearing", t0)
        if bearing >= 1.0:  # the start-up trips on vibration
            self._minutes(
                "cf01-run",
                t0,
                t0 + 600,
                lambda t, m: {
                    "cf01.speed": round(min(6500.0, 650 * m) + r.gauss(0, 5), 0),
                    "cf01.vibration": round(1.9 + 6.0 * bearing**1.5 * min(1.0, m / 6) + r.gauss(0, 0.08), 2),
                },
            )
        hs, he = cf.run(at, 6 * HOUR)
        if he >= self.t1:
            b.status = "in culture at the end of the year"
            return self.t1
        b.harvest_delay_h = (hs - at) / HOUR
        if hs > br.t:  # the culture goes on until the centrifuge takes it
            self._grow(b, hs, r)
            if b.lost:
                return br.t
        bearing = cf.sev("bearing", hs)
        h = min(len(b.vcd) - 1, int((hs - b.inoculated) / HOUR))
        b.ended = hs
        b.harvest_vcd, b.harvest_viability, b.harvest_titre = b.vcd[h], b.viability[h], b.titre_h[h]
        tau = (hs - b.inoculated) / DAY
        b.harvest_volume_l = 1500.0 * (1 + 0.022 * (min(tau, 14.0) - 3)) * 0.985
        b.harvest_mass_g = b.harvest_titre * b.harvest_volume_l * r.gauss(0.93, 0.01)
        b.centrate_ntu = 40 + 2.2 * (100 - b.harvest_viability) + abs(r.gauss(0, 4))
        b.df_dp = 0.45 + 0.025 * (100 - b.harvest_viability) + abs(r.gauss(0, 0.03))
        b.harvest_hmw = 2.2 + 0.07 * (100 - b.harvest_viability) + r.gauss(0, 0.15)
        b.harvest = (hs, he)
        b.status = "harvested"
        self.current[b.reactor] = None
        self.phase[b.reactor] = "harvest"
        br.advance(he, "run")
        br.t = he
        self.phase[b.reactor] = ""
        b.seal_wear = br.sev("seal", hs)
        self._minutes(
            "cf01-run",
            hs,
            he,
            lambda t, m: {
                "cf01.speed": round(6500 + r.gauss(0, 8), 0),
                "cf01.vibration": round(1.9 + 6.0 * bearing**1.5 + abs(r.gauss(0, 0.08)), 2),
            },
        )
        self.write("cf01-unit", "cf01.centrate_turbidity", he, round(b.centrate_ntu, 0))
        ds, de = df.run(hs, 6 * HOUR)
        self.write("df01-unit", "df01.max_dp", de, round(b.df_dp, 2))
        b.steps += [
            ("Harvest: centrifugation", "CF-01", hs, he, f"centrate {b.centrate_ntu:.0f} NTU"),
            ("Harvest: depth filtration", "DF-01", ds, de, f"pressure drop {b.df_dp:.2f} bar"),
        ]
        self.purify(b, max(he, de), r)
        return he

    def purify(self, b: Batch, ready: float, r: random.Random) -> None:
        s = self.stations
        bs, be = s["BP-01"].run(ready - 8 * HOUR, 10 * HOUR)
        cond = r.gauss(15.2, 0.3)
        self.year.buffers.append((f"BUF-{b.id[1:]}", bs, be, cond))
        self.write("bp01-unit", "bp01.conductivity", be, round(cond, 1))
        # Protein A capture, in cycles; the resin is replaced when its cycles would pass its life.
        cs1 = s["CS-01"]
        n = max(1, math.ceil(b.harvest_mass_g / (RESIN_L * RESIN_LOAD)))
        if self.resin_cycles + n > RESIN_LIFE and "CS-01" not in self.pending:
            at = self.earliest(cs1, max(ready, be))
            bisect.insort(
                cs1.planned, (at, at + 12 * HOUR, "PL-RSN", f"Protein A resin replaced at {self.resin_cycles} cycles")
            )
            self.pending.add("CS-01")
        a1, e1 = cs1.run(max(ready, be), n * 3.5 * HOUR)
        b.hold_h = (a1 - ready) / HOUR
        self.holds.append((ready, a1))
        load = b.harvest_mass_g / n / RESIN_L
        pool = 0.0
        for c in range(n):
            self.resin_cycles += 1
            rc = self.resin_cycles
            sy = 95.5 - 11 * (rc / RESIN_LIFE) ** 2 + r.gauss(0, 0.6)
            dp = 1.05 + 0.55 * (rc / RESIN_LIFE) ** 1.5 + r.gauss(0, 0.02)
            start = a1 + c * 3.5 * HOUR
            cyc = Cycle(f"{b.id}-PA{c + 1}", b.id, rc, start, load, sy, dp)
            b.cycles.append(cyc)
            pool += b.harvest_mass_g / n * sy / 100
            self._minutes("cs01-run", start, start + 3.5 * HOUR, partial(self._protein_a, dp, r))
            self.write("cs01-unit", "cs01.step_yield", start + 3.5 * HOUR - 60, round(sy, 1))
            self.write("cs01-unit", "cs01.column_dp", start + 100 * 60, round(dp, 2))
            if rc % 25 == 0:
                self.year.lab.append(
                    (start + 2 * DAY, "lab.pa_dbc", round(48 - 14 * (rc / RESIN_LIFE) ** 1.5 + r.gauss(0, 0.8), 1))
                )
        b.pa_yield = 100 * pool / b.harvest_mass_g
        b.steps.append(("Protein A capture", "CS-01", a1, e1, f"{n} cycles, yield {b.pa_yield:.1f} %"))
        # Low-pH viral inactivation
        va, ve = s["VT-01"].run(e1, 3 * HOUR)
        b.vi_ph, b.vi_minutes = r.gauss(3.55, 0.04), r.gauss(92, 5)
        if r.random() < 0.012:
            b.vi_ph = r.uniform(3.72, 3.80)
            self.deviate(
                ve,
                "Downstream",
                "VT-01",
                b.id,
                "Process",
                "major",
                f"Batch {b.id}: inactivation pH high",
                f"The low-pH hold read pH {b.vi_ph:.2f}, above the 3.70 limit.",
                "Acid titrant added by weight from an under-strength lot",
                capa=True,
            )
        self.write("vt01-unit", "vt01.hold_ph", ve, round(b.vi_ph, 2))
        self.write("vt01-unit", "vt01.hold_minutes", ve, round(b.vi_minutes, 0))
        b.steps.append(("Viral inactivation", "VT-01", va, ve, f"pH {b.vi_ph:.2f} for {b.vi_minutes:.0f} min"))
        # Polishing: CEX bind-elute, AEX flow-through; the pre-use test first.
        cs2 = s["CS-02"]
        t0 = self.earliest(cs2, ve)
        bed = cs2.sev("bed", t0)
        asym, cdp = 1.1 + 1.0 * bed**1.4 + r.gauss(0, 0.03), 1.4 + 1.0 * bed**1.5 + r.gauss(0, 0.03)
        self.write("cs02-unit", "cs02.cex_asymmetry", t0, round(asym, 2))
        self.write("cs02-unit", "cs02.cex_dp", t0, round(cdp, 2))
        if asym > 1.6 and bed < 1.0 and r.random() < 0.5 and "CS-02" not in self.pending:
            bisect.insort(cs2.planned, (t0, t0 + 16 * HOUR, "PL-COL", f"CEX column repacked: asymmetry {asym:.2f}"))
            self.pending.add("CS-02")
        a2, e2 = cs2.run(ve, 11 * HOUR)
        bed = cs2.sev("bed", a2)
        if a2 > t0 + HOUR:  # repacked, or waited: tested again before use
            asym, cdp = 1.1 + 1.0 * bed**1.4 + r.gauss(0, 0.03), 1.4 + 1.0 * bed**1.5 + r.gauss(0, 0.03)
            self.write("cs02-unit", "cs02.cex_asymmetry", a2 - 600, round(asym, 2))
            self.write("cs02-unit", "cs02.cex_dp", a2 - 600, round(cdp, 2))
        b.bed, b.cex_asymmetry, b.cex_dp = bed, asym, cdp
        self._minutes("cs02-run", a2, e2, lambda t, m: self._polish(m, cdp, r))
        clearance = 0.70 - 0.45 * bed**1.5 + r.gauss(0, 0.02)
        b.steps.append(("Polishing: CEX and AEX", "CS-02", a2, e2, f"asymmetry {asym:.2f}"))
        # Virus filtration
        fa, fe = s["VF-01"].run(e2, 5 * HOUR)
        decay = r.gauss(25, 4)
        if r.random() < 0.008:
            self.deviate(
                fe,
                "Downstream",
                "VF-01",
                b.id,
                "Equipment",
                "major",
                f"Batch {b.id}: virus filter failed its integrity test",
                "The post-use integrity test failed; the pool was filtered again through a new filter.",
                "Filter damaged at installation",
                capa=True,
            )
            _, fe = s["VF-01"].run(fe, 5 * HOUR)
        self.write("vf01-unit", "vf01.throughput", fe, round(r.gauss(420, 15), 0))
        self.write("vf01-unit", "vf01.flux_decay", fe, round(decay, 1))
        b.steps.append(("Virus filtration", "VF-01", fa, fe, f"flux decay {decay:.0f} %"))
        # UF/DF: the pre-use water flux test first.
        uf = s["UF-01"]
        t0 = self.earliest(uf, fe)
        mem = uf.sev("membrane", t0)
        nwp = 100 * (1 - 0.40 * mem**1.3) + r.gauss(0, 1.5)
        self.write("uf01-unit", "uf01.nwp", t0, round(nwp, 1))
        if nwp < 70 and mem < 1.0 and r.random() < 0.6 and "UF-01" not in self.pending:
            bisect.insort(uf.planned, (t0, t0 + 8 * HOUR, "PL-UF", f"Cassettes replaced: water flux {nwp:.0f} LMH/bar"))
            self.pending.add("UF-01")
        ua, ue = uf.run(fe, 8 * HOUR * (1 + 0.5 * mem))
        mem = uf.sev("membrane", ua)
        if ua > t0 + HOUR:
            nwp = 100 * (1 - 0.40 * mem**1.3) + r.gauss(0, 1.5)
            self.write("uf01-unit", "uf01.nwp", ua - 600, round(nwp, 1))
        b.membrane, b.nwp = mem, nwp
        dur = ue - ua
        self._minutes(
            "uf01-run",
            ua,
            ue,
            lambda t, m: {
                "uf01.tmp": round(1.1 + 1.2 * mem**1.5 + 0.3 * m * 60 / dur + r.gauss(0, 0.02), 2),
                "uf01.permeate_flux": round((55 - 20 * m * 60 / dur) * nwp / 100 + r.gauss(0, 0.5), 1),
            },
        )
        b.steps.append(("UF/DF", "UF-01", ua, ue, f"water flux {nwp:.0f} LMH/bar"))
        # Bulk fill and freezing; the train is cleaned.
        ba, bend = s["BF-01"].run(ue, 3 * HOUR)
        s["CIP-02"].run(bend, 4 * HOUR)
        yields = (b.pa_yield / 100) * 0.98 * r.gauss(0.90, 0.01) * 0.97 * 0.97 * r.gauss(0.97, 0.005) * 0.99
        b.bulk_id, b.bulk_end = f"DS{b.id[1:]}", bend
        b.bulk_g = b.harvest_mass_g * yields
        b.bulk_hmw = max(0.2, b.harvest_hmw * (1 - clearance))
        b.bulk_hcp = max(1.0, 9 + 0.9 * (100 - b.harvest_viability) + 0.12 * b.hold_h + r.gauss(0, 2))
        b.bulk_endotoxin = abs(r.gauss(0.015, 0.006)) + (r.uniform(0.11, 0.3) if r.random() < 0.004 else 0.0)
        b.bulk_conc = r.gauss(100.0, 1.5)
        b.steps.append(
            ("Bulk fill and freeze", "BF-01", ba, bend, f"{b.bulk_g / 1000:.2f} kg at {b.bulk_conc:.1f} g/L")
        )
        self.freezer.append(bend)
        b.bulk_tested = bend + r.uniform(5, 8) * DAY
        for tag, v in (
            ("lab.bulk_hmw", round(b.bulk_hmw, 2)),
            ("lab.bulk_hcp", round(b.bulk_hcp, 1)),
            ("lab.bulk_endotoxin", round(b.bulk_endotoxin, 3)),
            ("lab.bulk_concentration", round(b.bulk_conc, 1)),
        ):
            self.year.lab.append((b.bulk_tested, tag, v))
        bad = [
            what
            for what, out in (
                (f"aggregates {b.bulk_hmw:.2f} %", round(b.bulk_hmw, 2) > 2.0),
                (f"host cell protein {b.bulk_hcp:.0f} ppm", round(b.bulk_hcp, 1) > 50),
                (f"endotoxin {b.bulk_endotoxin:.3f} EU/mg", round(b.bulk_endotoxin, 3) > 0.10),
            )
            if out
        ]
        b.bulk_status = "rejected" if bad else "released"
        b.status = "drug substance " + b.bulk_status
        if bad:
            cause = (
                "The CEX column's bed had compressed: it cleared fewer aggregates"
                if "aggregates" in bad[0]
                else "Low viability at harvest and a long hold before capture"
                if "host" in bad[0]
                else "Endotoxin from a buffer lot"
            )
            self.deviate(
                b.bulk_tested,
                "Quality",
                "BF-01",
                b.bulk_id,
                "Laboratory",
                "major",
                f"Drug substance {b.bulk_id} out of specification",
                f"QC release testing found {', '.join(bad)}. The lot was rejected.",
                cause,
                capa=True,
            )

    def _protein_a(self, dp: float, r: random.Random, t: float, m: float) -> dict[str, float]:
        """A Protein A cycle's minute: equilibrate, load, wash, elute, strip, re-equilibrate."""
        if m < 20:
            uv, cond, flow = 0.02, 15.0, 1200.0
        elif m < 120:
            uv, cond, flow = 1.6 + 0.4 * (m - 20) / 100, 14.5, 1200.0
        elif m < 150:
            uv, cond, flow = 1.6 * math.exp(-(m - 120) / 6), 15.0, 1200.0
        elif m < 170:
            uv, cond, flow = 2.8 * math.exp(-(((m - 158) / 4) ** 2)), 3.0, 600.0
        elif m < 200:
            uv, cond, flow = 0.05, 80.0, 600.0
        else:
            uv, cond, flow = 0.02, 15.0, 1200.0
        return {
            "cs01.pressure": round(0.3 + dp * flow / 1200 + r.gauss(0, 0.01), 2),
            "cs01.uv280": round(max(0.0, uv + r.gauss(0, 0.005)), 3),
            "cs01.conductivity": round(cond + r.gauss(0, 0.1), 1),
            "cs01.flow": round(flow + r.gauss(0, 4), 0),
        }

    def _polish(self, m: float, dp: float, r: random.Random) -> dict[str, float]:
        """A polishing minute: two CEX cycles of 4 hours, then the AEX flow-through."""
        if m < 480:
            c = m % 240
            uv = 1.4 if 20 <= c < 140 else 2.2 * math.exp(-(((c - 175) / 8) ** 2)) + 0.02
            cond = 6.0 if c < 160 else 6.0 + 20 * min(1.0, (c - 160) / 30)
        else:
            uv, cond = 1.1 if m < 640 else 0.02, 7.0
        return {
            "cs02.pressure": round(0.3 + 0.6 * dp + r.gauss(0, 0.01), 2),
            "cs02.uv280": round(max(0.0, uv + r.gauss(0, 0.005)), 3),
            "cs02.conductivity": round(cond + r.gauss(0, 0.1), 1),
        }

    # ---- fill-finish -----------------------------------------------------------------------------------

    def fill_finish(self, hvac_stops: Planned) -> None:
        r = random.Random(f"{SEED}/fill-finish")
        ext = list(hvac_stops)
        fl = self.station(
            "FL-01",
            random_stops=FILL_STOPS,
            modes=(PUMP,),
            external=ext,
            planned=monthly_pm(self.shifts, 14, 8, "Monthly filler maintenance: pumps, needles, checkweigher"),
        )
        ly = self.station(
            "LY-01",
            random_stops=LYO_STOPS,
            modes=(LEAK,),
            planned=monthly_pm(self.shifts, 15, 10, "Monthly lyophiliser maintenance: door seal, valves, vacuum pumps"),
        )
        cp = self.station("CP-01", random_stops=CAP_STOPS, external=ext, planned=monthly_pm(self.shifts, 16, 4))
        avi = self.station("AVI-01", random_stops=AVI_STOPS, planned=monthly_pm(self.shifts, 17, 4))
        lots = sorted((b for b in self.year.batches if b.bulk_status == "released"), key=lambda b: b.bulk_end)
        for b in lots:
            ready = b.bulk_end + 7 * DAY
            if ready >= self.t1:
                continue
            # The pre-cycle leak test, and its repair when it fails.
            t0 = self.earliest(ly, ready)
            leak = ly.sev("leak", t0)
            rate = 4 + 16 * leak**1.5 + r.gauss(0, 0.4)
            self.write("ly01-unit", "ly01.leak_rate", t0, round(rate, 1))
            ly_ready, _ = ly.run(ready, 0.0)
            leak = ly.sev("leak", ly_ready)
            if ly_ready > t0 + HOUR:
                rate = 4 + 16 * leak**1.5 + r.gauss(0, 0.4)
                self.write("ly01-unit", "ly01.leak_rate", ly_ready - 600, round(rate, 1))
            vials = int(b.bulk_g * 0.985 / 1.0)
            t0 = self.earliest(fl, ly_ready)
            pump = fl.sev("pump", t0)
            head = random.Random(f"{SEED}/head/{b.id}").randrange(HEADS)
            if pump >= 1.0:  # the start-up checks find the worn pump
                for i in range(2 * HEADS):
                    hd = i % HEADS
                    w = FILL_G - (0.25 * pump**1.5 if hd == head else 0.0) + r.gauss(0, 0.035 + 0.05 * pump)
                    self.write("fl01-unit", "fl01.fill_weight", t0 + 10 * i, round(w, 3))
            fs, fe = fl.run(ly_ready, vials / 60 * 60 + 1800)
            if fe >= self.t1:
                break
            pump = fl.sev("pump", fs)
            for ep in fl.episodes:  # the pump's piston: one needle
                if ep.mode == "pump" and ep.onset <= fs and ep.resolved_at is None:
                    head = random.Random(ep.id).randrange(HEADS)
            ls, le = ly.run(fs, 62 * HOUR)
            if le >= self.t1:
                break
            leak = ly.sev("leak", ls)
            rate = 4 + 16 * leak**1.5
            pressure = 100 + 2.5 * (rate - 4)
            ca, ce = cp.run(le, 2.5 * HOUR)
            va, ve = avi.run(ce, 3.5 * HOUR)
            if ve >= self.t1:
                break
            lot = FillLot(
                f"DP{b.id[1:]}",
                b,
                vials,
                (fs, fe),
                (ls, le),
                (ca, ce),
                (va, ve),
                rate,
                pressure,
                pump,
                head,
                self.room_at(fs),
            )
            self._vials(lot, r)
            self._lyo_minutes(lot, r)
            self.fills.append((fs, fe))
            self.freezer.append(fs - DAY)
            lot.moisture = 0.85 + 0.02 * (pressure - 100) + r.gauss(0, 0.07)
            lot.em_cfu = sum(1 for _ in range(3) if r.random() < 0.01 + 0.3 * max(0.0, lot.room - 0.6))
            lot.tested = ve + r.uniform(4, 7) * DAY
            self.year.lab.append((lot.tested, "lab.dp_moisture", round(lot.moisture, 2)))
            self.year.lab.append((fe + 3 * DAY, "lab.em_grade_a", float(lot.em_cfu)))
            lot.status = "rejected" if round(lot.moisture, 2) > 2.0 else "released"
            if lot.em_cfu:
                self.deviate(
                    fe + 3 * DAY,
                    "Fill-finish",
                    "FR-01",
                    lot.id,
                    "Environment",
                    "major" if lot.em_cfu > 1 else "minor",
                    f"Grade A settle plate growth during {lot.id}",
                    f"{lot.em_cfu} CFU on the grade A settle plates at the filling needles.",
                    "Filling room pressure low while the AHU's filters were loaded"
                    if lot.room > 0.6
                    else "Operator intervention at the needles",
                    capa=lot.em_cfu > 1,
                )
            if lot.status == "rejected":
                self.deviate(
                    lot.tested,
                    "Quality",
                    "LY-01",
                    lot.id,
                    "Laboratory",
                    "major",
                    f"Drug product {lot.id} out of specification: moisture",
                    f"Residual moisture {lot.moisture:.2f} %, above the 2.0 % limit. The lot was rejected.",
                    "The lyophiliser leaked: its chamber pressure ran high in primary drying",
                    capa=True,
                )
            self.year.lots.append(lot)
        for st in (fl, ly, cp, avi):
            st.finish()

    def _vials(self, lot: FillLot, r: random.Random) -> None:
        fs, fe = lot.fill
        va, ve = lot.inspected
        dt_fill = (fe - fs - 1800) / lot.vials
        dt_avi = (ve - va) / lot.vials
        for i in range(lot.vials):
            head = i % HEADS
            worn = head == lot.worn_head
            w = FILL_G - (0.25 * lot.pump**1.5 if worn else 0.0) + r.gauss(0, 0.035 + (0.05 * lot.pump if worn else 0))
            lot.weights.append(w)
            t = fs + 900 + i * dt_fill
            self.write("fl01-unit", "fl01.fill_weight", t, round(w, 3))
            shelf = i * 8 // lot.vials
            edge = 1 if i % 47 < 6 else 0
            pt = -35.2 + 0.035 * (lot.chamber_pressure - 100) + 1.6 * edge + SHELF_BIAS[shelf] + r.gauss(0, 0.6)
            lot.product_temp.append(pt)
            if not FILL_LOW <= round(w, 3) <= FILL_HIGH:
                lot.rejects[i] = ("FIL-WT", t)
                continue
            at = va + i * dt_avi
            if pt > -32.0 and r.random() < 0.98:
                lot.rejects[i] = ("VIS-CAKE", at)
            elif r.random() < 0.0022 + 0.005 * max(0.0, lot.room - 0.6) / 0.4:
                lot.rejects[i] = ("VIS-PART", at)
            elif r.random() < 0.003:
                lot.rejects[i] = ("VIS-COS", at)
            elif r.random() < 0.0008:
                lot.rejects[i] = ("VIS-CRIMP", at)

    def _lyo_minutes(self, lot: FillLot, r: random.Random) -> None:
        ls, _ = lot.lyo
        p = lot.chamber_pressure
        base = statistics_mean(lot.product_temp) if lot.product_temp else -35.0

        def values(t: float, m: float) -> dict[str, float]:
            if m < 120:  # loading
                shelf, prod, ch, cond = 5.0, 6.0, 1330.0, 20.0
            elif m < 480:  # freezing
                f = min(1.0, (m - 120) / 120)
                shelf = 5 - 50 * f
                prod = shelf + 3 * math.exp(-(m - 120) / 60)
                ch, cond = 1330.0, 20.0 - 95 * max(0.0, (m - 420) / 60)
            elif m < 510:  # evacuation
                shelf, prod, ch, cond = -45.0, -44.0, max(p, 1330 - 41 * (m - 480)), -75.0
            elif m < 2910:  # primary drying
                f = (m - 510) / 2400
                shelf = -45 + 30 * min(1.0, f * 12)
                prod = base if f < 0.85 else base + (shelf - base) * (f - 0.85) / 0.15
                ch, cond = p, -72.0
            elif m < 3630:  # secondary drying
                f = (m - 2910) / 720
                shelf = -15 + 45 * min(1.0, f * 4)
                prod = shelf - 2 * (1 - f)
                ch, cond = 50 + (p - 100) / 2, -72.0
            else:  # stoppering, backfill, unloading
                shelf, prod, ch, cond = 30.0, 28.0, 1330.0, -60.0
            return {
                "ly01.shelf_temp": round(shelf + r.gauss(0, 0.15), 1),
                "ly01.product_temp": round(prod + r.gauss(0, 0.2), 1),
                "ly01.chamber_pressure": round(ch + r.gauss(0, 1.0), 0),
                "ly01.condenser_temp": round(cond + r.gauss(0, 0.3), 1),
            }

        self._minutes("ly01-run", ls, ls + 3720 * 60, values)

    # ---- the rooms, tanks and freezer, and the year's minor deviations -----------------------------------

    def rooms(self) -> None:
        r = random.Random(f"{SEED}/rooms")
        fills = sorted(self.fills)
        holds = sorted(self.holds)
        doors = sorted(self.freezer)
        fi = hi = di = 0
        fz = 0.0
        t = self.t0
        while t < self.t1:
            while fi < len(fills) and fills[fi][1] <= t:
                fi += 1
            filling = fi < len(fills) and fills[fi][0] <= t
            s = self.room_at(t)
            particles = 24000 + 90000 * max(0.0, s - 0.5) if filling else 1800 + 3000 * max(0.0, s - 0.5)
            self.write("fr01-particles", "fr01.particles_05", t, round(particles * math.exp(r.gauss(0, 0.25)), -1))
            while hi < len(holds) and holds[hi][1] <= t:
                hi += 1
            held = hi < len(holds) and holds[hi][0] <= t
            self.write("cold", "ht01.temperature", t, round((4.5 if held else 19.5) + r.gauss(0, 0.2), 1))
            while di < len(doors) and doors[di] <= t:
                di += 1
                fz = 7.0
            fz *= 0.6
            self.write("cold", "fz01.temperature", t, round(-40.0 + fz + r.gauss(0, 0.3), 1))
            t += GRID

    def minor_deviations(self) -> None:
        r = random.Random(f"{SEED}/deviations")
        kinds = (
            (
                "Documentation",
                "Upstream",
                "BR-0{n}",
                "Batch record entry missing a second signature",
                "Operator distracted at a shift handover",
            ),
            (
                "Documentation",
                "Downstream",
                "CS-0{m}",
                "Chromatography step recorded late",
                "Electronic batch record went offline",
            ),
            (
                "Laboratory",
                "QC lab",
                "HPLC-01",
                "Sample tested outside its hold time",
                "Courier delay between buildings",
            ),
            (
                "Material",
                "Downstream",
                "BP-01",
                "Buffer component lot received without its certificate",
                "Supplier's paperwork",
            ),
            ("Process", "Upstream", "BR-0{n}", "Feed added 40 minutes late", "Feed pump calibration overdue"),
            (
                "Environment",
                "Fill-finish",
                "FR-01",
                "Grade B surface sample over its alert level",
                "Cleaning frequency",
            ),
            ("Equipment", "Fill-finish", "FL-01", "Checkweigher calibration found 0.02 g off", "Load cell drift"),
            ("Equipment", "Upstream", "BR-0{n}", "Probe calibration overdue by a day", "Scheduling"),
        )
        t = self.t0
        while True:
            t += r.expovariate(1 / (2.6 * DAY))
            if t >= self.t1:
                break
            if not self.w.working(t):
                continue
            cat, area, asset, title, cause = r.choice(kinds)
            asset = asset.format(n=r.randint(1, 4), m=r.randint(1, 2))
            self.deviate(t, area, asset, "", cat, "minor", title, f"{title}.", cause)

    def run(self) -> Year:
        wfi_stops, hvac_stops = self.utilities()
        self.upstream(wfi_stops)
        for a in ("CF-01", "DF-01", "BP-01", "CS-01", "VT-01", "CS-02", "VF-01", "UF-01", "BF-01", "CIP-02"):
            self.stations[a].finish()
        self.fill_finish(hvac_stops)
        self.rooms()
        self.minor_deviations()
        # The DO probe that drifted (a known gap of the historian) was found at its calibration.
        self.deviate(
            datetime(2026, 2, 23, 10, tzinfo=ZONE).timestamp(),
            "Upstream",
            "BR-02",
            "",
            "Equipment",
            "minor",
            "BR-02 DO probe read high at calibration",
            "At its calibration the DO probe read 6 points above the reference: it had drifted since its"
            " membrane was changed on 2 February.",
            "Membrane fitted without its electrolyte refilled",
        )
        for t, tag, v in sorted(self.year.lab):
            if t < self.t1:  # results of the year's last lots come after it
                self.write("lab", tag, t, v)
        self.year.deviations.sort(key=lambda d: (d.opened, d.asset))
        for i, d in enumerate(self.year.deviations):
            d.id = f"DEV-{datetime.fromtimestamp(d.opened, ZONE):%y}-{i + 1:04d}"
        return self.year


def statistics_mean(values: array[float]) -> float:
    return sum(values) / len(values)


__all__ = ["PROCESS", "Batch", "Cycle", "Deviation", "FillLot", "Plant", "Year"]
