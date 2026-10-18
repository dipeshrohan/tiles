"""Writes the sample plant's files: what a partner hands over at the assessment (T2.16), made from
a year's simulation (simulate.py).

The files under the output directory (data/sample-plants/die-casting/ in the repository) are small and kept in
Git: the plant model, the tag list, the MES's stops, scrap and production, the shift calendar, the
CMMS's work orders, the lab's hydrogen tests, costs, documents, the copilot's question set and the
ground truth. The historian export, the per-shot quality table and the shot curves are large; they
are written under `generated/` (not in Git) when asked for, and the manifest gives each file's rows
and the SHA-256 of its uncompressed text, so a run can be checked against the one that made the
committed files.
"""

import bisect
import json
import random
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from tiles_api.sample_plant.common import Capture, Historian, Stats, Text, iso, write_csv
from tiles_api.sample_plant.common import local as local_in
from tiles_api.sample_plant.die_casting import calendar as cal
from tiles_api.sample_plant.die_casting import simulate as sim
from tiles_api.sample_plant.die_casting.plant import (
    CELLS,
    CODES,
    COSTS,
    DOWNTIME_CODES,
    END,
    FINISHING,
    MACHINING,
    MELTING,
    OLD_CODES,
    PEOPLE,
    PILOT,
    PRODUCTS,
    QUALITY,
    SCRAP_CODES,
    SEED,
    SITE_TAGS,
    START,
    UTILITIES,
    ZONE,
    Cell,
    all_tags,
    cell_equipment,
    ontology,
)

# Known gaps and errors, as a real export has them (README: "Known gaps").
OUTAGE = ("dc03", "hf03", datetime(2026, 2, 10, 6, tzinfo=ZONE), datetime(2026, 2, 12, 14, tzinfo=ZONE))
STUCK = (
    "dc02.die_temp_fixed",
    238.4,
    datetime(2026, 1, 19, 10, tzinfo=ZONE),
    datetime(2026, 1, 22, 15, 30, tzinfo=ZONE),
)
MPA = ("dc04.intensification_pressure", datetime(2026, 5, 11, 8, tzinfo=ZONE), datetime(2026, 5, 18, 7, tzinfo=ZONE))
MIXED_UP = 2  # stops of DC-04 the MES booked on DC-03
DUPLICATES = 0.004  # stops logged twice
NO_END = 0.003  # stops with no end time

PRECURSORS = {
    "plunger": "plunger_pressure_1st",
    "accumulator": "pressure_buildup_time; intensification_pressure; accumulator_pressure",
    "cooling": "cooling_flow_moving; die_temp_moving",
    "vacuum": "vacuum_level",
    "spray": "spray_pressure; die_temp_moving",
    "furnace": "heater_power; bath_temp",
    "oil": "hydraulic_oil_temp",
    "degassing": "lab.hydrogen",
}
TECHNICIAN = {"A": "Sofia Reiter", "B": "Tobias Lang", "C": "Emre Kaya"}
PARTS = {
    "DT-PLG": ("Plunger tip; shot sleeve honing", COSTS.plunger_tip_eur + 650),
    "PL-TIP": ("Plunger tip", COSTS.plunger_tip_eur),
    "DT-HYD": ("Nitrogen", COSTS.accumulator_recharge_eur),
    "DT-VAC": ("Vacuum filter", COSTS.vacuum_filter_eur),
    "DT-FUR": ("Heater element", COSTS.heater_element_eur),
    "DT-SPR": ("Spray nozzles (set)", 240.0),
    "DT-OIL": ("Cooler cleaning agent", 80.0),
    "DT-DIE": ("Descaling agent", 60.0),
}


def local(t: float) -> str:
    """The plant's time with its offset, as the MES exports."""
    return local_in(t, ZONE)


QUESTION_MONTH = (datetime(2026, 5, 1, tzinfo=ZONE), datetime(2026, 6, 1, tzinfo=ZONE))  # the question set's month


def quirk(tag: str, t: float, value: float) -> float | None:
    """What the historian holds for a reading: nothing in the outage, the stuck value, MPa."""
    prefix = tag.split(".", 1)[0]
    if prefix in OUTAGE[:2] and OUTAGE[2].timestamp() <= t < OUTAGE[3].timestamp():
        return None
    if tag == STUCK[0] and STUCK[2].timestamp() <= t < STUCK[3].timestamp():
        return STUCK[1]
    if tag == MPA[0] and MPA[1].timestamp() <= t < MPA[2].timestamp():
        return round(value / 10, 1)
    return value


