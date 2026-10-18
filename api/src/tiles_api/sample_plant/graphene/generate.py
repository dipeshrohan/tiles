"""Writes the graphene plant's files (data/sample-plants/graphene/): the small ones committed, and
with `--all` the historian export and the film rolls' genealogy and inspection under `generated/`, a
table a month (the manifest's `tables` names them for the loader).
"""

import bisect
import random
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

from tiles_api.sample_plant import common
from tiles_api.sample_plant.common import Capture, Historian, Stats, Text, iso, write_csv, write_json
from tiles_api.sample_plant.graphene import calendar as cal
from tiles_api.sample_plant.graphene import simulate as sim
from tiles_api.sample_plant.graphene.plant import (
    BATH_CHANGE,
    BY_ASSET,
    DOWNTIME_CODES,
    END,
    FOIL_M,
    FOIL_UM,
    LANES,
    LENGTHS,
    MACHINES,
    OLD_CODES,
    PART_COSTS,
    PEOPLE,
    PRODUCT,
    PRODUCT_NAME,
    ROLL_COST_GBP,
    ROLL_M,
    RUN_COST_GBP,
    SCRAP_CODES,
    SEED,
    START,
    TECHNICIAN,
    TECHNICIAN_GBP_H,
    ZONE,
    all_tags,
    ontology,
)

QUESTION_MONTH = (datetime(2026, 3, 1, tzinfo=ZONE), datetime(2026, 4, 1, tzinfo=ZONE))  # most breakdowns

# Known gaps (README: Known gaps). CVD-02's thermocouple drift (simulate.TC_DRIFT) is one too: the
# historian shows the set point while the furnace ran cooler.
FAHRENHEIT = ("tl01.etch_temp", datetime(2026, 5, 11, 6, tzinfo=ZONE), datetime(2026, 5, 18, 6, tzinfo=ZONE))
OUTAGE = ("sc01", datetime(2026, 4, 14, tzinfo=ZONE), datetime(2026, 4, 15, 12, tzinfo=ZONE))
RENAMED = ("ep01.current_ripple", "ep01.ripple_pct", datetime(2025, 12, 1, 6, tzinfo=ZONE))
STUCK = ("cr01.particles", datetime(2026, 5, 18, 10, tzinfo=ZONE), datetime(2026, 5, 21, 14, tzinfo=ZONE))
DUPLICATES, NO_END = 0.004, 0.003

ROLL_COLUMNS = (
    "roll_id", "inspected", "cvd_run", "reactor", "foil_roll", "foil_lot", "supplier", "transfer_line", "lane",
    "segment", "foil_ra", "base_pressure", "oxygen", "zone2_temp", "ch4_flow", "d_g", "two_d_g", "bath_copper",
    "etch_flow", "laminator_spread", "particles", "sheet_resistance", "uniformity", "transmittance", "defects",
    "grade", "scrap",
)  # fmt: skip
TEXT = (
    "roll_id",
    "inspected",
    "cvd_run",
    "reactor",
    "foil_roll",
    "foil_lot",
    "supplier",
    "transfer_line",
    "grade",
    "scrap",
)


def local(t: float) -> str:
    return common.local(t, ZONE)


class Quirks:
    """What the historian holds for a reading (its tag, time and value), or nothing."""

    def __init__(self) -> None:
        self.stuck: float | None = None

    def __call__(self, stream: str, tag: str, t: float, value: float) -> tuple[str, float, float] | None:
        if stream == OUTAGE[0] and OUTAGE[1].timestamp() <= t < OUTAGE[2].timestamp():
            return None
        if tag == sim.TC_DRIFT[0].lower().replace("-", "") + ".zone2_temp":
            a, b = sim.TC_DRIFT[2].timestamp(), sim.TC_DRIFT[3].timestamp()
            if a <= t < b:
                return tag, t, round(value + sim.TC_DRIFT[1], 1)  # the thermocouple read high
        if tag == FAHRENHEIT[0] and FAHRENHEIT[1].timestamp() <= t < FAHRENHEIT[2].timestamp():
            return tag, t, round(value * 9 / 5 + 32, 1)
        if tag == RENAMED[0] and t < RENAMED[2].timestamp():
            return RENAMED[1], t, value
        if tag == STUCK[0] and STUCK[1].timestamp() <= t < STUCK[2].timestamp():
            if self.stuck is None:
                self.stuck = value
            return tag, t, self.stuck
        return tag, t, value


