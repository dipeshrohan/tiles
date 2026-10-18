"""The sample plant as its people would describe it: the site, its hierarchy, products, machines,
tags, reason codes, costs and the people who act on warnings. Nothing here is random; the
simulation (simulate.py) runs this plant for a year.

Aldermoor Castings and its Kesselbach plant are made up. The equipment vendors are real makers of
such machines, named as a plant's asset register would name them.
"""

from dataclasses import dataclass, field
from datetime import datetime
from zoneinfo import ZoneInfo

ZONE = ZoneInfo("Europe/Berlin")
START = datetime(2025, 10, 1, tzinfo=ZONE)  # the first day of the year of history
END = datetime(2026, 10, 1, tzinfo=ZONE)  # the day after the last
BASELINE_END = datetime(2026, 4, 1, tzinfo=ZONE)  # six months' baseline, then six months of pilot

ENTERPRISE = "Aldermoor Castings"
SITE = "Kesselbach plant"
LOCATION = "Kesselbach, Germany"
SEED = "aldermoor-kesselbach-2026"


@dataclass(frozen=True)
class Product:
    code: str
    name: str
    alloy: str
    weight_kg: float  # one part
    cavities: int  # parts per shot
    cycle_s: float  # the die's cycle at its set point
    scrap_cost_eur: float  # a scrapped part: metal, energy and the work done on it
    die_temp_c: float  # the die's working temperature (fixed and moving halves alike)
    speed_2nd: float  # second-phase shot speed set point, m/s
    intensification_bar: float  # metal pressure set point


PRODUCTS = (
    Product("TH-410", "Transmission housing TH-410", "AlSi9Cu3(Fe)", 9.8, 1, 112.0, 48.0, 232.0, 4.8, 900.0),
    Product("EM-220", "E-motor housing EM-220", "AlSi10MnMg", 6.1, 1, 94.0, 36.0, 238.0, 4.6, 940.0),
    Product("CV-90", "Gearbox cover CV-90", "AlSi9Cu3(Fe)", 2.7, 2, 76.0, 14.0, 226.0, 4.2, 860.0),
    Product("BR-35", "Mounting bracket BR-35", "AlSi9Cu3(Fe)", 1.2, 2, 58.0, 6.0, 220.0, 3.9, 820.0),
)
PRODUCT = {p.code: p for p in PRODUCTS}


@dataclass(frozen=True)
class Code:
    code: str
    description: str
    category: str  # downtime: hydraulics, shot end, die… ; scrap: the defect
    planned: bool = False


DOWNTIME_CODES = (
    Code("DT-PLG", "Plunger seized or tip damaged", "Shot end"),
    Code("DT-HYD", "Hydraulic fault: accumulator pressure or pressure build-up", "Hydraulics"),
    Code("DT-OIL", "Hydraulic oil over temperature", "Hydraulics"),
    Code("DT-DIE", "Die cleaning: soldering or blocked cooling", "Die"),
    Code("DT-VAC", "Vacuum system fault", "Vacuum"),
    Code("DT-SPR", "Spray robot: nozzles blocked or spray fault", "Spray"),
    Code("DT-FUR", "Holding furnace fault", "Furnace"),
    Code("DT-ROB", "Extraction robot fault", "Automation"),
    Code("DT-TRM", "Trim press fault", "Automation"),
    Code("DT-ELE", "Electrical or control fault", "Electrical"),
    Code("DT-SEN", "Sensor fault", "Electrical"),
    Code("DT-MAT", "No metal: melting or transport delay", "Logistics"),
    Code("DT-OPR", "No operator", "Organisation"),
    Code("DT-QH", "Quality hold", "Quality"),
    Code("DT-OTH", "Other", "Other"),
    Code("PL-PM", "Planned maintenance", "Planned", True),
    Code("PL-TIP", "Planned plunger tip change", "Planned", True),
    Code("PL-DIE", "Die change", "Planned", True),
    Code("PL-TRL", "Trial or sampling run", "Planned", True),
    Code("PL-SHD", "Plant shutdown or holiday", "Planned", True),
)
SCRAP_CODES = (
    Code("POR", "Porosity (X-ray grade 3 or 4)", "Internal"),
    Code("CS", "Cold shut or misrun", "Filling"),
    Code("SOLD", "Soldering", "Die"),
    Code("STK", "Sticking or drag marks", "Die"),
    Code("FL", "Flash", "Die"),
    Code("WU", "Warm-up shot", "Start-up"),
    Code("DIM", "Out of tolerance", "Dimensions"),
    Code("DAM", "Handling damage", "Handling"),
)
CODES = {c.code: c for c in DOWNTIME_CODES + SCRAP_CODES}
PLANNED_CODES = tuple(c.code for c in DOWNTIME_CODES if c.planned)
# The MES called hydraulic faults HYD until it was updated on 1 December 2025 (a known gap: the same
# stops under two codes). The export keeps what the MES wrote.
OLD_CODES = {"DT-HYD": ("HYD", datetime(2025, 12, 1, tzinfo=ZONE))}


