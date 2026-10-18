"""The graphene plant as its people would describe it: Sorrel Carbon's Ashcombe film plant, which
grows monolayer graphene on copper foil by roll-to-roll chemical vapour deposition (CVD), transfers
it onto PET and sells it as SG-300 transparent conductive film for touch sensors and transparent
heaters. Nothing here is random; the simulation (simulate.py) runs the plant for a year.

Sorrel Carbon and its Ashcombe plant are made up. The equipment is named by makers of such
machines, as a plant's asset register would name it.
"""

import itertools
from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

ZONE = ZoneInfo("Europe/London")
START = datetime(2025, 10, 1, tzinfo=ZONE)
END = datetime(2026, 10, 1, tzinfo=ZONE)

ENTERPRISE = "Sorrel Carbon"
SITE = "Ashcombe film plant"
LOCATION = "Ashcombe, United Kingdom"
SEED = "sorrel-ashcombe-2026"

# The product and its process.
PRODUCT = "SG-300"
PRODUCT_NAME = "SG-300 monolayer graphene on 125 µm PET, 300 mm wide"
FOIL_M = 300  # metres of copper foil a CVD run grows on
FOIL_UM = 18  # copper foil thickness
FOIL_WIDTH_M = 0.32
GROWTH_SPEED = 0.5  # m/min through the furnace's hot zone
TRANSFER_SPEED = 1.0  # m/min through lamination and etching
INSPECT_SPEED = 3.0  # m/min through inline inspection
POLISH_SPEED = 3.0  # m/min through electropolishing
LANES = 2  # a transferred roll is slit into two 150 mm lanes
LENGTHS = 3  # each lane cut into three 100 m rolls
ROLL_M = FOIL_M // LENGTHS
GROWTH_C = 1035.0  # zone 2's set point
BATH_L = 4000.0  # the etch bath
BATH_CHANGE = 55.0  # g/L of copper: the bath is changed
BATH_PLAN = 45.0  # g/L: the change is planned for the next shift

# A CVD run: load and pump down, heat, grow, cool (hours).
LOAD_H, HEAT_H, COOL_H = 1.5, 1.0, 1.5
GROW_H = FOIL_M / GROWTH_SPEED / 60
RUN_H = LOAD_H + HEAT_H + GROW_H + COOL_H


@dataclass(frozen=True)
class Code:
    code: str
    description: str
    category: str
    planned: bool = False


DOWNTIME_CODES = (
    Code("DT-VAC", "Vacuum leak: tube seals", "CVD"),
    Code("DT-HTR", "Furnace heater fault", "CVD"),
    Code("DT-PMP", "Vacuum pump fault", "CVD"),
    Code("DT-MFC", "Gas flow fault: mass flow controller", "CVD"),
    Code("DT-FOL", "Foil break or wrinkle in the furnace", "CVD"),
    Code("DT-GAS", "Process gas supply alarm", "CVD"),
    Code("DT-EXH", "Exhaust scrubber out: CVD hall stopped", "Exhaust"),
    Code("DT-EPL", "Electropolishing fault: rectifier", "Foil preparation"),
    Code("DT-LAM", "Laminator fault: roll", "Transfer"),
    Code("DT-ETC", "Etchant circulation fault", "Transfer"),
    Code("DT-WEB", "Web break", "Web handling"),
    Code("DT-VIS", "Inspection system fault", "Automation"),
    Code("DT-ELE", "Electrical or control fault", "Electrical"),
    Code("DT-MAT", "Material missing: foil, PET or etchant", "Logistics"),
    Code("DT-OPR", "No operator", "Organisation"),
    Code("DT-QH", "Quality hold", "Quality"),
    Code("DT-OTH", "Other", "Other"),
    Code("PL-PM", "Planned maintenance", "Planned", True),
    Code("PL-BAK", "Planned tube bake-out", "Planned", True),
    Code("PL-BTH", "Planned etch bath change", "Planned", True),
    Code("PL-SHD", "Plant shutdown", "Planned", True),
)
SCRAP_CODES = (
    Code("CVD-WRK", "Run scrapped: foil wrinkled or broken in the furnace", "CVD"),
    Code("CVD-ABT", "Run scrapped: aborted when the CVD hall stopped", "CVD"),
    Code("TL-TEAR", "Film torn at transfer", "Transfer"),
    Code("QC-RS", "Roll rejected: sheet resistance", "Inspection"),
    Code("QC-T", "Roll rejected: transmittance", "Inspection"),
    Code("QC-DEF", "Roll rejected: defects", "Inspection"),
)
CODES = {c.code: c for c in DOWNTIME_CODES + SCRAP_CODES}
PLANNED_CODES = tuple(c.code for c in DOWNTIME_CODES if c.planned)
# The MES called the scrubber's stops SCRB until its update on 2 February 2026 (a known gap).
OLD_CODES = {"DT-EXH": ("SCRB", datetime(2026, 2, 2, tzinfo=ZONE))}


