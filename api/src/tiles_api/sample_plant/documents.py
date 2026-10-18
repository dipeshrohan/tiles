"""The plant's documents, for document search (T4.08) and the copilot: its SOPs, a maintenance
handbook, lessons-learned reports on the year's worst stops, and the maintenance team's monthly
reports. The SOPs' limits are the plant's: the simulation's machines behave as they say (a new
plunger tip reads about 15 bar in the slow phase, the wear limit is 36 bar; five porosity rejects in
thirty shots hold the cell). The reports are written from the year itself.
"""

from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any

from tiles_api.sample_plant import simulate as sim
from tiles_api.sample_plant.plant import CELLS, CODES, COSTS, PILOT, PRODUCTS, ZONE

if TYPE_CHECKING:
    from tiles_api.sample_plant.generate import Year


def die_ranges() -> str:
    return "\n".join(
        f"| {p.code} | {p.name} | {p.die_temp_c - 10:.0f} to {p.die_temp_c + 10:.0f} °C | {p.speed_2nd} m/s"
        f" | {p.intensification_bar:.0f} bar |"
        for p in PRODUCTS
    )


SOPS: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "SOP-DC-01": (
        "Start-up of a die-casting cell after a stop",
        f"""Applies to the die-casting cells of Line 1 and Line 2 (DC-01 to DC-06). Owner: process engineering.

## Before the first shot

1. Check the shot accumulator pressure on the HMI: it must be between 150 and 165 bar (nominal 160 bar).
   Below 145 bar, do not start: call maintenance (handbook MH-HYD-01).
2. Check the thermal control unit: oil at 200 °C, no alarms.
3. Run the vacuum test: the cavity must reach 80 mbar or less. Above 80 mbar, check the vacuum
   filter (SOP-DC-07) before casting.
4. Check the holding furnace: bath at 690 ± 5 °C (SOP-HF-03).

## Warm-up shots

After a stop of more than 30 minutes the die is cold. The first shots are warm-up shots: book them as
scrap with the code WU. Scrap three shots, plus two for each hour the cell stood, up to twelve.
After a weekend this is always twelve.

## Working die temperatures

| Product | Part | Die (fixed and moving halves) | Second-phase speed | Intensification |
| --- | --- | --- | --- | --- |
{die_ranges()}
""",
        ("dc-01", "dc-02", "dc-03", "dc-04", "dc-05", "dc-06"),
    ),
    "SOP-DC-04": (
        "Plunger tip and shot sleeve: inspection and change",
        """Applies to every die-casting machine. Owner: maintenance.

## The planned change

The plunger tip is changed every 20,000 shots, by the shot counter of the tip (HMI page "Shot end").
The change takes 35 to 55 minutes and is booked as PL-TIP. Lubricate the tip every shift.

## Watching the tip between changes

The shot cylinder pressure in the slow phase (tag `dcNN.plunger_pressure_1st`) shows the friction on
the plunger. With a new tip it reads about 15 bar; near the end of a tip's life about 21 bar.

- Over 25 bar: inspect the tip and the sleeve at the next stop.
- Over 30 bar: change the tip now. A scored tip seizes within hours to days.
- 36 bar is the wear limit: do not run the machine above it.

A seized plunger (DT-PLG) stops the cell for four to eight hours: the tip and often the shot sleeve
are changed, and the sleeve is honed. The shot sleeve (6,800 EUR) costs sixteen times as much as a
tip (420 EUR).
""",
        ("dc-01", "dc-02", "dc-03", "dc-04", "dc-05", "dc-06"),
    ),
    "SOP-DC-07": (
        "Vacuum system: filter change and leak test",
        """Applies to the vacuum units VU-01 to VU-06. Owner: maintenance.

The cavity vacuum at the shot (tag `dcNN.vacuum_level`, absolute pressure) is normally 45 to 55 mbar.
The vacuum filter is changed at every fourth weekly planned maintenance (monthly).

- Above 100 mbar: check the filter and the vacuum valve at the next stop.
- Above 150 mbar: change the filter now; porosity rises quickly.
- A blocked valve stops the cell (DT-VAC).

Porosity found at X-ray (SOP-QA-05) is often the first sign of a clogged filter.
""",
        ("vu-01", "vu-02", "vu-03", "vu-04", "vu-05", "vu-06"),
    ),
    "SOP-DC-09": (
        "Die cooling: flow limits and descaling",
        """Applies to the dies of every die-casting cell. Owner: maintenance and tooling.

The moving die half's cooling flow (tag `dcNN.cooling_flow_moving`) is normally about 42 l/min with a
freshly serviced die; it falls slowly as the channels scale, to about 38 l/min at the end of a die's
run. The fixed half runs at about 46 l/min.

- Below 36 l/min: plan descaling at the next die change.
- Below 32 l/min: descale now. The moving half runs hot (above 255 °C), parts solder (scrap code
  SOLD) and the die must be cleaned (DT-DIE).

Dies go for maintenance every eight to ten weeks (a spare die is fitted, PL-DIE), which descales them.
""",
        ("dc-01", "dc-02", "dc-03", "dc-04"),
    ),
    "SOP-DC-11": (
        "Spray robot: nozzle cleaning",
        """Applies to the spray robots SR-01 to SR-06. Owner: production.

The spray manifold pressure (tag `dcNN.spray_pressure`) is 5.0 to 5.4 bar. Below 4.6 bar nozzles are
blocking: clean them at the next stop. Below 4.0 bar parts stick in the die (scrap code STK) and the
die runs hotter; stop and clean the nozzles (DT-SPR, about an hour).
""",
        ("sr-01", "sr-02", "sr-03", "sr-04", "sr-05", "sr-06"),
    ),
    "SOP-ML-02": (
        "Melt treatment: degassing and the hydrogen test",
        """Applies to the melting furnaces MF-01 and MF-02 and the degassing station DG-01. Owner: melting.

Every transport ladle is degassed with the rotor at DG-01. The lab tests the melt twice a shift
(density index; the hydrogen in ml per 100 g is recorded as `lab.hydrogen`).

- Target: 0.15 ml/100 g or less (typically 0.08 to 0.13; a little higher in summer, when the air is damp).
- Above 0.19 ml/100 g: degas the ladle again and check the rotor; a worn rotor degasses poorly.

Hydrogen in the melt causes gas porosity in every cell the melt goes to.
""",
        ("mf-01", "mf-02", "dg-01"),
    ),
    "SOP-HF-03": (
        "Holding furnace: temperatures and heater checks",
        """Applies to the holding furnaces HF-01 to HF-06. Owner: maintenance.

The bath is held at 690 ± 5 °C in production and lowered to 655 °C when no shift is planned. The
heater power (tag `hfNN.heater_power`) is normally 34 to 50 kW in production.

- Above 58 kW in production: a heater element is ageing. Measure the element resistances at the next
  planned maintenance.
- A failed element lets the bath cool: below 665 °C the parts show cold shuts (scrap code CS). The
  cell stops (DT-FUR) for six to twelve hours while the element is changed (about 1,900 EUR).
""",
        ("hf-01", "hf-02", "hf-03", "hf-04", "hf-05", "hf-06"),
    ),
    "SOP-QA-05": (
        "X-ray inspection and porosity grades",
        """Applies to every housing from Line 2 (TH-410, EM-220, CV-90) and to Line 1's brackets. Owner: quality.

Every part is X-rayed at XR-01 or XR-02 and given a porosity grade by the porosity found:

| Grade | Porosity | Result |
| --- | --- | --- |
| 0 | below 0.6 % | OK |
| 1 | 0.6 to 0.85 % | OK |
| 2 | 0.85 to 1.1 % | OK, noted |
| 3 | 1.1 to 1.4 % | Scrap (POR) |
| 4 | 1.4 % or more | Scrap (POR) |

Five porosity rejects within thirty shots of one cell: quality holds the cell (DT-QH) and checks the
vacuum, the shot settings and the melt before it may cast again.
""",
        ("xr-01", "xr-02"),
    ),
    "MH-HYD-01": (
        "Maintenance handbook: hydraulics of the die-casting machines",
        """Applies to every die-casting machine. Owner: maintenance.

## Shot accumulator

The accumulator is charged with nitrogen to 90 bar and recharged by the pump to 160 bar after each
shot. Check the nitrogen precharge at every weekly planned maintenance.

A leaking precharge shows first in the intensification: the pressure build-up time (tag
`dcNN.pressure_buildup_time`) is normally 22 to 27 ms. Over 40 ms, recharge the accumulator; the
intensification pressure falls and porosity rises. The machine trips (DT-HYD) when the build-up is
too slow.

## Hydraulic oil

The oil tank runs at 35 to 50 °C in production. The machine trips at 58 °C (DT-OIL). In summer the
oil cooler fouls with the warmer cooling water: flush it when the oil runs above 52 °C.
""",
        ("dc-01", "dc-02", "dc-03", "dc-04", "dc-05", "dc-06"),
    ),
}