@dataclass(frozen=True)
class Cell:
    """A die-casting cell: the die caster and what serves it, controlled by one PLC."""

    number: int
    line: str  # "Line 1" or "Line 2"
    vendor: str
    model: str
    locking_kn: int
    year: int
    dies: tuple[str, ...]  # the products it casts, in turn
    plc_model: str
    protocol: str
    historian: str  # "full": every tag of a pilot cell; "partial": the few an older cell logs
    downtime_cost_eur_h: float  # the contribution lost per hour stopped (controlling's figure)

    @property
    def asset(self) -> str:
        return f"DC-{self.number:02d}"

    @property
    def key(self) -> str:  # the prefix of its tags
        return f"dc{self.number:02d}"


CELLS = (
    Cell(1, "Line 2", "Bühler", "Carat 220", 22_000, 2019, ("TH-410",), "Siemens S7-1500", "OPC UA", "full", 3100.0),
    Cell(2, "Line 2", "Bühler", "Carat 220", 22_000, 2019, ("TH-410",), "Siemens S7-1500", "OPC UA", "full", 3100.0),
    Cell(3, "Line 2", "Bühler", "Carat 160", 16_000, 2021, ("EM-220",), "Siemens S7-1500", "OPC UA", "full", 2700.0),
    Cell(
        4, "Line 2", "Idra", "OL 1600 S", 16_000, 2017, ("EM-220", "CV-90"), "Siemens S7-1500", "OPC UA", "full", 2400.0
    ),
    Cell(5, "Line 1", "Idra", "OL 800", 8_000, 2009, ("BR-35",), "Siemens S7-300", "MQTT", "partial", 900.0),
    Cell(6, "Line 1", "Idra", "OL 800", 8_000, 2010, ("BR-35", "CV-90"), "Siemens S7-300", "MQTT", "partial", 900.0),
)
PILOT = tuple(c for c in CELLS if c.historian == "full")


@dataclass(frozen=True)
class Equipment:
    """Equipment of a cell besides the die caster, or a machine elsewhere in the plant."""

    asset: str
    label: str
    kind: str
    vendor: str
    model: str = ""
    year: int = 0


def cell_equipment(c: Cell) -> tuple[Equipment, ...]:
    n = f"{c.number:02d}"
    furnace = ("StrikoWestofen", "StrikoDos 700") if c.historian == "full" else ("Meltec", "DH 450")
    return (
        Equipment(f"HF-{n}", f"Holding furnace HF-{n}", "holding-furnace", *furnace, c.year),
        Equipment(f"SR-{n}", f"Spray robot SR-{n}", "spray-robot", "Fanuc", "M-20iD", c.year),
        Equipment(f"ER-{n}", f"Extraction robot ER-{n}", "extraction-robot", "Fanuc", "R-2000iC", c.year),
        Equipment(f"TP-{n}", f"Trim press TP-{n}", "trim-press", "Schuler", "TP 250", c.year),
        Equipment(f"VU-{n}", f"Vacuum unit VU-{n}", "vacuum-unit", "Fondarex", "Evacuator", c.year),
    )


