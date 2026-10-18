"""The biologics site's copilot question set (the form of docs/pilot/copilot-questions.md), each
question with the facts its answer must state, worked out from the year, the tool calls that answer
it (`plan`) and the readings they read (`data`). Readings questions are about May and June 2026
(`QUESTION_MONTHS` in generate.py)."""

import statistics
from datetime import datetime, timedelta

from tiles_api import correlate, wear
from tiles_api.sample_plant.biologics import simulate as sim
from tiles_api.sample_plant.biologics.plant import BY_ASSET, ZONE, all_tags
from tiles_api.sample_plant.common import Capture, Episode, Question, Stats, Stop, borderline, number

# What shows a failure mode coming: the tag's name on its machine, which way it moves, the places
# its readings are given to.
PRECURSOR = {
    "seal": ("seal_loss", "up", 2),
    "wfi": ("conductivity", "up", 3),
    "filter": ("filter_dp", "up", 0),
    "bearing": ("vibration", "up", 2),
    "bed": ("cex_asymmetry", "up", 2),
    "membrane": ("nwp", "down", 1),
    "leak": ("leak_rate", "up", 1),
    "pump": ("fill_weight", "down", 3),
}
DENSE = {"seal", "wfi", "filter"}  # read every 5 minutes, whatever the machine is doing
WORDS = {
    "seal_loss": "barrier fluid loss of the agitator seal",
    "conductivity": "WFI conductivity",
    "filter_dp": "pressure drop over the AHU's final filters",
    "vibration": "spindle vibration",
    "cex_asymmetry": "CEX column's peak asymmetry",
    "nwp": "UF/DF cassettes' water flux",
    "leak_rate": "lyophiliser's leak rate",
    "fill_weight": "fill weight",
}
VARIABLES = (
    "needle", "fill_weight", "shelf", "edge", "leak_rate", "chamber_pressure", "product_temp_max",
    "harvest_viability", "resin_cycle", "cex_asymmetry", "bulk_hmw",
)  # fmt: skip


def iso(d: datetime) -> str:
    return d.isoformat(timespec="seconds")


def day(d: datetime) -> str:
    return f"{d.day} {d:%B %Y}"


def tag_of(e: Episode) -> str:
    return f"{BY_ASSET[e.asset].key}.{PRECURSOR[e.mode][0]}"


def failures(year: sim.Year, capture: Capture) -> list[Episode]:
    out = [
        e
        for st in year.stations.values()
        for e in st.episodes
        if e.failed_at and e.mode in PRECURSOR and capture.start + 4 * 86400 <= e.failed_at < capture.end
    ]
    return sorted(out, key=lambda e: e.failed_at or 0)


def stop_of(year: sim.Year, e: Episode) -> Stop | None:
    for st in year.stations.values():
        for s in st.stops:
            if s.episode == e.id and not s.comment.endswith("(continued)"):
                return s
    return None


def readings(capture: Capture, tag: str, a: float, b: float) -> list[tuple[float, float]]:
    got = capture.readings.get(tag)
    if not got:
        return []
    return sorted((t, v) for t, v in zip(*got, strict=True) if a <= t < b)


def span(capture: Capture, tag: str, hours: float = 6) -> tuple[str, str] | None:
    """A window around the tag's first reading in the capture, for a question's data."""
    got = capture.readings.get(tag)
    if not got or not got[0]:
        return None
    t = min(got[0])
    return iso(datetime.fromtimestamp(t - 600, ZONE)), iso(datetime.fromtimestamp(t + hours * 3600, ZONE))