def overview() -> str:
    cost = COSTS.downtime_eur_h
    cells = "\n".join(
        f"| {c.asset} | {c.line} | {c.vendor} {c.model} | {c.locking_kn:,} kN | {c.year} | {', '.join(c.dies)} |"
        for c in CELLS
    )
    return f"""# Kesselbach plant: overview

Aldermoor Castings' Kesselbach plant casts aluminium housings and brackets for car makers and their
suppliers: transmission housings, e-motor housings, gearbox covers and mounting brackets.

## Die-casting cells

| Cell | Line | Machine | Locking force | Built | Products |
| --- | --- | --- | --- | --- | --- |
{cells}

Each cell has a holding furnace (HF), a spray robot (SR), an extraction robot (ER), a trim press (TP)
and a vacuum unit (VU), controlled by the cell's PLC. Line 2's cells are the pilot: their PLCs
(Siemens S7-1500) serve OPC UA and every shot is logged. Line 1's older cells (S7-300) send two
five-minute averages over MQTT.

## Shifts

Three shifts (night 22:00 to 06:00 from Sunday night, early 06:00 to 14:00, late 14:00 to 22:00) on
weekdays, and a Saturday early shift except in July, August and December. Crews A, B and C rotate weekly.

## Who acts on a warning

The shift lead of Line 2 (crews A, B, C) receives the warnings and calls the maintenance technician of
the shift. The maintenance lead decides whether a warning was a true alarm. The process engineer
owns the shot settings and the quality lead the X-ray grades and quality holds.

## Costs (controlling, 2026)

A stop costs {cost["DC-01"]:,.0f} EUR an hour on DC-01 and DC-02, {cost["DC-03"]:,.0f} EUR on DC-03,
{cost["DC-04"]:,.0f} EUR on DC-04 and {cost["DC-05"]:,.0f} EUR on Line 1's cells. A scrapped part
costs {", ".join(f"{p.scrap_cost_eur:.0f} EUR ({p.code})" for p in PRODUCTS)}.
"""


