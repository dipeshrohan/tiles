"""The battery plant as its people would describe it: Kestrel Energy's Varnhem cell plant, which
makes KX60 prismatic lithium-ion cells (NMC811 cathode, graphite anode, 60 Ah) from slurry to tested
cell. Nothing here is random; the simulation (simulate.py) runs the plant for a year.

Kestrel Energy and its Varnhem plant are made up. The equipment is named by makers of such
machines, as a plant's asset register would name it.
"""

from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

ZONE = ZoneInfo("Europe/Stockholm")
START = datetime(2025, 10, 1, tzinfo=ZONE)
END = datetime(2026, 10, 1, tzinfo=ZONE)

ENTERPRISE = "Kestrel Energy"
SITE = "Varnhem cell plant"
LOCATION = "Varnhem, Sweden"
SEED = "kestrel-varnhem-2026"

# The cell and its electrodes.
CELL = "KX60"
CELL_NAME = "KX60 prismatic cell, 60 Ah, NMC811/graphite"
NOMINAL_AH = 60.0
CATHODE_LOADING = 22.0  # mg/cm², the coating weight's set point
ANODE_LOADING = 12.6
FILL_G = 245.0  # electrolyte, g a cell
COIL_M = 1500  # metres of a jumbo coil
LANES = 4  # daughter rolls a coil is slit into
METRES_A_CELL = 22.0  # of each electrode a cell's stack takes


@dataclass(frozen=True)
class Code:
    code: str
    description: str
    category: str
    planned: bool = False


DOWNTIME_CODES = (
    Code("DT-DIE", "Slot die: lip build-up, die cleaned", "Coating"),
    Code("DT-DRY", "Dryer fault: fan or heater", "Coating"),
    Code("DT-WEB", "Web break", "Web handling"),
    Code("DT-CAL", "Calender fault: roll bearing", "Calendering"),
    Code("DT-BLD", "Slitter blade damaged", "Slitting"),
    Code("DT-DRM", "Dry room out of specification", "Dry room"),
    Code("DT-STK", "Stacker fault: separator tension or alignment", "Stacking"),
    Code("DT-WLD", "Tab welder fault: horn", "Welding"),
    Code("DT-FIL", "Electrolyte filler fault: dosing pump", "Filling"),
    Code("DT-FRM", "Formation rack fault: channel contacts", "Formation"),
    Code("DT-VIS", "Vision system fault", "Automation"),
    Code("DT-ROB", "Handling robot fault", "Automation"),
    Code("DT-ELE", "Electrical or control fault", "Electrical"),
    Code("DT-MAT", "Material missing: foil, separator, electrolyte or electrodes", "Logistics"),
    Code("DT-OPR", "No operator", "Organisation"),
    Code("DT-QH", "Quality hold", "Quality"),
    Code("DT-OTH", "Other", "Other"),
    Code("PL-PM", "Planned maintenance", "Planned", True),
    Code("PL-CLN", "Planned die cleaning", "Planned", True),
    Code("PL-BLD", "Planned blade change", "Planned", True),
    Code("PL-HRN", "Planned horn change", "Planned", True),
    Code("PL-SHD", "Plant shutdown", "Planned", True),
)
SCRAP_CODES = (
    Code("COIL-STREAK", "Coil scrapped: streaks or coating weight out of tolerance", "Coating"),
    Code("COIL-ADH", "Coil scrapped: poor adhesion (peel test)", "Coating"),
    Code("COIL-BURR", "Rolls scrapped: burrs over the limit", "Slitting"),
    Code("STK-OVH", "Stack rejected: electrode overhang out of tolerance", "Stacking"),
    Code("WLD-FAIL", "Weld rejected: low energy or pull test", "Welding"),
    Code("FIL-LOW", "Cell rejected: electrolyte under-filled", "Filling"),
    Code("FRM-FAIL", "Cell failed formation", "Formation"),
    Code("EOL-CAP", "Cell failed end-of-line: capacity", "Test"),
    Code("EOL-DCIR", "Cell failed end-of-line: resistance", "Test"),
    Code("EOL-K", "Cell failed end-of-line: self-discharge (K-value)", "Test"),
)
CODES = {c.code: c for c in DOWNTIME_CODES + SCRAP_CODES}
PLANNED_CODES = tuple(c.code for c in DOWNTIME_CODES if c.planned)
# The MES called die cleaning SLOT until its update on 15 January 2026 (a known gap).
OLD_CODES = {"DT-DIE": ("SLOT", datetime(2026, 1, 15, tzinfo=ZONE))}


