"""Writes the battery plant's files (data/sample-plants/battery/): the small ones committed, and with
`--all` the historian export and the cells' genealogy and test results under `generated/`, a table
a month (the manifest's `tables` names them for the loader).
"""

import bisect
import random
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from tiles_api.sample_plant import common
from tiles_api.sample_plant.battery import calendar as cal
from tiles_api.sample_plant.battery import simulate as sim
from tiles_api.sample_plant.battery.plant import (
    BY_ASSET,
    CELL,
    CELL_COST_EUR,
    CELL_NAME,
    COIL_COST_EUR_M,
    COIL_M,
    DOWNTIME_CODES,
    END,
    LANES,
    MACHINES,
    OLD_CODES,
    PART_COSTS,
    PEOPLE,
    SCRAP_CODES,
    SEED,
    START,
    TECHNICIAN,
    TECHNICIAN_EUR_H,
    ZONE,
    all_tags,
    ontology,
)
from tiles_api.sample_plant.common import Capture, Historian, Stats, Text, iso, write_csv, write_json

QUESTION_MONTH = (datetime(2026, 6, 1, tzinfo=ZONE), datetime(2026, 7, 1, tzinfo=ZONE))  # most breakdowns

# Known gaps (README: Known gaps).
DEW_DRIFT = ("dr01.dew_point", -3.0, datetime(2026, 2, 2, 8, tzinfo=ZONE), datetime(2026, 2, 24, 10, tzinfo=ZONE))
G_M2 = ("cta1.coating_weight", 10.0, datetime(2026, 3, 9, 8, tzinfo=ZONE), datetime(2026, 3, 16, 8, tzinfo=ZONE))
OUTAGE = (("fm01", "fm02", "fm03", "fm04"), datetime(2026, 4, 6, tzinfo=ZONE), datetime(2026, 4, 7, 12, tzinfo=ZONE))
EOL_CLOCK = ("eol01", -3600.0, datetime(2026, 3, 29, 3, tzinfo=ZONE), datetime(2026, 4, 5, 12, tzinfo=ZONE))
DUPLICATES, NO_END = 0.004, 0.003

CELL_COLUMNS = (
    "cell_id", "stacked", "stacker", "cathode_coil", "cathode_roll", "anode_coil", "anode_roll", "cathode_loading",
    "cathode_loading_cv", "anode_loading", "cathode_thickness_sd", "cathode_burr", "anode_burr", "cathode_moisture",
    "anode_moisture", "dew_point", "overhang", "separator_tension", "weld_energy", "fill_weight", "rack",
    "formation_ah", "capacity", "dcir", "k_value", "grade", "scrap",
)  # fmt: skip
TEXT = (
    "cell_id",
    "stacked",
    "stacker",
    "cathode_coil",
    "cathode_roll",
    "anode_coil",
    "anode_roll",
    "rack",
    "grade",
    "scrap",
)


def local(t: float) -> str:
    return common.local(t, ZONE)


def quirk(stream: str, tag: str, t: float, value: float) -> tuple[float, float] | None:
    """What the historian holds for a reading (its time and value), or nothing."""
    if stream.split("-")[0] in OUTAGE[0] and OUTAGE[1].timestamp() <= t < OUTAGE[2].timestamp():
        return None
    if tag == DEW_DRIFT[0] and DEW_DRIFT[2].timestamp() <= t < DEW_DRIFT[3].timestamp():
        return t, round(value + DEW_DRIFT[1], 1)
    if tag == G_M2[0] and G_M2[2].timestamp() <= t < G_M2[3].timestamp():
        return t, round(value * G_M2[1], 1)
    if stream == EOL_CLOCK[0] and EOL_CLOCK[2].timestamp() <= t < EOL_CLOCK[3].timestamp():
        return t + EOL_CLOCK[1], value
    return t, value