MELTING = (
    Equipment("MF-01", "Tower melting furnace MF-01", "melting-furnace", "StrikoWestofen", "StrikoMelter 2000", 2018),
    Equipment("MF-02", "Tower melting furnace MF-02", "melting-furnace", "StrikoWestofen", "StrikoMelter 1500", 2012),
    Equipment("DG-01", "Degassing station DG-01", "degassing", "Foseco", "MDU", 2018),
)
FINISHING = (
    Equipment("SB-01", "Shot blast SB-01", "shot-blast", "Rösler", "RHBE", 2016),
    Equipment("FT-01", "Fettling cell FT-01", "fettling", "Kuka", "KR 210", 2020),
    Equipment("IM-01", "Impregnation plant IM-01", "impregnation", "Maldaner", "VAC 10", 2014),
)
MACHINING = (
    Equipment("CNC-01", "Machining centre CNC-01", "machining-centre", "Heller", "H 5000", 2019),
    Equipment("CNC-02", "Machining centre CNC-02", "machining-centre", "Heller", "H 5000", 2019),
    Equipment("CNC-03", "Machining centre CNC-03", "machining-centre", "Grob", "G550", 2021),
    Equipment("CNC-04", "Machining centre CNC-04", "machining-centre", "Grob", "G550", 2021),
    Equipment("WS-01", "Washer WS-01", "washer", "Dürr", "Ecoclean 81C", 2019),
    Equipment("LT-01", "Leak tester LT-01", "leak-tester", "ATEQ", "F620", 2019),
)
QUALITY = (
    Equipment("XR-01", "X-ray inspection XR-01", "x-ray", "Yxlon", "MU56 TB", 2019),
    Equipment("XR-02", "X-ray inspection XR-02", "x-ray", "Yxlon", "MU56 TB", 2021),
    Equipment("CMM-01", "Coordinate measuring machine CMM-01", "cmm", "Zeiss", "Contura", 2018),
)
UTILITIES = (
    Equipment("CP-01", "Air compressor CP-01", "compressor", "Kaeser", "CSD 125", 2015),
    Equipment("CT-01", "Cooling tower CT-01", "cooling-tower", "Baltimore Aircoil", "VXT", 2011),
)


@dataclass(frozen=True)
class Tag:
    tag: str
    unit: str
    kind: str  # shot: one reading a shot; continuous: every 5 minutes; lab: per sample; event; trace
    description: str
    asset: str  # the machine it belongs to, as the MES names it
    measure: str = ""  # what it measures, for detector templates (T7.02)
    low: float | None = None  # the expected range (data-quality check)
    high: float | None = None
    stuck_after_s: int | None = None
    wear_limit: float | None = None  # a component's wear limit (remaining life, T9.01)
    wear_direction: str | None = None
    event_kind: str | None = None  # downtime or scrap: an MES event stream

    @property
    def rate_hz(self) -> float | None:
        return {"continuous": 1 / 300, "trace": 200.0}.get(self.kind)


