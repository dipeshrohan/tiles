"""The biologics plant as its people would describe it: Brannock Biologics' Carrowmore site, which
makes BRN-217, a humanised IgG1 monoclonal antibody, from a CHO working cell bank to inspected
lyophilised vials: the seed train, four 2,000 L fed-batch bioreactors, harvest, Protein A capture,
low-pH viral inactivation, cation- and anion-exchange polishing, virus filtration, UF/DF and bulk
fill (the drug substance), then aseptic filling, lyophilisation, capping and visual inspection (the
drug product). Nothing here is random; the simulation (simulate.py) runs the site for a year.

Brannock Biologics, its Carrowmore site and BRN-217 are made up. The equipment is named by makers
of such equipment, as a site's asset register would name it.
"""

from dataclasses import dataclass
from datetime import datetime
from zoneinfo import ZoneInfo

ZONE = ZoneInfo("Europe/Dublin")
START = datetime(2025, 10, 1, tzinfo=ZONE)
END = datetime(2026, 10, 1, tzinfo=ZONE)

ENTERPRISE = "Brannock Biologics"
SITE = "Carrowmore biologics site"
LOCATION = "Carrowmore, Ireland"
SEED = "brannock-carrowmore-2026"

PRODUCT = "BRN-217"
PRODUCT_NAME = "BRN-217 for injection, 1,000 mg lyophilised powder in a 20R vial (humanised IgG1)"
WORKING_VOLUME_L = 2000.0
VIAL_MG = 1000.0
BULK_G_L = 100.0  # the drug substance's concentration
FILL_G = 10.30  # target fill weight of a vial (10.0 mL)
FILL_LOW, FILL_HIGH = 10.15, 10.45  # the checkweigher's limits
HEADS = 8  # filling needles
RESIN_L = 80.0  # Protein A column volume
RESIN_LOAD = 35.0  # g of antibody loaded per litre of resin a cycle
RESIN_LIFE = 150  # cycles before the resin is replaced
CULTURE_DAYS = 14.0


@dataclass(frozen=True)
class Code:
    code: str
    description: str
    category: str
    planned: bool = False


DOWNTIME_CODES = (
    Code("DT-SEAL", "Agitator mechanical seal failed", "Bioreactors"),
    Code("DT-CONT", "Contamination: batch aborted, vessel decontaminated", "Bioreactors"),
    Code("DT-CEN", "Centrifuge fault: spindle bearing", "Harvest"),
    Code("DT-COL", "Chromatography column repacked: bed compressed", "Chromatography"),
    Code("DT-UF", "UF/DF cassettes fouled: replaced", "UF/DF"),
    Code("DT-LYO", "Lyophiliser leak test failed: vacuum repaired", "Lyophilisation"),
    Code("DT-FIL", "Filler fault: dosing pump", "Filling"),
    Code("DT-HVAC", "Room pressure lost: HVAC filters loaded", "HVAC"),
    Code("DT-WFI", "WFI out of specification", "Utilities"),
    Code("DT-JAM", "Vial jam or broken vial", "Filling"),
    Code("DT-VIS", "Inspection camera fault", "Inspection"),
    Code("DT-CTL", "Control system fault (DCS or PLC)", "Automation"),
    Code("DT-ELE", "Electrical fault", "Electrical"),
    Code("DT-MAT", "Material missing: media, buffer, resin, vials or stoppers", "Logistics"),
    Code("DT-OPR", "No operator", "Organisation"),
    Code("DT-OTH", "Other", "Other"),
    Code("PL-PM", "Planned maintenance", "Planned", True),
    Code("PL-RSN", "Planned Protein A resin replacement", "Planned", True),
    Code("PL-COL", "Planned column repack", "Planned", True),
    Code("PL-UF", "Planned cassette replacement", "Planned", True),
    Code("PL-BRG", "Planned centrifuge bearing change", "Planned", True),
    Code("PL-FLT", "Planned HVAC filter change", "Planned", True),
    Code("PL-SHD", "Site shutdown", "Planned", True),
)
SCRAP_CODES = (
    Code("BATCH-CONT", "Batch lost: contamination", "Bioreactors"),
    Code("BATCH-SEAL", "Batch lost: agitator seal failed, sterile boundary breached", "Bioreactors"),
    Code("DS-OOS", "Drug substance lot rejected: out of specification", "Quality"),
    Code("FIL-WT", "Vial rejected by the checkweigher: fill weight", "Filling"),
    Code("VIS-CAKE", "Vial rejected at inspection: collapsed cake", "Inspection"),
    Code("VIS-PART", "Vial rejected at inspection: particles", "Inspection"),
    Code("VIS-COS", "Vial rejected at inspection: cosmetic defect", "Inspection"),
    Code("VIS-CRIMP", "Vial rejected at inspection: crimp defect", "Inspection"),
    Code("LOT-MOIST", "Drug product lot rejected: residual moisture", "Quality"),
)
CODES = {c.code: c for c in DOWNTIME_CODES + SCRAP_CODES}
PLANNED_CODES = tuple(c.code for c in DOWNTIME_CODES if c.planned)
# The MES called the lyophiliser's leak failures LYO until its update on 19 January 2026 (a known gap).
OLD_CODES = {"DT-LYO": ("LYO", datetime(2026, 1, 19, tzinfo=ZONE))}