def _month(t: float) -> str:
    return datetime.fromtimestamp(t, ZONE).strftime("%Y-%m")


def monthly_reports(year: "Year") -> dict[str, str]:
    stops = [s for r in year.cells.values() for s in r.stops]
    by_month: dict[str, list[sim.Stop]] = defaultdict(list)
    for s in stops:
        by_month[_month(s.start)].append(s)
    scrap: dict[tuple[str, str], int] = Counter()
    for asset, r in year.cells.items():
        for t, _, _, _ in r.scrap:
            scrap[(_month(t), asset)] += 1
    parts: dict[tuple[str, str], int] = Counter()
    for (asset, i), n in year.counts.items():
        parts[(year.shifts[i].start.strftime("%Y-%m"), asset)] += n.parts
    out = {}
    for month in sorted(by_month):
        title = datetime.strptime(month, "%Y-%m").strftime("%B %Y")
        rows = []
        for c in CELLS:
            mine = [s for s in by_month[month] if s.asset == c.asset and not s.planned]
            hours = sum(s.end - s.start for s in mine) / 3600
            top = Counter(s.code for s in mine).most_common(3)
            p = parts[(month, c.asset)]
            rate = 100 * scrap[(month, c.asset)] / p if p else 0.0
            rows.append(
                f"| {c.asset} | {len(mine)} | {hours:.1f} | {', '.join(f'{k} ({v})' for k, v in top)} | {rate:.1f} % |"
            )
        failures = [s for s in by_month[month] if s.episode and not s.comment.endswith("(continued)")]
        notes = (
            "\n".join(
                f"- {datetime.fromtimestamp(s.start, ZONE):%d %B, %H:%M}: {s.asset}"
                f" {CODES[s.code].description.lower()} ({s.comment})."
                for s in failures
            )
            or "- No breakdowns of the watched components."
        )
        out[f"MR-{month}"] = f"""# Maintenance report, {title}

Unplanned stops of the die-casting cells, from the MES, and their scrap rates.

| Cell | Unplanned stops | Hours | Most frequent codes | Scrap |
| --- | --- | --- | --- | --- |
{chr(10).join(rows)}

## Breakdowns

{notes}
"""
    return out


