"""Writes the biologics plant's files (data/sample-plants/biologics/): the small ones committed, and
with `--all` the historian export and every vial's genealogy and fate under `generated/`, a table a
month (the manifest's `tables` names them for the loader).
"""

import bisect
import random
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

from tiles_api.sample_plant import common
from tiles_api.sample_plant.biologics import calendar as cal
from tiles_api.sample_plant.biologics import simulate as sim
from tiles_api.sample_plant.biologics.plant import (
    BATCH_COST_EUR,
    BULK_G_L,
    BY_ASSET,
    CODES,
    DOWNTIME_CODES,
    DS_COST_EUR_G,
    END,
    FILL_G,
    MACHINES,
    OLD_CODES,
    OWNERS,
    PART_COSTS,
    PEOPLE,
    PRODUCT,
    PRODUCT_NAME,
    SCRAP_CODES,
    SEED,
    START,
    TECHNICIAN,
    TECHNICIAN_EUR_H,
    VIAL_COST_EUR,
    VIAL_MG,
    WORKING_VOLUME_L,
    ZONE,
    all_tags,
    ontology,
)
from tiles_api.sample_plant.common import Capture, Historian, Stats, Text, iso, write_csv, write_json

# The months the question set reads: most of the year's breakdowns. The vials table it reads is the last one's.
QUESTION_MONTHS = (datetime(2026, 5, 1, tzinfo=ZONE), datetime(2026, 7, 1, tzinfo=ZONE))
TABLE_MONTH = datetime(2026, 6, 1, tzinfo=ZONE)

# Known gaps (README: Known gaps).
DO_DRIFT = ("br02.do", 6.0, datetime(2026, 2, 2, 8, tzinfo=ZONE), datetime(2026, 2, 23, 10, tzinfo=ZONE))
MTORR = ("ly01.chamber_pressure", 0.75, datetime(2026, 3, 9, 8, tzinfo=ZONE), datetime(2026, 3, 16, 8, tzinfo=ZONE))
OUTAGE = (("cs01", "cs02"), datetime(2026, 4, 14, tzinfo=ZONE), datetime(2026, 4, 16, 6, tzinfo=ZONE))
LYO_CLOCK = ("ly01", -3600.0, datetime(2026, 3, 29, 3, tzinfo=ZONE), datetime(2026, 4, 5, 12, tzinfo=ZONE))
DUPLICATES, NO_END = 0.004, 0.003

VIAL_COLUMNS = (
    "vial_id", "fill_lot", "bulk_lot", "batch", "reactor", "filled", "needle", "fill_weight", "shelf", "edge",
    "leak_rate", "chamber_pressure", "product_temp_max", "harvest_viability", "resin_cycle", "cex_asymmetry",
    "bulk_hmw", "result", "reject",
)  # fmt: skip
TEXT = ("vial_id", "fill_lot", "bulk_lot", "batch", "reactor", "filled", "result", "reject")


def local(t: float) -> str:
    return common.local(t, ZONE)


def quirk(stream: str, tag: str, t: float, value: float) -> tuple[float, float] | None:
    """What the historian holds for a reading (its time and value), or nothing."""
    if stream.split("-")[0] in OUTAGE[0] and OUTAGE[1].timestamp() <= t < OUTAGE[2].timestamp():
        return None
    if tag == DO_DRIFT[0] and DO_DRIFT[2].timestamp() <= t < DO_DRIFT[3].timestamp():
        return t, round(value + DO_DRIFT[1], 1)
    if tag == MTORR[0] and MTORR[2].timestamp() <= t < MTORR[3].timestamp():
        return t, round(value * MTORR[1], 0)
    if stream.split("-")[0] == LYO_CLOCK[0] and LYO_CLOCK[2].timestamp() <= t < LYO_CLOCK[3].timestamp():
        return t + LYO_CLOCK[1], value
    return t, value


