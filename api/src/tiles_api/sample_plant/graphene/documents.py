"""The graphene plant's documents: SOPs whose limits are the simulation's, a plant overview,
lessons-learned reports on the year's longest breakdowns, and monthly maintenance reports."""

from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

from tiles_api.sample_plant.common import Stats, Stop
from tiles_api.sample_plant.graphene import simulate as sim
from tiles_api.sample_plant.graphene.plant import BY_ASSET, CODES, MACHINES, PART_COSTS, REACTORS, TRANSFERS, ZONE

SOPS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "SOP-CVD-01": (
        "Graphene growth: the recipe and the furnace",
        """Applies to the reactors CVD-01 to CVD-04. Owner: process engineering, CVD.

A run grows graphene on a 300 m roll of electropolished copper foil and takes 14 hours: 1.5 hours to
load and pump down, an hour to heat, 10 hours of growth at 0.5 m/min, 1.5 hours to cool. A run is
started only if it can finish within the working week and before the reactor's planned maintenance.

The recipe: zone 2 (growth) at 1,035 °C, zones 1 and 3 at 1,000 and 1,010 °C, methane 30 sccm,
hydrogen 600 sccm, 0.50 mbar.

Zone 2's heater normally draws 18 kW. Above 23 kW its element is ageing; 27 kW is the wear limit: plan
its replacement. A tired element can no longer hold 1,035 °C, and a cooler furnace grows smaller
grains: the film's sheet resistance rises (DT-HTR).

Every Monday at 06:00, as the week starts, each tube is baked out for 3 hours (PL-BAK).
""",
        tuple(a.lower() for a in REACTORS),
    ),
    "SOP-CVD-02": (
        "Vacuum: leaks and pumps",
        """Applies to the reactors' tubes and dry vacuum pumps. Owner: maintenance.

After pump-down the base pressure is normally 0.002 mbar. Above 0.010 mbar do not start the run:
leak-test the tube (DT-VAC). The residual gas analyser gives the oxygen in the exhaust, normally
below 1 ppm. Above 4 ppm look for a leak; 10 ppm is the wear limit. Oxygen in the tube etches the
graphene as it grows: Raman D/G and sheet resistance rise.

A pump's motor current is normally 9 A. Above 11.5 A plan its exchange; 13 A is the limit (DT-PMP).

The monthly maintenance includes a leak test and the methane controller's calibration.
""",
        tuple(a.lower() for a in REACTORS),
    ),
    "SOP-CVD-03": (
        "Process gases and their controllers",
        """Applies to the reactors' mass flow controllers. Owner: process engineering, CVD.

A drifting methane mass flow controller still reads its set point while it lets more methane through:
the graphene grows bilayer patches, Raman 2D/G falls below 2 and the film's transmittance falls. If
transmittance stays below 97.2 % on two runs of one reactor, recalibrate its methane controller
(DT-MFC). The controllers are calibrated at every monthly maintenance.
""",
        tuple(a.lower() for a in REACTORS),
    ),
    "SOP-EP-01": (
        "Copper foil electropolishing",
        """Applies to the electropolishing line EP-01. Owner: process engineering, CVD.

Each foil roll is polished at 3 m/min and 18 A/dm² in a bath at 35 °C. The bath is renewed at the
monthly maintenance; its conductivity is about 385 mS/cm when new.

The rectifier's current ripple is normally 1.5 %. Above 4 % inspect it; 6 % is its limit (DT-EPL).
A rectifier with ripple polishes less well. The lab measures the roughness Ra of each lot's first
roll after polishing (AFM), normally 60 to 80 nm: rougher foil grows smaller grains, and smaller
grains mean a higher sheet resistance.
""",
        ("ep-01",),
    ),
    "SOP-TR-01": (
        "Transfer: lamination",
        """Applies to the transfer lines TL-01 and TL-02. Owner: process engineering, transfer.

The graphene on copper is laminated onto adhesive-coated PET at 1 m/min between a heated roll at
120 °C and a nip of 4.0 bar. The roll's temperature spread across the width is normally 1.5 °C;
above 4 °C inspect the roll; 6 °C is its limit (DT-LAM). A worn roll traps bubbles and creases:
defects rise and the film can tear (TL-TEAR).
""",
        tuple(a.lower() for a in TRANSFERS),
    ),
    "SOP-TR-02": (
        "Transfer: copper etching and the bath",
        """Applies to the transfer lines' etch baths. Owner: process engineering, transfer.

The copper is etched away in a 4,000 L ammonium persulfate bath at 40 °C, circulating 180 L/min.
Each run dissolves about 15.5 kg of copper, 3.9 g/L of the bath.

- At 45 g/L of copper plan the bath change for the next shift.
- At 55 g/L change it (PL-BTH, 2.5 hours). Above that the etch slows and leaves copper behind:
  transmittance falls and rolls are rejected (QC-T).
- Etchant flow below 150 L/min: check the circulation pump (DT-ETC). A weak pump slows the etch too.
""",
        tuple(a.lower() for a in TRANSFERS),
    ),
    "SOP-QA-01": (
        "Inspection and grading",
        """Applies to the inline inspection IN-01 and the quality lab. Owner: quality.

IN-01 measures the film's sheet resistance (contactless), its transmittance at 550 nm and its
defects (holes, tears, bubbles) as it passes at 3 m/min. SP-01 slits each run's film into two
150 mm lanes of three 100 m rolls, and each roll is graded:

| Grade | Sheet resistance | Transmittance | Defects |
| --- | --- | --- | --- |
| A | 350 Ω/sq or less | 97.0 % or more | 3 a m² or fewer |
| B | 450 Ω/sq or less | 96.0 % or more | 8 a m² or fewer |
| NG | otherwise | | |

A roll needs at most 350 Ω/sq, at least 97.0 % and at most 3 defects a m² for grade A.
An NG roll is rejected for its worst fault: sheet resistance (QC-RS), transmittance (QC-T) or defects
(QC-DEF). A rejected roll costs about 420 GBP, a scrapped run about 2,600 GBP.

The lab takes a sample of each run: Raman D/G (normally 0.04; above 0.10 the graphene has defects)
and 2D/G (above 2 is monolayer), and a four-point probe's sheet resistance to check IN-01's.
""",
        ("in-01", "sp-01", "rm-01", "fp-01"),
    ),
    "SOP-EHS-01": (
        "Exhaust scrubber and hydrogen safety",
        """Applies to the exhaust scrubber SC-01 and the CVD hall. Owner: EHS and maintenance.

The scrubber takes the reactors' exhaust. Its pressure drop over the packing is normally 6 mbar;
clean the packing at 12 mbar; 14 mbar is its limit. If the scrubber trips, the CVD hall stops: every
reactor is purged with argon and its heaters switched off, and the runs in progress are lost
(CVD-ABT, DT-EXH).
""",
        ("sc-01",),
    ),
}