@dataclass(frozen=True)
class Machine:
    asset: str
    label: str
    kind: str
    vendor: str
    model: str
    year: int
    area: str  # its hall or room
    plc: str  # the controller it is on
    downtime_cost_gbp_h: float = 0.0

    @property
    def key(self) -> str:
        return self.asset.lower().replace("-", "")


REACTORS = tuple(f"CVD-{i:02d}" for i in range(1, 5))
TRANSFERS = ("TL-01", "TL-02")

FOIL = (
    Machine(
        "EP-01",
        "Electropolishing line EP-01",
        "electropolishing-line",
        "Atotech",
        "Horizon EP 320",
        2021,
        "Foil preparation",
        "PLC Foil preparation",
        600.0,
    ),
)
CVD = (
    *(
        Machine(
            a,
            f"Roll-to-roll CVD reactor {a}",
            "cvd-reactor",
            "Aixtron",
            "BM Pro R2R",
            2021 if i < 2 else 2023,
            "CVD hall",
            f"PLC {a}",
            1500.0,
        )
        for i, a in enumerate(REACTORS)
    ),
    Machine(
        "SC-01",
        "Exhaust scrubber SC-01",
        "scrubber",
        "Edwards",
        "Atlas TPU",
        2021,
        "CVD hall",
        "PLC Utilities",
        6000.0,
    ),
    Machine(
        "GS-01",
        "Process gas supply GS-01",
        "gas-supply",
        "Linde",
        "GC-4 gas cabinets",
        2021,
        "CVD hall",
        "PLC Utilities",
        0.0,
    ),
)
TRANSFER = (
    *(
        Machine(
            a,
            f"Transfer line {a}",
            "transfer-line",
            "Coatema",
            "TL 320",
            2021 if a == "TL-01" else 2023,
            "Transfer cleanroom",
            f"PLC {a}",
            900.0,
        )
        for a in TRANSFERS
    ),
    Machine(
        "CR-01",
        "Transfer cleanroom CR-01 (ISO 6)",
        "cleanroom",
        "Camfil",
        "ISO 6 cleanroom",
        2021,
        "Transfer cleanroom",
        "PLC Utilities",
        0.0,
    ),
)
FINISHING = (
    Machine(
        "IN-01",
        "Inline inspection IN-01",
        "inspection-line",
        "Suragus",
        "EddyCus inline 320",
        2022,
        "Inspection and finishing",
        "PLC Finishing",
        400.0,
    ),
    Machine(
        "SP-01",
        "Slitter and packer SP-01",
        "slitter",
        "Atlas Converting",
        "Titan SR9",
        2021,
        "Inspection and finishing",
        "PLC Finishing",
        300.0,
    ),
)
UTILITIES = (
    Machine(
        "CH-01", "Process chiller CH-01", "chiller", "Carrier", "30RB 160", 2021, "Utilities", "PLC Utilities", 0.0
    ),
    Machine(
        "DI-01", "DI water plant DI-01", "water-treatment", "Veolia", "Sirion 2000", 2021, "Utilities", "PLC Utilities"
    ),
)
QUALITY = (
    Machine("RM-01", "Raman spectrometer RM-01", "lab-instrument", "Renishaw", "inVia Qontor", 2021, "Quality lab", ""),
    Machine("FP-01", "Four-point probe FP-01", "lab-instrument", "Jandel", "RM3000+", 2021, "Quality lab", ""),
    Machine(
        "AF-01", "Atomic force microscope AF-01", "lab-instrument", "Bruker", "Dimension Icon", 2022, "Quality lab", ""
    ),
)
MACHINES = FOIL + CVD + TRANSFER + FINISHING + UTILITIES + QUALITY
BY_ASSET = {m.asset: m for m in MACHINES}