def cell_row(c: sim.CellRecord) -> dict[str, Any]:
    return {
        "cell_id": c.id,
        "stacked": iso(c.stacked),
        "stacker": c.stacker,
        "cathode_coil": c.cathode.coil.id,
        "cathode_roll": c.cathode.id,
        "anode_coil": c.anode.coil.id,
        "anode_roll": c.anode.id,
        "cathode_loading": round(c.cathode.coil.loading, 3),
        "cathode_loading_cv": round(c.cathode.coil.loading_cv, 2),
        "anode_loading": round(c.anode.coil.loading, 3),
        "cathode_thickness_sd": round(c.cathode.coil.thickness_sd, 2),
        "cathode_burr": round(c.cathode.burr, 1),
        "anode_burr": round(c.anode.burr, 1),
        "cathode_moisture": round(c.cathode.moisture, 0),
        "anode_moisture": round(c.anode.moisture, 0),
        "dew_point": round(c.dew_point, 1),
        "overhang": round(c.overhang, 3),
        "separator_tension": round(c.tension, 2),
        "weld_energy": round(c.weld_energy, 0),
        "fill_weight": round(c.fill_g, 1),
        "rack": c.rack,
        "formation_ah": round(c.formation_ah, 2),
        "capacity": round(c.capacity, 2),
        "dcir": round(c.dcir, 3),
        "k_value": round(c.k_value, 3),
        "grade": c.grade or "-",
        "scrap": c.scrap or "-",
    }


def simulate(out: Path, big: bool) -> tuple[sim.Year, Stats, Capture, dict[str, dict[str, Any]]]:
    stats = Stats(ZONE)
    capture = Capture(QUESTION_MONTH[0].timestamp(), QUESTION_MONTH[1].timestamp())
    hist = Historian(out / "generated" if big else None, stats, capture)

    def write(stream: str, tag: str, t: float, value: float) -> None:
        got = quirk(stream, tag, t, float(value))
        if got is not None:
            hist.write(stream, tag, got[0], got[1])

    year = sim.Plant(write).run()
    hist.close()
    files = dict(hist.files)
    month_cells: dict[str, list[sim.CellRecord]] = defaultdict(list)
    for c in year.cells:
        month_cells[datetime.fromtimestamp(c.stacked, ZONE).strftime("%Y-%m")].append(c)
        if capture.start <= c.stacked < capture.end:
            capture.quality["cells"].append(cell_row(c))
    if big:
        for month, cells in sorted(month_cells.items()):
            f = Text(out / "generated" / "tables" / f"cells-{month}.csv.gz", ",".join(CELL_COLUMNS), True)
            for c in cells:
                row = cell_row(c)
                f.line(",".join(str(row[k]) for k in CELL_COLUMNS))
            files[f"tables/cells-{month}.csv.gz"] = f.close()
    return year, stats, capture, files