@dataclass(frozen=True)
class Machine:
    asset: str
    label: str
    kind: str
    vendor: str
    model: str
    year: int
    area: str  # its line or room
    plc: str  # the control system it is on
    downtime_cost_eur_h: float = 0.0

    @property
    def key(self) -> str:
        return self.asset.lower().replace("-", "")


def _m(
    asset: str, label: str, kind: str, vendor: str, model: str, year: int, area: str, plc: str, cost: float = 0.0
) -> Machine:
    return Machine(asset, label, kind, vendor, model, year, area, plc, cost)


UP = "DCS Upstream"
DOWN = "DCS Downstream"
FF = "PLC Fill-finish"
SEED_TRAIN = (
    _m("IN-01", "Shake flask incubator IN-01", "incubator", "Kuhner", "ISF4-X", 2019, "Seed train", UP),
    _m(
        "WB-01",
        "Rocking bioreactor WB-01, 50 L",
        "rocking-bioreactor",
        "Sartorius",
        "BIOSTAT RM 50",
        2019,
        "Seed train",
        UP,
        150.0,
    ),
    _m(
        "WB-02",
        "Rocking bioreactor WB-02, 50 L",
        "rocking-bioreactor",
        "Sartorius",
        "BIOSTAT RM 50",
        2019,
        "Seed train",
        UP,
        150.0,
    ),
    _m(
        "SB-01",
        "N-1 bioreactor SB-01, 500 L",
        "single-use-bioreactor",
        "Thermo Fisher",
        "HyPerforma S.U.B. 500",
        2019,
        "Seed train",
        UP,
        400.0,
    ),
    _m(
        "SB-02",
        "N-1 bioreactor SB-02, 500 L",
        "single-use-bioreactor",
        "Thermo Fisher",
        "HyPerforma S.U.B. 500",
        2020,
        "Seed train",
        UP,
        400.0,
    ),
)
BIOREACTORS = tuple(
    _m(
        f"BR-0{i}",
        f"Production bioreactor BR-0{i}, 2,000 L",
        "bioreactor",
        "Pierre Guérin",
        "Biostar 2000",
        2019,
        "Production bioreactors",
        UP,
        2500.0,
    )
    for i in range(1, 5)
)
UPSTREAM_SUPPORT = (
    _m(
        "MP-01",
        "Media preparation MP-01",
        "mixer",
        "Merck Millipore",
        "Mobius MIX 3000",
        2019,
        "Production bioreactors",
        UP,
        300.0,
    ),
    _m(
        "CIP-01",
        "CIP skid CIP-01 (upstream)",
        "cip-skid",
        "GEA",
        "CIP Hygienic 3",
        2019,
        "Production bioreactors",
        UP,
        600.0,
    ),
)
PURIFICATION = (
    _m(
        "CF-01",
        "Harvest centrifuge CF-01",
        "centrifuge",
        "Alfa Laval",
        "BTPX 205",
        2019,
        "Purification train",
        DOWN,
        1200.0,
    ),
    _m(
        "DF-01",
        "Depth filtration DF-01",
        "depth-filter",
        "Merck Millipore",
        "Millistak+ Pod",
        2019,
        "Purification train",
        DOWN,
        300.0,
    ),
    _m("HT-01", "Harvest hold tank HT-01", "tank", "Pharmatec", "HT 2500", 2019, "Purification train", DOWN),
    _m(
        "BP-01",
        "Buffer preparation BP-01",
        "mixer",
        "Merck Millipore",
        "Mobius MIX 2000",
        2019,
        "Purification train",
        DOWN,
        300.0,
    ),
    _m(
        "CS-01",
        "Chromatography skid CS-01 (Protein A)",
        "chromatography-skid",
        "Cytiva",
        "ÄKTAprocess",
        2019,
        "Purification train",
        DOWN,
        1500.0,
    ),
    _m(
        "VT-01", "Viral inactivation tank VT-01", "tank", "Pharmatec", "VT 800", 2019, "Purification train", DOWN, 200.0
    ),
    _m(
        "CS-02",
        "Chromatography skid CS-02 (CEX and AEX)",
        "chromatography-skid",
        "Cytiva",
        "ÄKTAprocess",
        2019,
        "Purification train",
        DOWN,
        1200.0,
    ),
    _m(
        "VF-01",
        "Virus filtration VF-01",
        "virus-filter",
        "Asahi Kasei",
        "Planova 20N skid",
        2019,
        "Purification train",
        DOWN,
        600.0,
    ),
    _m(
        "UF-01",
        "UF/DF skid UF-01",
        "ultrafiltration",
        "Merck Millipore",
        "Pellicon 3 skid",
        2019,
        "Purification train",
        DOWN,
        900.0,
    ),
    _m(
        "BF-01",
        "Bulk fill and freeze BF-01",
        "bulk-fill",
        "Sartorius",
        "Celsius FFT",
        2020,
        "Purification train",
        DOWN,
        300.0,
    ),
    _m(
        "CIP-02",
        "CIP skid CIP-02 (downstream)",
        "cip-skid",
        "GEA",
        "CIP Hygienic 3",
        2019,
        "Purification train",
        DOWN,
        400.0,
    ),
    _m("FZ-01", "Bulk freezer FZ-01", "freezer", "Thermo Fisher", "TSX -40", 2020, "Purification train", DOWN),
)
FILL_FINISH = (
    _m(
        "FR-01", "Filling room FR-01 (grade B)", "cleanroom", "Kleanlabs", "Grade B suite", 2019, "Fill-finish line", FF
    ),
    _m(
        "FL-01", "Vial filler FL-01", "vial-filler", "Bausch+Ströbel", "VFVM 8100", 2019, "Fill-finish line", FF, 1800.0
    ),
    _m("LY-01", "Lyophiliser LY-01", "lyophiliser", "GEA", "LYOVAC FCM 6", 2019, "Fill-finish line", FF, 3200.0),
    _m("CP-01", "Capping machine CP-01", "capper", "Bausch+Ströbel", "VRK 9100", 2019, "Fill-finish line", FF, 600.0),
    _m(
        "AVI-01",
        "Automated visual inspection AVI-01",
        "inspection-machine",
        "Körber",
        "Seidenader V90+",
        2020,
        "Fill-finish line",
        FF,
        800.0,
    ),
)
UTILITIES = (
    _m(
        "WFI-01",
        "WFI system WFI-01 (still and loop)",
        "wfi-system",
        "Stilmas",
        "VC 3000",
        2019,
        "Utilities",
        "PLC Utilities",
        1500.0,
    ),
    _m(
        "CSG-01",
        "Clean steam generator CSG-01",
        "clean-steam",
        "Stilmas",
        "CSG 1000",
        2019,
        "Utilities",
        "PLC Utilities",
    ),
    _m(
        "AHU-01",
        "Air handling unit AHU-01 (fill-finish)",
        "air-handler",
        "Daikin",
        "Professional AHU D-AHU",
        2019,
        "Utilities",
        "BMS",
    ),
    _m("CR-01", "Cold room CR-01 (2-8 °C)", "cold-room", "Carrier", "Cold room 40", 2019, "Utilities", "BMS"),
)
QC = (
    _m("HPLC-01", "SEC-HPLC HPLC-01", "lab-instrument", "Agilent", "1260 Infinity II", 2021, "QC lab", "LIMS"),
    _m(
        "EL-01",
        "HCP ELISA reader EL-01",
        "lab-instrument",
        "Molecular Devices",
        "SpectraMax iD5",
        2021,
        "QC lab",
        "LIMS",
    ),
    _m(
        "LAL-01",
        "Endotoxin reader LAL-01",
        "lab-instrument",
        "Charles River",
        "Endosafe nexgen-PTS",
        2021,
        "QC lab",
        "LIMS",
    ),
    _m("KF-01", "Karl Fischer titrator KF-01", "lab-instrument", "Metrohm", "917 Coulometer", 2021, "QC lab", "LIMS"),
)
MACHINES = SEED_TRAIN + BIOREACTORS + UPSTREAM_SUPPORT + PURIFICATION + FILL_FINISH + UTILITIES + QC
BY_ASSET = {m.asset: m for m in MACHINES}