@dataclass(frozen=True)
class Tag:
    tag: str
    unit: str
    kind: str  # run: every minute while running; grid: every 5 minutes; unit: one a run or roll; lab; event
    description: str
    asset: str
    measure: str = ""
    low: float | None = None
    high: float | None = None
    stuck_after_s: int | None = None
    wear_limit: float | None = None
    wear_direction: str | None = None
    event_kind: str | None = None

    @property
    def rate_hz(self) -> float | None:
        return {"run": 1 / 60, "grid": 1 / 300}.get(self.kind)


def foil_tags() -> tuple[Tag, ...]:
    a = "EP-01"
    return (
        Tag("ep01.current_density", "A/dm²", "run", "EP-01 polishing current density", a, "current", 0, 40, 1800),
        Tag("ep01.line_speed", "m/min", "run", "EP-01 foil speed", a, "speed", 0, 5, 1800),
        Tag("ep01.bath_temp", "°C", "grid", "EP-01 polishing bath temperature", a, "temperature", 10, 60, 3600),
        Tag(
            "ep01.bath_conductivity",
            "mS/cm",
            "grid",
            "EP-01 polishing bath conductivity",
            a,
            "conductivity",
            0,
            500,
            3600,
        ),
        Tag(
            "ep01.current_ripple",
            "%",
            "grid",
            "EP-01 rectifier current ripple",
            a,
            "ripple",
            0,
            20,
            3600,
            wear_limit=6.0,
            wear_direction="up",
        ),
    )


def reactor_tags(a: str) -> tuple[Tag, ...]:
    k = a.lower().replace("-", "")
    return (
        Tag(f"{k}.foil_speed", "m/min", "run", f"{a} foil speed through the hot zone", a, "speed", 0, 2, 1800),
        Tag(f"{k}.foil_tension", "N", "run", f"{a} foil tension at the take-up", a, "tension", 0, 60, 1800),
        Tag(f"{k}.ch4_flow", "sccm", "run", f"{a} methane flow (its mass flow controller)", a, "flow", 0, 100, 1800),
        Tag(f"{k}.h2_flow", "sccm", "run", f"{a} hydrogen flow", a, "flow", 0, 2000, 1800),
        Tag(f"{k}.chamber_pressure", "mbar", "run", f"{a} chamber pressure during growth", a, "pressure", 0, 5, 1800),
        Tag(f"{k}.zone1_temp", "°C", "grid", f"{a} furnace zone 1 temperature", a, "temperature", 0, 1100, 3600),
        Tag(
            f"{k}.zone2_temp",
            "°C",
            "grid",
            f"{a} furnace zone 2 (growth) temperature",
            a,
            "temperature",
            0,
            1100,
            3600,
        ),
        Tag(f"{k}.zone3_temp", "°C", "grid", f"{a} furnace zone 3 temperature", a, "temperature", 0, 1100, 3600),
        Tag(
            f"{k}.heater_power",
            "kW",
            "grid",
            f"{a} zone 2 heater power",
            a,
            "power",
            0,
            40,
            3600,
            wear_limit=27.0,
            wear_direction="up",
        ),
        Tag(
            f"{k}.oxygen",
            "ppm",
            "grid",
            f"{a} oxygen in the chamber exhaust (residual gas analyser)",
            a,
            "content",
            0,
            50,
            3600,
            wear_limit=10.0,
            wear_direction="up",
        ),
        Tag(
            f"{k}.pump_current",
            "A",
            "grid",
            f"{a} dry vacuum pump motor current",
            a,
            "current",
            0,
            25,
            3600,
            wear_limit=13.0,
            wear_direction="up",
        ),
        Tag(
            f"{k}.base_pressure",
            "mbar",
            "unit",
            f"{a} base pressure after pump-down, each run",
            a,
            "vacuum",
            0,
            0.1,
        ),
    )