def cell_tags(c: Cell) -> tuple[Tag, ...]:
    k, a, n = c.key, c.asset, f"{c.number:02d}"
    events = (
        Tag(f"mes.{k}.downtime", "", "event", f"{a} stops from the MES: the reason code", a, event_kind="downtime"),
        Tag(f"mes.{k}.scrap", "", "event", f"{a} scrapped parts from the MES: the defect code", a, event_kind="scrap"),
    )
    if c.historian == "partial":  # an older cell: two averages over MQTT, and its MES events
        return (
            Tag(f"{k}.cycle_time", "s", "continuous", f"{a} cycle time, 5-minute average", a, "cycle", 40, 200),
            Tag(
                f"{k}.die_temp_fixed",
                "°C",
                "continuous",
                f"{a} fixed die half, 5-minute average",
                a,
                "temperature",
                20,
                300,
                7200,
            ),
            *events,
        )
    return (
        Tag(f"{k}.cycle_time", "s", "shot", f"{a} cycle time", a, "cycle", 40, 400),
        Tag(f"{k}.shot_speed_1st", "m/s", "shot", f"{a} first-phase (slow) shot speed", a, "speed", 0.1, 0.6),
        Tag(f"{k}.shot_speed_2nd", "m/s", "shot", f"{a} second-phase (fast) shot speed", a, "speed", 2.5, 7.0),
        Tag(f"{k}.fill_time", "ms", "shot", f"{a} cavity fill time", a, "time", 20, 200),
        Tag(
            f"{k}.intensification_pressure",
            "bar",
            "shot",
            f"{a} metal pressure at intensification",
            a,
            "pressure",
            500,
            1200,
        ),
        Tag(
            f"{k}.pressure_buildup_time", "ms", "shot", f"{a} intensification pressure build-up time", a, "time", 5, 120
        ),
        Tag(f"{k}.biscuit_length", "mm", "shot", f"{a} biscuit length", a, "length", 5, 80),
        Tag(f"{k}.vacuum_level", "mbar", "shot", f"{a} cavity vacuum at the shot (absolute)", a, "vacuum", 10, 1013),
        Tag(f"{k}.die_temp_fixed", "°C", "shot", f"{a} fixed die half before spraying", a, "temperature", 20, 320),
        Tag(f"{k}.die_temp_moving", "°C", "shot", f"{a} moving die half before spraying", a, "temperature", 20, 320),
        Tag(
            f"{k}.plunger_pressure_1st",
            "bar",
            "shot",
            f"{a} shot cylinder pressure in the slow phase: rises with plunger friction",
            a,
            "friction",
            5,
            80,
            wear_limit=36.0,
            wear_direction="up",
        ),
        Tag(f"{k}.spray_pressure", "bar", "shot", f"{a} spray robot manifold pressure", a, "pressure", 1, 8),
        Tag(
            f"{k}.hydraulic_oil_temp",
            "°C",
            "continuous",
            f"{a} hydraulic oil tank temperature",
            a,
            "temperature",
            10,
            70,
            7200,
        ),
        Tag(
            f"{k}.accumulator_pressure",
            "bar",
            "continuous",
            f"{a} shot accumulator pressure, recharged",
            a,
            "pressure",
            60,
            200,
            7200,
        ),
        Tag(
            f"{k}.cooling_flow_fixed",
            "l/min",
            "continuous",
            f"{a} die cooling flow, fixed half",
            a,
            "flow",
            0,
            80,
            7200,
        ),
        Tag(
            f"{k}.cooling_flow_moving",
            "l/min",
            "continuous",
            f"{a} die cooling flow, moving half",
            a,
            "flow",
            0,
            80,
            7200,
        ),
        Tag(
            f"{k}.tcu_oil_temp",
            "°C",
            "continuous",
            f"{a} thermal control unit oil temperature",
            a,
            "temperature",
            20,
            260,
            7200,
        ),
        Tag(
            f"hf{n}.bath_temp",
            "°C",
            "continuous",
            f"HF-{n} metal bath temperature",
            f"HF-{n}",
            "temperature",
            600,
            760,
            7200,
        ),
        Tag(f"hf{n}.heater_power", "kW", "continuous", f"HF-{n} heater power", f"HF-{n}", "power", 0, 120, 7200),
        *events,
    )


TRACE_TAGS = (
    Tag("dc01.shot.v", "m/s", "trace", "DC-01 plunger velocity through the shot (shot monitoring)", "DC-01", "speed"),
    Tag(
        "dc01.shot.ph", "bar", "trace", "DC-01 shot cylinder (hydraulic) pressure through the shot", "DC-01", "pressure"
    ),
    Tag("dc01.shot.pm", "bar", "trace", "DC-01 metal pressure through the shot", "DC-01", "pressure"),
)
SITE_TAGS = (
    Tag(
        "mf01.melt_temp",
        "°C",
        "continuous",
        "MF-01 melt temperature at tapping",
        "MF-01",
        "temperature",
        650,
        800,
        7200,
    ),
    Tag("mf01.gas_flow", "m³/h", "continuous", "MF-01 natural gas flow", "MF-01", "flow", 0, 400, 7200),
    Tag(
        "lab.hydrogen",
        "ml/100g",
        "lab",
        "Hydrogen in the melt after degassing (density index test, DG-01)",
        "DG-01",
        "content",
        0.03,
        0.40,
    ),
    Tag(
        "ct01.supply_temp", "°C", "continuous", "Cooling water supply temperature", "CT-01", "temperature", 5, 40, 7200
    ),
    Tag("cp01.header_pressure", "bar", "continuous", "Compressed air header pressure", "CP-01", "pressure", 4, 9, 7200),
    Tag("hall.ambient_temp", "°C", "continuous", "Die-casting hall air temperature", "", "temperature", -5, 45, 7200),
)
OTHER_EVENT_ASSETS = ("MF-01", "MF-02", "SB-01", "FT-01", "IM-01", "CNC-01", "CNC-02", "CNC-03", "CNC-04", "LT-01")


def event_tag(asset: str) -> Tag:
    key = asset.lower().replace("-", "")
    return Tag(
        f"mes.{key}.downtime", "", "event", f"{asset} stops from the MES: the reason code", asset, event_kind="downtime"
    )