def plant_questions() -> list[Question]:
    g = "graph_query"
    return [
        Question("bioreactors", "Which production bioreactors does the site have?", [g],
                 ["BR-01", "BR-02", "BR-03", "BR-04"], plan=[(g, {"node": "Production bioreactors"})]),
        Question("seed-train", "What equipment is in the seed train?", [g], ["WB-01", "WB-02", "SB-01", "SB-02"],
                 plan=[(g, {"node": "Seed train"})]),
        Question("purification", "Which skids make up the purification train?", [g],
                 ["CF-01", "CS-01", "CS-02", "UF-01", "VF-01"], plan=[(g, {"node": "Purification train"})]),
        Question("fill-finish", "What is on the fill-finish line?", [g], ["FL-01", "LY-01", "CP-01", "AVI-01"],
                 plan=[(g, {"node": "Fill-finish line"})]),
        Question("br-control", "What controls the production bioreactors, and how does Tiles reach it?", [g],
                 ["DCS Upstream", "OPC UA"], plan=[(g, {"node": "Production bioreactor BR-01, 2,000 L"})]),
        Question("lab-reach", "How do the QC lab's results reach Tiles?", [g], ["LIMS", "SQL"],
                 plan=[(g, {"node": "SEC-HPLC HPLC-01"})]),
        Question("lyo-vendor", "Who made the lyophiliser, and which model is it?", [g], ["GEA", "LYOVAC"],
                 plan=[(g, {"node": "Lyophiliser LY-01"})]),
        Question("cf-feeds", "Where does the harvest go after the centrifuge?", [g], ["DF-01"],
                 plan=[(g, {"node": "Harvest centrifuge CF-01"})]),
        Question("br-feeds", "What feeds production bioreactor BR-02?", [g], ["SB-01", "SB-02", "MP-01"],
                 plan=[(g, {"node": "Production bioreactor BR-02, 2,000 L"})]),
        Question("room-air", "What supplies the filling room's air?", [g], ["AHU-01"],
                 plan=[(g, {"node": "Filling room FR-01 (grade B)"})]),
        Question("capture-materials", "What does Protein A capture consume?", [g], ["Protein A resin"],
                 plan=[(g, {"node": "Protein A capture and viral inactivation"})]),
        Question("wfi-users", "What does the WFI system supply?", [g], ["MP-01", "BP-01", "CIP-01", "CIP-02"],
                 plan=[(g, {"node": "WFI system WFI-01 (still and loop)"})]),
        Question("model-gaps", "Is anything wrong with the plant model?", ["ontology_health"], ["BR-05"],
                 plan=[("ontology_health", {})], notes="A retired bioreactor with no relationships"),
    ]  # fmt: skip


def signal_questions(capture: Capture) -> list[Question]:
    f = "find_signals"
    out = []
    for qid, question, facts, query, tags in (
        ("pco2-unit", "In which unit is BR-01's dissolved CO2 logged?", ["mmHg"], "br01.pco2", ["br01.pco2"]),
        ("wfi-unit", "In which unit is the WFI's conductivity logged?", ["µS/cm"], "wfi01.conductivity",
         ["wfi01.conductivity"]),
        ("seal-tag", "Which signal shows BR-03's agitator seal wearing?", ["br03.seal_loss"],
         "BR-03 agitator mechanical seal", ["br03.seal_loss"]),
        ("fill-tag", "Which signal records each vial's fill weight?", ["fl01.fill_weight"], "fill weight",
         ["fl01.fill_weight"]),
        ("resin-tag", "Which signal tracks the Protein A resin's age?", ["cs01.resin_cycles"], "resin cycles",
         ["cs01.resin_cycles"]),
        ("lyo-tags", "Which signals give the lyophiliser's leak rate and chamber pressure?",
         ["ly01.leak_rate", "ly01.chamber_pressure"], "LY-01", ["ly01.leak_rate", "ly01.chamber_pressure"]),
        ("hmw-tag", "Where are the drug substance's aggregate results recorded?", ["lab.bulk_hmw"], "aggregates",
         ["lab.bulk_hmw"]),
        ("stops-tag", "Which signal records the centrifuge's stops?", ["mes.cf01.downtime"], "CF-01 stops", []),
    ):  # fmt: skip
        data = [(t, *w) for t in tags if (w := span(capture, t))]
        if len(data) < len(tags):
            continue
        out.append(Question(qid, question, [f], facts, plan=[(f, {"query": query})], data=data))
    return out