def transfer_tags(a: str) -> tuple[Tag, ...]:
    k = a.lower().replace("-", "")
    return (
        Tag(f"{k}.line_speed", "m/min", "run", f"{a} web speed", a, "speed", 0, 3, 1800),
        Tag(f"{k}.nip_pressure", "bar", "run", f"{a} laminator nip pressure", a, "pressure", 0, 10, 1800),
        Tag(
            f"{k}.etch_rate", "µm/min", "run", f"{a} copper etch rate (inline thickness gauge)", a, "rate", 0, 10, 1800
        ),
        Tag(
            f"{k}.rinse_conductivity",
            "µS/cm",
            "run",
            f"{a} rinse water conductivity after the etch",
            a,
            "conductivity",
            0,
            200,
            1800,
        ),
        Tag(f"{k}.laminator_temp", "°C", "grid", f"{a} laminator roll temperature", a, "temperature", 15, 160, 3600),
        Tag(
            f"{k}.roll_temp_spread",
            "°C",
            "grid",
            f"{a} laminator roll temperature spread across the width",
            a,
            "variation",
            0,
            20,
            3600,
            wear_limit=6.0,
            wear_direction="up",
        ),
        Tag(f"{k}.etch_temp", "°C", "grid", f"{a} etch bath temperature", a, "temperature", 10, 60, 3600),
        Tag(f"{k}.etch_flow", "L/min", "grid", f"{a} etchant circulation flow", a, "flow", 0, 300, 3600),
        Tag(
            f"{k}.bath_copper",
            "g/L",
            "grid",
            f"{a} copper dissolved in the etch bath",
            a,
            "content",
            0,
            100,
            86400,
            wear_limit=BATH_CHANGE,
            wear_direction="up",
        ),
    )


def other_tags() -> tuple[Tag, ...]:
    return (
        Tag(
            "in01.sheet_resistance",
            "Ω/sq",
            "run",
            "IN-01 sheet resistance (contactless, eddy current), a minute's average",
            "IN-01",
            "resistance",
            0,
            2000,
        ),
        Tag(
            "in01.transmittance",
            "%",
            "run",
            "IN-01 optical transmittance at 550 nm, a minute's average",
            "IN-01",
            "transmittance",
            80,
            100,
        ),
        Tag(
            "in01.defects",
            "/m²",
            "run",
            "IN-01 holes, tears and bubbles found by the camera, a minute's film",
            "IN-01",
            "count",
            0,
            100,
        ),
        Tag(
            "sc01.differential_pressure",
            "mbar",
            "grid",
            "Exhaust scrubber SC-01 pressure drop over the packing",
            "SC-01",
            "pressure",
            0,
            30,
            3600,
            wear_limit=14.0,
            wear_direction="up",
        ),
        Tag("sc01.exhaust_flow", "m³/h", "grid", "Exhaust scrubber SC-01 flow", "SC-01", "flow", 0, 3000, 3600),
        Tag("sc01.scrub_ph", "pH", "grid", "Exhaust scrubber SC-01 scrubbing liquid pH", "SC-01", "ph", 0, 14, 3600),
        Tag("gs01.h2_pressure", "bar", "grid", "Hydrogen supply pressure", "GS-01", "pressure", 0, 12, 3600),
        Tag(
            "cr01.particles",
            "/m³",
            "grid",
            "Cleanroom CR-01 particles of 0.5 µm and over",
            "CR-01",
            "count",
            0,
            100000,
            7200,
        ),
        Tag("cr01.temperature", "°C", "grid", "Cleanroom CR-01 air temperature", "CR-01", "temperature", 15, 30, 3600),
        Tag("ch01.supply_temp", "°C", "grid", "Furnace cooling water supply", "CH-01", "temperature", 5, 30, 3600),
        Tag(
            "di01.conductivity",
            "µS/cm",
            "grid",
            "DI water conductivity at the loop's return",
            "DI-01",
            "conductivity",
            0,
            10,
            3600,
        ),
        Tag(
            "lab.d_g_ratio",
            "1",
            "lab",
            "Raman D/G peak ratio, a sample each run (RM-01): defects in the graphene",
            "RM-01",
            "ratio",
            0,
            2,
        ),
        Tag(
            "lab.2d_g_ratio",
            "1",
            "lab",
            "Raman 2D/G peak ratio, a sample each run (RM-01): above 2 is monolayer",
            "RM-01",
            "ratio",
            0,
            5,
        ),
        Tag(
            "lab.sheet_resistance_4pp",
            "Ω/sq",
            "lab",
            "Four-point probe sheet resistance, a sample each run (FP-01)",
            "FP-01",
            "resistance",
            0,
            2000,
        ),
        Tag(
            "lab.foil_roughness",
            "nm",
            "lab",
            "Copper foil roughness Ra after electropolishing, a sample each foil lot (AF-01)",
            "AF-01",
            "roughness",
            0,
            500,
        ),
    )