QUALITY_COLUMNS = (
    "shot_id,time,asset,product,cycle_time,shot_speed_1st,shot_speed_2nd,fill_time,intensification_pressure,"
    "pressure_buildup_time,biscuit_length,vacuum_level,die_temp_fixed,die_temp_moving,plunger_pressure_1st,"
    "spray_pressure,bath_temp,hydrogen,porosity,xray_grade,parts,scrapped,defect,result"
)
VALUE_ORDER = (
    "cycle_time",
    "shot_speed_1st",
    "shot_speed_2nd",
    "fill_time",
    "intensification_pressure",
    "pressure_buildup_time",
    "biscuit_length",
    "vacuum_level",
    "die_temp_fixed",
    "die_temp_moving",
    "plunger_pressure_1st",
    "spray_pressure",
    "bath_temp",
)


def month_of(t: float) -> str:
    """The X-ray table a shot goes in: one per cell and month."""
    return datetime.fromtimestamp(t, ZONE).strftime("%Y-%m")


def quality_row(cell: Cell, r: sim.ShotRecord) -> dict[str, Any]:
    """A shot's row in the X-ray table (the stuck thermocouple reads stuck there too)."""
    values = dict(r.values)
    if STUCK[0] == f"{cell.key}.die_temp_fixed" and STUCK[2].timestamp() <= r.at < STUCK[3].timestamp():
        values["die_temp_fixed"] = STUCK[1]
    return {
        "shot_id": r.shot_id,
        "time": iso(r.at),
        "asset": cell.asset,
        "product": r.product,
        **{k: values[k] for k in VALUE_ORDER},
        "hydrogen": r.hydrogen,
        "porosity": r.porosity,
        "xray_grade": r.grade,
        "parts": r.parts,
        "scrapped": r.scrapped,
        "defect": r.defect,
        "result": "NG" if r.scrapped else "OK",
    }


@dataclass
class Counts:
    shots: int = 0
    parts: int = 0
    scrap: int = 0


@dataclass
class Year:
    """Everything the simulation made, for the files."""

    shifts: list[cal.Shift]
    working: sim.Working
    site: sim.SiteSeries
    cells: dict[str, sim.CellResult]
    other_stops: list[sim.Stop]
    counts: dict[tuple[str, int], Counts]  # (asset, shift index)
    stats: Stats
    files: dict[str, dict[str, Any]]
    trace_window: tuple[float, float]
    quality_ng: dict[str, int]
    capture: Capture