def vial_rows(lot: sim.FillLot) -> list[dict[str, Any]]:
    b = lot.batch
    fs, fe = lot.fill
    dt = (fe - fs - 1800) / lot.vials
    first = b.cycles[0].resin_cycle if b.cycles else 0
    out = []
    for i in range(lot.vials):
        code = lot.rejects.get(i, ("", 0.0))[0]
        out.append(
            {
                "vial_id": f"{lot.id}-{i + 1:05d}",
                "fill_lot": lot.id,
                "bulk_lot": b.bulk_id,
                "batch": b.id,
                "reactor": b.reactor,
                "filled": iso(fs + 900 + i * dt),
                "needle": i % 8 + 1,
                "fill_weight": round(lot.weights[i], 3),
                "shelf": i * 8 // lot.vials + 1,
                "edge": 1 if i % 47 < 6 else 0,
                "leak_rate": round(lot.leak_rate, 1),
                "chamber_pressure": round(lot.chamber_pressure, 0),
                "product_temp_max": round(lot.product_temp[i], 1),
                "harvest_viability": round(b.harvest_viability, 1),
                "resin_cycle": first,
                "cex_asymmetry": round(b.cex_asymmetry, 2),
                "bulk_hmw": round(b.bulk_hmw, 2),
                "result": "reject" if code else "pass",
                "reject": code or "-",
            }
        )
    return out


def simulate(out: Path, big: bool) -> tuple[sim.Year, Stats, Capture, dict[str, dict[str, Any]]]:
    stats = Stats(ZONE)
    capture = Capture(QUESTION_MONTHS[0].timestamp(), QUESTION_MONTHS[1].timestamp())
    hist = Historian(out / "generated" if big else None, stats, capture)

    def write(stream: str, tag: str, t: float, value: float) -> None:
        got = quirk(stream, tag, t, float(value))
        if got is not None:
            hist.write(stream, tag, got[0], got[1])

    year = sim.Plant(write).run()
    hist.close()
    files = dict(hist.files)
    by_month: dict[str, list[sim.FillLot]] = defaultdict(list)
    for lot in year.lots:
        by_month[datetime.fromtimestamp(lot.fill[0], ZONE).strftime("%Y-%m")].append(lot)
    capture.quality["vials"] = [row for lot in by_month.get(f"{TABLE_MONTH:%Y-%m}", []) for row in vial_rows(lot)]
    if big:
        for month, lots in sorted(by_month.items()):
            f = Text(out / "generated" / "tables" / f"vials-{month}.csv.gz", ",".join(VIAL_COLUMNS), True)
            for lot in lots:
                for row in vial_rows(lot):
                    f.line(",".join(str(row[k]) for k in VIAL_COLUMNS))
            files[f"tables/vials-{month}.csv.gz"] = f.close()
    return year, stats, capture, files