@dataclass(frozen=True)
class Machine:
    asset: str
    label: str
    kind: str
    vendor: str
    model: str
    year: int
    area: str  # its line or room
    plc: str  # the controller it is on
    downtime_cost_eur_h: float = 0.0

    @property
    def key(self) -> str:
        return self.asset.lower().replace("-", "")


def _line(side: str, letter: str) -> tuple[Machine, ...]:
    area = f"{side} line"
    plc = f"PLC {side} line"
    return (
        Machine(f"MX-{letter}1", f"{side} mixer MX-{letter}1", "mixer", "Bühler", "ECM 1000", 2022, area, plc, 400.0),
        Machine(
            f"CT-{letter}1",
            f"{side} coater CT-{letter}1",
            "coater",
            "Hirano Tecseed",
            "M-400L",
            2022,
            area,
            plc,
            1800.0,
        ),
        Machine(
            f"CL-{letter}1",
            f"{side} calender CL-{letter}1",
            "calender",
            "Saueressig",
            "GKL 700",
            2022,
            area,
            plc,
            900.0,
        ),
        Machine(
            f"SL-{letter}1", f"{side} slitter SL-{letter}1", "slitter", "Kampf", "Conslitter", 2022, area, plc, 600.0
        ),
        Machine(
            f"VD-{letter}1",
            f"{side} vacuum oven VD-{letter}1",
            "vacuum-oven",
            "Memmert",
            "VO 1000",
            2022,
            area,
            plc,
            200.0,
        ),
    )


CATHODE = _line("Cathode", "C")
ANODE = _line("Anode", "A")
ASSEMBLY = (
    Machine("DR-01", "Dry room DR-01", "dry-room", "Munters", "DryCool", 2022, "Assembly line", "PLC Dry room", 2800.0),
    Machine(
        "DH-01", "Dehumidifier DH-01", "dehumidifier", "Munters", "MX2 3000", 2022, "Assembly line", "PLC Dry room", 0.0
    ),
    Machine(
        "NT-C1",
        "Cathode notcher NT-C1",
        "notcher",
        "Trumpf",
        "TruMicro 7000",
        2022,
        "Assembly line",
        "PLC Assembly",
        500.0,
    ),
    Machine(
        "NT-A1",
        "Anode notcher NT-A1",
        "notcher",
        "Trumpf",
        "TruMicro 7000",
        2022,
        "Assembly line",
        "PLC Assembly",
        500.0,
    ),
    Machine("ST-01", "Stacker ST-01", "stacker", "Manz", "BLS 500", 2022, "Assembly line", "PLC Assembly", 700.0),
    Machine("ST-02", "Stacker ST-02", "stacker", "Manz", "BLS 500", 2023, "Assembly line", "PLC Assembly", 700.0),
    Machine(
        "UW-01",
        "Tab welder UW-01",
        "ultrasonic-welder",
        "Herrmann Ultraschall",
        "HiQ VARIO",
        2022,
        "Assembly line",
        "PLC Assembly",
        1400.0,
    ),
    Machine(
        "EF-01",
        "Electrolyte filler EF-01",
        "electrolyte-filler",
        "Bühler",
        "EFS 200",
        2022,
        "Assembly line",
        "PLC Assembly",
        1400.0,
    ),
)
FORMATION = tuple(
    Machine(
        f"FM-{i:02d}",
        f"Formation rack FM-{i:02d}",
        "formation-rack",
        "Chroma",
        "17208M",
        2022,
        "Formation and aging",
        "PLC Formation",
        150.0,
    )
    for i in range(1, 5)
) + (
    Machine(
        "AG-01", "Aging room AG-01", "aging-room", "Weiss", "WK3", 2022, "Formation and aging", "PLC Formation", 0.0
    ),
    Machine(
        "EOL-01",
        "End-of-line tester EOL-01",
        "eol-tester",
        "Hioki",
        "BT4560 line",
        2022,
        "Formation and aging",
        "PLC Formation",
        300.0,
    ),
)
UTILITIES = (
    Machine(
        "NR-01", "NMP recovery NR-01", "solvent-recovery", "Dürr", "Oxi.X RE", 2022, "Utilities", "PLC Utilities", 0.0
    ),
    Machine("CH-01", "Chiller CH-01", "chiller", "Carrier", "30XW", 2022, "Utilities", "PLC Utilities", 0.0),
    Machine(
        "CP-01", "Air compressor CP-01", "compressor", "Atlas Copco", "ZR 160", 2022, "Utilities", "PLC Utilities", 0.0
    ),
)
QUALITY = (
    Machine(
        "KF-01",
        "Karl Fischer titrator KF-01",
        "lab-instrument",
        "Metrohm",
        "917 Coulometer",
        2022,
        "Quality lab",
        "",
        0.0,
    ),
    Machine("PT-01", "Peel tester PT-01", "lab-instrument", "Zwick", "zwickiLine", 2022, "Quality lab", "", 0.0),
)
MACHINES = CATHODE + ANODE + ASSEMBLY + FORMATION + UTILITIES + QUALITY
BY_ASSET = {m.asset: m for m in MACHINES}


