"""The battery plant's documents: SOPs whose limits are the simulation's, a plant overview,
lessons-learned reports on the year's longest breakdowns, and monthly maintenance reports."""

from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

from tiles_api.sample_plant.battery import simulate as sim
from tiles_api.sample_plant.battery.plant import BY_ASSET, CODES, MACHINES, PART_COSTS, ZONE
from tiles_api.sample_plant.common import Stats

SOPS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "SOP-EL-01": (
        "Electrode coating: coating weight and die cleaning",
        """Applies to the coaters CT-C1 and CT-A1. Owner: process engineering, electrodes.

The coating weight's set point is 22.0 mg/cm² on the cathode and 12.6 mg/cm² on the anode, within
1.5 %. The beta gauge also gives its variation across the web (`coating_weight_cv`), normally 0.8
to 1.0 %.

- Above 2.0 %: clean the slot die lips at the next stop. Dried slurry on the lips makes streaks.
- Above 3.2 %, or more than 12 streaks on a coil: the coil is scrapped (COIL-STREAK).
- 2.5 % is the wear limit the plant watches for (the die needs cleaning before it).

The slot die is cleaned every week (PL-CLN, 90 minutes: CT-C1 on Wednesdays, CT-A1 on Thursdays).
""",
        ("ct-c1", "ct-a1"),
    ),
    "SOP-EL-02": (
        "Electrode drying: dryer zones and adhesion",
        """Applies to the coaters' dryers. Owner: maintenance.

Zone 3 runs at 120 °C on the cathode line and 95 °C on the anode line. Its fan motor normally draws
14 A; above 17 A its bearings are wearing and the zone runs colder. Residual solvent after the dryer
is normally about 180 ppm; above 500 ppm check the dryer.

A sample of every cathode coil is peel-tested (normally 16 N/m). Below 8 N/m the coil is scrapped
for poor adhesion (COIL-ADH): under-dried electrodes don't hold to the foil.
""",
        ("ct-c1", "ct-a1"),
    ),
    "SOP-EL-03": (
        "Calendering: thickness and roll bearings",
        """Applies to the calenders CL-C1 and CL-A1. Owner: maintenance.

Calendered thickness is 118 µm on the cathode and 136 µm on the anode. Its variation over a minute
(`thickness_sd`) is normally 0.8 µm; above 1.5 µm check the work roll bearings.

The bearings' vibration (`bearing_vibration`) is normally about 1.8 mm/s. At 4.5 mm/s plan a bearing
change; 7.1 mm/s is the limit (ISO 10816 zone D): stop and change the bearing (DT-CAL).
""",
        ("cl-c1", "cl-a1"),
    ),
    "SOP-EL-04": (
        "Slitting: blades and burrs",
        """Applies to the slitters SL-C1 and SL-A1. Owner: maintenance and quality.

Each coil is slit into four daughter rolls. The blades are changed every 150 km (PL-BLD). The burr on
the slit edge is measured on every roll (`burr_height`): normally 3 to 8 µm, rising as the blades
wear.

- 12 µm is the wear limit: plan the blade change.
- 15 µm or more: the roll is scrapped (COIL-BURR) and the blades changed now (DT-BLD).
- Burrs between 10 and 15 µm pass, but can pierce the separator: such cells show as self-discharge
  (K-value) failures at the end of the line, two weeks later.
""",
        ("sl-c1", "sl-a1"),
    ),
    "SOP-DR-01": (
        "Dry room: dew point and moisture",
        """Applies to the dry room DR-01 and its dehumidifier DH-01. Owner: facilities and quality.

The dew point is held at -45 °C. At -40 °C the alarm sounds; above -30 °C assembly stops (DT-DRM)
until the desiccant wheel is regenerated. The wheel's pressure drop (`dh01.wheel_dp`) is normally
220 Pa; 380 Pa is its limit: regenerate it.

Electrode moisture after vacuum drying is normally about 150 ppm (Karl Fischer, a sample each roll);
above 250 ppm hold the rolls. Moisture raises resistance and self-discharge and lowers capacity.
""",
        ("dr-01", "dh-01"),
    ),
    "SOP-AS-01": (
        "Stacking: alignment and separator tension",
        """Applies to the stackers ST-01 and ST-02. Owner: process engineering, assembly.

The vision system measures the anode's overhang over the cathode on every cell: its largest
deviation from nominal (`overhang_dev`) is normally about 0.1 mm. Over 0.8 mm the stack is rejected
(STK-OVH). The separator runs at 8 N; below 7 N check the dancer and its servo (DT-STK).
""",
        ("st-01", "st-02"),
    ),
    "SOP-AS-02": (
        "Tab welding: weld energy and horn changes",
        """Applies to the ultrasonic welder UW-01. Owner: maintenance.

The horn is changed every 200,000 welds (PL-HRN). Weld energy is normally 620 to 700 J; it rises as
the horn wears. Above 850 J inspect the horn; 900 J is its limit. A sample every 500 welds is
pull-tested: normally 140 N, at least 80 N. Weak welds raise the cell's resistance (DCIR).
""",
        ("uw-01",),
    ),
    "SOP-AS-03": (
        "Electrolyte filling",
        """Applies to the filler EF-01. Owner: process engineering, assembly.

Each cell takes 245 g of electrolyte, within 3 g. Below 240 g it is rejected (FIL-LOW). A worn dosing
pump fills less and less evenly: rebuild it when the fill weight's spread grows (DT-FIL).
Under-filled cells lose capacity.
""",
        ("ef-01",),
    ),
    "SOP-FA-01": (
        "Formation and aging",
        """Applies to the formation racks FM-01 to FM-04 and the aging room AG-01. Owner: process
engineering, formation.

After 24 hours' wetting, each cell is formed for 18 hours on a channel of a rack (512 channels a
rack). The channels' contact resistance is normally 2.5 mΩ; above 6 mΩ service the probes (DT-FRM):
poor contacts heat the cells and fail formations (FRM-FAIL).

Formed cells age for 10 days at 25 °C. The fall of their open-circuit voltage gives the self-discharge
(K-value, mV a day).
""",
        ("fm-01", "fm-02", "fm-03", "fm-04", "ag-01"),
    ),
    "SOP-QA-01": (
        "End-of-line test and grading",
        """Applies to the tester EOL-01. Owner: quality.

Every cell is tested for capacity, DC internal resistance (DCIR) and its K-value, and graded:

| Grade | Capacity | DCIR | K-value |
| --- | --- | --- | --- |
| A | 60.0 Ah or more | 0.90 mΩ or less | 0.20 mV/day or less |
| B | 58.8 Ah or more | 0.95 mΩ or less | 0.25 mV/day or less |
| NG | otherwise | | |

A cell needs 60.0 Ah, at most 0.90 mΩ and a K-value of at most 0.20 mV a day for grade A.
An NG cell is scrapped for its worst fault: self-discharge (EOL-K), resistance (EOL-DCIR) or
capacity (EOL-CAP). A scrapped cell costs about 24 EUR.
""",
        ("eol-01",),
    ),
}