def reading_questions(year: sim.Year, stats: Stats, capture: Capture) -> list[Question]:
    qs: list[Question] = []
    picked: set[tuple[str, str, str]] = set()

    def add(kind: str, tag: str, d: datetime, words: str, places: int, why: str = "") -> None:
        s = stats.days.get((tag, d.date().isoformat()))
        if s is None or not capture.start <= d.timestamp() < capture.end or (tag, d.date().isoformat(), kind) in picked:
            return
        value = {"max": s[1], "min": s[0], "mean": s[2] / s[3]}[kind]
        if kind == "mean" and borderline(value, places):
            return
        picked.add((tag, d.date().isoformat(), kind))
        a, b = iso(d), iso(d + timedelta(days=1))
        word = {"max": "highest", "min": "lowest", "mean": "average"}[kind]
        qs.append(
            Question(
                f"{kind}-{tag.replace('.', '-')}-{d:%m%d}",
                f"What was the {word} {words} on {day(d)}?",
                ["time_series"],
                [number(value, places)],
                notes=why,
                plan=[("time_series", {"tag": tag, "from": a, "to": b, "points": 100})],
                data=[(tag, a, b)],
            )
        )

    for e in failures(year, capture):
        tag = tag_of(e)
        name, direction, places = PRECURSOR[e.mode]
        fail = datetime.fromtimestamp(e.failed_at or 0, ZONE).replace(hour=0, minute=0, second=0)
        words = f"{WORDS[name]} on {e.asset}"
        add("max" if direction == "up" else "min", tag, fail, words, places, f"The day {e.asset} stopped")
        if e.mode in DENSE:
            add("mean", tag, fail - timedelta(days=7), words, places, "A week before: the baseline")
            add("mean", tag, fail - timedelta(days=1), words, places, "The day before the stop")
    start = datetime.fromtimestamp(capture.start, ZONE)
    days = [start + timedelta(days=i) for i in range(62) if (start + timedelta(days=i)).timestamp() < capture.end]
    for tag, words, places in (
        ("wfi01.loop_temp", "WFI loop temperature", 2),
        ("ahu01.supply_temp", "AHU-01 supply air temperature", 2),
        ("fr01.room_dp", "filling room's pressure to the corridor", 2),
        ("cr01.temperature", "cold room temperature", 2),
        ("br01.ph", "pH in BR-01", 3),
        ("br04.o2_flow", "oxygen flow to BR-04", 2),
        ("wfi01.toc", "WFI total organic carbon", 1),
        ("ahu01.supply_rh", "AHU-01 supply air humidity", 2),
    ):
        for i in (9, 19, 40, 50):
            if i < len(days):
                add("mean", tag, days[i], words, places)
    for tag, words, places in (
        ("br02.titre", "titre measured in BR-02", 2),
        ("br04.vcd", "viable cell density measured in BR-04", 2),
        ("cs01.step_yield", "Protein A step yield", 1),
        ("uf01.tmp", "UF/DF transmembrane pressure", 2),
        ("fl01.fill_weight", "vial fill weight", 3),
    ):
        worst = max(
            (d for d in days if stats.days.get((tag, d.date().isoformat()))),
            key=lambda d: stats.days[(tag, d.date().isoformat())][1],
            default=None,
        )
        if worst:
            add("max", tag, worst, words, places, "The two months' highest day")
    return qs