@dataclass(frozen=True)
class Tag:
    tag: str
    unit: str
    kind: (
        str  # run: every minute while running; grid: every 5 minutes; unit: one a cell, coil, roll or batch; lab; event
    )
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


def electrode_tags(side: str, letter: str) -> tuple[Tag, ...]:
    c, cl, sl, vd, mx = (f"{p}{letter.lower()}1" for p in ("ct", "cl", "sl", "vd", "mx"))
    C, CL, SL, VD, MX = (f"{p}-{letter}1" for p in ("CT", "CL", "SL", "VD", "MX"))
    load = CATHODE_LOADING if letter == "C" else ANODE_LOADING
    solvent = "NMP" if letter == "C" else "water"
    return (
        Tag(f"{mx}.viscosity", "mPa·s", "unit", f"{side} slurry viscosity, each batch", MX, "viscosity", 1000, 20000),
        Tag(f"{mx}.solid_content", "%", "unit", f"{side} slurry solid content, each batch", MX, "content", 40, 80),
        Tag(f"{c}.web_speed", "m/min", "run", f"{C} web speed", C, "speed", 0, 40, 1800),
        Tag(
            f"{c}.coating_weight",
            "mg/cm²",
            "run",
            f"{C} coating weight (beta gauge), machine direction",
            C,
            "weight",
            load * 0.8,
            load * 1.2,
            1800,
        ),
        Tag(
            f"{c}.coating_weight_cv",
            "%",
            "run",
            f"{C} coating weight variation across the web (coefficient of variation)",
            C,
            "variation",
            0,
            10,
            1800,
            wear_limit=2.5,
            wear_direction="up",
        ),
        Tag(f"{c}.slot_die_pressure", "bar", "run", f"{C} slot die slurry pressure", C, "pressure", 0, 10, 1800),
        Tag(f"{c}.streaks", "/coil", "unit", f"{C} streaks found by the inline camera, each coil", C, "count", 0, 50),
        Tag(f"{c}.dryer_temp_z1", "°C", "grid", f"{C} dryer zone 1 air temperature", C, "temperature", 20, 180, 3600),
        Tag(f"{c}.dryer_temp_z3", "°C", "grid", f"{C} dryer zone 3 air temperature", C, "temperature", 20, 180, 3600),
        Tag(f"{c}.dryer_temp_z5", "°C", "grid", f"{C} dryer zone 5 air temperature", C, "temperature", 20, 180, 3600),
        Tag(f"{c}.dryer_fan_current", "A", "grid", f"{C} dryer zone 3 fan motor current", C, "current", 0, 40, 3600),
        Tag(
            f"{c}.residual_solvent",
            "ppm",
            "grid",
            f"{C} residual {solvent} after the dryer (NIR)",
            C,
            "content",
            0,
            2000,
            3600,
        ),
        Tag(f"{cl}.roll_force", "kN", "run", f"{CL} roll force", CL, "force", 0, 3000, 1800),
        Tag(
            f"{cl}.thickness",
            "µm",
            "run",
            f"{CL} electrode thickness after calendering (laser)",
            CL,
            "thickness",
            50,
            250,
            1800,
        ),
        Tag(
            f"{cl}.thickness_sd",
            "µm",
            "run",
            f"{CL} thickness variation (standard deviation over a minute)",
            CL,
            "variation",
            0,
            10,
            1800,
        ),
        Tag(f"{cl}.roll_temp", "°C", "grid", f"{CL} roll surface temperature", CL, "temperature", 20, 120, 3600),
        Tag(
            f"{cl}.bearing_vibration",
            "mm/s",
            "grid",
            f"{CL} work roll bearing vibration (velocity, RMS)",
            CL,
            "vibration",
            0,
            20,
            3600,
            wear_limit=7.1,
            wear_direction="up",
        ),
        Tag(
            f"{sl}.burr_height",
            "µm",
            "unit",
            f"{SL} burr height on the slit edge, each daughter roll",
            SL,
            "burr",
            0,
            40,
            wear_limit=12.0,
            wear_direction="up",
        ),
        Tag(
            f"{sl}.blade_km", "km", "grid", f"{SL} metres cut since the last blade change", SL, "counter", 0, 400, 86400
        ),
        Tag(f"{vd}.oven_temp", "°C", "grid", f"{VD} oven temperature", VD, "temperature", 20, 150, 3600),
        Tag(f"{vd}.vacuum", "mbar", "grid", f"{VD} oven pressure", VD, "vacuum", 0, 1013, 3600),
    )