def overview() -> str:
    rows = "\n".join(f"| {m.asset} | {m.label} | {m.vendor} {m.model} | {m.area} |" for m in MACHINES)
    return f"""# Ashcombe film plant: overview

Sorrel Carbon's Ashcombe plant makes SG-300 transparent conductive film for touch sensors and
transparent heaters: monolayer graphene, grown by roll-to-roll CVD on copper foil and transferred onto
125 µm PET, sold in 150 mm rolls of 100 m. It works three shifts (crews A to C, rotating weekly) from
Monday 06:00 to Saturday 06:00, with England's bank holidays and a Christmas and a summer shutdown.

## Equipment

| Asset | What | Machine | Where |
| --- | --- | --- | --- |
{rows}

## Who acts on a warning

The shift lead receives the warnings and calls the maintenance technician of the shift. The
maintenance lead decides whether a warning was a true alarm. The CVD and transfer process engineers
own the recipes, the quality lead the grades and holds.

## Costs (controlling, 2026)

A reactor's stop costs 1,500 GBP an hour, the scrubber's 6,000 GBP (it stops the CVD hall), a
transfer line 900 GBP, electropolishing 600 GBP. A rejected roll costs 420 GBP, a scrapped run
2,600 GBP. Parts: {", ".join(f"{k} {v:,.0f} GBP" for k, v in PART_COSTS.items())}.
"""


def _month(t: float) -> str:
    return datetime.fromtimestamp(t, ZONE).strftime("%Y-%m")


def monthly_reports(year: sim.Year) -> dict[str, str]:
    by_month: dict[str, list[tuple[str, float, float, str, str, str | None]]] = defaultdict(list)
    for st in year.stations.values():
        for s in st.stops:
            if not s.planned:
                by_month[_month(s.start)].append((s.asset, s.start, s.end, s.code, s.comment, s.episode))
    made: dict[str, Counter[str]] = defaultdict(Counter)
    for run in year.runs:
        made[_month(run.job[0])]["runs"] += 1
    for x in year.rolls:
        key = _month(x.run.inspected[1])
        made[key]["rolls"] += 1
        if x.scrap:
            made[key]["rejected"] += 1
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
                f"- {datetime.fromtimestamp(x[1], ZONE):%d %B, %H:%M}: {x[0]}"
                f" {CODES[x[3]].description.lower()} ({x[4]})."
                for x in sorted(by_month[month], key=lambda x: x[1])
                if x[5] and not x[4].endswith("(continued)")
            )
            or "- No breakdowns of the watched components."
        )
        c = made[month]
        out[f"MR-{month}"] = f"""# Maintenance report, {title}

Unplanned stops from the MES. {c["runs"]:,} CVD runs started, {c["rolls"]:,} rolls inspected,
{c["rejected"]:,} rejected.

| Machine | Unplanned stops | Hours | Most frequent codes |
| --- | --- | --- | --- |
{chr(10).join(rows)}

## Breakdowns

{notes}
"""
    return out