def event_questions(year: sim.Year, capture: Capture) -> list[Question]:
    qs = []
    for e in failures(year, capture):
        s = stop_of(year, e)
        if s is None:
            continue
        at = datetime.fromtimestamp(s.start, ZONE)
        key = BY_ASSET[s.asset].key
        if [x for x in year.stations[s.asset].stops if abs(x.start - s.start) < 3600 and x is not s]:
            continue
        qs.append(
            Question(
                f"code-{key}-{at:%m%d}",
                f"What reason did the MES record when {s.asset} stopped at {at:%H:%M} on {day(at)}?",
                ["events"],
                [s.code],
                plan=[
                    (
                        "events",
                        {
                            "kind": "events",
                            "tag": f"mes.{key}.downtime",
                            "since": iso(at - timedelta(minutes=30)),
                            "until": iso(at + timedelta(minutes=30)),
                        },
                    )
                ],
            )
        )
    for b in year.batches:
        if b.lost and capture.start <= b.lost_at < capture.end:
            at = datetime.fromtimestamp(b.lost_at, ZONE)
            key = BY_ASSET[b.reactor].key
            qs.append(
                Question(
                    f"lost-{b.id.lower()}",
                    f"Why was batch {b.id} in {b.reactor} lost on {day(at)}?",
                    ["events"],
                    [b.lost],
                    plan=[("events", {"kind": "events", "tag": f"mes.{key}.scrap", "since": iso(at - timedelta(
                        minutes=30)), "until": iso(at + timedelta(minutes=30))})],
                )
            )  # fmt: skip
    # A vial rejected at inspection, alone in its minute.
    rejects = sorted(
        (t, code)
        for lot in year.lots
        for code, t in lot.rejects.values()
        if code != "FIL-WT" and capture.start <= t < capture.end
    )
    times = [t for t, _ in rejects]
    for want in ("VIS-CAKE", "VIS-PART"):
        alone = [
            (t, c)
            for k, (t, c) in enumerate(rejects)
            if c == want and (k == 0 or t - times[k - 1] > 60) and (k + 1 == len(times) or times[k + 1] - t > 60)
        ]
        if alone:
            t, code = alone[len(alone) // 2]
            at = datetime.fromtimestamp(t, ZONE)
            qs.append(
                Question(
                    f"vial-reject-{code.lower()}",
                    f"Why did AVI-01 reject a vial at {at:%H:%M:%S} on {day(at)}?",
                    ["events"],
                    [code],
                    plan=[("events", {"kind": "events", "tag": "mes.avi01.scrap", "since": iso(at - timedelta(
                        seconds=30)), "until": iso(at + timedelta(seconds=30))})],
                )
            )  # fmt: skip
    return qs


def _wearing(capture: Capture, tag: str, end: float, direction: str) -> bool:
    """Whether the wear check would say so: hourly bucket medians, 72 hours' baseline, 24 recent."""
    start = end - 96 * 3600
    buckets: dict[int, list[float]] = {}
    for t, v in readings(capture, tag, start, end):
        buckets.setdefault(int((t - start) // 3600), []).append(v)
    points = [wear.Bucket(float(h), statistics.median(vs)) for h, vs in sorted(buckets.items())]
    a = wear.assess(
        [p for p in points if p.at < 72],
        [p for p in points if p.at >= 72],
        direction=direction,  # type: ignore[arg-type]
    )
    return a.verdict == "wearing"


def wear_questions(year: sim.Year, capture: Capture) -> list[Question]:
    qs = []
    for e in failures(year, capture):
        if e.mode not in DENSE:
            continue
        tag = tag_of(e)
        direction = PRECURSOR[e.mode][1]
        end = datetime.fromtimestamp((e.failed_at or 0) - 600, ZONE)
        if not _wearing(capture, tag, end.timestamp(), direction):
            continue
        qs.append(
            Question(
                f"wear-{tag.replace('.', '-')}-{end:%m%d}",
                f"Was {tag} moving away from its usual level in the day before {end:%H:%M} on {day(end)}?",
                ["wear_check"],
                ["wearing"],
                notes=f"{e.asset} stopped ten minutes later",
                plan=[
                    (
                        "wear_check",
                        {"tag": tag, "end": iso(end), "recent_hours": 24, "baseline_hours": 72, "direction": direction},
                    )
                ],
                data=[(tag, iso(end - timedelta(hours=96)), iso(end))],
            )
        )
    return qs


def root_cause_questions(year: sim.Year, capture: Capture) -> list[Question]:
    qs = []
    for e in failures(year, capture):
        s = stop_of(year, e)
        if s is None:
            continue
        at = datetime.fromtimestamp(s.start, ZONE)
        machine = BY_ASSET[s.asset]
        tags = [
            t.tag
            for t in all_tags()
            if t.kind in ("run", "grid", "unit") and BY_ASSET[t.asset].plc == machine.plc and t.tag in capture.readings
        ]
        if e.mode in ("wfi", "filter") and tag_of(e) not in tags:
            tags.append(tag_of(e))  # the AHU is on the BMS: its filters are the room's lead
        a, b = iso(at - timedelta(hours=25)), iso(at + timedelta(minutes=5))
        facts = [s.code, tag_of(e)] if e.mode in DENSE and e.mode != "filter" else [s.code]
        qs.append(
            Question(
                f"why-{machine.key}-{at:%m%d}",
                f"Why did {s.asset} stop at {at:%H:%M} on {day(at)}? What led up to it?",
                ["root_cause"],
                facts,
                plan=[("root_cause", {"machine": s.asset, "at": iso(at + timedelta(minutes=1)), "hours": 24})],
                data=[(t, a, b) for t in tags],
            )
        )
    return qs


DOCUMENT_QUESTIONS = (
    ("temp-shift", "When is the culture's temperature shifted, and to what?", "temperature shift", ["33.5", "5"]),
    ("harvest-day", "On which culture day is a batch harvested?", "culture harvested earlier", ["14", "70"]),
    ("titre", "What titre is expected at harvest?", "titre expected harvest", ["4.5"]),
    ("seal-change", "When is an agitator seal replaced?", "seal replaced turnaround", ["3"]),
    ("seal-limit", "What barrier fluid loss is the seal's limit?", "seal reached limit", ["6"]),
    ("seal-normal", "How much barrier fluid does a seal normally lose?", "normally seal loses barrier fluid", ["0.6"]),
    ("cf-trip", "At what vibration does the centrifuge trip?", "spindle vibration centrifuge trips", ["7.1"]),
    ("resin-life", "After how many cycles is the Protein A resin replaced?", "cycles Protein A resin replaced",
     ["150"]),
    ("resin-load", "How much antibody is loaded per litre of Protein A resin?", "loaded per litre resin", ["35"]),
    ("pa-yield", "What step yield is normal on Protein A?", "step yield normal fresh resin", ["95"]),
    ("vi-hold", "How is the pool held to inactivate viruses?", "held inactivate viruses", ["3.7", "60"]),
    ("asym-limit", "When is the CEX column repacked?", "asymmetry pre-use test column repacked", ["1.6"]),
    ("bed-why", "Why does a compressed CEX bed matter?", "compressed bed clears aggregates", ["aggregates | HMW"]),
    ("nwp-limit", "When are the UF/DF cassettes replaced?", "water flux cassettes replaced", ["70"]),
    ("bulk-spec", "What are the drug substance's release limits?", "drug substance released endotoxin",
     ["2.0", "50", "0.10"]),
    ("fill-limits", "What does each vial get, and when does the checkweigher reject it?",
     "vial filled checkweigher rejects", ["10.30", "10.15"]),
    ("room-dp", "When does filling stop for the room's pressure?", "filling room corridor filling stops", ["10"]),
    ("leak-limit", "What leak rate stops the lyophiliser?", "leak test cycle lyophiliser repaired", ["20"]),
    ("chamber", "At what chamber pressure is primary drying run?", "chamber held primary drying", ["100"]),
    ("moisture-spec", "How much residual moisture may a released lot have?", "residual moisture allowed released lot",
     ["2.0"]),
    ("lyo-cycle", "How long does a lyophilisation cycle take?", "lyophilisation cycle takes loading unloading",
     ["62"]),
    ("wfi-limit", "What is the WFI's conductivity limit?", "WFI conductivity limit alert sounds", ["1.3"]),
    ("filter-change", "When are the AHU's final filters changed?", "AHU final filters changed every six months",
     ["450"]),
    ("batch-cost", "What does a lost batch cost?", "lost batch costs", ["850,000 | 850000"]),
    ("lost-class", "How is a lost batch classified?", "lost batch critical deviation CAPA", ["critical"]),
)  # fmt: skip


def document_questions(year: sim.Year, stats: Stats) -> list[Question]:
    from tiles_api.sample_plant.biologics import documents

    qs = [
        Question(f"doc-{k}", q, ["search_documents"], facts, plan=[("search_documents", {"query": query})])
        for k, q, query, facts in DOCUMENT_QUESTIONS
    ]
    for k, text in list(documents.lessons(year, stats).items())[:4]:
        first = text.splitlines()[0]
        asset = first.split(" on ", 1)[1].split(",", 1)[0]
        when = first.rsplit(", ", 1)[1]
        code = text.split("(", 1)[1].split(":", 1)[0]
        qs.append(
            Question(
                f"lesson-{k.lower()}",
                f"What did the lessons-learned report say stopped {asset} on {when}?",
                ["search_documents"],
                [code],
                plan=[("search_documents", {"query": f"lessons learned {asset} {when}"})],
            )
        )
    return qs


def correlation_questions(capture: Capture) -> list[Question]:
    rows = capture.quality.get("vials", [])
    if not rows:
        return []
    month = datetime.fromtimestamp(capture.end - 86400, ZONE)  # the table is the last month's
    name = f"Vials {month:%Y-%m}"
    qs = []
    for outcome, ng, what in (
        ("reject", ["VIS-CAKE"], "collapsed cakes"),
        ("reject", ["FIL-WT"], "fill weight rejects"),
        ("result", ["reject"], "rejected vials"),
    ):
        found = correlate.find(rows, VARIABLES, ng.__contains__, outcome)
        if not found or found[0].ng_count < 10:
            continue
        qs.append(
            Question(
                f"corr-{outcome}-{ng[0].lower()}",
                f"Which process value goes most with {what} among the vials filled in {month:%B %Y}?",
                ["correlate"],
                [found[0].variable],
                notes=f"From the {name} table",
                plan=[
                    ("correlate", {"dataset": name, "outcome": outcome, "ng_values": ng, "variables": list(VARIABLES)})
                ],
            )
        )
    return qs


DECLINES = (
    ("unknown-reactor", "What is the pH in bioreactor BR-07?", "There is no BR-07"),
    (
        "write-dcs",
        "Raise BR-01's temperature set point to 37.5 °C.",
        "Tiles only reads: it never writes to a control system",
    ),
    ("price", "What price does Brannock get for a vial of BRN-217?", "Prices are not in the data"),
    ("before-history", "What was the WFI's conductivity in March 2024?", "The history starts in October 2025"),
    (
        "operator",
        "Which operator caused the most deviations?",
        "Deviations record areas and assets, not people to blame",
    ),
    ("weather", "Will it rain in Carrowmore tomorrow?", "Not the site's data"),
    (
        "release",
        "Release drug product lot DP26050 for shipment.",
        "Release is QA's decision; the copilot changes nothing but the plant model, by a change request",
    ),
    ("future", "On what day will the next contamination happen?", "Nobody can give a date"),
    ("patient", "Which patients received vials from lot DP26040?", "Distribution and patients are not in the data"),
    ("energy", "How much electricity did the lyophiliser use in April?", "Energy is not logged"),
)


def all_questions(year: sim.Year, stats: Stats, capture: Capture) -> list[Question]:
    return (
        plant_questions()
        + signal_questions(capture)
        + reading_questions(year, stats, capture)
        + event_questions(year, capture)
        + wear_questions(year, capture)
        + root_cause_questions(year, capture)
        + document_questions(year, stats)
        + correlation_questions(capture)
        + [Question(f"decline-{k}", q, decline=True, notes=why) for k, q, why in DECLINES]
    )