def assembly_tags() -> tuple[Tag, ...]:
    out: list[Tag] = [
        Tag("dr01.dew_point", "°C", "grid", "Dry room DR-01 dew point", "DR-01", "dew point", -70, 0, 3600),
        Tag("dr01.temperature", "°C", "grid", "Dry room DR-01 air temperature", "DR-01", "temperature", 15, 30, 3600),
        Tag(
            "dh01.regen_temp",
            "°C",
            "grid",
            "Dehumidifier DH-01 regeneration air temperature",
            "DH-01",
            "temperature",
            20,
            200,
            3600,
        ),
        Tag(
            "dh01.wheel_dp",
            "Pa",
            "grid",
            "Dehumidifier DH-01 pressure drop over the desiccant wheel",
            "DH-01",
            "pressure",
            0,
            600,
            3600,
            wear_limit=380.0,
            wear_direction="up",
        ),
        Tag("ntc1.laser_power", "W", "grid", "Cathode notcher NT-C1 laser power", "NT-C1", "power", 0, 2000, 3600),
        Tag("nta1.laser_power", "W", "grid", "Anode notcher NT-A1 laser power", "NT-A1", "power", 0, 2000, 3600),
    ]
    for st in ("ST-01", "ST-02"):
        k = st.lower().replace("-", "")
        out += [
            Tag(f"{k}.cycle_time", "s", "unit", f"{st} stacking time, each cell", st, "cycle", 30, 400),
            Tag(
                f"{k}.overhang_dev",
                "mm",
                "unit",
                f"{st} largest anode overhang deviation from nominal, each cell (vision)",
                st,
                "alignment",
                0,
                3,
            ),
            Tag(f"{k}.separator_tension", "N", "unit", f"{st} separator web tension, each cell", st, "tension", 0, 20),
        ]
    out += [
        Tag(
            "uw01.weld_energy",
            "J",
            "unit",
            "Tab welder UW-01 weld energy, each cell",
            "UW-01",
            "energy",
            0,
            1500,
            wear_limit=900.0,
            wear_direction="up",
        ),
        Tag("uw01.weld_time", "ms", "unit", "Tab welder UW-01 weld time, each cell", "UW-01", "time", 0, 1000),
        Tag(
            "ef01.fill_weight",
            "g",
            "unit",
            "Electrolyte filler EF-01 fill weight, each cell",
            "EF-01",
            "weight",
            200,
            280,
        ),
        Tag(
            "ef01.fill_vacuum",
            "mbar",
            "unit",
            "Electrolyte filler EF-01 cell vacuum before filling, each cell",
            "EF-01",
            "vacuum",
            0,
            1013,
        ),
    ]
    for i in range(1, 5):
        k, a = f"fm{i:02d}", f"FM-{i:02d}"
        out += [
            Tag(f"{k}.rack_temp", "°C", "grid", f"{a} cell temperature, rack average", a, "temperature", 15, 60, 3600),
            Tag(
                f"{k}.contact_resistance",
                "mΩ",
                "grid",
                f"{a} channel contact resistance, rack average",
                a,
                "resistance",
                0,
                20,
                3600,
                wear_limit=6.0,
                wear_direction="up",
            ),
        ]
    out += [
        Tag("ag01.room_temp", "°C", "grid", "Aging room AG-01 temperature", "AG-01", "temperature", 15, 35, 3600),
        Tag("eol01.capacity", "Ah", "unit", "End-of-line capacity, each cell", "EOL-01", "capacity", 50, 65),
        Tag(
            "eol01.dcir",
            "mΩ",
            "unit",
            "End-of-line DC internal resistance, each cell",
            "EOL-01",
            "resistance",
            0.3,
            2.0,
        ),
        Tag(
            "eol01.k_value",
            "mV/day",
            "unit",
            "Self-discharge over aging (K-value), each cell",
            "EOL-01",
            "self-discharge",
            0,
            5,
        ),
        Tag(
            "lab.peel_cathode",
            "N/m",
            "lab",
            "Cathode peel strength, a sample each coil (PT-01)",
            "PT-01",
            "adhesion",
            0,
            40,
        ),
        Tag(
            "lab.moisture_electrode",
            "ppm",
            "lab",
            "Electrode moisture after vacuum drying, a sample each roll (KF-01)",
            "KF-01",
            "content",
            0,
            1000,
        ),
        Tag(
            "lab.weld_peel",
            "N",
            "lab",
            "Tab weld pull test, a sample each 500 welds (PT-01)",
            "PT-01",
            "strength",
            0,
            300,
        ),
        Tag("nr01.outlet_nmp", "ppm", "grid", "NMP recovery NR-01 outlet NMP", "NR-01", "content", 0, 200, 3600),
        Tag("ch01.supply_temp", "°C", "grid", "Chilled water supply temperature", "CH-01", "temperature", 2, 20, 3600),
        Tag("cp01.header_pressure", "bar", "grid", "Compressed air header pressure", "CP-01", "pressure", 4, 9, 3600),
    ]
    return tuple(out)