@dataclass(frozen=True)
class Tag:
    tag: str
    unit: str
    # run: every minute while running; grid: every 5 minutes; unit: one a batch, cycle, sample or vial; lab; event
    kind: str
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


def bioreactor_tags(asset: str) -> tuple[Tag, ...]:
    k = asset.lower().replace("-", "")
    a = asset
    return (
        Tag(f"{k}.temperature", "°C", "grid", f"{a} culture temperature", a, "temperature", 15, 130, 7200),
        Tag(f"{k}.ph", "pH", "grid", f"{a} culture pH", a, "ph", 6.5, 7.5, 7200),
        Tag(f"{k}.do", "%", "grid", f"{a} dissolved oxygen (% of air saturation)", a, "dissolved oxygen", 0, 120, 7200),
        Tag(f"{k}.agitation", "rpm", "grid", f"{a} agitator speed", a, "speed", 0, 200, 86400),
        Tag(f"{k}.air_flow", "slpm", "grid", f"{a} air sparge flow", a, "flow", 0, 60, 86400),
        Tag(f"{k}.o2_flow", "slpm", "grid", f"{a} oxygen sparge flow", a, "flow", 0, 40, 86400),
        Tag(f"{k}.co2_flow", "slpm", "grid", f"{a} CO2 flow for pH control", a, "flow", 0, 10, 86400),
        Tag(f"{k}.pressure", "mbar", "grid", f"{a} head pressure (gauge)", a, "pressure", 0, 1500, 86400),
        Tag(f"{k}.weight", "kg", "grid", f"{a} culture weight (load cells)", a, "weight", 0, 2200, 86400),
        Tag(f"{k}.jacket_temp", "°C", "grid", f"{a} jacket water temperature", a, "temperature", 0, 135, 7200),
        Tag(
            f"{k}.seal_loss",
            "mL/h",
            "grid",
            f"{a} agitator mechanical seal barrier fluid loss",
            a,
            "leak rate",
            0,
            30,
            86400,
            wear_limit=6.0,
            wear_direction="up",
        ),
        Tag(f"{k}.vcd", "1e6 cells/mL", "unit", f"{a} viable cell density, daily sample", a, "cell density", 0, 40),
        Tag(f"{k}.viability", "%", "unit", f"{a} cell viability, daily sample", a, "viability", 0, 100),
        Tag(f"{k}.glucose", "g/L", "unit", f"{a} glucose, daily sample", a, "concentration", 0, 12),
        Tag(f"{k}.lactate", "g/L", "unit", f"{a} lactate, daily sample", a, "concentration", 0, 8),
        Tag(f"{k}.titre", "g/L", "unit", f"{a} antibody titre, daily sample (from day 3)", a, "titre", 0, 8),
        Tag(f"{k}.pco2", "mmHg", "unit", f"{a} dissolved CO2, daily sample", a, "partial pressure", 0, 200),
        Tag(f"{k}.osmolality", "mOsm/kg", "unit", f"{a} osmolality, daily sample", a, "osmolality", 250, 500),
    )