def overview() -> str:
    rows = "\n".join(f"| {m.asset} | {m.label} | {m.vendor} {m.model} | {m.area} |" for m in MACHINES)
    return f"""# Varnhem cell plant: overview

Kestrel Energy's Varnhem plant makes KX60 prismatic lithium-ion cells for car makers: NMC811 cathode,
graphite anode, 60 Ah, about 2,000 a day. It runs around the clock: four crews (A to D) on twelve-hour
shifts, stopping only for Christmas, New Year and a week's summer maintenance.

## Equipment

| Asset | What | Machine | Where |
| --- | --- | --- | --- |
{rows}

## Who acts on a warning

The shift lead (crews A to D) receives the warnings and calls the maintenance technician of the
shift. The maintenance lead decides whether a warning was a true alarm. The electrode and assembly
process engineers own the settings, the quality lead the grades and holds.

## Costs (controlling, 2026)

A stop of a coater costs 1,800 EUR an hour, the dry room 2,800 EUR (it stops assembly), the welder or
filler 1,400 EUR, a stacker 700 EUR. A scrapped cell costs 24 EUR, cathode coil 9 EUR a metre.
Parts: {", ".join(f"{k} {v:,.0f} EUR" for k, v in PART_COSTS.items())}.
"""


def _month(t: float) -> str:
    return datetime.fromtimestamp(t, ZONE).strftime("%Y-%m")