def simulate(out: Path, big: bool) -> Year:
    shifts = cal.shifts()
    working = sim.Working(cal.working_intervals(shifts))
    site = sim.site_series(working, shifts)
    stats = Stats(ZONE)
    capture = Capture(QUESTION_MONTH[0].timestamp(), QUESTION_MONTH[1].timestamp())
    hist = Historian(out / "generated" if big else None, stats, capture)
    starts = [s.start.timestamp() for s in shifts]
    counts: dict[tuple[str, int], Counts] = defaultdict(Counts)
    quality_files: dict[str, Text] = {}
    files: dict[str, dict[str, Any]] = {}
    quality_ng: dict[str, int] = defaultdict(int)

    # The site's readings: the hall, cooling water, compressed air, MF-01 and the lab.
    for i in range(len(site.ambient)):
        t = site.t0 + i * sim.GRID
        hist.write("site", "hall.ambient_temp", t, round(site.ambient[i], 1))
        hist.write("site", "ct01.supply_temp", t, round(site.water[i], 1))
        hist.write("site", "cp01.header_pressure", t, round(site.air[i], 2))
        hist.write("site", "mf01.melt_temp", t, round(site.melt[i], 1))
        hist.write("site", "mf01.gas_flow", t, round(site.gas[i], 1))
    for t, h2 in zip(site.lab_times, site.lab_h2, strict=True):
        hist.write("lab", "lab.hydrogen", t, h2)
    hist.close()

    mf = sim.melting_stops(working)
    others: list[sim.Stop] = list(mf)
    rates = {
        "MF-02": (160.0, 30.0, ("DT-ELE", "DT-OTH", "DT-SEN")),
        "SB-01": (70.0, 35.0, ("DT-ELE", "DT-OTH", "DT-SEN")),
        "FT-01": (60.0, 20.0, ("DT-ROB", "DT-OTH", "DT-ELE")),
        "IM-01": (120.0, 60.0, ("DT-ELE", "DT-OTH")),
        "CNC-01": (80.0, 40.0, ("DT-ELE", "DT-SEN", "DT-OTH")),
        "CNC-02": (80.0, 40.0, ("DT-ELE", "DT-SEN", "DT-OTH")),
        "CNC-03": (95.0, 35.0, ("DT-ELE", "DT-SEN", "DT-OTH")),
        "CNC-04": (95.0, 35.0, ("DT-ELE", "DT-SEN", "DT-OTH")),
        "LT-01": (110.0, 25.0, ("DT-SEN", "DT-OTH")),
    }
    for asset, (mean_h, median, codes) in rates.items():
        others += sim.other_stops(asset, working, mean_h, median, codes)

    # DC-01's shot curves cover the two weeks before its first plunger seizure in 2026.
    probe = sim.CellSim(CELLS[0], working, shifts, site, mf, lambda *a: None, lambda *a: None, None, None).run()
    seizure = next(
        e.failed_at
        for e in probe.episodes
        if e.mode == "plunger" and e.failed_at and e.failed_at > datetime(2026, 1, 15, tzinfo=ZONE).timestamp()
    )
    window = (seizure - 14 * 86400, seizure + 86400)
    trace_rng = random.Random(f"{SEED}/DC-01/trace")
    traces = (
        Text(out / "generated" / "traces" / "dc01-shots.csv.gz", "timestamp,tag,value,quality", True) if big else None
    )

    def trace(t: float, friction: float) -> None:
        if traces is None:
            return
        v, ph, pm = sim.trace_shot(trace_rng, friction)
        for i in range(sim.SAMPLES):
            at = t + i * sim.DT
            traces.line(f"{iso(at)},dc01.shot.v,{v[i]:.4f},Good")
            traces.line(f"{iso(at)},dc01.shot.ph,{ph[i]:.2f},Good")
            traces.line(f"{iso(at)},dc01.shot.pm,{pm[i]:.2f},Good")

    results: dict[str, sim.CellResult] = {}
    for c in CELLS:
        stream = f"line{c.line[-1]}-{c.key}"

        def reading(tag: str, t: float, value: float | str, stream: str = stream) -> None:
            v = quirk(tag, t, float(value)) if isinstance(value, float | int) else value
            if v is not None:
                hist.write(stream, tag, t, v)

        def shot(cell: Cell, r: sim.ShotRecord) -> None:
            i = max(0, bisect.bisect_right(starts, r.at) - 1)
            n = counts[(cell.asset, i)]
            n.shots += 1
            n.parts += r.parts
            n.scrap += r.scrapped
            if r.scrapped:
                quality_ng[cell.asset] += 1
            if cell.historian != "full":
                return
            if capture.start <= r.at < capture.end:
                capture.quality[cell.asset].append(quality_row(cell, r))
            if not big:
                return
            key = f"quality/{cell.key}-{month_of(r.at)}.csv.gz"
            f = quality_files.get(key)
            if f is None:
                for k in [k for k in quality_files if k.startswith(f"quality/{cell.key}-")]:
                    files[k] = quality_files.pop(k).close()
                f = quality_files[key] = Text(out / "generated" / key, QUALITY_COLUMNS, True)
            row = quality_row(cell, r)
            f.line(",".join(str(row[k]) for k in QUALITY_COLUMNS.split(",")))

        is_dc01 = c.number == 1
        results[c.asset] = sim.CellSim(
            c, working, shifts, site, mf, reading, shot, trace if is_dc01 else None, window if is_dc01 else None
        ).run()
        hist.close()
    for k, f in quality_files.items():
        files[k] = f.close()
    if traces:
        files["traces/dc01-shots.csv.gz"] = traces.close()
    files.update(hist.files)
    return Year(shifts, working, site, results, others, counts, stats, files, window, dict(quality_ng), capture)


# ---- the committed files -------------------------------------------------------------------------