def tables() -> dict[str, dict[str, Any]]:
    out = {}
    month = START
    while month < END:
        m = month.strftime("%Y-%m")
        out[f"generated/tables/cells-{m}.csv.gz"] = {
            "name": f"Cells {m}",
            "description": (
                f"Every {CELL} cell stacked in {m}: its genealogy (coils, rolls, stacker, rack), process values"
                " and end-of-line results"
            ),
            "text": list(TEXT),
        }
        month = month.replace(year=month.year + month.month // 12, month=month.month % 12 + 1)
    return out


# ---- the committed files -------------------------------------------------------------------------


def all_stops(year: sim.Year) -> list[common.Stop]:
    return sorted((s for st in year.stations.values() for s in st.stops), key=lambda s: (s.start, s.asset))


def mes_stops(year: sim.Year) -> list[list[Any]]:
    rng = random.Random(f"{SEED}/mes")
    starts = [s.start.timestamp() for s in year.shifts]
    rows = []
    for s in all_stops(year):
        sh = year.shifts[max(0, bisect.bisect_right(starts, s.start) - 1)]
        code = s.code
        old = OLD_CODES.get(code)
        if old and s.start < old[1].timestamp():
            code = old[0]
        end = "" if rng.random() < NO_END and not s.planned else local(s.end)
        row = [s.asset, local(s.start), end, code, "yes" if s.planned else "no", sh.name, sh.crew, s.comment]
        rows.append(row)
        if rng.random() < DUPLICATES:
            rows.append(list(row))
    return [[f"S{i + 1:06d}", *r] for i, r in enumerate(rows)]


SCRAP_ASSET = {
    "STK-OVH": None,
    "WLD-FAIL": "UW-01",
    "FIL-LOW": "EF-01",
    "FRM-FAIL": None,
    "EOL-CAP": "EOL-01",
    "EOL-DCIR": "EOL-01",
    "EOL-K": "EOL-01",
}


def scrap(year: sim.Year) -> list[tuple[str, str, str, str, str]]:
    rows = []
    for c in year.cells:
        if c.scrap:
            asset = SCRAP_ASSET[c.scrap] or (c.stacker if c.scrap == "STK-OVH" else c.rack)
            rows.append((local(c.scrap_at), asset, CELL, c.id, c.scrap))
    for coil in year.coils:
        if coil.scrapped:
            rows.append(
                (
                    local(coil.coated[1] + 1800),
                    f"CT-{coil.side}1",
                    f"{'Cathode' if coil.side == 'C' else 'Anode'} coil",
                    coil.id,
                    coil.scrapped,
                )
            )
    for r in year.rolls:
        if r.scrapped == "COIL-BURR":
            rows.append(
                (
                    local(r.coil.slit[1] + r.lane),
                    f"SL-{r.coil.side}1",
                    f"{'Cathode' if r.coil.side == 'C' else 'Anode'} roll",
                    r.id,
                    r.scrapped,
                )
            )
    return sorted(rows)


def production(year: sim.Year) -> list[list[Any]]:
    starts = [s.start.timestamp() for s in year.shifts]
    count: dict[tuple[int, str], int] = Counter()

    def at(t: float, what: str) -> None:
        if t:
            i = bisect.bisect_right(starts, t) - 1
            if i >= 0:
                count[(i, what)] += 1

    for coil in year.coils:
        at(coil.coated[1], f"coils_{coil.side}")
    for c in year.cells:
        at(c.stacked, "stacked")
        at(c.filled, "filled")
        at(c.formed[1], "formed")
        if c.tested:
            at(c.tested, f"grade_{c.grade}")
    rows = []
    for i, sh in enumerate(year.shifts):
        rows.append(
            [
                sh.day.isoformat(), sh.name, sh.crew, count[(i, "coils_C")], count[(i, "coils_A")],
                count[(i, "stacked")], count[(i, "filled")], count[(i, "formed")], count[(i, "grade_A")],
                count[(i, "grade_B")], count[(i, "grade_NG")],
            ]
        )  # fmt: skip
    return rows


PARTS = {
    "DT-DIE": "slot die cleaning kit",
    "DT-DRY": "dryer fan bearing set",
    "DT-CAL": "calender roll bearing",
    "DT-BLD": "slitter blade set",
    "PL-BLD": "slitter blade set",
    "DT-DRM": "desiccant wheel regeneration service",
    "DT-STK": "stacker dancer and servo",
    "DT-WLD": "ultrasonic horn",
    "PL-HRN": "ultrasonic horn",
    "DT-FIL": "dosing pump rebuild kit",
    "DT-FRM": "formation channel contact set",
}


def work_orders(year: sim.Year) -> list[list[Any]]:
    jobs = sorted(
        (m for st in year.stations.values() for m in st.maintenance), key=lambda m: (m.start, m.asset, m.kind)
    )
    starts = [s.start.timestamp() for s in year.shifts]
    rng = random.Random(f"{SEED}/cmms")
    rows = []
    for i, m in enumerate(jobs):
        sh = year.shifts[max(0, bisect.bisect_right(starts, m.start) - 1)]
        part = PARTS.get(m.code, "") if m.kind != "PM" or m.code in ("PL-BLD", "PL-HRN") else ""
        reported, started = m.start, m.start
        if m.kind == "CM":
            reported = m.start + rng.uniform(1, 5) * 60
            started = min(m.end, reported + rng.uniform(5, 20) * 60)
        hours = max(0.25, (m.end - m.start) / 3600 * rng.uniform(0.8, 1.3))
        kind = {"CM": "Corrective", "PM": "Preventive", "INSP": "Condition-based"}[m.kind]
        rows.append(
            [
                f"WO-{datetime.fromtimestamp(m.start, ZONE):%y}-{i + 1:05d}", kind, m.asset, m.component, m.code,
                local(reported), local(started), local(m.end), round(hours, 2), TECHNICIAN[sh.crew], part,
                PART_COSTS.get(part, 0.0), m.text, m.episode or "",
            ]
        )  # fmt: skip
    return rows


PRECURSORS = {
    "die-lip": "coating_weight_cv; streaks",
    "dryer": "dryer_fan_current; dryer_temp_z3; residual_solvent; lab.peel_cathode",
    "bearing": "bearing_vibration; thickness_sd",
    "blade-chip": "burr_height; eol01.k_value (two weeks later)",
    "desiccant": "dr01.dew_point; dh01.wheel_dp; lab.moisture_electrode",
    "tension": "overhang_dev; separator_tension",
    "horn": "uw01.weld_energy; lab.weld_peel; eol01.dcir",
    "pump": "ef01.fill_weight; eol01.capacity",
    "contacts": "contact_resistance; rack_temp",
}


def episodes(year: sim.Year) -> list[list[Any]]:
    rows = []
    every = sorted((e for st in year.stations.values() for e in st.episodes), key=lambda e: (e.onset, e.asset))
    for e in every:
        key = BY_ASSET[e.asset].key
        tags = "; ".join(t if "." in t else f"{key}.{t}" for t in PRECURSORS[e.mode].split("; "))
        code = next(m.code for st in year.stations.values() for m in st.modes.values() if m.name == e.mode)
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


def planned_stops(year: sim.Year) -> list[list[Any]]:
    rows = [["", local(a), local(b), why, "PL-SHD"] for a, b, why in cal.gaps(year.working.intervals)]
    rows += [[s.asset, local(s.start), local(s.end), s.comment, s.code] for s in all_stops(year) if s.planned]
    return sorted(rows, key=lambda r: (r[1], r[0]))


def write_committed(out: Path, year: sim.Year, stats: Stats) -> dict[str, int]:
    from tiles_api.sample_plant.battery import documents

    n: dict[str, int] = {}
    nodes, edges = ontology()
    known = {nd["id"] for nd in nodes}
    for key, (title, _, about) in documents.all_documents(year, stats).items():
        doc = f"doc-{key.lower()}"
        nodes.append(
            {
                "id": doc,
                "type": "Document",
                "label": f"{key}: {title}" if key.startswith(("SOP", "MH")) else title,
                "props": {"number": key},
            }
        )
        edges += [{"id": f"{doc}-describes-{x}", "from": doc, "rel": "describes", "to": x} for x in about if x in known]
    write_json(
        out / "plant" / "ontology.json", {"format": "tiles-ontology", "version": 1, "nodes": nodes, "edges": edges}
    )
    n["plant/ontology.json"] = len(nodes)
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
            for t in all_tags()
        ),
    )
    n["plant/equipment.csv"] = write_csv(
        out / "plant" / "equipment.csv",
        ("asset", "label", "kind", "vendor", "model", "year", "area", "plc"),
        ((m.asset, m.label, m.kind, m.vendor, m.model, m.year, m.area, m.plc) for m in MACHINES),
    )
    cost_rows: list[list[Any]] = [
        ["downtime", m.asset, m.downtime_cost_eur_h, "EUR/h"] for m in MACHINES if m.downtime_cost_eur_h
    ]
    cost_rows += [
        ["scrap", CELL, CELL_COST_EUR, "EUR/cell"],
        ["scrap", "cathode coil", COIL_COST_EUR_M["C"], "EUR/m"],
        ["scrap", "anode coil", COIL_COST_EUR_M["A"], "EUR/m"],
    ]
    cost_rows += [["labour", "maintenance technician", TECHNICIAN_EUR_H, "EUR/h"]] + [
        ["part", k, v, "EUR"] for k, v in PART_COSTS.items()
    ]
    n["plant/costs.csv"] = write_csv(out / "plant" / "costs.csv", ("item", "of", "value", "unit"), cost_rows)
    n["plant/products.csv"] = write_csv(
        out / "plant" / "products.csv",
        ("product", "name", "nominal_ah", "coil_m", "lanes", "metres_a_cell"),
        [(CELL, CELL_NAME, 60.0, COIL_M, LANES, 22.0)],
    )
    n["plant/people.csv"] = write_csv(
        out / "plant" / "people.csv",
        ("name", "email", "tiles_role", "job", "crew"),
        ((p.name, p.email, p.role, p.job, p.crew) for p in PEOPLE),
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
    n["mes/scrap.csv"] = write_csv(
        out / "mes" / "scrap.csv", ("time", "asset", "product", "part_id", "code"), scrap(year)
    )
    n["mes/production.csv"] = write_csv(
        out / "mes" / "production.csv",
        (
            "day",
            "shift",
            "crew",
            "cathode_coils",
            "anode_coils",
            "cells_stacked",
            "cells_filled",
            "cells_formed",
            "grade_a",
            "grade_b",
            "ng",
        ),
        production(year),
    )
    n["mes/batches.csv"] = write_csv(
        out / "mes" / "batches.csv",
        ("batch", "side", "start", "end", "viscosity_mpas", "solid_content_pct"),
        (
            (b, "cathode" if s == "C" else "anode", local(a), local(e), round(v, 0), round(sc, 2))
            for b, s, a, e, v, sc in year.batches
        ),
    )
    n["mes/coils.csv"] = write_csv(
        out / "mes" / "coils.csv",
        (
            "coil", "side", "batch", "coated_start", "coated_end", "calendered_end", "slit_end", "dried_end",
            "loading_mg_cm2", "loading_cv_pct", "streaks", "residual_solvent_ppm", "peel_n_m", "thickness_um",
            "thickness_sd_um", "scrapped",
        ),
        (
            (
                c.id, "cathode" if c.side == "C" else "anode", c.batch, local(c.coated[0]), local(c.coated[1]),
                local(c.calendered[1]), local(c.slit[1]), local(c.dried[1]), round(c.loading, 3),
                round(c.loading_cv, 2), c.streaks, round(c.residual, 0), round(c.peel, 1), round(c.thickness, 1),
                round(c.thickness_sd, 2), c.scrapped,
            )
            for c in year.coils
        ),
    )  # fmt: skip
    n["mes/rolls.csv"] = write_csv(
        out / "mes" / "rolls.csv",
        ("roll", "coil", "lane", "burr_um", "moisture_ppm", "ready", "scrapped"),
        (
            (r.id, r.coil.id, r.lane, round(r.burr, 1), round(r.moisture, 0), local(r.ready), r.scrapped)
            for r in year.rolls
        ),
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
    lab_files = {
        "lab.peel_cathode": ("lab/peel.csv", "peel_n_m"),
        "lab.moisture_electrode": ("lab/moisture.csv", "moisture_ppm"),
        "lab.weld_peel": ("lab/weld-pull.csv", "pull_n"),
    }
    for tag, (path, col) in lab_files.items():
        rows = [
            (f"{tag.split('.')[1].upper()[:3]}-{i + 1:05d}", local(t), v)
            for i, (t, _, v) in enumerate(x for x in sorted(year.lab) if x[1] == tag)
        ]
        n[path] = write_csv(out / path, ("sample_id", "time", col), rows)
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
                "sensor drift",
                DEW_DRIFT[0],
                DEW_DRIFT[2].isoformat(),
                DEW_DRIFT[3].isoformat(),
                "The dew point sensor read 3 °C too dry until its calibration",
            ),
            (
                "wrong unit",
                G_M2[0],
                G_M2[2].isoformat(),
                G_M2[3].isoformat(),
                "Logged in g/m² (ten times the mg/cm² values) after a gauge software update",
            ),
            (
                "historian outage",
                "fm01.*, fm02.*, fm03.*, fm04.*",
                OUTAGE[1].isoformat(),
                OUTAGE[2].isoformat(),
                "No formation rack readings: the collector was down",
            ),
            (
                "clock offset",
                "eol01.*",
                EOL_CLOCK[2].isoformat(),
                EOL_CLOCK[3].isoformat(),
                "The tester's clock stayed on winter time: its readings are an hour early",
            ),
            (
                "code renamed",
                "mes/stops.csv",
                START.isoformat(),
                OLD_CODES["DT-DIE"][1].isoformat(),
                "Die cleaning is SLOT before the MES update, DT-DIE after",
            ),
            (
                "duplicate rows",
                "mes/stops.csv",
                START.isoformat(),
                END.isoformat(),
                "About 0.4% of stops are logged twice",
            ),
            (
                "no end time",
                "mes/stops.csv",
                START.isoformat(),
                END.isoformat(),
                "About 0.3% of unplanned stops have no end time",
            ),
            (
                "model gap",
                "plant/ontology.json",
                START.isoformat(),
                END.isoformat(),
                "A spare vacuum oven (VD-C2) with no relationships",
            ),
        ],
    )
    write_json(
        out / "ground-truth" / "quality-model.json",
        {"cell": sim.QUALITY, "notes": "The cell's end-of-line results from its genealogy (simulate.py)"},
    )
    n["ground-truth/quality-model.json"] = len(sim.QUALITY)
    (out / "baseline.md").write_text(baseline(year), encoding="utf-8")
    n["baseline.md"] = 1
    return n