def logged_zone2(run: sim.Run) -> float:
    """The growth temperature as the plant recorded it (CVD-02's thermocouple read high for a while)."""
    a, b = sim.TC_DRIFT[2].timestamp(), sim.TC_DRIFT[3].timestamp()
    drift = sim.TC_DRIFT[1] if run.reactor == sim.TC_DRIFT[0] and a <= run.growth[0] < b else 0.0
    return run.zone2 + drift


def roll_row(x: sim.FilmRoll) -> dict[str, Any]:
    run = x.run
    return {
        "roll_id": x.id,
        "inspected": iso(run.inspected[1]),
        "cvd_run": run.id,
        "reactor": run.reactor,
        "foil_roll": run.foil.id,
        "foil_lot": run.foil.lot.id,
        "supplier": run.foil.lot.supplier,
        "transfer_line": run.line,
        "lane": x.lane,
        "segment": x.segment,
        "foil_ra": round(run.foil.ra, 1),
        "base_pressure": round(run.base_pressure, 4),
        "oxygen": round(run.oxygen, 2),
        "zone2_temp": round(logged_zone2(run), 1),
        "ch4_flow": 30.0,  # its set point, which the controller reads back
        "d_g": round(run.d_g, 3),
        "two_d_g": round(run.two_d_g, 2),
        "bath_copper": round(run.bath_copper, 1),
        "etch_flow": round(run.etch_flow, 1),
        "laminator_spread": round(run.lam_spread, 2),
        "particles": round(run.particles, -1),
        "sheet_resistance": round(x.rs, 0),
        "uniformity": round(x.uniformity, 1),
        "transmittance": round(x.transmittance, 2),
        "defects": round(x.defects, 1),
        "grade": x.grade,
        "scrap": x.scrap or "-",
    }


def simulate(out: Path, big: bool) -> tuple[sim.Year, Stats, Capture, dict[str, dict[str, Any]]]:
    stats = Stats(ZONE)
    capture = Capture(QUESTION_MONTH[0].timestamp(), QUESTION_MONTH[1].timestamp())
    hist = Historian(out / "generated" if big else None, stats, capture)
    quirk = Quirks()

    def write(stream: str, tag: str, t: float, value: float) -> None:
        got = quirk(stream, tag, t, float(value))
        if got is not None:
            hist.write(stream, got[0], got[1], got[2])

    year = sim.Plant(write).run()
    hist.close()
    files = dict(hist.files)
    by_month: dict[str, list[sim.FilmRoll]] = {}
    for x in year.rolls:
        by_month.setdefault(datetime.fromtimestamp(x.run.inspected[1], ZONE).strftime("%Y-%m"), []).append(x)
        if capture.start <= x.run.inspected[1] < capture.end:
            capture.quality["rolls"].append(roll_row(x))
    if big:
        for month, rolls in sorted(by_month.items()):
            f = Text(out / "generated" / "tables" / f"rolls-{month}.csv.gz", ",".join(ROLL_COLUMNS), True)
            for x in rolls:
                row = roll_row(x)
                f.line(",".join(str(row[k]) for k in ROLL_COLUMNS))
            files[f"tables/rolls-{month}.csv.gz"] = f.close()
    return year, stats, capture, files