ROOT_CAUSES = {
    "leak": "the tube's flange seals hardened; air leaked in and the oxygen etched the graphene as it grew.",
    "heater": "zone 2's heating element aged; it drew more power and at last could not hold 1,035 °C.",
    "pump": "the dry pump's bearings wore; its current rose until it tripped.",
    "mfc": "the methane controller drifted: it read 30 sccm while letting more through, growing bilayer patches.",
    "rectifier": "a rectifier board failed by degrees; the polishing current rippled and the foil came out rougher.",
    "laminator": "the laminator roll's surface wore unevenly; it heated unevenly and trapped bubbles.",
    "etch-pump": "the etchant pump's impeller wore; the bath circulated less and the etch slowed.",
    "packing": "the scrubber's packing fouled with the exhaust's deposits; its pressure drop rose until it tripped.",
}
ACTIONS = {
    "leak": "leak-test when the exhaust's oxygen passes 4 ppm (SOP-CVD-02).",
    "heater": "plan the element's replacement when its power passes 23 kW (SOP-CVD-01).",
    "pump": "plan the pump's exchange at 11.5 A (SOP-CVD-02).",
    "mfc": "recalibrate when transmittance stays below 97.2 % on two runs (SOP-CVD-03).",
    "rectifier": "inspect the rectifier above 4 % ripple, and watch the lots' roughness (SOP-EP-01).",
    "laminator": "inspect the roll above a 4 °C spread (SOP-TR-01).",
    "etch-pump": "check the pump when the flow falls below 150 L/min (SOP-TR-02).",
    "packing": "clean the packing at 12 mbar, before it trips the hall (SOP-EHS-01).",
}
FIRST = {
    "leak": "oxygen",
    "heater": "heater_power",
    "pump": "pump_current",
    "mfc": "in01.transmittance",
    "rectifier": "current_ripple",
    "laminator": "roll_temp_spread",
    "etch-pump": "etch_flow",
    "packing": "differential_pressure",
}


def lessons(year: sim.Year, stats: Stats) -> dict[str, str]:
    failed = [e for st in year.stations.values() for e in st.episodes if e.failed_at]
    hours: dict[str, float] = defaultdict(float)
    first_stop: dict[str, Stop] = {}
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
        mode = year.stations[e.asset].modes[e.mode]
        s = first_stop[e.id]
        machine = BY_ASSET[s.asset]
        tag = FIRST[e.mode] if "." in FIRST[e.mode] else f"{machine.key}.{FIRST[e.mode]}"
        before, last = _mean(stats, tag, (e.failed_at or 0) - 8 * 86400), _mean(stats, tag, (e.failed_at or 0) - 86400)
        signal = (
            f"`{tag}` averaged {before:.1f} a week before and {last:.1f} the day before."
            if before is not None and last is not None
            else f"`{tag}` was not logged then."
        )
        cost = hours[e.id] * machine.downtime_cost_gbp_h
        what = CODES[mode.code].description.lower()
        out[
            f"LL-{when:%Y}-{numbers[when.year]:02d}"
        ] = f"""# Lessons learned: {mode.component.lower()} on {s.asset}, {when:%d %B %Y}

**What happened:** {s.asset} stopped at {when:%H:%M} on {when:%A %d %B %Y} ({mode.code}: {what}).
The MES logged: "{s.comment}". It was down {hours[e.id]:.1f} hours, about {cost:,.0f} GBP of lost contribution.

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
    docs["PLANT-OVERVIEW"] = ("Ashcombe film plant overview", overview(), ("ashcombe",))
    if stats is not None:
        for k, text in lessons(year, stats).items():
            asset = text.split(" on ", 1)[1].split(",", 1)[0]
            docs[k] = (text.splitlines()[0].removeprefix("# "), text, (asset.lower(),))
    for k, text in monthly_reports(year).items():
        docs[k] = (text.splitlines()[0].removeprefix("# "), text, ("ashcombe",))
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