def seed_tags() -> tuple[Tag, ...]:
    out: list[Tag] = []
    for a in ("WB-01", "WB-02"):
        k = a.lower().replace("-", "")
        out += [
            Tag(f"{k}.temperature", "°C", "grid", f"{a} culture temperature", a, "temperature", 15, 40, 7200),
            Tag(f"{k}.rocking", "rpm", "grid", f"{a} rocking rate", a, "speed", 0, 40, 86400),
        ]
    for a in ("SB-01", "SB-02"):
        k = a.lower().replace("-", "")
        out += [
            Tag(f"{k}.temperature", "°C", "grid", f"{a} culture temperature", a, "temperature", 15, 40, 7200),
            Tag(f"{k}.ph", "pH", "grid", f"{a} culture pH", a, "ph", 6.5, 7.5, 7200),
            Tag(f"{k}.do", "%", "grid", f"{a} dissolved oxygen", a, "dissolved oxygen", 0, 120, 7200),
            Tag(
                f"{k}.final_vcd",
                "1e6 cells/mL",
                "unit",
                f"{a} viable cell density at transfer",
                a,
                "cell density",
                0,
                15,
            ),
            Tag(f"{k}.final_viability", "%", "unit", f"{a} viability at transfer", a, "viability", 0, 100),
        ]
    out += [
        Tag(
            "mp01.osmolality",
            "mOsm/kg",
            "unit",
            "Media preparation MP-01 osmolality, each media lot",
            "MP-01",
            "osmolality",
            250,
            400,
        ),
        Tag("mp01.ph", "pH", "unit", "Media preparation MP-01 pH, each media lot", "MP-01", "ph", 6.5, 7.6),
        Tag(
            "cip01.final_rinse_conductivity",
            "µS/cm",
            "unit",
            "CIP-01 final rinse conductivity, each cycle",
            "CIP-01",
            "conductivity",
            0,
            10,
        ),
    ]
    return tuple(out)