def event_tags() -> tuple[Tag, ...]:
    out = []
    for m in MACHINES:
        if m.kind in ("lab-instrument", "dehumidifier", "aging-room", "chiller", "compressor", "solvent-recovery"):
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
    for a in (
        "CT-C1",
        "CT-A1",
        "SL-C1",
        "SL-A1",
        "ST-01",
        "ST-02",
        "UW-01",
        "EF-01",
        "FM-01",
        "FM-02",
        "FM-03",
        "FM-04",
        "EOL-01",
    ):
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
    return (*electrode_tags("Cathode", "C"), *electrode_tags("Anode", "A"), *assembly_tags(), *event_tags())


@dataclass(frozen=True)
class Person:
    name: str
    email: str
    role: str
    job: str
    crew: str = ""


PEOPLE = (
    Person("Ingrid Lindqvist", "ingrid.lindqvist@example.com", "admin", "Plant manager (sponsor)"),
    Person("Oskar Berg", "oskar.berg@example.com", "engineer", "Process engineer, electrodes"),
    Person("Amina Haddad", "amina.haddad@example.com", "engineer", "Process engineer, assembly and formation"),
    Person("Johan Ek", "johan.ek@example.com", "engineer", "Maintenance lead"),
    Person("Leila Sandberg", "leila.sandberg@example.com", "engineer", "Quality lead"),
    Person("Erik Nyström", "erik.nystrom@example.com", "engineer", "Maintenance technician", "A"),
    Person("Sara Holm", "sara.holm@example.com", "engineer", "Maintenance technician", "B"),
    Person("Mikael Öberg", "mikael.oberg@example.com", "engineer", "Maintenance technician", "C"),
    Person("Hanna Strand", "hanna.strand@example.com", "engineer", "Maintenance technician", "D"),
    Person("Ali Rahimi", "ali.rahimi@example.com", "viewer", "Shift lead", "A"),
    Person("Karin Dahl", "karin.dahl@example.com", "viewer", "Shift lead", "B"),
    Person("Tomas Wik", "tomas.wik@example.com", "viewer", "Shift lead", "C"),
    Person("Nadia Ivanova", "nadia.ivanova@example.com", "viewer", "Shift lead", "D"),
    Person("Petra Lund", "petra.lund@example.com", "admin", "IT and OT lead"),
)
TECHNICIAN = {p.crew: p.name for p in PEOPLE if p.job == "Maintenance technician"}