def tables() -> dict[str, dict[str, Any]]:
    out = {}
    month = START
    while month < END:
        m = month.strftime("%Y-%m")
        out[f"generated/tables/vials-{m}.csv.gz"] = {
            "name": f"Vials {m}",
            "description": (
                f"Every {PRODUCT} vial filled in {m}: its genealogy (fill lot, bulk lot, batch, reactor), its needle,"
                " fill weight and place in the lyophiliser, the cycle's leak rate and pressure, and its inspection"
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
        if s.asset == "AHU-01":  # the AHU's planned work is in the CMMS, not the MES
            continue
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
    t1 = END.timestamp()
    rows = []
    for b in year.batches:
        if b.lost:
            rows.append((local(b.lost_at), b.reactor, "Batch", b.id, b.lost))
        if b.bulk_status == "rejected" and b.bulk_tested < t1:
            rows.append((local(b.bulk_tested), "BF-01", "Drug substance lot", b.bulk_id, "DS-OOS"))
    for lot in year.lots:
        for i, (code, t) in sorted(lot.rejects.items()):
            asset = "FL-01" if code == "FIL-WT" else "AVI-01"
            rows.append((local(t), asset, "Vial", f"{lot.id}-{i + 1:05d}", code))
        if lot.status == "rejected" and lot.tested < t1:
            rows.append((local(lot.tested), "LY-01", "Drug product lot", lot.id, "LOT-MOIST"))
    return sorted(rows)


def production(year: sim.Year) -> list[list[Any]]:
    starts = [s.start.timestamp() for s in year.shifts]
    count: dict[tuple[int, str], float] = defaultdict(float)

    def at(t: float, what: str, n: float = 1) -> None:
        if t:
            i = bisect.bisect_right(starts, t) - 1
            if i >= 0:
                count[(i, what)] += n

    for b in year.batches:
        at(b.inoculated, "inoculated")
        if b.harvest[0]:
            at(b.harvest[0], "harvested")
        if b.lost:
            at(b.lost_at, "lost")
        if b.bulk_end:
            at(b.bulk_end, "bulk")
            at(b.bulk_end, "bulk_kg", b.bulk_g / 1000)
    for lot in year.lots:
        at(lot.fill[0], "filled", lot.vials)
        at(lot.inspected[1], "rejected", len(lot.rejects))
        at(lot.inspected[1], "inspected", lot.vials - len(lot.rejects))
    rows = []
    for i, sh in enumerate(year.shifts):
        rows.append(
            [
                sh.day.isoformat(), sh.name, sh.crew, int(count[(i, "inoculated")]), int(count[(i, "harvested")]),
                int(count[(i, "lost")]), int(count[(i, "bulk")]), round(count[(i, "bulk_kg")], 2),
                int(count[(i, "filled")]), int(count[(i, "rejected")]), int(count[(i, "inspected")]),
            ]
        )  # fmt: skip
    return rows


PARTS = {
    "DT-SEAL": "agitator mechanical seal kit",
    "DT-CEN": "centrifuge spindle bearing set",
    "DT-COL": "CEX column repack (labour and resin top-up)",
    "PL-COL": "CEX column repack (labour and resin top-up)",
    "DT-UF": "UF/DF cassette set",
    "PL-UF": "UF/DF cassette set",
    "DT-LYO": "lyophiliser door seal and valve kit",
    "DT-FIL": "filler dosing pump",
    "DT-HVAC": "AHU final filter set",
    "PL-FLT": "AHU final filter set",
    "DT-WFI": "WFI still service",
    "PL-RSN": "Protein A resin, 80 L",
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
        part = PARTS.get(m.code, "") if m.kind != "PM" or m.code in ("PL-RSN", "PL-COL", "PL-UF", "PL-FLT") else ""
        if m.kind == "INSP" and m.code == "DT-SEAL":
            part = PARTS["DT-SEAL"]
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
    "seal": "seal_loss; contamination risk",
    "wfi": "conductivity; toc",
    "filter": "filter_dp; fr01.room_dp; fr01.particles_05; lab.em_grade_a",
    "bearing": "vibration",
    "bed": "cex_asymmetry; cex_dp; lab.bulk_hmw",
    "membrane": "nwp; uf01.tmp",
    "leak": "leak_rate; ly01.chamber_pressure; lab.dp_moisture; VIS-CAKE rejects",
    "pump": "fill_weight; FIL-WT rejects",
}


def episodes(year: sim.Year) -> list[list[Any]]:
    rows = []
    every = sorted((e for st in year.stations.values() for e in st.episodes), key=lambda e: (e.onset, e.asset))
    for e in every:
        key = BY_ASSET[e.asset].key
        tags = "; ".join(t if "." in t or " " in t else f"{key}.{t}" for t in PRECURSORS[e.mode].split("; "))
        rows.append(
            [
                e.id,
                e.asset,
                e.mode,
                sim.MODES[e.mode].code,
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
    rows += [
        [s.asset, local(s.start), local(s.end), s.comment, s.code]
        for s in all_stops(year)
        if s.planned and s.asset != "AHU-01"
    ]
    return sorted(rows, key=lambda r: (r[1], r[0]))


CAPA_ACTIONS = {
    "seal": ("Replace agitator seals when their barrier fluid loss passes 3 mL/h, and trend it per batch", "Upstream"),
    "contamination": ("Review sampling aseptic technique and the seal condition before each inoculation", "Upstream"),
    "WFI": ("Clean the still's heat exchanger every quarter; alarm the loop at 1.0 µS/cm", "Utilities"),
    "pressure cascade": ("Change the AHU final filters at 450 Pa, not only every six months", "Utilities"),
    "inactivation": ("Titrate the acid by pH, not by weight; check each titrant lot's strength", "Downstream"),
    "integrity": ("Train installers on the virus filter's housing; add a pre-use integrity test", "Downstream"),
    "out of specification": ("Repack the CEX column when its asymmetry passes 1.6; trend HMW per lot", "Downstream"),
    "moisture": ("Leak-test the lyophiliser before every cycle and stop above 20 µbar·L/s", "Fill-finish"),
    "settle plate": ("Retrain on interventions at the needles; review the room pressure alarms", "Fill-finish"),
}


def capa(year: sim.Year) -> list[list[Any]]:
    rows = []
    t1 = END.timestamp()
    n = 0
    for d in year.deviations:
        if not d.capa:
            continue
        n += 1
        key = next((k for k in CAPA_ACTIONS if k.lower() in (d.title + " " + d.root_cause).lower()), "seal")
        action, area = CAPA_ACTIONS[key]
        r = random.Random(f"{SEED}/capa/{d.id}")
        due = d.opened + 60 * 86400
        closed = d.opened + r.uniform(30, 75) * 86400
        effective = closed + 90 * 86400
        rows.append(
            [
                f"CAPA-{datetime.fromtimestamp(d.opened, ZONE):%y}-{n:03d}", d.id, local(d.opened), action,
                OWNERS[area], local(due), local(closed) if closed < t1 else "",
                local(effective) if effective < t1 else "", "closed" if closed < t1 else "open",
            ]
        )  # fmt: skip
    return rows


def write_committed(out: Path, year: sim.Year, stats: Stats) -> dict[str, int]:
    from tiles_api.sample_plant.biologics import documents

    t1 = END.timestamp()
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
            "tag", "unit", "kind", "sample_rate_hz", "description", "asset", "measure", "range_min", "range_max",
            "stuck_after_s", "wear_limit", "wear_direction", "event_kind",
        ),
        (
            (
                t.tag, t.unit, t.kind, t.rate_hz, t.description, t.asset, t.measure, t.low, t.high, t.stuck_after_s,
                t.wear_limit, t.wear_direction, t.event_kind,
            )
            for t in all_tags()
        ),
    )  # fmt: skip
    n["plant/equipment.csv"] = write_csv(
        out / "plant" / "equipment.csv",
        ("asset", "label", "kind", "vendor", "model", "year", "area", "plc"),
        ((m.asset, m.label, m.kind, m.vendor, m.model, m.year, m.area, m.plc) for m in MACHINES),
    )
    cost_rows: list[list[Any]] = [
        ["downtime", m.asset, m.downtime_cost_eur_h, "EUR/h"] for m in MACHINES if m.downtime_cost_eur_h
    ]
    cost_rows += [
        ["scrap", "lost batch", BATCH_COST_EUR, "EUR/batch"],
        ["scrap", "drug substance", DS_COST_EUR_G, "EUR/g"],
        ["scrap", "vial", VIAL_COST_EUR, "EUR/vial"],
        ["labour", "maintenance technician", TECHNICIAN_EUR_H, "EUR/h"],
    ]
    cost_rows += [["part", k, v, "EUR"] for k, v in PART_COSTS.items()]
    n["plant/costs.csv"] = write_csv(out / "plant" / "costs.csv", ("item", "of", "value", "unit"), cost_rows)
    n["plant/products.csv"] = write_csv(
        out / "plant" / "products.csv",
        ("product", "name", "mg_a_vial", "fill_g", "bulk_g_l", "working_volume_l"),
        [(PRODUCT, PRODUCT_NAME, VIAL_MG, FILL_G, BULK_G_L, WORKING_VOLUME_L)],
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
            "day", "shift", "crew", "batches_inoculated", "batches_harvested", "batches_lost", "bulk_lots", "bulk_kg",
            "vials_filled", "vials_rejected", "vials_passed",
        ),
        production(year),
    )  # fmt: skip
    batches = [b for b in year.batches if b.inoculated]
    n["batch-records/batches.csv"] = write_csv(
        out / "batch-records" / "batches.csv",
        (
            "batch", "reactor", "vial", "thawed", "rocking_bioreactor", "n1_bioreactor", "n1_transfer_vcd",
            "n1_transfer_viability", "seed_hold_h", "inoculated", "culture_end", "status", "lost_code", "peak_vcd",
            "harvest_vcd", "harvest_viability", "harvest_titre_g_l", "harvest_volume_l", "harvest_mass_g",
            "harvest_delay_h", "hold_before_capture_h", "bulk_lot",
        ),
        (
            (
                b.id, b.reactor, b.vial, local(b.seed_start), b.wb, b.sb, round(b.transfer_vcd, 2),
                round(b.transfer_viability, 1), round(b.seed_hold_h, 1), local(b.inoculated),
                local(b.ended) if b.ended < t1 else "", b.status, b.lost, round(max(b.vcd), 1),
                round(b.harvest_vcd, 2) if b.harvest[0] else "", round(b.harvest_viability, 1) if b.harvest[0] else "",
                round(b.harvest_titre, 2) if b.harvest[0] else "", round(b.harvest_volume_l, 0) if b.harvest[0] else "",
                round(b.harvest_mass_g, 0) if b.harvest[0] else "", round(b.harvest_delay_h, 1) if b.harvest[0] else "",
                round(b.hold_h, 1) if b.bulk_id else "", b.bulk_id,
            )
            for b in batches
        ),
    )  # fmt: skip
    n["batch-records/unit-operations.csv"] = write_csv(
        out / "batch-records" / "unit-operations.csv",
        ("batch", "step", "equipment", "start", "end", "result"),
        ((b.id, step, eq, local(a), local(e), res) for b in batches for step, eq, a, e, res in b.steps),
    )
    n["batch-records/protein-a-cycles.csv"] = write_csv(
        out / "batch-records" / "protein-a-cycles.csv",
        ("cycle", "batch", "resin_cycle", "start", "load_g_l", "step_yield_pct", "column_dp_bar"),
        (
            (c.id, c.batch, c.resin_cycle, local(c.start), round(c.load_g_l, 1), round(c.step_yield, 1),
             round(c.column_dp, 2))
            for b in batches for c in b.cycles
        ),
    )  # fmt: skip
    n["batch-records/bulk-lots.csv"] = write_csv(
        out / "batch-records" / "bulk-lots.csv",
        (
            "bulk_lot", "batch", "filled", "mass_g", "concentration_g_l", "hmw_pct", "hcp_ppm", "endotoxin_eu_mg",
            "cex_asymmetry", "tested", "status",
        ),
        (
            (
                b.bulk_id, b.id, local(b.bulk_end), round(b.bulk_g, 0), round(b.bulk_conc, 1), round(b.bulk_hmw, 2),
                round(b.bulk_hcp, 1), round(b.bulk_endotoxin, 3), round(b.cex_asymmetry, 2),
                local(b.bulk_tested) if b.bulk_tested < t1 else "",
                b.bulk_status if b.bulk_tested < t1 else "in testing",
            )
            for b in batches if b.bulk_id
        ),
    )  # fmt: skip
    n["batch-records/fill-lots.csv"] = write_csv(
        out / "batch-records" / "fill-lots.csv",
        (
            "fill_lot", "bulk_lot", "filled_start", "filled_end", "lyo_start", "lyo_end", "inspected_end", "vials",
            "rejected", "fil_wt", "vis_cake", "vis_part", "vis_cos", "vis_crimp", "leak_rate", "chamber_pressure",
            "moisture_pct", "em_cfu", "status",
        ),
        (
            (
                lot.id, lot.batch.bulk_id, local(lot.fill[0]), local(lot.fill[1]), local(lot.lyo[0]), local(lot.lyo[1]),
                local(lot.inspected[1]), lot.vials, len(lot.rejects),
                *(sum(1 for c, _ in lot.rejects.values() if c == k)
                  for k in ("FIL-WT", "VIS-CAKE", "VIS-PART", "VIS-COS", "VIS-CRIMP")),
                round(lot.leak_rate, 1), round(lot.chamber_pressure, 0), round(lot.moisture, 2), lot.em_cfu,
                lot.status if lot.tested < t1 else "in testing",
            )
            for lot in year.lots
        ),
    )  # fmt: skip
    n["batch-records/media-and-buffers.csv"] = write_csv(
        out / "batch-records" / "media-and-buffers.csv",
        ("lot", "kind", "start", "end", "osmolality_mosm_kg", "ph", "conductivity_ms_cm"),
        [(lot, "medium", local(a), local(e), round(o, 0), round(p, 2), "") for lot, a, e, o, p in year.media]
        + [(lot, "buffer", local(a), local(e), "", "", round(c, 1)) for lot, a, e, c in year.buffers],
    )
    n["qms/deviations.csv"] = write_csv(
        out / "qms" / "deviations.csv",
        (
            "deviation", "opened", "area", "asset", "lot", "category", "classification", "title", "description",
            "root_cause", "capa", "closed",
        ),
        (
            (
                d.id, local(d.opened), d.area, d.asset, d.lot, d.category, d.classification, d.title, d.description,
                d.root_cause if d.closed < t1 else "", "yes" if d.capa else "",
                local(d.closed) if d.closed < t1 else "",
            )
            for d in year.deviations if d.opened < t1
        ),
    )  # fmt: skip
    n["qms/capa.csv"] = write_csv(
        out / "qms" / "capa.csv",
        ("capa", "deviation", "opened", "action", "owner", "due", "closed", "effectiveness_check", "status"),
        capa(year),
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
            "work_order", "type", "asset", "component", "code", "reported", "started", "finished", "labour_hours",
            "technician", "parts", "parts_cost_eur", "description", "episode",
        ),
        work_orders(year),
    )  # fmt: skip
    release = []
    for b in batches:
        if b.bulk_id and b.bulk_tested < t1:
            for test, value, unit, spec in (
                ("Aggregates (SEC-HPLC, HMW)", round(b.bulk_hmw, 2), "%", "<= 2.0"),
                ("Host cell protein (ELISA)", round(b.bulk_hcp, 1), "ppm", "<= 50"),
                ("Endotoxin (LAL)", round(b.bulk_endotoxin, 3), "EU/mg", "<= 0.10"),
                ("Concentration (A280)", round(b.bulk_conc, 1), "g/L", "95 to 105"),
            ):
                release.append((b.bulk_id, "drug substance", local(b.bulk_tested), test, value, unit, spec))
    for lot in year.lots:
        if lot.tested < t1:
            release.append(
                (lot.id, "drug product", local(lot.tested), "Residual moisture (Karl Fischer)", round(lot.moisture, 2),
                 "%", "<= 2.0")
            )  # fmt: skip
    n["lab/release-tests.csv"] = write_csv(
        out / "lab" / "release-tests.csv", ("lot", "kind", "tested", "test", "result", "unit", "specification"), release
    )
    n["lab/environmental-monitoring.csv"] = write_csv(
        out / "lab" / "environmental-monitoring.csv",
        ("fill_lot", "read", "location", "cfu", "limit"),
        (
            (lot.id, local(lot.fill[1] + 3 * 86400), "Grade A settle plates at the filling needles", lot.em_cfu, "< 1")
            for lot in year.lots
            if lot.fill[1] + 3 * 86400 < t1
        ),
    )
    n["lab/resin-binding-capacity.csv"] = write_csv(
        out / "lab" / "resin-binding-capacity.csv",
        ("sample_id", "time", "dbc_g_l"),
        (
            (f"DBC-{i + 1:03d}", local(t), v)
            for i, (t, _, v) in enumerate(x for x in sorted(year.lab) if x[1] == "lab.pa_dbc" and x[0] < t1)
        ),
    )
    n["ground-truth/episodes.csv"] = write_csv(
        out / "ground-truth" / "episodes.csv",
        (
            "episode", "asset", "mode", "code", "onset", "failed_at", "resolved_at", "outcome", "peak_severity",
            "ramp_working_days", "precursors",
        ),
        episodes(year),
    )  # fmt: skip
    n["ground-truth/quirks.csv"] = write_csv(
        out / "ground-truth" / "quirks.csv",
        ("quirk", "where", "from", "to", "what"),
        [
            ("sensor drift", DO_DRIFT[0], DO_DRIFT[2].isoformat(), DO_DRIFT[3].isoformat(),
             "BR-02's DO probe read 6 points high from its membrane change until its calibration"),
            ("wrong unit", MTORR[0], MTORR[2].isoformat(), MTORR[3].isoformat(),
             "Logged in mTorr (0.75 of the µbar values) after a gauge software update"),
            ("historian outage", "cs01.*, cs02.*", OUTAGE[1].isoformat(), OUTAGE[2].isoformat(),
             "No chromatography skid readings: the collector was down"),
            ("clock offset", "ly01.*", LYO_CLOCK[2].isoformat(), LYO_CLOCK[3].isoformat(),
             "The lyophiliser's clock stayed on winter time: its readings are an hour early"),
            ("code renamed", "mes/stops.csv", START.isoformat(), OLD_CODES["DT-LYO"][1].isoformat(),
             "Lyophiliser leak failures are LYO before the MES update, DT-LYO after"),
            ("duplicate rows", "mes/stops.csv", START.isoformat(), END.isoformat(),
             "About 0.4% of stops are logged twice"),
            ("no end time", "mes/stops.csv", START.isoformat(), END.isoformat(),
             "About 0.3% of unplanned stops have no end time"),
            ("model gap", "plant/ontology.json", START.isoformat(), END.isoformat(),
             "A retired 500 L bioreactor (BR-05) with no relationships"),
        ],
    )  # fmt: skip
    write_json(
        out / "ground-truth" / "process-model.json",
        {"process": sim.PROCESS, "notes": "Each lot's and vial's results from its genealogy (simulate.py)"},
    )
    n["ground-truth/process-model.json"] = len(sim.PROCESS)
    (out / "baseline.md").write_text(baseline(year), encoding="utf-8")
    n["baseline.md"] = 1
    return n