def tables() -> dict[str, dict[str, Any]]:
    out = {}
    month = START
    while month < END:
        m = month.strftime("%Y-%m")
        out[f"generated/tables/rolls-{m}.csv.gz"] = {
            "name": f"Film rolls {m}",
            "description": (
                f"Every {PRODUCT} roll inspected in {m}: its genealogy (CVD run, reactor, foil and lot, transfer"
                " line), process values and inspection results"
            ),
            "text": list(TEXT),
        }
        month = month.replace(year=month.year + month.month // 12, month=month.month % 12 + 1)
    return out


# ---- the committed files -------------------------------------------------------------------------


def all_stops(year: sim.Year) -> list[common.Stop]:
    return sorted((s for st in year.stations.values() for s in st.stops), key=lambda s: (s.start, s.asset))


def shift_at(year: sim.Year, starts: list[float], t: float) -> cal.Shift:
    return year.shifts[max(0, bisect.bisect_right(starts, t) - 1)]


def mes_stops(year: sim.Year) -> list[list[Any]]:
    rng = random.Random(f"{SEED}/mes")
    starts = [s.start.timestamp() for s in year.shifts]
    rows = []
    for s in all_stops(year):
        sh = shift_at(year, starts, s.start)
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


def scrap(year: sim.Year) -> list[tuple[str, str, str, str, str]]:
    rows = []
    for run in year.runs:
        if run.scrap:
            asset = run.line if run.scrap == "TL-TEAR" else run.reactor
            rows.append((local(run.scrap_at), asset, f"{PRODUCT} run", run.id, run.scrap))
    for x in year.rolls:
        if x.scrap:
            rows.append((local(x.run.inspected[1]), "IN-01", f"{PRODUCT} roll", x.id, x.scrap))
    return sorted(rows)


def production(year: sim.Year) -> list[list[Any]]:
    starts = [s.start.timestamp() for s in year.shifts]
    count: Counter[tuple[int, str]] = Counter()

    def at(t: float, what: str) -> None:
        if t:
            i = bisect.bisect_right(starts, t) - 1
            if i >= 0:
                count[(i, what)] += 1

    for f in year.foils:
        at(f.polished[1], "polished")
    for run in year.runs:
        at(run.job[1] if run.scrap != "CVD-ABT" else run.scrap_at, "grown")
        if run.line:
            at(run.transfer[1], "transferred")
    for x in year.rolls:
        at(x.run.inspected[1], f"grade_{x.grade}")
    rows = []
    for i, sh in enumerate(year.shifts):
        rows.append(
            [
                sh.day.isoformat(), sh.name, sh.crew, count[(i, "polished")], count[(i, "grown")],
                count[(i, "transferred")], count[(i, "grade_A")], count[(i, "grade_B")], count[(i, "grade_NG")],
            ]
        )  # fmt: skip
    return rows


PARTS = {
    "DT-VAC": "quartz tube seal kit",
    "DT-HTR": "zone 2 heating element",
    "DT-PMP": "dry vacuum pump exchange",
    "DT-MFC": "mass flow controller recalibration",
    "DT-EPL": "rectifier control board",
    "DT-LAM": "laminator roll",
    "DT-ETC": "etch pump impeller",
    "DT-EXH": "scrubber packing cleaning service",
    "PL-BTH": "etch bath change (etchant)",
}


def work_orders(year: sim.Year) -> list[list[Any]]:
    jobs = sorted(
        (m for st in year.stations.values() for m in st.maintenance), key=lambda m: (m.start, m.asset, m.kind)
    )
    starts = [s.start.timestamp() for s in year.shifts]
    rng = random.Random(f"{SEED}/cmms")
    rows = []
    for i, m in enumerate(jobs):
        sh = shift_at(year, starts, m.start)
        part = PARTS.get(m.code, "") if m.kind != "PM" or m.code == "PL-BTH" else ""
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
    "leak": "oxygen; base_pressure; lab.d_g_ratio",
    "heater": "heater_power; zone2_temp (late); in01.sheet_resistance",
    "pump": "pump_current; base_pressure",
    "mfc": "in01.transmittance; lab.2d_g_ratio (the flow reads its set point)",
    "rectifier": "current_ripple; lab.foil_roughness",
    "laminator": "roll_temp_spread; in01.defects",
    "etch-pump": "etch_flow; etch_rate; in01.transmittance",
    "packing": "differential_pressure; exhaust_flow",
}