def downstream_tags() -> tuple[Tag, ...]:
    return (
        Tag("cf01.speed", "rpm", "run", "Harvest centrifuge CF-01 bowl speed", "CF-01", "speed", 0, 10000, 1800),
        Tag(
            "cf01.vibration",
            "mm/s",
            "run",
            "Harvest centrifuge CF-01 spindle vibration (velocity, RMS)",
            "CF-01",
            "vibration",
            0,
            20,
            1800,
            wear_limit=7.1,
            wear_direction="up",
        ),
        Tag(
            "cf01.centrate_turbidity",
            "NTU",
            "unit",
            "CF-01 centrate turbidity, each harvest",
            "CF-01",
            "turbidity",
            0,
            500,
        ),
        Tag(
            "df01.max_dp",
            "bar",
            "unit",
            "Depth filtration DF-01 highest pressure drop, each harvest",
            "DF-01",
            "pressure",
            0,
            3,
        ),
        Tag(
            "ht01.temperature", "°C", "grid", "Harvest hold tank HT-01 temperature", "HT-01", "temperature", 0, 30, 7200
        ),
        Tag(
            "bp01.conductivity",
            "mS/cm",
            "unit",
            "Buffer preparation BP-01 conductivity, each buffer lot",
            "BP-01",
            "conductivity",
            0,
            200,
        ),
        Tag("cs01.pressure", "bar", "run", "CS-01 system pressure", "CS-01", "pressure", 0, 5, 1800),
        Tag("cs01.uv280", "AU", "run", "CS-01 UV absorbance at 280 nm", "CS-01", "absorbance", 0, 3, 1800),
        Tag("cs01.conductivity", "mS/cm", "run", "CS-01 conductivity", "CS-01", "conductivity", 0, 200, 1800),
        Tag("cs01.flow", "L/h", "run", "CS-01 flow", "CS-01", "flow", 0, 1500, 1800),
        Tag("cs01.step_yield", "%", "unit", "Protein A step yield, each cycle", "CS-01", "yield", 50, 100),
        Tag(
            "cs01.column_dp",
            "bar",
            "unit",
            "Protein A column pressure drop at loading flow, each cycle",
            "CS-01",
            "pressure",
            0,
            4,
        ),
        Tag(
            "cs01.resin_cycles",
            "cycles",
            "grid",
            "Protein A resin cycles since it was packed",
            "CS-01",
            "counter",
            0,
            300,
            wear_limit=float(RESIN_LIFE),
            wear_direction="up",
        ),
        Tag("vt01.hold_ph", "pH", "unit", "Viral inactivation hold pH, each batch", "VT-01", "ph", 3.0, 4.5),
        Tag("vt01.hold_minutes", "min", "unit", "Viral inactivation hold time, each batch", "VT-01", "time", 0, 240),
        Tag("cs02.pressure", "bar", "run", "CS-02 system pressure", "CS-02", "pressure", 0, 5, 1800),
        Tag("cs02.uv280", "AU", "run", "CS-02 UV absorbance at 280 nm", "CS-02", "absorbance", 0, 3, 1800),
        Tag("cs02.conductivity", "mS/cm", "run", "CS-02 conductivity", "CS-02", "conductivity", 0, 200, 1800),
        Tag(
            "cs02.cex_asymmetry",
            "ratio",
            "unit",
            "CEX column peak asymmetry at the pre-use test, each batch",
            "CS-02",
            "asymmetry",
            0.5,
            3.0,
            wear_limit=1.6,
            wear_direction="up",
        ),
        Tag(
            "cs02.cex_dp",
            "bar",
            "unit",
            "CEX column pressure drop at the pre-use test, each batch",
            "CS-02",
            "pressure",
            0,
            4,
        ),
        Tag("vf01.throughput", "L/m²", "unit", "Virus filter throughput, each batch", "VF-01", "throughput", 0, 600),
        Tag("vf01.flux_decay", "%", "unit", "Virus filter flux decay at the end, each batch", "VF-01", "decay", 0, 100),
        Tag("uf01.tmp", "bar", "run", "UF/DF transmembrane pressure", "UF-01", "pressure", 0, 4, 1800),
        Tag("uf01.permeate_flux", "LMH", "run", "UF/DF permeate flux", "UF-01", "flux", 0, 120, 1800),
        Tag(
            "uf01.nwp",
            "LMH/bar",
            "unit",
            "UF/DF cassettes' normalised water permeability at the pre-use test, each batch",
            "UF-01",
            "permeability",
            0,
            150,
            wear_limit=70.0,
            wear_direction="down",
        ),
        Tag("fz01.temperature", "°C", "grid", "Bulk freezer FZ-01 temperature", "FZ-01", "temperature", -60, 0, 7200),
    )


def fill_finish_tags() -> tuple[Tag, ...]:
    return (
        Tag(
            "fl01.fill_weight",
            "g",
            "unit",
            "Vial filler FL-01 fill weight, each vial (checkweigher)",
            "FL-01",
            "weight",
            9.5,
            11.0,
        ),
        Tag(
            "ly01.shelf_temp", "°C", "run", "Lyophiliser LY-01 shelf temperature", "LY-01", "temperature", -60, 50, 3600
        ),
        Tag(
            "ly01.product_temp",
            "°C",
            "run",
            "Lyophiliser LY-01 product temperature (probe vials)",
            "LY-01",
            "temperature",
            -60,
            50,
            3600,
        ),
        Tag(
            "ly01.chamber_pressure",
            "µbar",
            "run",
            "Lyophiliser LY-01 chamber pressure (capacitance gauge)",
            "LY-01",
            "pressure",
            0,
            1500,
            3600,
        ),
        Tag(
            "ly01.condenser_temp",
            "°C",
            "run",
            "Lyophiliser LY-01 condenser temperature",
            "LY-01",
            "temperature",
            -90,
            30,
            3600,
        ),
        Tag(
            "ly01.leak_rate",
            "µbar·L/s",
            "unit",
            "Lyophiliser LY-01 leak rate at the pre-cycle test, each cycle",
            "LY-01",
            "leak rate",
            0,
            60,
            wear_limit=20.0,
            wear_direction="up",
        ),
        Tag(
            "fr01.room_dp",
            "Pa",
            "grid",
            "Filling room FR-01 pressure difference to the corridor",
            "FR-01",
            "pressure",
            0,
            40,
            7200,
        ),
        Tag(
            "fr01.particles_05",
            "/m³",
            "grid",
            "Filling room FR-01 particles of 0.5 µm and over",
            "FR-01",
            "particles",
            0,
            3520000,
        ),
        Tag("fr01.temperature", "°C", "grid", "Filling room FR-01 temperature", "FR-01", "temperature", 15, 25, 7200),
    )