def mes_stops(year: Year) -> list[list[Any]]:
    """The MES's stop log as it is exported: its code changes, mix-ups, duplicates and blanks."""
    rng = random.Random(f"{SEED}/mes")
    starts = [s.start.timestamp() for s in year.shifts]
    stops = [s for r in year.cells.values() for s in r.stops] + year.other_stops
    stops.sort(key=lambda s: (s.start, s.asset))
    rows = []
    mixed = 0
    for s in stops:
        sh = year.shifts[max(0, bisect.bisect_right(starts, s.start) - 1)]
        code = s.code
        old = OLD_CODES.get(code)
        if old and s.start < old[1].timestamp():
            code = old[0]
        asset = s.asset
        if (
            asset == "DC-04"
            and not s.planned
            and mixed < MIXED_UP
            and s.start > datetime(2026, 3, 1, tzinfo=ZONE).timestamp()
            and rng.random() < 0.05
        ):
            asset, mixed = "DC-03", mixed + 1
        end = "" if rng.random() < NO_END and not s.planned else local(s.end)
        row = [asset, local(s.start), end, code, "yes" if s.planned else "no", sh.name, sh.crew, s.comment]
        rows.append(row)
        if rng.random() < DUPLICATES:
            rows.append(list(row))
    return [[f"S{i + 1:06d}", *r] for i, r in enumerate(rows)]


def production(year: Year) -> list[list[Any]]:
    rows = []
    stops_by_asset: dict[str, list[sim.Stop]] = defaultdict(list)
    for r in year.cells.values():
        for s in r.stops:
            stops_by_asset[s.asset].append(s)
    for c in CELLS:
        mine = stops_by_asset[c.asset]
        changes = year.cells[c.asset].die_changes
        j = 0
        for i, sh in enumerate(year.shifts):
            a, b = sh.start.timestamp(), sh.end.timestamp()
            planned = unplanned = 0.0
            while j < len(mine) and mine[j].end <= a:
                j += 1
            k = j
            while k < len(mine) and mine[k].start < b:
                s = mine[k]
                overlap = max(0.0, min(b, s.end) - max(a, s.start))
                if s.planned:
                    planned += overlap
                else:
                    unplanned += overlap
                k += 1
            n = year.counts.get((c.asset, i), Counts())
            idx = bisect.bisect_right([t for t, _ in changes], a) - 1
            product = changes[idx][1] if idx >= 0 else c.dies[0]
            rows.append(
                [
                    sh.day.isoformat(),
                    sh.name,
                    sh.crew,
                    c.asset,
                    product,
                    round((b - a) / 60),
                    round(planned / 60),
                    round(unplanned / 60),
                    n.shots,
                    n.parts,
                    n.scrap,
                    n.parts - n.scrap,
                ]
            )
    return rows


def work_orders(year: Year) -> list[list[Any]]:
    jobs = [m for r in year.cells.values() for m in r.maintenance]
    for s in year.other_stops:
        if s.code in ("DT-ELE", "DT-SEN", "DT-FUR", "DT-ROB"):
            jobs.append(sim.Maintenance(s.asset, s.start, s.end, "CM", "", s.code, s.comment))
    jobs.sort(key=lambda m: (m.start, m.asset, m.kind))
    starts = [s.start.timestamp() for s in year.shifts]
    rng = random.Random(f"{SEED}/cmms")
    rows = []
    for i, m in enumerate(jobs):
        sh = year.shifts[max(0, bisect.bisect_right(starts, m.start) - 1)]
        tech = TECHNICIAN[sh.crew]
        part, cost = PARTS.get(m.code, ("", 0.0)) if m.kind != "PM" or m.code == "PL-TIP" else ("", 0.0)
        if m.kind == "INSP":
            part, cost = PARTS.get(m.code, ("", 0.0))
        hours = max(0.25, (m.end - m.start) / 3600 * rng.uniform(0.8, 1.3))
        # A breakdown is reported a few minutes after it stops the machine, and the technician
        # starts once there; planned work is booked as it starts.
        reported, started = m.start, m.start
        if m.kind == "CM":
            reported = m.start + rng.uniform(1, 5) * 60
            started = min(m.end, reported + rng.uniform(5, 20) * 60)
        wo_type = {"CM": "Corrective", "PM": "Preventive", "INSP": "Condition-based"}[m.kind]
        component = m.component or {"PL-PM": "Die-casting cell", "PL-DIE": "Die"}.get(m.code, "")
        rows.append(
            [
                f"WO-{datetime.fromtimestamp(m.start, ZONE):%y}-{i + 1:05d}",
                wo_type,
                m.asset,
                component,
                m.code,
                local(reported),
                local(started),
                local(m.end),
                round(hours, 2),
                tech,
                part,
                round(cost, 2),
                m.text,
                m.episode or "",
            ]
        )
    return rows