def episodes(year: sim.Year) -> list[list[Any]]:
    rows = []
    every = sorted((e for st in year.stations.values() for e in st.episodes), key=lambda e: (e.onset, e.asset))
    for e in every:
        key = BY_ASSET[e.asset].key
        tags = "; ".join(t if "." in t.split(" ")[0] else f"{key}.{t}" for t in PRECURSORS[e.mode].split("; "))
        code = year.stations[e.asset].modes[e.mode].code
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


QUIRKS = (
    (
        "sensor drift",
        "cvd02.zone2_temp",
        sim.TC_DRIFT[2],
        sim.TC_DRIFT[3],
        "The zone 2 thermocouple read 8 °C high until its recalibration: the furnace grew 8 °C cooler than logged",
    ),
    ("wrong unit", FAHRENHEIT[0], FAHRENHEIT[1], FAHRENHEIT[2], "Logged in °F after an HMI update"),
    ("historian outage", "sc01.*", OUTAGE[1], OUTAGE[2], "No scrubber readings: its collector was down"),
    (
        "tag renamed",
        RENAMED[0],
        START,
        RENAMED[2],
        f"Logged as {RENAMED[1]} until the PLC update renamed the tag",
    ),
    ("stuck value", STUCK[0], STUCK[1], STUCK[2], "The particle counter froze at one reading until it was reset"),
    (
        "code renamed",
        "mes/stops.csv",
        START,
        OLD_CODES["DT-EXH"][1],
        "The scrubber's stops are SCRB before the MES update, DT-EXH after",
    ),
    ("duplicate rows", "mes/stops.csv", START, END, "About 0.4% of stops are logged twice"),
    ("no end time", "mes/stops.csv", START, END, "About 0.3% of unplanned stops have no end time"),
    (
        "model gap",
        "plant/ontology.json",
        START,
        END,
        "A fifth reactor (CVD-05), being commissioned, with no relationships",
    ),
)