def event_tags() -> tuple[Tag, ...]:
    out = []
    for m in MACHINES:
        if m.kind in ("lab-instrument", "gas-supply", "cleanroom", "chiller", "water-treatment"):
            continue
        out.append(
            Tag(
                f"mes.{m.key}.downtime",
                "",
                "event",
                f"{m.asset} stops from the MES: the reason code",
                m.asset,
                event_kind="downtime",
            )
        )
    for a in (*REACTORS, *TRANSFERS, "IN-01"):
        out.append(
            Tag(
                f"mes.{BY_ASSET[a].key}.scrap",
                "",
                "event",
                f"{a} scrap from the MES: the defect code",
                a,
                event_kind="scrap",
            )
        )
    return tuple(out)


def all_tags() -> tuple[Tag, ...]:
    return (
        *foil_tags(),
        *itertools.chain.from_iterable(reactor_tags(a) for a in REACTORS),
        *itertools.chain.from_iterable(transfer_tags(a) for a in TRANSFERS),
        *other_tags(),
        *event_tags(),
    )


@dataclass(frozen=True)
class Person:
    name: str
    email: str
    role: str
    job: str
    crew: str = ""


PEOPLE = (
    Person("Fiona Marsh", "fiona.marsh@example.com", "admin", "Site director (sponsor)"),
    Person("Rajesh Iyer", "rajesh.iyer@example.com", "engineer", "Process engineer, CVD"),
    Person("Chloe Whitfield", "chloe.whitfield@example.com", "engineer", "Process engineer, transfer"),
    Person("Gareth Owen", "gareth.owen@example.com", "engineer", "Maintenance lead"),
    Person("Abena Mensah", "abena.mensah@example.com", "engineer", "Quality lead"),
    Person("Liam Doherty", "liam.doherty@example.com", "engineer", "Maintenance technician", "A"),
    Person("Sophie Clarke", "sophie.clarke@example.com", "engineer", "Maintenance technician", "B"),
    Person("Tomasz Nowak", "tomasz.nowak@example.com", "engineer", "Maintenance technician", "C"),
    Person("Hannah Price", "hannah.price@example.com", "viewer", "Shift lead", "A"),
    Person("Daniel Okafor", "daniel.okafor@example.com", "viewer", "Shift lead", "B"),
    Person("Megan Hughes", "megan.hughes@example.com", "viewer", "Shift lead", "C"),
    Person("Imran Siddiqui", "imran.siddiqui@example.com", "admin", "IT and OT lead"),
)
TECHNICIAN = {p.crew: p.name for p in PEOPLE if p.job == "Maintenance technician"}

# Controlling's figures for 2026.
ROLL_COST_GBP = 420.0  # a finished 100 m roll rejected
RUN_COST_GBP = 2600.0  # a CVD run scrapped: foil, gases and furnace time
PART_COSTS = {
    "quartz tube seal kit": 650.0,
    "zone 2 heating element": 4800.0,
    "dry vacuum pump exchange": 7500.0,
    "mass flow controller recalibration": 450.0,
    "rectifier control board": 2200.0,
    "laminator roll": 3900.0,
    "etch pump impeller": 800.0,
    "scrubber packing cleaning service": 2800.0,
    "etch bath change (etchant)": 1100.0,
}
TECHNICIAN_GBP_H = 58.0


def slug(text: str) -> str:
    return "".join(ch if ch.isalnum() else "-" for ch in text.lower()).strip("-").replace("--", "-")