def episodes(year: Year) -> list[list[Any]]:
    rows = []
    every = [e for r in year.cells.values() for e in r.episodes] + year.site.degas_episodes
    for e in sorted(every, key=lambda e: (e.onset, e.asset)):
        cell = next((c for c in CELLS if c.asset == e.asset), None)
        tags = PRECURSORS[e.mode]
        if cell:
            prefix = cell.key
            tags = "; ".join(
                f"hf{cell.number:02d}.{t}" if t in ("heater_power", "bath_temp") else f"{prefix}.{t}"
                for t in tags.split("; ")
            )
            if cell.historian != "full":
                tags = f"(not logged on {cell.asset}) {tags}"
        code = sim.MODES[e.mode].code if e.mode in sim.MODES else ""
        rows.append(
            [
                e.id,
                e.asset,
                e.mode,
                code,
                local(e.onset),
                local(e.failed_at) if e.failed_at else "",
                local(e.resolved_at) if e.resolved_at else "",
                e.outcome,
                round(e.peak, 2),
                round(e.ramp_s / 86400, 2),
                tags,
            ]
        )
    return rows


def planned_stops(year: Year) -> list[list[Any]]:
    rows = [["", local(a), local(b), why, "PL-SHD"] for a, b, why in cal.gaps(year.working.intervals)]
    for r in year.cells.values():
        for s in r.stops:
            if s.planned:
                rows.append([s.asset, local(s.start), local(s.end), s.comment, s.code])
    rows.sort(key=lambda r: (r[1], r[0]))
    return rows


