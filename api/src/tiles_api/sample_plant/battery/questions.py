"""The battery plant's copilot question set (the form of docs/pilot/copilot-questions.md), each
question with the facts its answer must state, worked out from the year, the tool calls that
answer it (`plan`) and the readings they read (`data`). Readings questions are about June 2026
(`QUESTION_MONTH` in generate.py)."""

from datetime import datetime, timedelta

from tiles_api import correlate
from tiles_api.sample_plant.battery import simulate as sim
from tiles_api.sample_plant.battery.plant import BY_ASSET, ZONE, all_tags
from tiles_api.sample_plant.common import Capture, Episode, Question, Stats, Stop, borderline, number

# What shows a failure mode coming: the tag (its machine's key and name) and which way it moves.
PRECURSOR = {
    "die-lip": ("coating_weight_cv", "up", 2),
    "dryer": ("dryer_fan_current", "up", 2),
    "bearing": ("bearing_vibration", "up", 2),
    "tension": ("separator_tension", "down", 2),
    "horn": ("weld_energy", "up", 0),
    "pump": ("fill_weight", "down", 1),
    "contacts": ("contact_resistance", "up", 2),
    "desiccant": ("wheel_dp", "up", 0),
}
WORDS = {
    "coating_weight_cv": "coating weight variation across the web",
    "dryer_fan_current": "dryer fan current",
    "bearing_vibration": "roll bearing vibration",
    "separator_tension": "separator tension",
    "weld_energy": "weld energy",
    "fill_weight": "electrolyte fill weight",
    "contact_resistance": "channel contact resistance",
    "wheel_dp": "desiccant wheel pressure drop",
}
VARIABLES = (
    "cathode_loading", "cathode_loading_cv", "anode_loading", "cathode_thickness_sd", "cathode_burr", "anode_burr",
    "cathode_moisture", "anode_moisture", "dew_point", "overhang", "separator_tension", "weld_energy", "fill_weight",
    "formation_ah",
)  # fmt: skip


def iso(d: datetime) -> str:
    return d.isoformat(timespec="seconds")


def day(d: datetime) -> str:
    return f"{d.day} {d:%B %Y}"


def tag_of(e: Episode) -> str:
    name = PRECURSOR[e.mode][0]
    key = "dh01" if e.mode == "desiccant" else BY_ASSET[e.asset].key
    return f"{key}.{name}"


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


def plant_questions() -> list[Question]:
    g = "graph_query"
    q = [
        Question(
            "cathode-line",
            "Which machines make up the cathode line?",
            [g],
            ["MX-C1", "CT-C1", "CL-C1", "SL-C1", "VD-C1"],
            plan=[(g, {"node": "Cathode line"})],
        ),
        Question(
            "anode-line",
            "Which machines are on the anode line?",
            [g],
            ["MX-A1", "CT-A1", "CL-A1", "SL-A1", "VD-A1"],
            plan=[(g, {"node": "Anode line"})],
        ),
        Question(
            "assembly-line",
            "What is on the assembly line?",
            [g],
            ["ST-01", "ST-02", "UW-01", "EF-01", "DR-01"],
            plan=[(g, {"node": "Assembly line"})],
        ),
        Question(
            "racks",
            "Which formation racks does the plant have?",
            [g],
            ["FM-01", "FM-02", "FM-03", "FM-04"],
            plan=[(g, {"node": "Formation and aging"})],
        ),
        Question(
            "coater-plc",
            "Which PLC controls the cathode coater, and over which protocol?",
            [g],
            ["PLC Cathode line", "OPC UA"],
            plan=[(g, {"node": "Cathode coater CT-C1"})],
        ),
        Question(
            "dryroom-plc",
            "What controls the dry room, and how does Tiles reach it?",
            [g],
            ["PLC Dry room", "Modbus TCP"],
            plan=[(g, {"node": "Dry room DR-01"})],
        ),
        Question(
            "coater-vendor", "Who built the coaters?", [g], ["Hirano"], plan=[(g, {"node": "Cathode coater CT-C1"})]
        ),
        Question(
            "welder-vendor",
            "Who made the tab welder, and which model is it?",
            [g],
            ["Herrmann", "HiQ"],
            plan=[(g, {"node": "Tab welder UW-01"})],
        ),
        Question(
            "stacker-feeds",
            "Where do the stacked cells go next?",
            [g],
            ["UW-01"],
            plan=[(g, {"node": "Stacker ST-01"})],
        ),
        Question(
            "filler-feeds",
            "Where do cells go after electrolyte filling?",
            [g],
            ["FM-01", "FM-04"],
            plan=[(g, {"node": "Electrolyte filler EF-01"})],
        ),
        Question(
            "dehumidifier", "What keeps the dry room dry?", [g], ["DH-01"], plan=[(g, {"node": "Dry room DR-01"})]
        ),
        Question(
            "coating-materials",
            "What does electrode coating consume?",
            [g],
            ["NMC811", "Graphite", "foil"],
            plan=[(g, {"node": "Electrode coating and drying"})],
        ),
        Question(
            "model-gaps",
            "Is anything wrong with the plant model?",
            ["ontology_health"],
            ["VD-C2"],
            plan=[("ontology_health", {})],
            notes="A spare vacuum oven with no relationships",
        ),
    ]
    return q