def ontology() -> tuple[list[dict[str, object]], list[dict[str, str]]]:
    """The plant model in Tiles' terms (docs/data-model.md)."""
    nodes: list[dict[str, object]] = []
    edges: list[dict[str, str]] = []

    def node(id_: str, type_: str, label: str, **props: object) -> str:
        nodes.append(
            {"id": id_, "type": type_, "label": label, "props": {k: v for k, v in props.items() if v not in ("", None)}}
        )
        return id_

    def edge(a: str, rel: str, b: str) -> None:
        edges.append({"id": f"{a}-{rel}-{b}", "from": a, "rel": rel, "to": b})

    ent = node("sorrel", "Enterprise", ENTERPRISE)
    site = node("ashcombe", "Site", SITE, location=LOCATION, timezone="Europe/London")
    edge(ent, "contains", site)
    wc = {n: node(slug(n), "Workcenter", n) for n in ("Growth", "Transfer and finishing", "Quality lab", "Utilities")}
    for w in wc.values():
        edge(site, "contains", w)
    places = {
        "Foil preparation": node("foil-preparation", "Line", "Foil preparation"),
        "CVD hall": node("cvd-hall", "Line", "CVD hall"),
        "Transfer cleanroom": node("transfer-cleanroom", "Line", "Transfer cleanroom"),
        "Inspection and finishing": node("inspection-and-finishing", "Line", "Inspection and finishing"),
        "Quality lab": wc["Quality lab"],
        "Utilities": wc["Utilities"],
    }
    edge(wc["Growth"], "contains", places["Foil preparation"])
    edge(wc["Growth"], "contains", places["CVD hall"])
    edge(wc["Transfer and finishing"], "contains", places["Transfer cleanroom"])
    edge(wc["Transfer and finishing"], "contains", places["Inspection and finishing"])
    plcs: dict[str, str] = {}
    for name, protocol, model in (
        ("PLC Foil preparation", "OPC UA", "Siemens S7-1500"),
        *((f"PLC {a}", "OPC UA", "Beckhoff CX5240") for a in REACTORS),
        *((f"PLC {a}", "OPC UA", "Siemens S7-1500") for a in TRANSFERS),
        ("PLC Finishing", "MQTT", "Suragus inline gateway"),
        ("PLC Utilities", "Modbus TCP", "Schneider M580"),
    ):
        plcs[name] = node(slug(name), "PLC", name, protocol=protocol, model=model)
    for m in MACHINES:
        n = node(
            m.asset.lower(), "Machine", m.label, vendor=m.vendor, model=m.model, kind=m.kind, asset=m.asset, year=m.year
        )
        edge(places[m.area], "contains", n)
        if m.plc:
            edge(n, "controlledBy", plcs[m.plc])
    for t in all_tags():
        if t.kind == "event":
            continue
        m = BY_ASSET[t.asset]
        s = node(f"sig-{slug(t.tag)}", "Signal", t.description, unit=t.unit, tag=t.tag, measure=t.measure)
        edge(plcs[m.plc] if m.plc else plcs["PLC Finishing"], "emits", s)
    # The flow: foil to graphene on copper to film on PET to finished rolls.
    for a in REACTORS:
        edge("ep-01", "feeds", a.lower())
        for b in TRANSFERS:
            edge(a.lower(), "feeds", b.lower())
    for b in TRANSFERS:
        edge(b.lower(), "feeds", "in-01")
    edge("in-01", "feeds", "sp-01")
    for a in REACTORS:
        edge("gs-01", "feeds", a.lower())  # process gases in
        edge(a.lower(), "feeds", "sc-01")  # exhaust out
    processes = {
        "polishing": node("proc-polishing", "Process", "Copper foil electropolishing"),
        "growth": node("proc-growth", "Process", "Graphene growth by CVD"),
        "transfer": node("proc-transfer", "Process", "Transfer: lamination and copper etching"),
        "inspection": node("proc-inspection", "Process", "Inspection, slitting and packing"),
    }
    edge("ep-01", "runs", processes["polishing"])
    for a in REACTORS:
        edge(a.lower(), "runs", processes["growth"])
    for b in TRANSFERS:
        edge(b.lower(), "runs", processes["transfer"])
    edge("in-01", "runs", processes["inspection"])
    mats = {
        "copper": node("mat-copper-foil", "Material", "Copper foil, 18 µm, 320 mm"),
        "methane": node("mat-methane", "Material", "Methane, 5.5"),
        "hydrogen": node("mat-hydrogen", "Material", "Hydrogen, 6.0"),
        "pet": node("mat-pet", "Material", "PET film with adhesive, 125 µm"),
        "etchant": node("mat-etchant", "Material", "Ammonium persulfate etchant"),
    }
    edge(processes["polishing"], "consumes", mats["copper"])
    for mat in ("methane", "hydrogen"):
        edge(processes["growth"], "consumes", mats[mat])
    for mat in ("pet", "etchant"):
        edge(processes["transfer"], "consumes", mats[mat])
    # A known gap of the model: a fifth reactor being commissioned, connected to nothing.
    node(
        "cvd-05", "Machine", "CVD reactor CVD-05 (commissioning)", vendor="Aixtron", kind="cvd-reactor", asset="CVD-05"
    )
    return nodes, edges