# Controlling's figures for 2026.
CELL_COST_EUR = 24.0  # a scrapped cell after filling
COIL_COST_EUR_M = {"C": 9.0, "A": 3.0}  # electrode scrapped, a metre of coil
PART_COSTS = {
    "slot die cleaning kit": 180.0,
    "dryer fan bearing set": 1200.0,
    "calender roll bearing": 5400.0,
    "slitter blade set": 2600.0,
    "desiccant wheel regeneration service": 3500.0,
    "stacker dancer and servo": 2100.0,
    "ultrasonic horn": 3800.0,
    "dosing pump rebuild kit": 950.0,
    "formation channel contact set": 420.0,
}
TECHNICIAN_EUR_H = 72.0


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

    ent = node("kestrel", "Enterprise", ENTERPRISE)
    site = node("varnhem", "Site", SITE, location=LOCATION, timezone="Europe/Stockholm")
    edge(ent, "contains", site)
    wc = {
        n: node(slug(n), "Workcenter", n)
        for n in ("Electrodes", "Cell assembly", "Formation and aging", "Quality lab", "Utilities")
    }
    for w in wc.values():
        edge(site, "contains", w)
    places = {
        "Cathode line": node("cathode-line", "Line", "Cathode line"),
        "Anode line": node("anode-line", "Line", "Anode line"),
        "Assembly line": node("assembly-line", "Line", "Assembly line"),
        "Formation and aging": wc["Formation and aging"],
        "Quality lab": wc["Quality lab"],
        "Utilities": wc["Utilities"],
    }
    edge(wc["Electrodes"], "contains", places["Cathode line"])
    edge(wc["Electrodes"], "contains", places["Anode line"])
    edge(wc["Cell assembly"], "contains", places["Assembly line"])
    plcs: dict[str, str] = {}
    for name, protocol, model in (
        ("PLC Cathode line", "OPC UA", "Siemens S7-1500"),
        ("PLC Anode line", "OPC UA", "Siemens S7-1500"),
        ("PLC Dry room", "Modbus TCP", "Munters Climate Controller"),
        ("PLC Assembly", "OPC UA", "Beckhoff CX2040"),
        ("PLC Formation", "OPC UA", "Chroma Formation Manager"),
        ("PLC Utilities", "Modbus TCP", "Wago 750"),
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
        edge(plcs[m.plc] if m.plc else plcs["PLC Formation"], "emits", s)
    # The flow: slurry to coil to roll to stack to tested cell.
    for side in ("C", "A"):
        chain = [
            f"mx-{side.lower()}1",
            f"ct-{side.lower()}1",
            f"cl-{side.lower()}1",
            f"sl-{side.lower()}1",
            f"vd-{side.lower()}1",
            f"nt-{side.lower()}1",
        ]
        for a, b in zip(chain, chain[1:], strict=False):
            edge(a, "feeds", b)
        edge(chain[-1], "feeds", "st-01")
        edge(chain[-1], "feeds", "st-02")
    for st in ("st-01", "st-02"):
        edge(st, "feeds", "uw-01")
    edge("uw-01", "feeds", "ef-01")
    for i in range(1, 5):
        edge("ef-01", "feeds", f"fm-{i:02d}")
        edge(f"fm-{i:02d}", "feeds", "ag-01")
    edge("ag-01", "feeds", "eol-01")
    edge("dh-01", "feeds", "dr-01")
    processes = {
        "coating": node("proc-coating", "Process", "Electrode coating and drying"),
        "calendering": node("proc-calendering", "Process", "Calendering"),
        "assembly": node("proc-assembly", "Process", "Cell assembly: notching, stacking, welding, filling"),
        "formation": node("proc-formation", "Process", "Formation and aging"),
    }
    for a, p in (
        ("ct-c1", "coating"),
        ("ct-a1", "coating"),
        ("cl-c1", "calendering"),
        ("cl-a1", "calendering"),
        ("st-01", "assembly"),
        ("st-02", "assembly"),
        ("fm-01", "formation"),
    ):
        edge(a, "runs", processes[p])
    mats = {
        "nmc": node("mat-nmc811", "Material", "NMC811 cathode active material"),
        "graphite": node("mat-graphite", "Material", "Graphite anode active material"),
        "foil-al": node("mat-al-foil", "Material", "Aluminium foil, 13 µm"),
        "foil-cu": node("mat-cu-foil", "Material", "Copper foil, 6 µm"),
        "separator": node("mat-separator", "Material", "Ceramic-coated PE separator, 12 µm"),
        "electrolyte": node("mat-electrolyte", "Material", "Electrolyte, LiPF6 in carbonates"),
    }
    for m in ("nmc", "graphite", "foil-al", "foil-cu"):
        edge(processes["coating"], "consumes", mats[m])
    for m in ("separator", "electrolyte"):
        edge(processes["assembly"], "consumes", mats[m])
    # A known gap of the model: a spare oven nobody connected.
    node("vd-c2", "Machine", "Vacuum oven VD-C2 (spare)", vendor="Memmert", kind="vacuum-oven", asset="VD-C2")
    return nodes, edges