def utility_tags() -> tuple[Tag, ...]:
    return (
        Tag(
            "wfi01.conductivity",
            "µS/cm",
            "grid",
            "WFI loop conductivity at 25 °C, return",
            "WFI-01",
            "conductivity",
            0,
            5,
            7200,
            wear_limit=1.3,
            wear_direction="up",
        ),
        Tag("wfi01.toc", "ppb", "grid", "WFI loop total organic carbon, return", "WFI-01", "content", 0, 1000, 7200),
        Tag("wfi01.loop_temp", "°C", "grid", "WFI loop temperature", "WFI-01", "temperature", 60, 95, 7200),
        Tag("wfi01.return_velocity", "m/s", "grid", "WFI loop return velocity", "WFI-01", "velocity", 0, 3, 7200),
        Tag("csg01.pressure", "bar", "grid", "Clean steam header pressure", "CSG-01", "pressure", 0, 5, 7200),
        Tag(
            "csg01.condensate_conductivity",
            "µS/cm",
            "grid",
            "Clean steam condensate conductivity",
            "CSG-01",
            "conductivity",
            0,
            5,
            7200,
        ),
        Tag(
            "ahu01.filter_dp",
            "Pa",
            "grid",
            "AHU-01 final filter pressure drop",
            "AHU-01",
            "pressure",
            0,
            800,
            7200,
            wear_limit=450.0,
            wear_direction="up",
        ),
        Tag("ahu01.supply_temp", "°C", "grid", "AHU-01 supply air temperature", "AHU-01", "temperature", 10, 30, 7200),
        Tag("ahu01.supply_rh", "%", "grid", "AHU-01 supply air relative humidity", "AHU-01", "humidity", 0, 100, 7200),
        Tag("cr01.temperature", "°C", "grid", "Cold room CR-01 temperature", "CR-01", "temperature", -5, 15, 7200),
    )


def lab_tags() -> tuple[Tag, ...]:
    return (
        Tag(
            "lab.bulk_hmw",
            "%",
            "lab",
            "Drug substance aggregates (SEC-HPLC high molecular weight), each lot",
            "HPLC-01",
            "aggregates",
            0,
            10,
        ),
        Tag(
            "lab.bulk_hcp",
            "ppm",
            "lab",
            "Drug substance host cell protein (ELISA), each lot",
            "EL-01",
            "impurity",
            0,
            500,
        ),
        Tag("lab.bulk_endotoxin", "EU/mg", "lab", "Drug substance endotoxin, each lot", "LAL-01", "endotoxin", 0, 1),
        Tag(
            "lab.bulk_concentration",
            "g/L",
            "lab",
            "Drug substance concentration (A280), each lot",
            "HPLC-01",
            "concentration",
            50,
            150,
        ),
        Tag(
            "lab.dp_moisture",
            "%",
            "lab",
            "Drug product residual moisture (Karl Fischer), each lot",
            "KF-01",
            "content",
            0,
            5,
        ),
        Tag(
            "lab.pa_dbc",
            "g/L",
            "lab",
            "Protein A resin dynamic binding capacity, every 25 cycles",
            "HPLC-01",
            "capacity",
            0,
            80,
        ),
        Tag(
            "lab.em_grade_a",
            "CFU",
            "lab",
            "Grade A settle plates at the filling needles, each fill",
            "FR-01",
            "microbial count",
            0,
            20,
        ),
    )


# The machines the MES logs stops of (the room's are the HVAC's, WFI-01's are the WFI's).
DOWNTIME_ASSETS = (
    "WB-01", "WB-02", "SB-01", "SB-02", "BR-01", "BR-02", "BR-03", "BR-04", "MP-01", "CIP-01", "CF-01", "DF-01",
    "BP-01", "CS-01", "VT-01", "CS-02", "VF-01", "UF-01", "BF-01", "CIP-02", "FR-01", "FL-01", "LY-01", "CP-01",
    "AVI-01", "WFI-01",
)  # fmt: skip
SCRAP_ASSETS = ("BR-01", "BR-02", "BR-03", "BR-04", "BF-01", "FL-01", "LY-01", "AVI-01")


def event_tags() -> tuple[Tag, ...]:
    out = [
        Tag(
            f"mes.{BY_ASSET[a].key}.downtime",
            "",
            "event",
            f"{a} stops from the MES: the reason code",
            a,
            event_kind="downtime",
        )
        for a in DOWNTIME_ASSETS
    ]
    out += [
        Tag(
            f"mes.{BY_ASSET[a].key}.scrap",
            "",
            "event",
            f"{a} rejects and lost batches from the MES: the code",
            a,
            event_kind="scrap",
        )
        for a in SCRAP_ASSETS
    ]
    return tuple(out)