def monthly_reports(year: sim.Year) -> dict[str, str]:
    by_month: dict[str, list[tuple[str, float, float, str, str, str | None]]] = defaultdict(list)
    for st in year.stations.values():
        for s in st.stops:
            if not s.planned:
                by_month[_month(s.start)].append((s.asset, s.start, s.end, s.code, s.comment, s.episode))
    cells: dict[str, Counter[str]] = defaultdict(Counter)
    for c in year.cells:
        m = _month(c.stacked)
        cells[m]["stacked"] += 1
        if c.scrap:
            cells[m]["scrap"] += 1
    out = {}
    for month in sorted(by_month):
        title = datetime.strptime(month, "%Y-%m").strftime("%B %Y")
        rows = []
        for m in MACHINES:
            mine = [x for x in by_month[month] if x[0] == m.asset]
            if not mine:
                continue
            hours = sum(x[2] - x[1] for x in mine) / 3600
            top = Counter(x[3] for x in mine).most_common(3)
            rows.append(f"| {m.asset} | {len(mine)} | {hours:.1f} | {', '.join(f'{k} ({v})' for k, v in top)} |")
        notes = (
            "\n".join(
                f"- {datetime.fromtimestamp(x[1], ZONE):%d %B, %H:%M}: {x[0]} {CODES[x[3]].description.lower()} ({x[4]})."
                for x in sorted(by_month[month], key=lambda x: x[1])
                if x[5] and not x[4].endswith("(continued)")
            )
            or "- No breakdowns of the watched components."
        )
        c = cells[month]
        out[f"MR-{month}"] = f"""# Maintenance report, {title}

Unplanned stops from the MES. {c["stacked"]:,} cells stacked, {c["scrap"]:,} scrapped.

| Machine | Unplanned stops | Hours | Most frequent codes |
| --- | --- | --- | --- |
{chr(10).join(rows)}

## Breakdowns

{notes}
"""
    return out


ROOT_CAUSES = {
    "die-lip": "dried slurry built up on the slot die lips, making streaks and an uneven coating across the web.",
    "dryer": "the zone 3 fan's bearings wore; the zone ran colder and the electrode left the dryer wet.",
    "bearing": "a work roll bearing wore; the roll vibrated and the thickness varied.",
    "blade-chip": "a slitter blade chipped; the burrs on the slit edge grew.",
    "desiccant": "the dehumidifier's desiccant wheel loaded up; the dry room's dew point rose.",
    "tension": "the separator dancer wore; the tension drifted and the stacks lost their alignment.",
    "horn": "the ultrasonic horn cracked; the welds needed more energy and grew weaker.",
    "pump": "the dosing pump's valves wore; cells were filled less and less evenly.",
    "contacts": "the channels' contact probes wore; contact resistance rose and cells ran hot.",
}
ACTIONS = {
    "die-lip": "clean the die when the coating weight's variation passes 2.0 % (SOP-EL-01).",
    "dryer": "change the fan bearings when the fan current passes 17 A (SOP-EL-02).",
    "bearing": "plan the bearing change at 4.5 mm/s (SOP-EL-03).",
    "blade-chip": "change blades at a 12 µm burr, and watch the K-values of cells from rolls over 10 µm (SOP-EL-04).",
    "desiccant": "regenerate the wheel at 380 Pa, before the dew point climbs (SOP-DR-01).",
    "tension": "check the dancer when the tension falls below 7 N (SOP-AS-01).",
    "horn": "inspect the horn above 850 J (SOP-AS-02).",
    "pump": "rebuild the pump when the fill weight spreads (SOP-AS-03).",
    "contacts": "service the probes above 6 mΩ (SOP-FA-01).",
}
FIRST = {
    "die-lip": "coating_weight_cv",
    "dryer": "dryer_fan_current",
    "bearing": "bearing_vibration",
    "blade-chip": "blade_km",
    "desiccant": "wheel_dp",
    "tension": "separator_tension",
    "horn": "weld_energy",
    "pump": "fill_weight",
    "contacts": "contact_resistance",
}