def baseline(year: sim.Year) -> str:
    rows = []
    months = 12
    for m in MACHINES:
        st = year.stations.get(m.asset)
        if not st or not m.downtime_cost_eur_h:
            continue
        stops = [s for s in st.stops if not s.planned and not s.comment.endswith("(continued)")]
        hours = sum(s.end - s.start for s in st.stops if not s.planned) / 3600
        rows.append(
            f"| {m.asset} | {len(stops):,} | {len(stops) / months:.1f} | {hours:,.0f}"
            f" | {hours * m.downtime_cost_eur_h:,.0f} |"
        )
    batches = [b for b in year.batches if b.inoculated]
    lost = [b for b in batches if b.lost]
    ds = [b for b in batches if b.bulk_id and b.bulk_tested < END.timestamp()]
    rejected = [b for b in ds if b.bulk_status == "rejected"]
    vials = sum(lot.vials for lot in year.lots)
    codes = Counter(c for lot in year.lots for c, _ in lot.rejects.values())
    reject_rows = "\n".join(
        f"| {CODES[c].code} | {CODES[c].description} | {k:,} | {100 * k / vials:.2f} % | {k * VIAL_COST_EUR:,.0f} |"
        for c, k in codes.most_common()
    )
    ds_kg = sum(b.bulk_g for b in ds) / 1000
    return (
        "# Baseline metrics\n\n"
        "Made by `tiles-sample-plant generate biologics` from the simulated year: each machine's unplanned\n"
        "stops (a stop continued into the next shift counts once; its hours in full) and their cost at\n"
        "controlling's figures (plant/costs.csv), the batches and the vials.\n\n"
        "## Stops\n\n| Machine | Unplanned stops | A month | Hours | Cost of the hours (EUR) |\n"
        "| --- | --- | --- | --- | --- |\n"
        + "\n".join(rows)
        + f"\n\n## Batches\n\n{len(batches)} batches inoculated; {len(lost)} lost"
        f" ({', '.join(f'{b.id}: {CODES[b.lost].description.lower()}' for b in lost) or 'none'}),"
        f" {len(lost) * BATCH_COST_EUR:,.0f} EUR. {len(ds)} drug substance lots tested ({ds_kg:,.1f} kg),"
        f" {len(rejected)} rejected"
        f"{' (' + ', '.join(b.bulk_id for b in rejected) + ')' if rejected else ''}.\n\n"
        f"## Vials\n\n{len(year.lots)} fill lots, {vials:,} vials filled, {sum(codes.values()):,} rejected.\n\n"
        "| Code | Reject | Vials | Of those filled | Cost (EUR) |\n| --- | --- | --- | --- | --- |\n"
        + reject_rows
        + "\n"
    )


def build(out: Path, big: bool = False) -> tuple[sim.Year, Stats, Capture, dict[str, Any]]:
    from tiles_api.sample_plant.biologics import documents, questions

    year, stats, capture, files = simulate(out, big)
    counts = write_committed(out, year, stats)
    counts.update(documents.write(out, year, stats))
    counts["copilot/questions.csv"] = common.write_questions(
        out / "copilot" / "questions.csv", questions.all_questions(year, stats, capture)
    )
    previous = common.read_json(out / "manifest.json")
    manifest = {
        "plant": "Brannock Biologics, Carrowmore biologics site (made up)",
        "from": START.isoformat(),
        "to": END.isoformat(),
        "seed": SEED,
        "committed": dict(sorted(counts.items())),
        "generated": dict(sorted(files.items())) if big else previous.get("generated", {}),
        "tables": tables(),
        "batches": len([b for b in year.batches if b.inoculated]),
        "vials": sum(lot.vials for lot in year.lots),
    }
    write_json(out / "manifest.json", manifest)
    return year, stats, capture, manifest


def generate(out: Path, big: bool = False) -> dict[str, Any]:
    return build(out, big)[3]


__all__ = ["build", "generate"]