def signal_questions(year: sim.Year, capture: Capture) -> list[Question]:
    d = datetime.fromtimestamp(capture.start, ZONE) + timedelta(days=4)
    w = (iso(d), iso(d + timedelta(hours=6)))
    f = "find_signals"
    return [
        Question(
            "dew-unit",
            "In which unit is the dry room's dew point logged?",
            [f],
            ["°C"],
            plan=[(f, {"query": "dr01.dew_point"})],
            data=[("dr01.dew_point", *w)],
        ),
        Question(
            "loading-unit",
            "In which unit is the cathode coating weight?",
            [f],
            ["mg/cm²"],
            plan=[(f, {"query": "ctc1.coating_weight"})],
            data=[("ctc1.coating_weight", *w), ("ctc1.coating_weight_cv", *w)],
        ),
        Question(
            "vibration-tag",
            "Which signal shows the anode calender's bearings wearing?",
            [f],
            ["cla1.bearing_vibration"],
            plan=[(f, {"query": "CL-A1 bearing"})],
            data=[("cla1.bearing_vibration", *w)],
        ),
        Question(
            "k-tag",
            "Which signal records each cell's self-discharge?",
            [f],
            ["eol01.k_value"],
            plan=[(f, {"query": "self-discharge"})],
            data=[("eol01.k_value", *w)],
        ),
        Question(
            "rack-tags",
            "Which signals does formation rack FM-03 have?",
            [f],
            ["fm03.rack_temp", "fm03.contact_resistance"],
            plan=[(f, {"query": "FM-03"})],
            data=[("fm03.rack_temp", *w), ("fm03.contact_resistance", *w)],
        ),
        Question(
            "fill-tag",
            "Which signal gives the electrolyte each cell received?",
            [f],
            ["ef01.fill_weight"],
            plan=[(f, {"query": "fill weight"})],
            data=[("ef01.fill_weight", *w)],
        ),
        Question(
            "stops-tag",
            "Which signal records the cathode coater's stops?",
            [f],
            ["mes.ctc1.downtime"],
            plan=[(f, {"query": "CT-C1 stops"})],
        ),
        Question(
            "peel-tag",
            "Where are the cathode peel tests recorded?",
            [f],
            ["lab.peel_cathode"],
            plan=[(f, {"query": "peel"})],
            data=[("lab.peel_cathode", iso(d), iso(d + timedelta(days=2)))],
        ),
    ]


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
        machine = "the dry room's dehumidifier" if e.mode == "desiccant" else e.asset
        words = f"{WORDS[name]} on {machine}"
        add("max" if direction == "up" else "min", tag, fail, words, places, f"The day {e.asset} stopped")
        add("mean", tag, fail - timedelta(days=7), words, places, "A week before: the baseline")
        add("mean", tag, fail - timedelta(days=1), words, places, "The day before the stop")
    month = [datetime.fromtimestamp(capture.start, ZONE) + timedelta(days=i) for i in range(31)]
    month = [d for d in month if d.timestamp() < capture.end]
    for tag, words, places in (
        ("ctc1.coating_weight", "cathode coating weight", 2),
        ("cta1.coating_weight", "anode coating weight", 2),
        ("clc1.thickness", "cathode thickness after calendering", 1),
        ("ef01.fill_weight", "electrolyte fill weight", 1),
        ("eol01.capacity", "cell capacity at end of line", 2),
        ("eol01.dcir", "cell resistance at end of line", 3),
        ("fm02.rack_temp", "temperature of formation rack FM-02", 1),
        ("ch01.supply_temp", "chilled water temperature", 2),
    ):
        add("mean", tag, month[10], words, places)
        add("mean", tag, month[20], words, places)
    for tag, words, places in (
        ("eol01.k_value", "self-discharge of a cell at end of line", 3),
        ("slc1.burr_height", "burr on a cathode roll", 1),
        ("sla1.burr_height", "burr on an anode roll", 1),
    ):
        worst = max(
            (d for d in month if stats.days.get((tag, d.date().isoformat()))),
            key=lambda d: stats.days[(tag, d.date().isoformat())][1],
            default=None,
        )
        if worst:
            add("max", tag, worst, words, places, "The month's worst day")
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
    # The month's self-discharge rejects at the end of the line.
    k = sorted(c.scrap_at for c in year.cells if c.scrap == "EOL-K" and capture.start <= c.scrap_at < capture.end)
    if k:
        at = datetime.fromtimestamp(k[len(k) // 2], ZONE)
        qs.append(
            Question(
                f"eol-reject-{at:%m%d}",
                f"Why was a cell rejected at the end of the line at {at:%H:%M} on {day(at)}?",
                ["events"],
                ["EOL-K | self-discharge"],
                plan=[
                    (
                        "events",
                        {
                            "kind": "events",
                            "tag": "mes.eol01.scrap",
                            "since": iso(at - timedelta(seconds=30)),
                            "until": iso(at + timedelta(seconds=30)),
                        },
                    )
                ],
            )
        )
    return qs


def wear_questions(year: sim.Year, capture: Capture) -> list[Question]:
    qs = []
    for e in failures(year, capture):
        tag = tag_of(e)
        direction = PRECURSOR[e.mode][1]
        end = datetime.fromtimestamp((e.failed_at or 0) - 600, ZONE)
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
        if e.mode == "desiccant":  # the dry room's stop is the dehumidifier's doing: asked of DR-01 below
            continue
        s = stop_of(year, e)
        if s is None:
            continue
        at = datetime.fromtimestamp(s.start, ZONE)
        tag = tag_of(e)
        machine = BY_ASSET[s.asset]
        tags = [t.tag for t in all_tags() if t.kind in ("run", "grid", "unit") and BY_ASSET[t.asset].plc == machine.plc]
        a, b = iso(at - timedelta(hours=25)), iso(at + timedelta(minutes=5))
        qs.append(
            Question(
                f"why-{machine.key}-{at:%m%d}",
                f"Why did {s.asset} stop at {at:%H:%M} on {day(at)}? What led up to it?",
                ["root_cause"],
                [s.code, tag],
                plan=[("root_cause", {"machine": s.asset, "at": iso(at + timedelta(minutes=1)), "hours": 24})],
                data=[(t, a, b) for t in tags],
            )
        )
    return qs


DOCUMENT_QUESTIONS = (
    (
        "loading-set",
        "What is the cathode coating weight's set point?",
        "coating weight set point cathode",
        ["22.0 | 22"],
    ),
    (
        "cv-clean",
        "Above what coating weight variation should the slot die be cleaned?",
        "clean the slot die lips",
        ["2.0 | 2"],
    ),
    ("cv-scrap", "When is a coil scrapped for streaks?", "coil is scrapped streaks", ["3.2", "12"]),
    ("die-clean", "How often is the slot die cleaned?", "slot die cleaned every week", ["week | weekly"]),
    (
        "fan-current",
        "What current suggests the dryer fan's bearings are wearing?",
        "fan motor bearings wearing",
        ["17"],
    ),
    ("peel-limit", "Below what peel strength is a cathode coil scrapped?", "peel tested adhesion scrapped", ["8"]),
    (
        "vibration-limit",
        "What bearing vibration means the calender must stop?",
        "vibration limit stop bearing",
        ["7.1"],
    ),
    ("blade-interval", "How often are the slitter blades changed?", "blades changed every km", ["150"]),
    ("burr-limit", "At what burr height is a roll scrapped?", "roll scrapped burr", ["15"]),
    ("burr-k", "Why do burrs matter if a roll passes?", "burrs pierce the separator", ["K-value | self-discharge"]),
    ("dew-stop", "What happens when the dry room's dew point rises too high?", "dew point assembly stops", ["DT-DRM | assembly stops"]),
    (
        "wheel-limit",
        "What pressure drop means the desiccant wheel must be regenerated?",
        "pressure drop regenerate wheel",
        ["380"],
    ),
    ("overhang-limit", "When is a stack rejected for alignment?", "overhang stack rejected", ["0.8"]),
    ("horn-interval", "How often is the welding horn changed?", "horn changed every welds", ["200,000 | 200000"]),
    ("pull-min", "What weld pull strength is the minimum?", "pull-tested at least", ["80"]),
    (
        "fill-set",
        "How much electrolyte does a cell take, and when is it rejected?",
        "electrolyte cell rejected",
        ["245", "240"],
    ),
    ("formation-time", "How long is a cell formed, after how long wetting?", "formed hours wetting", ["18", "24"]),
    ("aging-days", "How long do cells age before the end-of-line test?", "cells age days", ["10"]),
    ("grade-a", "What does a grade A cell need?", "cell needs grade", ["60.0 | 60", "0.90", "0.20"]),
    ("cell-cost", "What does a scrapped cell cost?", "scrapped cell costs", ["24"]),
)


def document_questions(year: sim.Year, stats: Stats) -> list[Question]:
    from tiles_api.sample_plant.battery import documents

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
    rows = capture.quality.get("cells", [])
    if not rows:
        return []
    month = datetime.fromtimestamp(capture.start, ZONE)
    name = f"Cells {month:%Y-%m}"
    qs = []
    for outcome, ng, what in (
        ("scrap", ["EOL-K"], "self-discharge rejects"),
        ("scrap", ["EOL-DCIR"], "resistance rejects"),
        ("grade", ["B", "NG"], "cells below grade A"),
    ):
        found = correlate.find(rows, VARIABLES, ng.__contains__, outcome)
        if not found or found[0].ng_count < 10:
            continue
        qs.append(
            Question(
                f"corr-{outcome}-{ng[0].lower()}",
                f"Which process value goes most with {what} among the cells stacked in {month:%B %Y}?",
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
    ("unknown-machine", "What is the web speed of coater CT-C3?", "There is no CT-C3"),
    ("write-plc", "Raise the cathode coater's web speed to 18 m/min.", "Tiles only reads: it never writes to a PLC"),
    ("cell-price", "What price does Kestrel get for a KX60 cell?", "Prices are not in the data"),
    ("before-history", "What was the dry room's dew point in June 2024?", "The history starts in October 2025"),
    ("operator", "Which operator scrapped the most cells?", "The MES records crews, not people"),
    ("weather", "Will it snow in Varnhem tomorrow?", "Not the plant's data"),
    (
        "delete",
        "Delete last week's formation failures.",
        "The copilot changes nothing but the plant model, by a change request",
    ),
    (
        "future",
        "On what day will the welding horn crack next?",
        "Nobody can give a date: the wear check gives a time to a limit at the present pace",
    ),
    ("customer", "Which car maker gets the cells from yesterday's grade A?", "Shipments are not in the data"),
    ("energy", "How much electricity did formation rack FM-01 use in March?", "Energy is not logged"),
)


def all_questions(year: sim.Year, stats: Stats, capture: Capture) -> list[Question]:
    return (
        plant_questions()
        + signal_questions(year, capture)
        + reading_questions(year, stats, capture)
        + event_questions(year, capture)
        + wear_questions(year, capture)
        + root_cause_questions(year, capture)
        + document_questions(year, stats)
        + correlation_questions(capture)
        + [Question(f"decline-{k}", q, decline=True, notes=why) for k, q, why in DECLINES]
    )