def lessons(year: sim.Year, stats: Stats) -> dict[str, str]:
    failed = [e for st in year.stations.values() for e in st.episodes if e.failed_at]
    hours: dict[str, float] = defaultdict(float)
    first_stop = {}
    for st in year.stations.values():
        for s in st.stops:
            if s.episode:
                hours[s.episode] += (s.end - s.start) / 3600
                first_stop.setdefault(s.episode, s)
    failed = [e for e in failed if e.id in first_stop]
    failed.sort(key=lambda e: -hours[e.id])
    numbers: Counter[int] = Counter()
    out = {}
    for e in sorted(failed[:10], key=lambda e: e.failed_at or 0):
        when = datetime.fromtimestamp(e.failed_at or 0, ZONE)
        numbers[when.year] += 1
        mode = year.stations[e.asset].modes.get(e.mode) or next(
            m for st in year.stations.values() for m in st.modes.values() if m.name == e.mode
        )
        s = first_stop[e.id]
        machine = BY_ASSET[s.asset]
        key = "dh01" if e.mode == "desiccant" else machine.key
        tag = f"{key}.{FIRST[e.mode]}"
        before, last = _mean(stats, tag, (e.failed_at or 0) - 8 * 86400), _mean(stats, tag, (e.failed_at or 0) - 86400)
        signal = (
            f"`{tag}` averaged {before:.1f} a week before and {last:.1f} the day before."
            if before is not None and last is not None
            else f"`{tag}` was not logged then."
        )
        cost = hours[e.id] * machine.downtime_cost_eur_h
        out[
            f"LL-{when:%Y}-{numbers[when.year]:02d}"
        ] = f"""# Lessons learned: {mode.component.lower()} on {s.asset}, {when:%d %B %Y}

**What happened:** {s.asset} stopped at {when:%H:%M} on {when:%A %d %B %Y} ({mode.code}: {CODES[mode.code].description.lower()}).
The MES logged: "{s.comment}". It was down {hours[e.id]:.1f} hours, about {cost:,.0f} EUR of lost contribution.

**What the data showed:** the problem started around {datetime.fromtimestamp(e.onset, ZONE):%d %B}. {signal}

**Root cause:** {ROOT_CAUSES[e.mode]}

**Actions:** {ACTIONS[e.mode]}
"""
    return out


def _mean(stats: Stats, tag: str, t: float) -> float | None:
    s = stats.days.get((tag, datetime.fromtimestamp(t, ZONE).date().isoformat()))
    return s[2] / s[3] if s else None


def all_documents(year: sim.Year, stats: Stats | None = None) -> dict[str, tuple[str, str, tuple[str, ...]]]:
    docs = {k: (title, f"# {k}: {title}\n\n{body}", about) for k, (title, body, about) in SOPS.items()}
    docs["PLANT-OVERVIEW"] = ("Varnhem cell plant overview", overview(), ("varnhem",))
    if stats is not None:
        for k, text in lessons(year, stats).items():
            asset = text.split(" on ", 1)[1].split(",", 1)[0]
            docs[k] = (text.splitlines()[0].removeprefix("# "), text, (asset.lower(),))
    for k, text in monthly_reports(year).items():
        docs[k] = (text.splitlines()[0].removeprefix("# "), text, ("varnhem",))
    return docs


def write(out: Path, year: sim.Year, stats: Stats) -> dict[str, int]:
    folder = out / "documents"
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("*.md"):
        old.unlink()
    docs = all_documents(year, stats)
    for k, (_, text, _) in docs.items():
        (folder / f"{k}.md").write_text(text, encoding="utf-8")
    return {"documents": len(docs)}