def baseline(year: sim.Year) -> str:
    rows = []
    months = 12
    tested = [c for c in year.cells if c.tested]
    for m in MACHINES:
        st = year.stations.get(m.asset)
        if not st or not m.downtime_cost_eur_h:
            continue
        own = [s for s in st.stops if not s.planned and (s.code != "DT-DRM" or m.asset == "DR-01")]
        stops = [s for s in own if not s.comment.endswith("(continued)")]
        hours = sum(s.end - s.start for s in own) / 3600
        rows.append(
            f"| {m.asset} | {len(stops):,} | {len(stops) / months:.1f} | {hours:,.0f}"
            f" | {hours * m.downtime_cost_eur_h:,.0f} |"
        )
    grades = Counter(c.grade for c in tested)
    scrap = Counter(c.scrap for c in year.cells if c.scrap)
    yield_rows = "\n".join(
        f"| {code} | {n:,} | {100 * n / len(year.cells):.2f} % | {n * CELL_COST_EUR:,.0f} |"
        for code, n in scrap.most_common()
    )
    return (
        "# Baseline metrics\n\n"
        "Made by `tiles-sample-plant generate battery` from the simulated year: each machine's unplanned\n"
        "stops (a stop continued into the next shift counts once; its hours in full) and their cost at\n"
        "controlling's figures (plant/costs.csv), and the cells' yield. The dry room's stops stop the assembly\n"
        "line too (DT-DRM on each of its machines in the MES); they are counted once, on DR-01.\n\n"
        "## Stops\n\n| Machine | Unplanned stops | A month | Hours | Cost of the hours (EUR) |\n"
        "| --- | --- | --- | --- | --- |\n"
        + "\n".join(rows)
        + f"\n\n## Cells\n\n{len(year.cells):,} cells stacked; {len(tested):,} tested: {grades['A']:,} grade A,"
        f" {grades['B']:,} grade B, {grades['NG']:,} NG.\n\n"
        "| Scrap | Cells | Of those stacked | Cost (EUR) |\n| --- | --- | --- | --- |\n" + yield_rows + "\n"
    )


def build(out: Path, big: bool = False) -> tuple[sim.Year, Stats, Capture, dict[str, Any]]:
    from tiles_api.sample_plant.battery import documents, questions

    year, stats, capture, files = simulate(out, big)
    counts = write_committed(out, year, stats)
    counts.update(documents.write(out, year, stats))
    counts["copilot/questions.csv"] = common.write_questions(
        out / "copilot" / "questions.csv", questions.all_questions(year, stats, capture)
    )
    previous = common.read_json(out / "manifest.json")
    manifest = {
        "plant": "Kestrel Energy, Varnhem cell plant (made up)",
        "from": START.isoformat(),
        "to": END.isoformat(),
        "seed": SEED,
        "committed": dict(sorted(counts.items())),
        "generated": dict(sorted(files.items())) if big else previous.get("generated", {}),
        "tables": tables(),
        "cells": len(year.cells),
        "coils": len(year.coils),
    }
    write_json(out / "manifest.json", manifest)
    return year, stats, capture, manifest


def generate(out: Path, big: bool = False) -> dict[str, Any]:
    return build(out, big)[3]


__all__ = ["build", "generate"]