def all_tags() -> tuple[Tag, ...]:
    return (
        *(t for c in CELLS for t in cell_tags(c)),
        *TRACE_TAGS,
        *SITE_TAGS,
        *(event_tag(a) for a in OTHER_EVENT_ASSETS),
    )


@dataclass(frozen=True)
class Person:
    name: str
    email: str
    role: str  # the Tiles role
    job: str
    shift: str = ""  # A, B, C crews; day work otherwise


PEOPLE = (
    Person("Katrin Vogel", "katrin.vogel@example.com", "admin", "Plant manager (sponsor)"),
    Person("Jonas Brandt", "jonas.brandt@example.com", "engineer", "Process engineer, die casting"),
    Person("Aylin Demir", "aylin.demir@example.com", "engineer", "Maintenance lead"),
    Person("Marek Nowak", "marek.nowak@example.com", "engineer", "Quality lead"),
    Person("Sofia Reiter", "sofia.reiter@example.com", "engineer", "Maintenance technician", "A"),
    Person("Tobias Lang", "tobias.lang@example.com", "engineer", "Maintenance technician", "B"),
    Person("Emre Kaya", "emre.kaya@example.com", "engineer", "Maintenance technician", "C"),
    Person("Lena Hoffmann", "lena.hoffmann@example.com", "viewer", "Shift lead, Line 2", "A"),
    Person("Patrick Schulz", "patrick.schulz@example.com", "viewer", "Shift lead, Line 2", "B"),
    Person("Dariusz Wójcik", "dariusz.wojcik@example.com", "viewer", "Shift lead, Line 2", "C"),
    Person("Nina Becker", "nina.becker@example.com", "admin", "IT and OT lead"),
)


@dataclass(frozen=True)
class Costs:
    """Controlling's figures for 2026: what a stop and a scrapped part cost."""

    downtime_eur_h: dict[str, float] = field(default_factory=dict)
    scrap_eur_part: dict[str, float] = field(default_factory=dict)
    technician_eur_h: float = 68.0
    plunger_tip_eur: float = 420.0
    shot_sleeve_eur: float = 6800.0
    accumulator_recharge_eur: float = 160.0
    vacuum_filter_eur: float = 95.0
    heater_element_eur: float = 1900.0


COSTS = Costs(
    downtime_eur_h={c.asset: c.downtime_cost_eur_h for c in CELLS},
    scrap_eur_part={p.code: p.scrap_cost_eur for p in PRODUCTS},
)


def slug(text: str) -> str:
    return "".join(ch if ch.isalnum() else "-" for ch in text.lower()).strip("-").replace("--", "-")