def all_tags() -> tuple[Tag, ...]:
    return (
        *(t for b in BIOREACTORS for t in bioreactor_tags(b.asset)),
        *seed_tags(),
        *downstream_tags(),
        *fill_finish_tags(),
        *utility_tags(),
        *lab_tags(),
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
    Person("Siobhán Kelly", "siobhan.kelly@example.com", "admin", "Site director (sponsor)"),
    Person("Ciarán Doyle", "ciaran.doyle@example.com", "engineer", "Upstream process lead"),
    Person("Aoife Byrne", "aoife.byrne@example.com", "engineer", "Downstream process lead"),
    Person("Niamh Walsh", "niamh.walsh@example.com", "engineer", "Fill-finish lead"),
    Person("Declan Murphy", "declan.murphy@example.com", "engineer", "Maintenance and reliability lead"),
    Person("Róisín O'Brien", "roisin.obrien@example.com", "engineer", "Head of quality assurance"),
    Person("Eoin Gallagher", "eoin.gallagher@example.com", "engineer", "QC laboratory manager"),
    Person("Sinéad Ryan", "sinead.ryan@example.com", "engineer", "Maintenance technician", "A"),
    Person("Pádraig Lynch", "padraig.lynch@example.com", "engineer", "Maintenance technician", "B"),
    Person("Orla Fitzgerald", "orla.fitzgerald@example.com", "engineer", "Maintenance technician", "C"),
    Person("Darragh Nolan", "darragh.nolan@example.com", "engineer", "Maintenance technician", "D"),
    Person("Caoimhe Burke", "caoimhe.burke@example.com", "viewer", "Shift manager", "A"),
    Person("Fionn Quinn", "fionn.quinn@example.com", "viewer", "Shift manager", "B"),
    Person("Grace Moran", "grace.moran@example.com", "viewer", "Shift manager", "C"),
    Person("Rory Kavanagh", "rory.kavanagh@example.com", "viewer", "Shift manager", "D"),
    Person("Meabh Foley", "meabh.foley@example.com", "admin", "IT and OT lead"),
)
TECHNICIAN = {p.crew: p.name for p in PEOPLE if p.job == "Maintenance technician"}
OWNERS = {
    "Upstream": "Ciarán Doyle",
    "Downstream": "Aoife Byrne",
    "Fill-finish": "Niamh Walsh",
    "Utilities": "Declan Murphy",
    "QC lab": "Eoin Gallagher",
    "Quality": "Róisín O'Brien",
}