def write_committed(out: Path, year: sim.Year, stats: Stats) -> dict[str, int]:
    from tiles_api.sample_plant.graphene import documents

    n: dict[str, int] = {}
    nodes, edges = ontology()
    known = {nd["id"] for nd in nodes}
    for key, (title, _, about) in documents.all_documents(year, stats).items():
        doc = f"doc-{key.lower()}"
        nodes.append(
            {
                "id": doc,
                "type": "Document",
                "label": f"{key}: {title}" if key.startswith("SOP") else title,
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
        ["downtime", m.asset, m.downtime_cost_gbp_h, "GBP/h"] for m in MACHINES if m.downtime_cost_gbp_h
    ]
    cost_rows += [
        ["scrap", f"{PRODUCT} roll", ROLL_COST_GBP, "GBP/roll"],
        ["scrap", f"{PRODUCT} run", RUN_COST_GBP, "GBP/run"],
        ["labour", "maintenance technician", TECHNICIAN_GBP_H, "GBP/h"],
    ]
    cost_rows += [["part", k, v, "GBP"] for k, v in PART_COSTS.items()]
    n["plant/costs.csv"] = write_csv(out / "plant" / "costs.csv", ("item", "of", "value", "unit"), cost_rows)
    n["plant/products.csv"] = write_csv(
        out / "plant" / "products.csv",
        ("product", "name", "run_m", "foil_um", "lanes", "roll_m", "rolls_a_run"),
        [(PRODUCT, PRODUCT_NAME, FOIL_M, FOIL_UM, LANES, ROLL_M, LANES * LENGTHS)],
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
        ("day", "shift", "crew", "foils_polished", "runs_grown", "runs_transferred", "grade_a", "grade_b", "ng"),
        production(year),
    )
    n["mes/foil-lots.csv"] = write_csv(
        out / "mes" / "foil-lots.csv",
        ("lot", "supplier", "received", "rolls", "thickness_um"),
        ((x.id, x.supplier, local(x.received), x.rolls, FOIL_UM) for x in year.lots),
    )
    n["mes/runs.csv"] = write_csv(
        out / "mes" / "runs.csv",
        (
            "run", "reactor", "foil_roll", "foil_lot", "polished_end", "loaded", "growth_start", "growth_end",
            "unloaded", "base_pressure_mbar", "zone2_temp_c", "ch4_flow_sccm", "transfer_line", "transfer_start",
            "transfer_end", "bath_copper_g_l", "inspected_end", "packed", "scrapped",
        ),
        (
            (
                r.id, r.reactor, r.foil.id, r.foil.lot.id, local(r.foil.polished[1]), local(r.job[0]),
                local(r.growth[0]), local(r.growth[1]), local(r.job[1]), round(r.base_pressure, 4),
                round(logged_zone2(r), 1), 30.0, r.line, local(r.transfer[0]) if r.line else "",
                local(r.transfer[1]) if r.line else "", round(r.bath_copper, 1) if r.line else "",
                local(r.inspected[1]) if r.inspected[1] else "", local(r.packed) if r.packed else "", r.scrap,
            )
            for r in year.runs
        ),
    )  # fmt: skip
    n["mes/rolls.csv"] = write_csv(
        out / "mes" / "rolls.csv",
        ("roll", "run", "lane", "segment", "sheet_resistance_ohm_sq", "uniformity_pct", "transmittance_pct",
         "defects_m2", "grade", "scrapped"),
        (
            (x.id, x.run.id, x.lane, x.segment, round(x.rs, 0), round(x.uniformity, 1), round(x.transmittance, 2),
             round(x.defects, 1), x.grade, x.scrap)
            for x in year.rolls
        ),
    )  # fmt: skip
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
            "parts_cost_gbp",
            "description",
            "episode",
        ),
        work_orders(year),
    )
    sampled = [r for r in year.runs if r.lab_at and r.lab_at < END.timestamp()]
    n["lab/raman.csv"] = write_csv(
        out / "lab" / "raman.csv",
        ("sample_id", "time", "run", "d_g_ratio", "two_d_g_ratio"),
        (
            (f"RAM-{i + 1:05d}", local(r.lab_at), r.id, round(r.d_g, 3), round(r.two_d_g, 2))
            for i, r in enumerate(sampled)
        ),
    )
    n["lab/four-point-probe.csv"] = write_csv(
        out / "lab" / "four-point-probe.csv",
        ("sample_id", "time", "run", "sheet_resistance_ohm_sq"),
        ((f"FPP-{i + 1:05d}", local(r.lab_at + 1800), r.id, r.rs_4pp) for i, r in enumerate(sampled)),
    )
    n["lab/foil-roughness.csv"] = write_csv(
        out / "lab" / "foil-roughness.csv",
        ("sample_id", "time", "lot", "supplier", "ra_nm"),
        (
            (f"AFM-{i + 1:04d}", local(x.measured_at), x.id, x.supplier, x.ra_measured)
            for i, x in enumerate(x for x in year.lots if x.measured_at)
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
        [(q, where, a.isoformat(), b.isoformat(), what) for q, where, a, b, what in QUIRKS],
    )
    n["ground-truth/runs.csv"] = write_csv(
        out / "ground-truth" / "runs.csv",
        (
            "run", "zone2_temp_actual_c", "ch4_flow_actual_sccm", "domain_um", "bilayer", "residual_copper",
            "laminator_wear",
        ),
        (
            (r.id, round(r.zone2, 1), round(r.ch4_actual, 2), round(r.domain, 2), round(r.bilayer, 3),
             round(r.residual, 3), round(r.laminator, 3))
            for r in year.runs
        ),
    )  # fmt: skip
    write_json(
        out / "ground-truth" / "quality-model.json",
        {"film": sim.QUALITY, "notes": "The film's inspection results from its genealogy (simulate.py)"},
    )
    n["ground-truth/quality-model.json"] = len(sim.QUALITY)
    (out / "baseline.md").write_text(baseline(year), encoding="utf-8")
    n["baseline.md"] = 1
    return n


def baseline(year: sim.Year) -> str:
    rows = []
    months = 12
    for m in MACHINES:
        st = year.stations.get(m.asset)
        if not st or not m.downtime_cost_gbp_h:
            continue
        stops = [s for s in st.stops if not s.planned and not s.comment.endswith("(continued)")]
        hours = sum(s.end - s.start for s in st.stops if not s.planned) / 3600
        rows.append(
            f"| {m.asset} | {len(stops):,} | {len(stops) / months:.1f} | {hours:,.0f}"
            f" | {hours * m.downtime_cost_gbp_h:,.0f} |"
        )
    grades = Counter(x.grade for x in year.rolls)
    run_scrap = Counter(r.scrap for r in year.runs if r.scrap)
    roll_scrap = Counter(x.scrap for x in year.rolls if x.scrap)
    scrap_rows = [f"| {c} | {k:,} runs | {k * RUN_COST_GBP:,.0f} |" for c, k in run_scrap.most_common()]
    scrap_rows += [f"| {c} | {k:,} rolls | {k * ROLL_COST_GBP:,.0f} |" for c, k in roll_scrap.most_common()]
    bath = [c for _, _, c in year.bath_changes]
    late = sum(1 for c in bath if c > BATH_CHANGE)
    return (
        "# Baseline metrics\n\n"
        "Made by `tiles-sample-plant generate graphene` from the simulated year: each machine's unplanned\n"
        "stops (a stop continued into the next shift counts once; its hours in full) and their cost at\n"
        "controlling's figures (plant/costs.csv), and the film's yield.\n\n"
        "## Stops\n\n| Machine | Unplanned stops | A month | Hours | Cost of the hours (GBP) |\n"
        "| --- | --- | --- | --- | --- |\n"
        + "\n".join(rows)
        + f"\n\n## Film\n\n{len(year.runs):,} CVD runs; {len(year.rolls):,} rolls inspected: {grades['A']:,} grade A,"
        f" {grades['B']:,} grade B, {grades['NG']:,} NG.\n\n"
        "| Scrap | How many | Cost (GBP) |\n| --- | --- | --- |\n" + "\n".join(scrap_rows) + "\n\n"
        f"The etch baths were changed {len(bath)} times, {late} of them after the copper had passed"
        f" {BATH_CHANGE:.0f} g/L.\n"
    )


def build(out: Path, big: bool = False) -> tuple[sim.Year, Stats, Capture, dict[str, Any]]:
    from tiles_api.sample_plant.graphene import documents, questions

    year, stats, capture, files = simulate(out, big)
    counts = write_committed(out, year, stats)
    counts.update(documents.write(out, year, stats))
    counts["copilot/questions.csv"] = common.write_questions(
        out / "copilot" / "questions.csv", questions.all_questions(year, stats, capture)
    )
    previous = common.read_json(out / "manifest.json")
    manifest = {
        "plant": "Sorrel Carbon, Ashcombe film plant (made up)",
        "from": START.isoformat(),
        "to": END.isoformat(),
        "seed": SEED,
        "committed": dict(sorted(counts.items())),
        "generated": dict(sorted(files.items())) if big else previous.get("generated", {}),
        "tables": tables(),
        "runs": len(year.runs),
        "rolls": len(year.rolls),
    }
    write_json(out / "manifest.json", manifest)
    return year, stats, capture, manifest


def generate(out: Path, big: bool = False) -> dict[str, Any]:
    return build(out, big)[3]


__all__ = ["build", "generate"]