def write_committed(out: Path, year: Year) -> dict[str, int]:
    n: dict[str, int] = {}
    from tiles_api.sample_plant.die_casting import documents

    nodes, edges = ontology()
    known = {nd["id"] for nd in nodes}
    for key, (title, _, about) in documents.all_documents(year).items():
        doc = f"doc-{key.lower()}"
        nodes.append(
            {
                "id": doc,
                "type": "Document",
                "label": f"{key}: {title}" if key.startswith(("SOP", "MH")) else title,
                "props": {"number": key},
            }
        )
        edges += [{"id": f"{doc}-describes-{n}", "from": doc, "rel": "describes", "to": n} for n in about if n in known]
    (out / "plant").mkdir(parents=True, exist_ok=True)
    body = {"format": "tiles-ontology", "version": 1, "nodes": nodes, "edges": edges}
    (out / "plant" / "ontology.json").write_text(
        json.dumps(body, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    n["plant/ontology.json"] = len(nodes)
    tags = all_tags()
    n["plant/tags.csv"] = write_csv(
        out / "plant" / "tags.csv",
        (
            "tag",
            "unit",
            "kind",
            "sample_rate_hz",
            "description",
            "asset",
            "measure",
            "range_min",
            "range_max",
            "stuck_after_s",
            "wear_limit",
            "wear_direction",
            "event_kind",
        ),
        (
            (
                t.tag,
                t.unit,
                t.kind,
                t.rate_hz,
                t.description,
                t.asset,
                t.measure,
                t.low,
                t.high,
                t.stuck_after_s,
                t.wear_limit,
                t.wear_direction,
                t.event_kind,
            )
            for t in tags
        ),
    )
    equipment: list[list[Any]] = []
    for c in CELLS:
        equipment.append(
            [
                c.asset,
                f"{c.asset} die-casting machine",
                "die-caster",
                c.vendor,
                c.model,
                c.year,
                c.line,
                f"Cell {c.asset}",
                c.plc_model,
                c.protocol,
            ]
        )
        for e in cell_equipment(c):
            equipment.append([e.asset, e.label, e.kind, e.vendor, e.model, e.year, c.line, f"Cell {c.asset}", "", ""])
    for area, group in (
        ("Melting", MELTING),
        ("Finishing", FINISHING),
        ("Machining", MACHINING),
        ("Quality lab", QUALITY),
        ("Utilities", UTILITIES),
    ):
        for e in group:
            equipment.append([e.asset, e.label, e.kind, e.vendor, e.model, e.year, area, "", "", ""])
    n["plant/equipment.csv"] = write_csv(
        out / "plant" / "equipment.csv",
        ("asset", "label", "kind", "vendor", "model", "year", "area", "cell", "plc", "protocol"),
        equipment,
    )
    cost_rows: list[list[Any]] = [["downtime", a, v, "EUR/h"] for a, v in COSTS.downtime_eur_h.items()]
    cost_rows += [["scrap", p, v, "EUR/part"] for p, v in COSTS.scrap_eur_part.items()]
    cost_rows += [
        ["labour", "maintenance technician", COSTS.technician_eur_h, "EUR/h"],
        ["part", "plunger tip", COSTS.plunger_tip_eur, "EUR"],
        ["part", "shot sleeve", COSTS.shot_sleeve_eur, "EUR"],
        ["part", "accumulator nitrogen recharge", COSTS.accumulator_recharge_eur, "EUR"],
        ["part", "vacuum filter", COSTS.vacuum_filter_eur, "EUR"],
        ["part", "heater element", COSTS.heater_element_eur, "EUR"],
    ]
    n["plant/costs.csv"] = write_csv(out / "plant" / "costs.csv", ("item", "of", "value", "unit"), cost_rows)
    n["plant/products.csv"] = write_csv(
        out / "plant" / "products.csv",
        ("product", "name", "alloy", "weight_kg", "cavities", "cycle_s", "scrap_cost_eur"),
        ((p.code, p.name, p.alloy, p.weight_kg, p.cavities, p.cycle_s, p.scrap_cost_eur) for p in PRODUCTS),
    )
    n["plant/people.csv"] = write_csv(
        out / "plant" / "people.csv",
        ("name", "email", "tiles_role", "job", "crew"),
        ((p.name, p.email, p.role, p.job, p.shift) for p in PEOPLE),
    )
    n["mes/reason-codes.csv"] = write_csv(
        out / "mes" / "reason-codes.csv",
        ("code", "description", "category", "kind", "planned"),
        [(c.code, c.description, c.category, "downtime", "yes" if c.planned else "no") for c in DOWNTIME_CODES]
        + [(c.code, c.description, c.category, "scrap", "no") for c in SCRAP_CODES],
    )
    n["mes/stops.csv"] = write_csv(
        out / "mes" / "stops.csv",
        ("stop_id", "asset", "start", "end", "code", "planned", "shift", "crew", "comment"),
        mes_stops(year),
    )
    scrap = sorted((t, asset, prod, part, code) for asset, r in year.cells.items() for t, prod, code, part in r.scrap)
    n["mes/scrap.csv"] = write_csv(
        out / "mes" / "scrap.csv",
        ("time", "asset", "product", "part_id", "code"),
        ((local(t), a, p, part, code) for t, a, p, part, code in scrap),
    )
    n["mes/production.csv"] = write_csv(
        out / "mes" / "production.csv",
        (
            "day",
            "shift",
            "crew",
            "asset",
            "product",
            "shift_minutes",
            "planned_stop_minutes",
            "unplanned_stop_minutes",
            "shots",
            "parts",
            "scrap",
            "good",
        ),
        production(year),
    )
    n["calendar/shifts.csv"] = write_csv(
        out / "calendar" / "shifts.csv",
        ("day", "shift", "crew", "start", "end"),
        ((s.day.isoformat(), s.name, s.crew, s.start.isoformat(), s.end.isoformat()) for s in year.shifts),
    )
    n["calendar/planned-stops.csv"] = write_csv(
        out / "calendar" / "planned-stops.csv", ("asset", "start", "end", "reason", "code"), planned_stops(year)
    )
    n["cmms/work-orders.csv"] = write_csv(
        out / "cmms" / "work-orders.csv",
        (
            "work_order",
            "type",
            "asset",
            "component",
            "code",
            "reported",
            "started",
            "finished",
            "labour_hours",
            "technician",
            "parts",
            "parts_cost_eur",
            "description",
            "episode",
        ),
        work_orders(year),
    )
    n["lab/hydrogen.csv"] = write_csv(
        out / "lab" / "hydrogen.csv",
        ("sample_id", "time", "furnace", "hydrogen_ml_100g", "density_index_pct"),
        (
            (f"H2-{i + 1:05d}", local(t), "MF-01", h, round(h * 38, 1))
            for i, (t, h) in enumerate(zip(year.site.lab_times, year.site.lab_h2, strict=True))
        ),
    )
    n["ground-truth/episodes.csv"] = write_csv(
        out / "ground-truth" / "episodes.csv",
        (
            "episode",
            "asset",
            "mode",
            "code",
            "onset",
            "failed_at",
            "resolved_at",
            "outcome",
            "peak_severity",
            "ramp_working_days",
            "precursors",
        ),
        episodes(year),
    )
    n["ground-truth/quirks.csv"] = write_csv(
        out / "ground-truth" / "quirks.csv",
        ("quirk", "where", "from", "to", "what"),
        [
            (
                "historian outage",
                "dc03.*, hf03.*",
                OUTAGE[2].isoformat(),
                OUTAGE[3].isoformat(),
                "No readings: the historian's collector for Cell DC-03 was down",
            ),
            (
                "stuck value",
                STUCK[0],
                STUCK[2].isoformat(),
                STUCK[3].isoformat(),
                f"Thermocouple failed: reads {STUCK[1]} °C; replaced on {STUCK[3]:%d %B}",
            ),
            (
                "wrong unit",
                MPA[0],
                MPA[1].isoformat(),
                MPA[2].isoformat(),
                "Logged in MPa (a tenth of the bar values) after a PLC firmware update",
            ),
            (
                "code renamed",
                "mes/stops.csv",
                START.isoformat(),
                OLD_CODES["DT-HYD"][1].isoformat(),
                "Hydraulic faults are HYD before the MES update, DT-HYD after",
            ),
            (
                "wrong asset",
                "mes/stops.csv",
                "2026-03-01",
                END.isoformat(),
                f"{MIXED_UP} stops of DC-04 booked on DC-03",
            ),
            (
                "duplicate rows",
                "mes/stops.csv",
                START.isoformat(),
                END.isoformat(),
                "About 0.4% of stops are logged twice (same start, asset and code)",
            ),
            (
                "no end time",
                "mes/stops.csv",
                START.isoformat(),
                END.isoformat(),
                "About 0.3% of unplanned stops have no end time",
            ),
            (
                "not logged",
                "Line 1 (DC-05, DC-06)",
                START.isoformat(),
                END.isoformat(),
                "Older cells: only 5-minute cycle time and die temperature over MQTT, and MES events",
            ),
        ],
    )
    model = {
        "porosity_pct": sim.POROSITY,
        "set_points": {
            p.code: {
                "die_temp_c": p.die_temp_c,
                "speed_2nd_m_s": p.speed_2nd,
                "intensification_bar": p.intensification_bar,
            }
            for p in PRODUCTS
        },
        "xray_grades": {
            "0": "below 0.6",
            "1": "0.6 to 0.85",
            "2": "0.85 to 1.1",
            "3": "1.1 to 1.4",
            "4": "1.4 or more",
        },
        "scrapped_from_grade": 3,
        "notes": "porosity = base + each coefficient times its term + noise; a part of grade 3 or 4 is scrap (POR)",
    }
    (out / "ground-truth" / "process-model.json").write_text(json.dumps(model, indent=2) + "\n", encoding="utf-8")
    n["ground-truth/process-model.json"] = len(sim.POROSITY)
    (out / "baseline.md").write_text(baseline(year), encoding="utf-8")
    n["baseline.md"] = len(CELLS)
    return n


def baseline(year: Year) -> str:
    """The assessment's baseline metrics (docs/pilot/assessment.md#2-baseline-metrics) per cell: stops
    and scrap, per month and per 1,000 parts, their hours and cost."""
    halves = (
        ("The year", START, END),
        ("October to March", START, datetime(2026, 4, 1, tzinfo=ZONE)),
        ("April to September", datetime(2026, 4, 1, tzinfo=ZONE), END),
    )
    sections = []
    for title, a, b in halves:
        months = (b.year - a.year) * 12 + b.month - a.month
        rows = []
        for c in CELLS:
            r = year.cells[c.asset]
            stops = [
                s
                for s in r.stops
                if not s.planned and a.timestamp() <= s.start < b.timestamp() and not s.comment.endswith("(continued)")
            ]
            hours = (
                sum(s.end - s.start for s in r.stops if not s.planned and a.timestamp() <= s.start < b.timestamp())
                / 3600
            )
            parts = sum(
                n.parts for (asset, i), n in year.counts.items() if asset == c.asset and a <= year.shifts[i].start < b
            )
            scrap = [x for x in r.scrap if a.timestamp() <= x[0] < b.timestamp()]
            scrap_cost = sum(COSTS.scrap_eur_part[x[1]] for x in scrap)
            cells = (
                c.asset,
                f"{parts:,}",
                f"{len(stops):,}",
                f"{len(stops) / months:.1f}",
                f"{1000 * len(stops) / parts:.2f}",
                f"{hours:,.0f}",
                f"{hours * c.downtime_cost_eur_h:,.0f}",
                f"{len(scrap):,}",
                f"{100 * len(scrap) / parts:.2f} %",
                f"{scrap_cost:,.0f}",
            )
            rows.append("| " + " | ".join(cells) + " |")
        head = (
            "Cell",
            "Parts",
            "Unplanned stops",
            "A month",
            "Per 1,000 parts",
            "Hours",
            "Cost of the hours (EUR)",
            "Scrapped parts",
            "Scrap rate",
            "Scrap cost (EUR)",
        )
        table = ["| " + " | ".join(head) + " |", "| " + " | ".join("---" for _ in head) + " |", *rows]
        sections.append(f"## {title}\n\n" + "\n".join(table))
    return (
        "# Baseline metrics\n\n"
        "Made by `tiles-sample-plant generate die-casting` from the simulated year: each cell's unplanned\n"
        "stops (a stop continued into the next shift counts once; its hours count in full), scrapped parts\n"
        "and their costs at controlling's figures (plant/costs.csv). The MES export (mes/stops.csv) holds\n"
        "the same stops with its known errors (README: Known gaps).\n\n" + "\n\n".join(sections) + "\n"
    )


def generate(out: Path, big: bool = False) -> dict[str, Any]:
    """Simulates the year and writes the files; the manifest describes them."""
    return build(out, big)[1]


def build(out: Path, big: bool = False) -> tuple[Year, dict[str, Any]]:
    """`generate`, also giving the year it simulated (the tests read it)."""
    from tiles_api.sample_plant.die_casting import documents, questions

    year = simulate(out, big)
    counts = write_committed(out, year)
    counts.update(documents.write(out, year))
    counts.update(questions.write(out, year))
    manifest_path = out / "manifest.json"
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    manifest = {
        "plant": "Aldermoor Castings, Kesselbach plant (made up)",
        "from": START.isoformat(),
        "to": END.isoformat(),
        "seed": SEED,
        "committed": dict(sorted(counts.items())),
        "generated": dict(sorted(year.files.items())) if big else previous.get("generated", {}),
        "trace_window": [local(year.trace_window[0]), local(year.trace_window[1])],
        "tables": tables(),
        "shots": {a: r.shots for a, r in year.cells.items()},
        "parts": {a: r.parts for a, r in year.cells.items()},
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return year, manifest


def tables() -> dict[str, dict[str, Any]]:
    """The batch tables `--all` writes, for the loader: one a Line 2 cell and month."""
    out = {}
    month = START
    while month < END:
        m = month.strftime("%Y-%m")
        for c in PILOT:
            out[f"generated/quality/{c.key}-{m}.csv.gz"] = {
                "name": f"X-ray results {c.asset} {m}",
                "description": f"Every shot of {c.asset} in {m}: its process values and X-ray result",
                "text": ["shot_id", "time", "asset", "product", "defect", "result"],
            }
        month = month.replace(year=month.year + month.month // 12, month=month.month % 12 + 1)
    return out


def day_range(day: str) -> tuple[datetime, datetime]:
    d = datetime.fromisoformat(day).replace(tzinfo=ZONE)
    return d, d + timedelta(days=1)


__all__ = ["CODES", "PILOT", "SITE_TAGS", "Year", "day_range", "generate", "iso", "local"]