# Controlling's figures for 2026.
BATCH_COST_EUR = 850_000.0  # a lost 2,000 L batch: media, consumables, labour and the reactor's fortnight
VIAL_COST_EUR = 140.0  # a rejected vial of drug product
DS_COST_EUR_G = 120.0  # drug substance rejected, a gram
PART_COSTS = {
    "agitator mechanical seal kit": 14_000.0,
    "centrifuge spindle bearing set": 9_500.0,
    "CEX column repack (labour and resin top-up)": 22_000.0,
    "UF/DF cassette set": 18_000.0,
    "lyophiliser door seal and valve kit": 6_500.0,
    "filler dosing pump": 4_200.0,
    "AHU final filter set": 7_800.0,
    "WFI still service": 5_500.0,
    "Protein A resin, 80 L": 960_000.0,
}
TECHNICIAN_EUR_H = 78.0


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

    ent = node("brannock", "Enterprise", ENTERPRISE)
    site = node("carrowmore", "Site", SITE, location=LOCATION, timezone="Europe/Dublin")
    edge(ent, "contains", site)
    wc = {n: node(slug(n), "Workcenter", n) for n in ("Upstream", "Downstream", "Fill-finish", "Utilities", "QC lab")}
    for w in wc.values():
        edge(site, "contains", w)
    places = {
        "Seed train": node("seed-train", "Line", "Seed train"),
        "Production bioreactors": node("production-bioreactors", "Line", "Production bioreactors"),
        "Purification train": node("purification-train", "Line", "Purification train"),
        "Fill-finish line": node("fill-finish-line", "Line", "Fill-finish line"),
        "Utilities": wc["Utilities"],
        "QC lab": wc["QC lab"],
    }
    edge(wc["Upstream"], "contains", places["Seed train"])
    edge(wc["Upstream"], "contains", places["Production bioreactors"])
    edge(wc["Downstream"], "contains", places["Purification train"])
    edge(wc["Fill-finish"], "contains", places["Fill-finish line"])
    plcs: dict[str, str] = {}
    for name, protocol, model in (
        (UP, "OPC UA", "Emerson DeltaV"),
        (DOWN, "OPC UA", "Emerson DeltaV"),
        (FF, "OPC UA", "Siemens S7-1500"),
        ("PLC Utilities", "OPC UA", "Rockwell ControlLogix with Kepware"),
        ("BMS", "OPC UA", "Siemens Desigo CC"),
        ("LIMS", "SQL", "LabWare LIMS 8"),
    ):
        plcs[name] = node(slug(name), "PLC", name, protocol=protocol, model=model)
    for m in MACHINES:
        n = node(
            m.asset.lower(), "Machine", m.label, vendor=m.vendor, model=m.model, kind=m.kind, asset=m.asset, year=m.year
        )
        edge(places[m.area], "contains", n)
        edge(n, "controlledBy", plcs[m.plc])
    for t in all_tags():
        if t.kind == "event":
            continue
        m = BY_ASSET[t.asset]
        s = node(f"sig-{slug(t.tag)}", "Signal", t.description, unit=t.unit, tag=t.tag, measure=t.measure)
        edge(plcs[m.plc], "emits", s)
    # The flow: vial thaw to inspected vial.
    flow = [
        ("in-01", "wb-01"), ("in-01", "wb-02"), ("wb-01", "sb-01"), ("wb-02", "sb-02"),
        *((sb, f"br-0{i}") for sb in ("sb-01", "sb-02") for i in range(1, 5)),
        *((f"br-0{i}", "cf-01") for i in range(1, 5)),
        *(("mp-01", f"br-0{i}") for i in range(1, 5)),
        *(("csg-01", f"br-0{i}") for i in range(1, 5)),
        *(("cip-01", f"br-0{i}") for i in range(1, 5)),
        ("cf-01", "df-01"), ("df-01", "ht-01"), ("ht-01", "cs-01"), ("cs-01", "vt-01"), ("vt-01", "cs-02"),
        ("cs-02", "vf-01"), ("vf-01", "uf-01"), ("uf-01", "bf-01"), ("bf-01", "fz-01"), ("fz-01", "fl-01"),
        ("bp-01", "cs-01"), ("bp-01", "cs-02"), ("bp-01", "uf-01"), ("cip-02", "cs-01"), ("cip-02", "uf-01"),
        ("fl-01", "ly-01"), ("ly-01", "cp-01"), ("cp-01", "avi-01"),
        ("wfi-01", "mp-01"), ("wfi-01", "bp-01"), ("wfi-01", "cip-01"), ("wfi-01", "cip-02"),
        ("ahu-01", "fr-01"), ("cr-01", "ht-01"),
    ]  # fmt: skip
    for a, b in flow:
        edge(a, "feeds", b)
    for a in ("fl-01", "ly-01", "cp-01"):
        edge("fr-01", "contains", a)
    processes = {
        "culture": node("proc-culture", "Process", "Cell culture: fed-batch, 14 days"),
        "harvest": node("proc-harvest", "Process", "Harvest and clarification"),
        "capture": node("proc-capture", "Process", "Protein A capture and viral inactivation"),
        "polishing": node("proc-polishing", "Process", "Polishing and virus filtration"),
        "formulation": node("proc-formulation", "Process", "UF/DF formulation and bulk fill"),
        "fill": node("proc-fill", "Process", "Aseptic filling and lyophilisation"),
        "inspection": node("proc-inspection", "Process", "Capping and visual inspection"),
    }
    for a, p in (
        *((f"br-0{i}", "culture") for i in range(1, 5)),
        ("cf-01", "harvest"),
        ("df-01", "harvest"),
        ("cs-01", "capture"),
        ("vt-01", "capture"),
        ("cs-02", "polishing"),
        ("vf-01", "polishing"),
        ("uf-01", "formulation"),
        ("bf-01", "formulation"),
        ("fl-01", "fill"),
        ("ly-01", "fill"),
        ("cp-01", "inspection"),
        ("avi-01", "inspection"),
    ):
        edge(a, "runs", processes[p])
    mats = {
        "cells": node("mat-wcb", "Material", "BRN-217 CHO working cell bank"),
        "medium": node("mat-medium", "Material", "Chemically defined basal medium"),
        "feed": node("mat-feed", "Material", "Chemically defined feed"),
        "resin": node("mat-protein-a", "Material", "Protein A resin (alkali-stable)"),
        "cex": node("mat-cex", "Material", "Cation-exchange resin"),
        "vf": node("mat-vf", "Material", "Planova 20N virus filter"),
        "vials": node("mat-vials", "Material", "20R glass vials, stoppers and caps"),
    }
    for p, mat in (
        ("culture", "cells"),
        ("culture", "medium"),
        ("culture", "feed"),
        ("capture", "resin"),
        ("polishing", "cex"),
        ("polishing", "vf"),
        ("fill", "vials"),
    ):
        edge(processes[p], "consumes", mats[mat])
    # A known gap of the model: a retired bioreactor nobody took out.
    node(
        "br-05",
        "Machine",
        "Bioreactor BR-05, 500 L (retired)",
        vendor="Pierre Guérin",
        kind="bioreactor",
        asset="BR-05",
    )
    return nodes, edges