def ontology() -> tuple[list[dict[str, object]], list[dict[str, str]]]:
    """The plant model in Tiles' terms (docs/data-model.md): nodes and relationships."""
    nodes: list[dict[str, object]] = []
    edges: list[dict[str, str]] = []

    def node(id_: str, type_: str, label: str, **props: object) -> str:
        nodes.append(
            {"id": id_, "type": type_, "label": label, "props": {k: v for k, v in props.items() if v not in ("", None)}}
        )
        return id_

    def edge(a: str, rel: str, b: str) -> None:
        edges.append({"id": f"{a}-{rel}-{b}", "from": a, "rel": rel, "to": b})

    def equipment(e: Equipment, parent: str) -> str:
        n = node(
            e.asset.lower(),
            "Machine",
            e.label,
            vendor=e.vendor,
            model=e.model,
            kind=e.kind,
            asset=e.asset,
            year=e.year or None,
        )
        edge(parent, "contains", n)
        return n

    def signal(t: Tag, plc: str) -> None:
        s = node(f"sig-{slug(t.tag)}", "Signal", t.description, unit=t.unit or None, tag=t.tag, measure=t.measure)
        edge(plc, "emits", s)

    ent = node("aldermoor", "Enterprise", ENTERPRISE)
    site = node("kesselbach", "Site", SITE, location=LOCATION, timezone="Europe/Berlin")
    edge(ent, "contains", site)
    wc = {
        name: node(slug(name), "Workcenter", name)
        for name in ("Melting", "Die casting", "Finishing", "Machining", "Quality lab", "Utilities")
    }
    for w in wc.values():
        edge(site, "contains", w)

    materials = {
        "AlSi9Cu3(Fe)": node("mat-alsi9cu3", "Material", "AlSi9Cu3(Fe) melt", standard="EN AC-46000"),
        "AlSi10MnMg": node("mat-alsi10mnmg", "Material", "AlSi10MnMg melt", standard="EN AC-43500"),
    }
    hpdc = node("proc-hpdc", "Process", "High-pressure die casting")
    for m in materials.values():
        edge(hpdc, "consumes", m)
    melting = node("proc-melting", "Process", "Melting and degassing")
    for m in materials.values():
        edge(melting, "consumes", m)

    for e in MELTING:
        n = equipment(e, wc["Melting"])
        edge(n, "runs", melting)
    plc_melt = node("plc-melting", "PLC", "PLC Melting", protocol="OPC UA", model="Siemens S7-1500")
    edge("mf-01", "controlledBy", plc_melt)
    edge("dg-01", "controlledBy", plc_melt)
    for t in SITE_TAGS:
        if t.asset in ("MF-01", "DG-01"):
            signal(t, plc_melt)

    lines = {name: node(slug(name), "Line", f"Die-casting {name.lower()}") for name in ("Line 1", "Line 2")}
    for ln in lines.values():
        edge(wc["Die casting"], "contains", ln)
    for c in CELLS:
        cell = node(f"cell-{c.key}", "Cell", f"Cell {c.asset}")
        edge(lines[c.line], "contains", cell)
        dc = node(
            c.key[:2] + "-" + c.key[2:],
            "Machine",
            f"{c.asset} die-casting machine",
            vendor=c.vendor,
            model=c.model,
            kind="die-caster",
            asset=c.asset,
            year=c.year,
            locking_force_kn=c.locking_kn,
            products=", ".join(c.dies),
        )
        edge(cell, "contains", dc)
        edge(dc, "runs", hpdc)
        plc = node(f"plc-{c.key}", "PLC", f"PLC {c.asset}", protocol=c.protocol, model=c.plc_model)
        edge(dc, "controlledBy", plc)
        for e in cell_equipment(c):
            m = equipment(e, cell)
            if e.kind in ("holding-furnace", "vacuum-unit"):
                edge(m, "controlledBy", plc)
        edge(f"hf-{c.number:02d}", "feeds", dc)
        edge(dc, "feeds", f"tp-{c.number:02d}")
        for t in cell_tags(c):
            if t.kind != "event":
                signal(t, plc)
        edge("mf-01" if c.line == "Line 2" else "mf-02", "feeds", f"hf-{c.number:02d}")
    for t in TRACE_TAGS:
        signal(t, "plc-dc01")

    fin = node("fettling-line", "Line", "Fettling line")
    edge(wc["Finishing"], "contains", fin)
    for e in FINISHING:
        equipment(e, fin)
    mach = node("machining-line", "Line", "Machining line")
    edge(wc["Machining"], "contains", mach)
    for e in MACHINING:
        equipment(e, mach)
    for e in QUALITY:
        equipment(e, wc["Quality lab"])
    plc_util = node("plc-utilities", "PLC", "PLC Utilities", protocol="Modbus TCP", model="Wago 750")
    for e in UTILITIES:
        edge(equipment(e, wc["Utilities"]), "controlledBy", plc_util)
    for t in SITE_TAGS:
        if t.asset in ("CT-01", "CP-01", ""):
            signal(t, plc_util)
    edge("tp-01", "feeds", "fettling-line")
    edge("fettling-line", "feeds", "machining-line")

    # Two gaps the plant's model has, as real ones do: a spare compressor nobody connected, and a
    # conveyor entered without its vendor.
    node("cp-02", "Machine", "Air compressor CP-02 (spare)", vendor="Kaeser", kind="compressor", asset="CP-02")
    edge(lines["Line 2"], "contains", node("sc-01", "Machine", "Scrap conveyor SC-01", kind="conveyor", asset="SC-01"))

    plunger = node("model-plunger", "Model", "Plunger friction virtual sensor", key="plunger-friction", version="1.0.0")
    for tag in ("dc01.shot.v", "dc01.shot.ph", "dc01.shot.pm"):
        edge(plunger, "reads", f"sig-{slug(tag)}")
    edge(plunger, "monitors", "dc-01")
    return nodes, edges