def lessons(year: "Year") -> dict[str, str]:
    """A lessons-learned report on each of the year's failures of a watched component on Line 2,
    longest first: what the readings did in the days before."""
    failed = [e for c in PILOT for e in year.cells[c.asset].episodes if e.failed_at]
    stops = {
        s.episode: s
        for r in year.cells.values()
        for s in r.stops
        if s.episode and not s.comment.endswith("(continued)")
    }
    hours: dict[str, float] = defaultdict(float)
    for r in year.cells.values():
        for s in r.stops:
            if s.episode:
                hours[s.episode] += (s.end - s.start) / 3600
    failed.sort(key=lambda e: -hours[e.id])
    out = {}
    numbers: Counter[int] = Counter()
    for e in sorted(failed[:10], key=lambda e: e.failed_at or 0):
        cell = next(c for c in CELLS if c.asset == e.asset)
        s = stops[e.id]
        tag = _precursor(cell, e.mode)
        before = _mean(year, tag, (e.failed_at or 0) - 8 * 86400, (e.failed_at or 0) - 5 * 86400)
        last = _mean(year, tag, (e.failed_at or 0) - 86400, (e.failed_at or 0))
        when = datetime.fromtimestamp(e.failed_at or 0, ZONE)
        numbers[when.year] += 1
        n = numbers[when.year]
        onset = datetime.fromtimestamp(e.onset, ZONE)
        mode = sim.MODES[e.mode]
        cost = hours[e.id] * cell.downtime_cost_eur_h
        what = CODES[mode.code].description.lower()
        signal = (
            f"`{tag}` averaged {before:.1f} a week before and {last:.1f} in the last day."
            if before is not None and last is not None
            else f"`{tag}` was not logged over that time."
        )
        out[f"LL-{when:%Y}-{n:02d}"] = f"""# Lessons learned: {mode.component.lower()} on {e.asset}, {when:%d %B %Y}

**What happened:** {e.asset} stopped at {when:%H:%M} on {when:%A %d %B %Y} ({mode.code}: {what}).
The MES logged: "{s.comment}". The cell was down {hours[e.id]:.1f} hours, about {cost:,.0f} EUR
of lost contribution.

**What the data showed:** the problem started around {onset:%d %B}. {signal}

**Root cause:** {ROOT_CAUSES[e.mode]}

**Actions:** {ACTIONS[e.mode]}
"""
    return out


ROOT_CAUSES = {
    "plunger": "the plunger tip scored in the shot sleeve and friction rose shot by shot until it seized.",
    "accumulator": "the shot accumulator's nitrogen precharge leaked away; the intensification built up too slowly.",
    "cooling": "a cooling channel in the moving die half scaled up; the die ran hot and the parts soldered.",
    "vacuum": "the vacuum filter clogged; the cavity vacuum worsened until the valve blocked.",
    "spray": "spray nozzles blocked; the die ran hot and parts stuck.",
    "furnace": "a heater element of the holding furnace aged and failed; the bath cooled.",
    "oil": "the hydraulic oil cooler fouled with the warm summer cooling water; the oil overheated.",
}
ACTIONS = {
    "plunger": "watch the slow-phase pressure and change the tip above 30 bar (SOP-DC-04).",
    "accumulator": "check the build-up time each shift; recharge the precharge above 40 ms (MH-HYD-01).",
    "cooling": "watch the moving-half flow; descale below 32 l/min (SOP-DC-09).",
    "vacuum": "change the filter above 150 mbar, not only at the monthly PM (SOP-DC-07).",
    "spray": "clean the nozzles below 4.6 bar (SOP-DC-11).",
    "furnace": "measure the element resistances when the heater power runs above 58 kW (SOP-HF-03).",
    "oil": "flush the oil cooler before summer and above 52 °C (MH-HYD-01).",
}


def _precursor(cell: Any, mode: str) -> str:
    first = {
        "plunger": "plunger_pressure_1st",
        "accumulator": "pressure_buildup_time",
        "cooling": "cooling_flow_moving",
        "vacuum": "vacuum_level",
        "spray": "spray_pressure",
        "furnace": "heater_power",
        "oil": "hydraulic_oil_temp",
    }[mode]
    return f"hf{cell.number:02d}.{first}" if first == "heater_power" else f"{cell.key}.{first}"


def _mean(year: "Year", tag: str, a: float, b: float) -> float | None:
    """The mean of a tag's readings over whole plant days from a to b (the daily statistics)."""
    total = n = 0.0
    day = datetime.fromtimestamp(a, ZONE).date()
    last = datetime.fromtimestamp(b, ZONE).date()
    while day <= last:
        s = year.stats.days.get((tag, day.isoformat()))
        if s:
            total += s[2]
            n += s[3]
        day = day.fromordinal(day.toordinal() + 1)
    return total / n if n else None


def all_documents(year: "Year") -> dict[str, tuple[str, str, tuple[str, ...]]]:
    """Every document: id → (title, Markdown, the plant model's nodes it describes)."""
    docs = {k: (title, f"# {k}: {title}\n\n{body}", nodes) for k, (title, body, nodes) in SOPS.items()}
    docs["PLANT-OVERVIEW"] = ("Kesselbach plant overview", overview(), ("kesselbach",))
    for k, text in lessons(year).items():
        asset = text.split(" on ", 1)[1].split(",", 1)[0]
        docs[k] = (text.splitlines()[0].removeprefix("# "), text, (asset.lower(),))
    for k, text in monthly_reports(year).items():
        docs[k] = (text.splitlines()[0].removeprefix("# "), text, ("die-casting",))
    return docs


def write(out: Path, year: "Year") -> dict[str, int]:
    folder = out / "documents"
    folder.mkdir(parents=True, exist_ok=True)
    for old in folder.glob("*.md"):
        old.unlink()
    docs = all_documents(year)
    for k, (_, text, _) in docs.items():
        (folder / f"{k}.md").write_text(text, encoding="utf-8")
    return {"documents": len(docs)}
